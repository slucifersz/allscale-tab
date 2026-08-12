import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { chainIdForSlug, normalizeChain, normalizeStableCoin } from '../src/chains.js';
import { parseJsonStream, redactArgv, redactPayload } from '../src/cli-adapter.js';
import {
  claimArgv,
  claimUrlRecoveryArgv,
  echoClaim,
  echoClaimStatus,
  echoInvoiceSend,
  echoPayoutEnable,
  echoPayoutSend,
  echoPayoutStatus,
  echoTransactionList,
  invoiceSendArgv,
  payoutSendArgv,
  renderInvoiceLine,
} from '../src/cli-echo.js';
import { resolveAdapterKind, createAdapter } from '../src/factory.js';
import { StubAdapter } from '../src/stub-adapter.js';

/**
 * Fidelity guard (the design brief §4 M1): the only vocabulary allowed at the top level
 * of an adapter result is what the verified CLI surface uses. Everything else
 * lives under `raw`. The allow-lists below are traceable to docs/cli-help/.
 */
function assertNoInventedFields(obj: object, allowed: string[], label: string): void {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  assert.deepEqual(extra, [], `${label} has undocumented top-level fields: ${extra.join(', ')}`);
}

/** Sepolia × USDT — the pair this account has delegated (payout status). */
const PAIR = { chain: 'sepolia', coin: 'USDT' } as const;

const fenceParams = {
  storeId: 'stub_store_001',
  chain: PAIR.chain,
  coin: PAIR.coin,
  singleTxCap: '200',
  totalCap: '20000',
  expires: '2026-09-11T04:25:27+00:00',
};

function payoutParams(overrides: Record<string, string> = {}) {
  return {
    amount: '0.50',
    chain: PAIR.chain,
    stableCoin: PAIR.coin,
    referenceId: 'tab-claude-2026w33',
    receiverEmail: 'seller@example.com',
    ...overrides,
  };
}

function invoiceParams(overrides: Record<string, unknown> = {}) {
  return {
    toEmail: 'buyer@example.com',
    amount: '0.60',
    walletIds: ['stub_wallet_001'],
    stableCoin: PAIR.coin,
    lines: [
      { desc: 'fx_rate', qty: 50, unitPrice: '0.01' },
      { desc: 'fx_convert', qty: 5, unitPrice: '0.02' },
    ],
    memo: 'tab-claude-2026w33',
    ...overrides,
  };
}

describe('chains — slug ↔ numeric id', () => {
  it('maps the ids observed in live wallet list output', () => {
    assert.equal(chainIdForSlug('sepolia'), 11);
    assert.equal(chainIdForSlug('bsc'), 6);
    assert.equal(chainIdForSlug('base'), 5);
    assert.equal(chainIdForSlug('ethereum'), 1);
    // Not an EVM payout target, so it has no slug to look up.
    assert.equal(chainIdForSlug('solana'), undefined);
  });

  it('normalizes to the enum payout send accepts, and rejects anything else', () => {
    assert.equal(normalizeChain('SEPOLIA'), 'sepolia');
    assert.throws(() => normalizeChain('sepolia-testnet'), /INVALID_CHAIN/);
    assert.throws(() => normalizeChain('solana'), /INVALID_CHAIN/);
  });

  it('upper-cases stablecoins, because --stable-coin is case-sensitive', () => {
    assert.equal(normalizeStableCoin('usdt'), 'USDT');
    assert.equal(normalizeStableCoin('USDC'), 'USDC');
    assert.throws(() => normalizeStableCoin('DAI'), /INVALID_STABLE_COIN/);
  });
});

describe('stub adapter — CLI fidelity', () => {
  it('payout status returns the fields payout status actually selects', async () => {
    const a = new StubAdapter();
    const fence = await a.enableFence(fenceParams);
    assertNoInventedFields(
      fence,
      [
        'enabled',
        'provisioned',
        'active',
        'singleTxCap',
        'totalCap',
        'used',
        'remaining',
        'expires',
        'authorizedPairs',
        'chain',
        'coin',
        'storeId',
        'raw',
      ],
      'FenceStatus',
    );
    assert.equal(fence.provisioned, true);
    assert.equal(fence.active, true);
    assert.equal(fence.enabled, true);
    assert.equal(fence.totalCap, '20000');
    assert.equal(fence.remaining, '20000.00');
    assert.equal(fence.used, '0.00');
    // Authorization is per chain × token, exactly as the backend reports it.
    for (const pair of fence.authorizedPairs) {
      assertNoInventedFields(pair, ['chain', 'tokenSymbol', 'policyId'], 'AuthorizedPair');
      assert.equal(typeof pair.chain, 'number');
    }
  });

  it('payout send reports a funded claim link, not a completed transfer', async () => {
    const a = new StubAdapter();
    const r = await a.sendPayout(payoutParams());
    assertNoInventedFields(
      r,
      [
        'amount',
        'chain',
        'stableCoin',
        'referenceId',
        'receiverEmail',
        'status',
        'claimLinkId',
        'chainId',
        'tokenSymbol',
        'backendStatus',
        'claimToken',
        'claimUrl',
        'fundingTxHash',
        'fundedAmount',
        'idempotentHit',
        'raw',
      ],
      'PayoutResult',
    );
    assert.equal(r.status, 'submitted');
    assert.equal(r.chainId, 11, 'sepolia');
    assert.equal(r.tokenSymbol, 'USDT');
    assert.ok(r.claimLinkId, 'a claim link id is always returned');
    assert.ok(r.claimToken, 'the one-time bearer token is returned here and nowhere else');
    assert.equal(r.idempotentHit, false);
    // The bearer token must never reach a persisted payload.
    assert.equal(r.raw['token'], '***');
  });

  it('invoice send returns payment_id and no invented status', async () => {
    const a = new StubAdapter();
    const r = await a.sendInvoice(invoiceParams());
    assertNoInventedFields(
      r,
      ['id', 'status', 'amount', 'toEmail', 'walletId', 'lines', 'memo', 'raw'],
      'InvoiceResult',
    );
    assert.equal(r.amount, '0.60');
    assert.match(r.id, /^stub_inv_\d{4}$/);
    assert.equal(r.status, undefined, 'invoice send returns no status — none is invented');
  });

  it('transaction list rows keep an authoritative raw payload', async () => {
    const a = new StubAdapter();
    await a.sendInvoice(invoiceParams());
    const txs = await a.listTransactions();
    assert.equal(txs.length, 1);
    for (const tx of txs) {
      assertNoInventedFields(tx, ['id', 'amount', 'referenceId', 'raw'], 'Transaction');
      assert.equal(tx.raw['stub'], true);
    }
  });
});

describe('stub adapter — authorization is per chain × token', () => {
  it('refuses an undelegated pair with FENCE_NOT_AUTHORIZED', async () => {
    const a = new StubAdapter();
    // The sandbox account delegates Sepolia and BSC only — Base is not delegated.
    await assert.rejects(
      () => a.sendPayout(payoutParams({ chain: 'base' })),
      /FENCE_NOT_AUTHORIZED/,
    );
    // Same chain, undelegated token.
    const onlyUsdt = new StubAdapter({
      fence: { authorizedPairs: [{ chain: 11, tokenSymbol: 'USDT', policyId: 'p' }] },
    });
    await assert.rejects(
      () => onlyUsdt.sendPayout(payoutParams({ stableCoin: 'USDC' })),
      /FENCE_NOT_AUTHORIZED/,
    );
    // And the delegated pair goes through.
    const ok = await onlyUsdt.sendPayout(payoutParams());
    assert.equal(ok.status, 'submitted');
  });

  it('refuses to confirm a fence for an undelegated pair', async () => {
    const a = new StubAdapter();
    await assert.rejects(
      () => a.enableFence({ ...fenceParams, chain: 'polygon' }),
      /FENCE_NOT_AUTHORIZED/,
    );
  });

  it('refuses payouts when the session is not active', async () => {
    const a = new StubAdapter({ fence: { active: false } });
    await assert.rejects(() => a.sendPayout(payoutParams()), /FENCE_NOT_ENABLED/);
  });
});

describe('stub adapter — caps and idempotency', () => {
  const tight = { ...fenceParams, singleTxCap: '1.00', totalCap: '2.00' };

  it('enforces the per-transaction limit', async () => {
    const a = new StubAdapter({ fence: tight });
    await assert.rejects(() => a.sendPayout(payoutParams({ amount: '1.01' })), /FENCE_EXCEEDED/);
  });

  it('enforces the remaining total cap', async () => {
    const a = new StubAdapter({ fence: tight });
    for (const ref of ['tab-claude-a', 'tab-claude-b']) {
      await a.sendPayout(payoutParams({ amount: '1.00', referenceId: ref }));
    }
    assert.equal((await a.fenceStatus()).remaining, '0.00');
    await assert.rejects(
      () => a.sendPayout(payoutParams({ amount: '0.01', referenceId: 'tab-claude-c' })),
      /FENCE_EXCEEDED/,
    );
  });

  it('treats a replayed reference id as a duplicate without funding twice', async () => {
    const a = new StubAdapter({ fence: tight });
    const p = payoutParams({ amount: '1.00', referenceId: 'tab-claude-a' });
    const first = await a.sendPayout(p);
    const second = await a.sendPayout(p);
    assert.equal(first.status, 'submitted');
    assert.equal(second.status, 'duplicate');
    assert.equal(second.idempotentHit, true);
    assert.equal(second.claimLinkId, first.claimLinkId, 'the same link, not a new one');
    assert.equal((await a.fenceStatus()).remaining, '1.00', 'the duplicate spent nothing');
  });

  it('surfaces an in-flight funding as a pending status', async () => {
    const a = new StubAdapter({ pendingRounds: 1 });
    const pending = await a.sendPayout(payoutParams());
    assert.equal(pending.status, 'pending');
    assert.equal(pending.backendStatus, 'funding_pending');
    assert.equal(pending.claimToken, undefined, 'no token while the funding is unresolved');

    // Retrying the same reference id resolves it — the CLI's own guidance.
    const settled = await a.sendPayout(payoutParams());
    assert.equal(settled.status, 'submitted');
    assert.ok(settled.claimToken);
  });
});

describe('stub adapter — the claim step', () => {
  it('delivers the money only once the link is claimed', async () => {
    const a = new StubAdapter();
    const payout = await a.sendPayout(payoutParams());
    assert.ok(payout.claimToken);

    const claim = await a.claimPayout({
      claimToken: payout.claimToken,
      referenceId: payout.referenceId,
    });
    assert.equal(claim.claimed, true);
    assert.equal(claim.claimLinkId, payout.claimLinkId);
    assert.equal(claim.destination, 'allscale-wallet');

    // Both legs show up as transactions.
    const kinds = (await a.listTransactions()).map((t) => t.raw['stub_kind']);
    assert.deepEqual(kinds, ['payout', 'claim']);
  });

  it('claims to an explicit address when one is given', async () => {
    const a = new StubAdapter();
    const payout = await a.sendPayout(payoutParams());
    const claim = await a.claimPayout({
      claimToken: payout.claimToken as string,
      toAddress: '0x000000000000000000000000000000000000dEaD',
    });
    assert.equal(claim.destination, '0x000000000000000000000000000000000000dEaD');
  });

  it('refuses a second claim on the same link', async () => {
    const a = new StubAdapter();
    const payout = await a.sendPayout(payoutParams());
    await a.claimPayout({ claimToken: payout.claimToken as string });
    await assert.rejects(
      () => a.claimPayout({ claimToken: payout.claimToken as string }),
      /CLAIM_EXPIRED/,
    );
  });

  it('refuses an expired link — the case that silently loses money', async () => {
    // Claim windows are short (~21 min observed); a zero-length one expires at once.
    const a = new StubAdapter({ claimTtlMs: -1 });
    const payout = await a.sendPayout(payoutParams());
    await assert.rejects(
      () => a.claimPayout({ claimToken: payout.claimToken as string }),
      /CLAIM_EXPIRED/,
    );
  });

  it('refuses an unknown token', async () => {
    const a = new StubAdapter();
    await assert.rejects(() => a.claimPayout({ claimToken: 'nope' }), /CLAIM_EXPIRED/);
  });
});

describe('cli echo — verified flags only', () => {
  it('renders payout send for the delegated pair', () => {
    assert.equal(
      echoPayoutSend(payoutParams()),
      'allscale payout send --amount 0.50 --chain sepolia --stable-coin USDT ' +
        '--reference-id tab-claude-2026w33 --receiver-email seller@example.com --json',
    );
  });

  it('omits --receiver-email when there is none, and never emits --expires', () => {
    const cmd = echoPayoutSend({ ...payoutParams(), receiverEmail: '' });
    assert.equal(
      cmd,
      'allscale payout send --amount 0.50 --chain sepolia --stable-coin USDT ' +
        '--reference-id tab-claude-2026w33 --json',
    );
    // payout send has no --expires; only claim-link create does.
    assert.doesNotMatch(cmd, /--expires/);
  });

  it('renders invoice send with the LINE TOTAL, not the unit price', () => {
    // 50 × 0.01 = 0.50 and 5 × 0.02 = 0.10, summing to the 0.60 total. Passing
    // the unit price here would make the CLI sum the invoice to 0.03.
    assert.equal(renderInvoiceLine({ desc: 'fx_rate', qty: 50, unitPrice: '0.01' }), 'fx_rate|50|0.50');
    assert.equal(
      echoInvoiceSend(invoiceParams()),
      'allscale invoice send --to-email buyer@example.com --amount 0.60 ' +
        '--line "fx_rate|50|0.50" --line "fx_convert|5|0.10" --wallet-id stub_wallet_001 ' +
        '--payment-type 1 --memo tab-claude-2026w33 --auto-create-contact --json',
    );
  });

  it('selects --payment-type 2 for USDC', () => {
    const argv = invoiceSendArgv(invoiceParams({ stableCoin: 'USDC' }));
    assert.equal(argv[argv.indexOf('--payment-type') + 1], '2');
  });

  it('redacts the bearer token in the claim echo but not in the argv', () => {
    const params = { claimToken: 'secret-token-value' };
    assert.equal(echoClaim(params), 'allscale claim-link claim --claim-token *** --to-wallet --json');
    assert.deepEqual(claimArgv(params), [
      'claim-link',
      'claim',
      '--claim-token',
      'secret-token-value',
      '--to-wallet',
      '--json',
    ]);
  });

  it('renders the read-only commands', () => {
    assert.equal(echoPayoutStatus(), 'allscale payout status --json');
    assert.equal(echoTransactionList(), 'allscale transaction list --json');
  });

  it('tells a human to use the dashboard instead of inventing payout enable', () => {
    const text = echoPayoutEnable(fenceParams);
    assert.match(text, /not a CLI action/);
    assert.match(text, /Store Settings → Payout Authorization/);
    assert.match(text, /allscale payout status --json/);
    // There is no such command, so it must never be rendered as one.
    assert.doesNotMatch(text, /allscale payout enable/);
  });

  it('never emits a flag outside the verified set', () => {
    const verified = new Set([
      '--amount',
      '--chain',
      '--stable-coin',
      '--reference-id',
      '--receiver-email',
      '--to-email',
      '--wallet-id',
      '--line',
      '--memo',
      '--due',
      '--payment-type',
      '--auto-create-contact',
      '--claim-token',
      '--claim-url',
      '--to',
      '--to-wallet',
      '--json',
      '--select',
      '--all',
    ]);
    const commands = [
      echoPayoutSend(payoutParams()),
      echoInvoiceSend(invoiceParams({ due: '2026-09-01' })),
      echoClaim({ claimToken: 't', toAddress: '0xabc' }),
      echoPayoutStatus(),
      echoTransactionList(),
    ];
    for (const cmd of commands) {
      for (const flag of cmd.match(/--[a-z-]+/g) ?? []) {
        assert.ok(verified.has(flag), `unverified flag ${flag} in: ${cmd}`);
      }
    }
  });

  it('builds argv and echo from the same source', () => {
    const argv = payoutSendArgv(payoutParams());
    assert.equal(`allscale ${argv.join(' ')}`, echoPayoutSend(payoutParams()));
  });
});

describe('cli output parsing', () => {
  it('reads the last document when the CLI prints progress events first', () => {
    // Real `payout send` output: an event line, then the result.
    const stdout =
      '{"version":"1","event":"payout_destination","payout_api_base":"<derived payout API>"}\n' +
      '{"data":{"claim_link_id":"abc","status":"funded"}}\n';
    const events = parseJsonStream(stdout);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.['event'], 'payout_destination');
    assert.deepEqual(events.at(-1)?.['data'], { claim_link_id: 'abc', status: 'funded' });
  });

  it('reads a single pretty-printed document', () => {
    const events = parseJsonStream('{\n  "data": {\n    "provisioned": true\n  }\n}\n');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]?.['data'], { provisioned: true });
  });

  it('ignores non-JSON noise', () => {
    assert.deepEqual(parseJsonStream(''), []);
    assert.deepEqual(parseJsonStream('Scopes for profile default: invoice:all\n'), []);
  });
});

describe('secret hygiene', () => {
  it('redacts secret flag values in logged argv', () => {
    assert.deepEqual(
      redactArgv(['claim-link', 'claim', '--claim-token', 'abc', '--to-wallet']),
      ['claim-link', 'claim', '--claim-token', '***', '--to-wallet'],
    );
    assert.deepEqual(redactArgv(['payout', 'send', '--api-secret', 's']), [
      'payout',
      'send',
      '--api-secret',
      '***',
    ]);
  });

  it('redacts bearer tokens in payloads that get persisted', () => {
    const out = redactPayload({
      token: 'secret',
      // The claim URL embeds the token (…/claim/<token>), so it is a credential
      // too — anyone holding the URL can take the money.
      claim_url: 'https://app.allscale.io/claim/secret',
      claim_link_id: 'abc',
      amount: '1',
    });
    assert.equal(out['token'], '***');
    assert.equal(out['claim_url'], '***');
    assert.equal(out['claim_link_id'], 'abc', 'the link id is not a secret');
    assert.equal(out['amount'], '1');
  });
});

describe('adapter factory', () => {
  it('defaults to stub and honours TAB_ADAPTER / ADAPTER', () => {
    const saved = { tab: process.env.TAB_ADAPTER, alias: process.env.ADAPTER };
    try {
      delete process.env.TAB_ADAPTER;
      delete process.env.ADAPTER;
      assert.equal(resolveAdapterKind(), 'stub');
      assert.equal(createAdapter().kind, 'stub');

      process.env.ADAPTER = 'stub';
      assert.equal(resolveAdapterKind(), 'stub');

      process.env.TAB_ADAPTER = 'cli';
      assert.equal(resolveAdapterKind(), 'cli');
      assert.equal(createAdapter().kind, 'cli');

      process.env.TAB_ADAPTER = 'nope';
      assert.throws(() => resolveAdapterKind(), /INVALID_ADAPTER/);
    } finally {
      if (saved.tab === undefined) delete process.env.TAB_ADAPTER;
      else process.env.TAB_ADAPTER = saved.tab;
      if (saved.alias === undefined) delete process.env.ADAPTER;
      else process.env.ADAPTER = saved.alias;
    }
  });
});

describe('cli adapter — credential discipline', () => {
  it('fails closed when the STORE key is absent (it is not the login key)', async () => {
    const { CliAdapter } = await import('../src/cli-adapter.js');
    const saved = {
      k: process.env.ALLSCALE_STORE_API_KEY,
      s: process.env.ALLSCALE_STORE_API_SECRET,
    };
    try {
      delete process.env.ALLSCALE_STORE_API_KEY;
      delete process.env.ALLSCALE_STORE_API_SECRET;
      const a = new CliAdapter();
      await assert.rejects(() => a.sendPayout(payoutParams()), /CLI_AUTH_MISSING/);
    } finally {
      if (saved.k !== undefined) process.env.ALLSCALE_STORE_API_KEY = saved.k;
      if (saved.s !== undefined) process.env.ALLSCALE_STORE_API_SECRET = saved.s;
    }
  });
});

describe('claim link status — the asynchronous deposit', () => {
  it('reports PENDING_DEPOSIT until the deposit confirms, then LINK_SENT', async () => {
    const a = new StubAdapter({ depositDelayMs: 10_000, claimWaitMs: 0 });
    const payout = await a.sendPayout(payoutParams());
    const token = payout.claimToken as string;

    const pending = await a.claimLinkStatus({ claimToken: token });
    assert.equal(pending.status, 'PENDING_DEPOSIT');
    assert.equal(pending.isClaimable, false, 'is_claimable is the gate, not the status string');
    assert.equal(pending.amount, '0.50');
    assert.equal(pending.tokenSymbol, 'USDT');
    assert.equal(pending.chain, 11);

    // Claiming before the deposit confirms is refused as TRANSIENT, not terminal.
    await assert.rejects(
      () => a.claimPayout({ claimToken: token, waitForDeposit: false }),
      /CLAIM_NOT_READY/,
    );
    // …and the link is still there to claim later.
    assert.equal((await a.claimLinkStatus({ claimToken: token })).isClaimable, false);
  });

  it('waits for the deposit and then claims, by default', async () => {
    const a = new StubAdapter({ depositDelayMs: 120, claimPollIntervalMs: 20 });
    const payout = await a.sendPayout(payoutParams());
    const started = Date.now();
    const claim = await a.claimPayout({ claimToken: payout.claimToken as string });
    assert.equal(claim.claimed, true);
    assert.equal(claim.outcome, 'claimed');
    assert.ok(claim.claimTxHash, 'a claimed link carries a tx hash');
    assert.ok(Date.now() - started >= 100, 'it actually waited for the deposit');
    assert.equal((await a.claimLinkStatus({ claimToken: payout.claimToken as string })).status, 'CLAIMED');
  });

  it('gives up as retryable when the deposit outlasts the budget', async () => {
    const a = new StubAdapter({ depositDelayMs: 60_000, claimWaitMs: 60, claimPollIntervalMs: 20 });
    const payout = await a.sendPayout(payoutParams());
    await assert.rejects(
      () => a.claimPayout({ claimToken: payout.claimToken as string }),
      /CLAIM_NOT_READY/,
      'a slow deposit is retryable, never terminal',
    );
  });

  it('reports EXPIRED once the window closes, which IS terminal', async () => {
    const a = new StubAdapter({ claimTtlMs: -1 });
    const payout = await a.sendPayout(payoutParams());
    const status = await a.claimLinkStatus({ claimToken: payout.claimToken as string });
    assert.equal(status.status, 'EXPIRED');
    assert.equal(status.isClaimable, false);
    await assert.rejects(
      () => a.claimPayout({ claimToken: payout.claimToken as string }),
      /CLAIM_EXPIRED/,
    );
  });

  it('accepts a claim URL as the credential source', async () => {
    const a = new StubAdapter();
    const payout = await a.sendPayout(payoutParams());
    const byUrl = await a.claimLinkStatus({ claimUrl: payout.claimUrl as string });
    assert.equal(byUrl.isClaimable, true);
    const claim = await a.claimPayout({ claimUrl: payout.claimUrl as string });
    assert.equal(claim.claimed, true);
  });

  it('renders the status command with the credential redacted', () => {
    assert.equal(
      echoClaimStatus({ claimToken: 'secret' }),
      'allscale claim-link status --claim-token *** --json',
    );
    assert.equal(
      echoClaimStatus({ claimUrl: '<internal test environment>/claim/secret' }),
      'allscale claim-link status --claim-url *** --json',
    );
    assert.equal(
      echoClaim({ claimUrl: '<internal test environment>/claim/secret' }),
      'allscale claim-link claim --claim-url *** --to-wallet --json',
    );
  });

  it('builds the owner-side claim URL recovery command', () => {
    assert.deepEqual(claimUrlRecoveryArgv('6a7c2b77e2eb941d437f9fe2'), [
      'claim-link',
      'get',
      '6a7c2b77e2eb941d437f9fe2',
      '--select',
      'id status claim_url',
      '--json',
    ]);
  });

  it('refuses to build a claim command with no credential', () => {
    assert.throws(() => claimArgv({}), /CLAIM_SOURCE_MISSING/);
  });
});
