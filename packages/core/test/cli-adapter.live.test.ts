/**
 * CliAdapter against the REAL CLI.
 *
 * The rest of the suite injects a StubAdapter, so `TAB_ADAPTER=cli` alone proves
 * nothing about the CLI path. These tests actually spawn `allscale`.
 *
 * They are read-only and skip themselves when the CLI or its session is absent,
 * so the suite still passes on a machine without credentials:
 *
 *   - `payout status`      → field mapping, per-pair authorization
 *   - `transaction list`   → row mapping
 *   - an undelegated pair  → FENCE_NOT_AUTHORIZED, decided from live data
 *   - `payout send`        → fails closed without STORE credentials (no network)
 *
 * Nothing here moves money or sends mail.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

import { CliAdapter } from '../src/cli-adapter.js';
import { chainIdForSlug } from '../src/chains.js';
import { toCentsFloor } from '../src/money.js';

const run = promisify(execFile);
const bin = process.env.ALLSCALE_CLI_BIN ?? 'allscale';

/** Is there a CLI with a usable session? Result is cached for the whole file. */
const available = await (async (): Promise<{ ok: boolean; why: string }> => {
  if (process.env.TAB_SKIP_LIVE_CLI === '1') return { ok: false, why: 'TAB_SKIP_LIVE_CLI=1' };
  try {
    await run(bin, ['--version']);
  } catch {
    return { ok: false, why: `${bin} is not on PATH` };
  }
  try {
    const { stdout } = await run(bin, ['whoami', '--json']);
    const data = JSON.parse(stdout).data ?? {};
    if (data.expired === true) return { ok: false, why: 'the CLI session has expired' };
    return { ok: true, why: '' };
  } catch {
    return { ok: false, why: 'no CLI session — run `allscale device-login`' };
  }
})();

const CHAIN = process.env.TAB_CHAIN ?? 'sepolia';
const COIN = process.env.TAB_STABLE_COIN ?? 'USDT';

describe('CliAdapter — live, read-only', () => {
  it('maps payout status onto FenceStatus', async (t) => {
    if (!available.ok) return t.skip(available.why);
    const fence = await new CliAdapter({ chain: CHAIN, stableCoin: COIN }).fenceStatus();

    assert.equal(typeof fence.provisioned, 'boolean');
    assert.equal(typeof fence.active, 'boolean');
    assert.equal(fence.enabled, fence.provisioned && fence.active);
    assert.equal(fence.chain, CHAIN, 'echoes the configured pair, not a CLI field');
    assert.equal(fence.coin, COIN);

    // The amounts arrive as decimal strings with more than cent precision.
    for (const [field, value] of [
      ['totalCap', fence.totalCap],
      ['used', fence.used],
      ['remaining', fence.remaining],
      ['singleTxCap', fence.singleTxCap],
    ] as const) {
      assert.match(value, /^\d+(\.\d+)?$/, `${field} should be a decimal string, got ${value}`);
      assert.doesNotThrow(() => toCentsFloor(value), `${field} must survive parsing`);
    }

    // authorized_pairs is the per-chain × token delegation list.
    assert.ok(Array.isArray(fence.authorizedPairs));
    for (const pair of fence.authorizedPairs) {
      assert.equal(typeof pair.chain, 'number', 'chain is numeric in responses');
      assert.equal(typeof pair.tokenSymbol, 'string');
    }
    // The raw payload stays authoritative.
    assert.equal(typeof fence.raw['provisioned'], 'boolean');
  });

  it('maps transaction list rows', async (t) => {
    if (!available.ok) return t.skip(available.why);
    const txs = await new CliAdapter().listTransactions();
    assert.ok(Array.isArray(txs));
    for (const tx of txs.slice(0, 5)) {
      assert.equal(typeof tx.raw, 'object');
      if (tx.amount !== undefined) assert.equal(typeof tx.amount, 'string');
      if (tx.id !== undefined) assert.equal(typeof tx.id, 'string');
    }
  });

  it('refuses an undelegated chain × token pair, decided from live authorization', async (t) => {
    if (!available.ok) return t.skip(available.why);
    const adapter = new CliAdapter({ chain: CHAIN, stableCoin: COIN });
    const fence = await adapter.fenceStatus();
    if (fence.authorizedPairs.length === 0) return t.skip('no authorized pairs to compare against');

    // Find a slug this session is definitely NOT delegated for.
    const delegated = new Set(
      fence.authorizedPairs.map((p) => `${p.chain}/${p.tokenSymbol.toUpperCase()}`),
    );
    const candidate = ['polygon', 'arbitrum', 'optimism', 'base', 'ethereum'].find((slug) => {
      const id = chainIdForSlug(slug);
      return id !== undefined && !delegated.has(`${id}/${COIN}`);
    });
    if (!candidate) return t.skip('every known chain is delegated for this coin');

    await assert.rejects(
      () =>
        new CliAdapter({ chain: candidate, stableCoin: COIN }).enableFence({
          storeId: '',
          chain: candidate,
          coin: COIN,
          singleTxCap: fence.singleTxCap,
          totalCap: fence.totalCap,
          expires: fence.expires,
        }),
      /FENCE_NOT_AUTHORIZED/,
      `${candidate} × ${COIN} is not delegated, so it must be refused`,
    );
  });

  it('confirms the configured pair is delegated, or says why not', async (t) => {
    if (!available.ok) return t.skip(available.why);
    const adapter = new CliAdapter({ chain: CHAIN, stableCoin: COIN });
    const fence = await adapter.fenceStatus();
    const id = chainIdForSlug(CHAIN);
    const delegated = fence.authorizedPairs.some(
      (p) => p.chain === id && p.tokenSymbol.toUpperCase() === COIN,
    );
    if (!delegated) {
      return t.skip(
        `${CHAIN} × ${COIN} is not delegated on this account — grant it in Store Settings → Payout Authorization`,
      );
    }
    const confirmed = await adapter.enableFence({
      storeId: '',
      chain: CHAIN,
      coin: COIN,
      singleTxCap: fence.singleTxCap,
      totalCap: fence.totalCap,
      expires: fence.expires,
    });
    assert.equal(confirmed.enabled, true);
    assert.equal(confirmed.provisioned, true);
  });

  it('fails closed on payout send without STORE credentials, before any network call', async (t) => {
    if (!available.ok) return t.skip(available.why);
    const saved = {
      k: process.env.ALLSCALE_STORE_API_KEY,
      s: process.env.ALLSCALE_STORE_API_SECRET,
    };
    try {
      delete process.env.ALLSCALE_STORE_API_KEY;
      delete process.env.ALLSCALE_STORE_API_SECRET;
      await assert.rejects(
        () =>
          new CliAdapter({ chain: CHAIN, stableCoin: COIN }).sendPayout({
            amount: '0.10',
            chain: CHAIN,
            stableCoin: COIN,
            referenceId: 'tab-live-test-must-not-run',
            receiverEmail: '',
          }),
        /CLI_AUTH_MISSING/,
      );
    } finally {
      if (saved.k !== undefined) process.env.ALLSCALE_STORE_API_KEY = saved.k;
      if (saved.s !== undefined) process.env.ALLSCALE_STORE_API_SECRET = saved.s;
    }
  });

  it('captures --help for every command the adapter depends on', async (t) => {
    if (!available.ok) return t.skip(available.why);
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const dir = mkdtempSync(path.join(tmpdir(), 'tab-help-'));
    try {
      const files = await new CliAdapter({ helpDir: dir }).captureHelp();
      assert.ok(files.length >= 25, `expected the full command surface, got ${files.length}`);

      // The flags the adapter builds argv from must appear in the captured help.
      const payoutSend = readFileSync(path.join(dir, 'payout-send.txt'), 'utf8');
      for (const flag of ['--amount', '--chain', '--stable-coin', '--reference-id', '--json']) {
        assert.match(payoutSend, new RegExp(flag.replace(/-/g, '\\-')), `payout send should list ${flag}`);
      }
      // And the one it must never emit.
      assert.doesNotMatch(payoutSend, /--expires/, 'payout send has no --expires');

      const invoiceSend = readFileSync(path.join(dir, 'invoice-send.txt'), 'utf8');
      for (const flag of ['--to-email', '--line', '--wallet-id', '--payment-type', '--memo']) {
        assert.match(invoiceSend, new RegExp(flag.replace(/-/g, '\\-')), `invoice send should list ${flag}`);
      }

      // payout enable must still not exist.
      const payoutEnable = readFileSync(path.join(dir, 'payout-enable.txt'), 'utf8');
      assert.match(payoutEnable, /Unknown command/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
