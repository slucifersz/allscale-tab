/**
 * M5 acceptance: after the seller's middleware triggers a settle, the buyer kit
 * funds AND claims it, the tab goes back to zero, and the equivalent CLI
 * commands are echoed correctly.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  Ledger,
  StubAdapter,
  startLedgerServer,
  type ClaimPayoutParams,
  type ClaimResult,
  type LedgerServer,
  type PayoutResult,
  type SendPayoutParams,
} from '@tab/core';

import { BuyerKit, REFERENCE_ID_RE, type SettleOutcome } from '../src/buyer-kit.js';

/** Records the order of adapter calls, so serialisation can be asserted. */
class TracingStub extends StubAdapter {
  readonly calls: string[] = [];
  claimDelayMs = 0;

  override async sendPayout(p: SendPayoutParams): Promise<PayoutResult> {
    this.calls.push(`send:${p.referenceId}`);
    return await super.sendPayout(p);
  }

  override async claimPayout(p: ClaimPayoutParams): Promise<ClaimResult> {
    this.calls.push(`claim:${p.referenceId ?? '?'}`);
    if (this.claimDelayMs > 0) await new Promise((r) => setTimeout(r, this.claimDelayMs));
    return await super.claimPayout(p);
  }
}

interface Fixture {
  ledger: Ledger;
  api: LedgerServer;
  kit: BuyerKit;
  adapter: TracingStub;
  lines: string[];
  close(): Promise<void>;
}

async function fixture(
  t: { after: (fn: () => void | Promise<void>) => void },
  opts: { maxAutoPay?: string; fenceSingleTx?: string; adapter?: TracingStub } = {},
): Promise<Fixture> {
  const ledger = new Ledger({
    adapter: new StubAdapter(),
    ephemeral: true,
    defaultCreditLimit: '5.00',
    chain: 'sepolia',
    stableCoin: 'USDT',
    identity: {
      buyerEmail: 'buyer@example.com',
      sellerWalletId: 'stub_wallet_001',
      sellerEmail: 'seller@example.com',
    },
  });
  // Port 0: let the OS pick, so tests never collide with a running demo.
  const api = await startLedgerServer({ ledger, port: 0 });

  const adapter =
    opts.adapter ??
    new TracingStub({
      fence: {
        singleTxCap: opts.fenceSingleTx ?? '200',
        totalCap: '20000',
      },
    });

  const lines: string[] = [];
  const kit = new BuyerKit({
    adapter,
    ledgerApi: `http://127.0.0.1:${api.port}`,
    buyerId: 'claude',
    ...(opts.maxAutoPay === undefined ? {} : { maxAutoPay: opts.maxAutoPay }),
    intervalMs: 50,
    print: (l) => lines.push(l),
  });

  const f: Fixture = {
    ledger,
    api,
    kit,
    adapter,
    lines,
    close: async () => {
      kit.stop();
      await api.close();
    },
  };
  // Registered on the test context: a failing assertion must still release the
  // HTTP server, or the whole runner hangs waiting on the open handle.
  t.after(() => f.close());
  return f;
}

/** Charge until the tab holds an amount, then close the cycle. */
async function billAndInvoice(f: Fixture, calls: number): Promise<string> {
  for (let i = 0; i < calls; i++) f.ledger.charge('claude', 'fx_rate', '0.01');
  const { invoice } = await f.ledger.settle('claude');
  return invoice.referenceId;
}

describe('reference id validation', () => {
  it('accepts the documented format and rejects anything else', () => {
    assert.match('tab-claude-2026w33', REFERENCE_ID_RE);
    assert.match('tab-claude-2026w33.2', REFERENCE_ID_RE);
    assert.doesNotMatch('tab-claude', REFERENCE_ID_RE);
    assert.doesNotMatch('invoice-claude-2026w33', REFERENCE_ID_RE);
    assert.doesNotMatch('tab-claude-2026week33', REFERENCE_ID_RE);
  });
});

describe('M5 acceptance — automatic settlement', () => {
  it('funds, claims, zeroes the tab, and echoes both real CLI commands', async (t) => {
    const f = await fixture(t);
    const referenceId = await billAndInvoice(f, 50);
    assert.equal(f.ledger.getTab('claude').balance, '0.50');
    assert.equal(f.ledger.getTab('claude').status, 'settling');

    const outcomes = await f.kit.runOnce();
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.paid, true);
    assert.equal(outcomes[0]?.referenceId, referenceId);
    assert.equal(outcomes[0]?.amount, '0.50');
    assert.equal(outcomes[0]?.payout?.status, 'submitted');
    assert.equal(outcomes[0]?.claim?.claimed, true);

    // Funding then claiming, in that order, for this reference id.
    assert.deepEqual(f.adapter.calls, [`send:${referenceId}`, `claim:${referenceId}`]);

    // Tab is clear and open again.
    const tab = f.ledger.getTab('claude');
    assert.equal(tab.balance, '0.00');
    assert.equal(tab.status, 'open');
    assert.equal(f.ledger.getInvoice(referenceId)?.status, 'paid');
    assert.equal(f.ledger.outstanding('claude'), '0.00');

    // The ledger records BOTH legs — funding alone would not be payment.
    const stored = f.ledger.getInvoice(referenceId);
    assert.equal(stored?.payment?.claimLinkId, outcomes[0]?.payout?.claimLinkId);
    assert.equal(stored?.claim?.claimed, true);
    // And the bearer token never reached the ledger.
    assert.equal(stored?.payment?.claimToken, undefined);

    // Char-exact echo of the funding command, with verified flags only.
    const payoutEcho = f.lines.find((l) => l.includes('allscale payout send'));
    assert.ok(payoutEcho, 'expected a payout send command echo');
    assert.match(
      payoutEcho,
      new RegExp(
        '^\\u001b\\[1m\\u001b\\[32m→ allscale payout send ' +
          '--amount 0\\.50 --chain sepolia --stable-coin USDT ' +
          `--reference-id ${referenceId} --receiver-email seller@example\\.com --json\\u001b\\[0m$`,
      ),
    );

    // And of the claim command, with the bearer token redacted.
    const claimEcho = f.lines.find((l) => l.includes('allscale claim-link claim'));
    assert.ok(claimEcho, 'expected a claim command echo');
    assert.match(
      claimEcho,
      /^\u001b\[1m\u001b\[32m→ allscale claim-link claim --claim-token \*\*\* --to-wallet --json\u001b\[0m$/,
    );

    // Both reached the ledger's CLI log, which is what the UI renders.
    const cliLog = f.ledger.snapshot().cliLog;
    const buyerCommands = cliLog.filter((c) => c.actor === 'buyer').map((c) => c.command);
    assert.equal(buyerCommands.filter((c) => c.includes('payout send')).length, 1);
    assert.equal(buyerCommands.filter((c) => c.includes('claim-link claim')).length, 1);
    // The token is redacted everywhere it is persisted.
    assert.ok(!JSON.stringify(cliLog).includes('stub_claim_token'));
    await f.close();
  });

  it('settles within 5 seconds of the seller closing the cycle', async (t) => {
    const f = await fixture(t);
    assert.equal(await f.kit.waitForLedger(5_000), true);
    f.kit.start();

    const referenceId = await billAndInvoice(f, 50);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 5_000) {
      if (f.ledger.getInvoice(referenceId)?.status === 'paid') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    const elapsed = Date.now() - startedAt;

    assert.equal(f.ledger.getInvoice(referenceId)?.status, 'paid', 'invoice paid within 5s');
    assert.ok(elapsed < 5_000, `settled in ${elapsed}ms`);
    assert.equal(f.ledger.getTab('claude').balance, '0.00');
    await f.close();
  });

  it('does not pay the same reference id twice', async (t) => {
    const f = await fixture(t);
    const referenceId = await billAndInvoice(f, 50);
    await f.kit.runOnce();

    // Nothing outstanding, so a second pass is a no-op.
    const second = await f.kit.runOnce();
    assert.deepEqual(second, []);

    // A forced replay funds nothing new: the same reference id returns the same
    // link, and the ledger ignores the duplicate payment.
    const invoice = f.ledger.getInvoice(referenceId);
    assert.ok(invoice);
    const replay: SettleOutcome = await f.kit.settleInvoice({ ...invoice, status: 'sent' });
    assert.equal(replay.payout?.status, 'duplicate');
    assert.equal(replay.payout?.idempotentHit, true);
    assert.equal(f.ledger.getTab('claude').balance, '0.00');
    assert.equal(
      f.ledger.getTab('claude').entries.filter((e) => e.type === 'payment').length,
      1,
      'exactly one payment entry',
    );
    await f.close();
  });
});

describe('M5 — funding and claiming are one serialised step', () => {
  it('never interleaves two settlements', async (t) => {
    const adapter = new TracingStub();
    adapter.claimDelayMs = 40;
    const f = await fixture(t, { adapter });

    // Two invoices outstanding at once.
    const first = await billAndInvoice(f, 10);
    f.ledger.applyPayment({ referenceId: first, amount: f.ledger.getInvoice(first)!.amount });
    f.ledger.charge('claude', 'fx_convert', '0.02');
    const second = (await f.ledger.settle('claude')).invoice.referenceId;
    const firstInvoice = { ...f.ledger.getInvoice(first)!, status: 'sent' as const };
    const secondInvoice = f.ledger.getInvoice(second)!;

    await Promise.all([f.kit.settleInvoice(firstInvoice), f.kit.settleInvoice(secondInvoice)]);

    // Each send is immediately followed by its own claim — never send, send, claim.
    assert.equal(adapter.calls.length, 4);
    for (let i = 0; i < adapter.calls.length; i += 2) {
      const send = adapter.calls[i] as string;
      const claim = adapter.calls[i + 1] as string;
      assert.ok(send.startsWith('send:'), `expected a send at ${i}, got ${send}`);
      assert.ok(claim.startsWith('claim:'), `expected a claim at ${i + 1}, got ${claim}`);
      assert.equal(send.slice(5), claim.slice(6), 'the claim belongs to the payout before it');
    }
    await f.close();
  });

  it('leaves the invoice unpaid when funding succeeds but the claim fails', async (t) => {
    // A claim window that has already closed: the link is funded, unclaimable,
    // and will be refunded to the buyer.
    const adapter = new TracingStub({ claimTtlMs: -1 });
    const f = await fixture(t, { adapter });
    const referenceId = await billAndInvoice(f, 50);

    const outcome = await f.kit.settleInvoice(f.ledger.getInvoice(referenceId)!);
    assert.equal(outcome.paid, false);
    assert.equal(outcome.fundedButUnclaimed, true);
    assert.match(outcome.error ?? '', /CLAIM_EXPIRED/);

    // The bill must NOT be marked paid just because money left the buyer.
    assert.equal(f.ledger.getInvoice(referenceId)?.status, 'sent');
    assert.equal(f.ledger.getTab('claude').balance, '0.50');
    assert.ok(f.lines.some((l) => l.includes('FUNDED BUT NOT CLAIMED')));
    await f.close();
  });

  it('defers the claim while funding is still in flight, then retries it', async (t) => {
    const adapter = new TracingStub({ pendingRounds: 1 });
    const f = await fixture(t, { adapter });
    const referenceId = await billAndInvoice(f, 50);

    // First pass: the backend reports funding_pending, so there is no token yet.
    const first = await f.kit.runOnce();
    assert.equal(first[0]?.paid, false);
    assert.equal(first[0]?.payout?.backendStatus, 'funding_pending');
    assert.equal(f.ledger.getInvoice(referenceId)?.status, 'sent');
    assert.deepEqual(adapter.calls, [`send:${referenceId}`], 'no claim attempted without a token');

    // Second pass: the same reference id resolves, and the claim goes through.
    const second = await f.kit.runOnce();
    assert.equal(second[0]?.paid, true);
    assert.equal(f.ledger.getInvoice(referenceId)?.status, 'paid');
    assert.equal(f.ledger.getTab('claude').balance, '0.00');
    await f.close();
  });
});

describe('M5 — buyer-side refusals', () => {
  it('refuses an invoice above the buyer-side ceiling', async (t) => {
    const f = await fixture(t, { maxAutoPay: '0.25' });
    const referenceId = await billAndInvoice(f, 50);

    const outcomes = await f.kit.runOnce();
    assert.equal(outcomes[0]?.paid, false);
    assert.equal(outcomes[0]?.skipped, 'OVER_MAX_AUTO_PAY');
    assert.equal(f.ledger.getInvoice(referenceId)?.status, 'sent', 'invoice left unpaid');
    assert.equal(f.ledger.getTab('claude').balance, '0.50');
    assert.deepEqual(f.adapter.calls, [], 'nothing was sent');
    assert.ok(f.lines.some((l) => l.includes('OVER_MAX_AUTO_PAY')));
    await f.close();
  });

  it('refuses an invoice above the fence per-transaction limit', async (t) => {
    const f = await fixture(t, { fenceSingleTx: '0.10' });
    await billAndInvoice(f, 50);
    const outcomes = await f.kit.runOnce();
    assert.equal(outcomes[0]?.skipped, 'OVER_FENCE_SINGLE_TX');
    assert.equal(f.ledger.getTab('claude').balance, '0.50');
    await f.close();
  });

  it('tolerates the 6-decimal amounts the CLI reports for caps', async (t) => {
    // Real `payout status` returns e.g. remaining_usd "19995.162308".
    const adapter = new TracingStub({
      fence: { totalCap: '19995.162308', singleTxCap: '200.5' },
    });
    const f = await fixture(t, { adapter });
    const referenceId = await billAndInvoice(f, 50);
    const outcomes = await f.kit.runOnce();
    assert.equal(outcomes[0]?.paid, true, 'sub-cent precision must not crash validation');
    assert.equal(f.ledger.getInvoice(referenceId)?.status, 'paid');
    await f.close();
  });

  it('refuses an invoice whose reference id is malformed', async (t) => {
    const f = await fixture(t);
    await billAndInvoice(f, 1);
    const invoice = f.ledger.listInvoices({ status: 'sent' })[0];
    assert.ok(invoice);
    const outcome = await f.kit.settleInvoice({ ...invoice, referenceId: 'not-a-tab-reference' });
    assert.equal(outcome.paid, false);
    assert.equal(outcome.skipped, 'BAD_REFERENCE_ID');
    await f.close();
  });

  it('survives the ledger API being down and recovers', async (t) => {
    const f = await fixture(t);
    await billAndInvoice(f, 50);
    await f.api.close();

    await assert.rejects(() => f.kit.pendingInvoices());
    // The polling loop must not crash the process on a dead API.
    f.kit.start();
    await new Promise((r) => setTimeout(r, 150));
    f.kit.stop();
    assert.equal(f.ledger.getTab('claude').balance, '0.50', 'nothing was paid while down');
  });
});
