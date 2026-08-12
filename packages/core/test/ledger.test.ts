import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';

import { Ledger, isoWeek } from '../src/ledger.js';
import { StubAdapter } from '../src/stub-adapter.js';
import type { SendInvoiceParams, SendPayoutParams } from '../src/adapter.js';
import type { InvoiceResult, PayoutResult } from '../src/types.js';

/** StubAdapter with call counters, so we can assert nothing fires twice. */
class CountingStub extends StubAdapter {
  invoiceCalls: SendInvoiceParams[] = [];
  payoutCalls: SendPayoutParams[] = [];

  override async sendInvoice(p: SendInvoiceParams): Promise<InvoiceResult> {
    this.invoiceCalls.push(p);
    return await super.sendInvoice(p);
  }

  override async sendPayout(p: SendPayoutParams): Promise<PayoutResult> {
    this.payoutCalls.push(p);
    return await super.sendPayout(p);
  }
}

function newLedger(creditLimit = '0.50'): { ledger: Ledger; adapter: CountingStub } {
  const adapter = new CountingStub();
  const ledger = new Ledger({
    adapter,
    ephemeral: true,
    defaultCreditLimit: creditLimit,
    identity: {
      buyerEmail: 'buyer@example.com',
      sellerWalletId: 'stub_wallet_001',
      sellerEmail: 'seller@example.com',
    },
  });
  return { ledger, adapter };
}

describe('ledger.charge', () => {
  it('accumulates charges in exact cents', () => {
    const { ledger } = newLedger('5.00');
    for (let i = 0; i < 50; i++) ledger.charge('claude', 'fx_rate', '0.01');
    const tab = ledger.getTab('claude');
    assert.equal(tab.balance, '0.50');
    assert.equal(tab.entries.filter((e) => e.type === 'charge').length, 50);
    assert.equal(tab.entries.at(-1)?.balanceAfter, '0.50');
  });

  it('rejects a charge that would exceed the credit limit', () => {
    const { ledger } = newLedger('0.50');
    for (let i = 0; i < 50; i++) ledger.charge('claude', 'fx_rate', '0.01');
    assert.equal(ledger.getTab('claude').balance, '0.50');

    try {
      ledger.charge('claude', 'fx_rate', '0.01');
      assert.fail('expected CREDIT_EXCEEDED');
    } catch (e) {
      assert.equal((e as { code: string }).code, 'CREDIT_EXCEEDED');
      assert.deepEqual((e as { details: Record<string, unknown> }).details, {
        buyerId: 'claude',
        toolName: 'fx_rate',
        price: '0.01',
        balance: '0.50',
        creditLimit: '0.50',
      });
    }

    // The rejected charge left no trace on the tab.
    const tab = ledger.getTab('claude');
    assert.equal(tab.balance, '0.50');
    assert.equal(tab.entries.filter((e) => e.type === 'charge').length, 50);
  });

  it('rejects a charge whose price alone exceeds the limit', () => {
    const { ledger } = newLedger('0.50');
    assert.throws(() => ledger.charge('claude', 'expensive_tool', '0.51'), /CREDIT_EXCEEDED/);
  });
});

describe('ledger.cutoff', () => {
  it('refuses charges once the tab is cut off, and resumes after reopen', () => {
    const { ledger } = newLedger('5.00');
    ledger.charge('claude', 'fx_rate', '0.01');
    ledger.cutoff('claude', 'overdue');

    assert.equal(ledger.getTab('claude').status, 'delinquent');
    try {
      ledger.charge('claude', 'fx_rate', '0.01');
      assert.fail('expected TAB_DELINQUENT');
    } catch (e) {
      assert.equal((e as { code: string }).code, 'TAB_DELINQUENT');
    }
    assert.equal(ledger.getTab('claude').balance, '0.01');

    ledger.reopen('claude');
    ledger.charge('claude', 'fx_rate', '0.01');
    assert.equal(ledger.getTab('claude').balance, '0.02');
  });
});

describe('ledger.settle', () => {
  it('issues one invoice with aggregated line items and the documented reference id', async () => {
    const { ledger, adapter } = newLedger('5.00');
    for (let i = 0; i < 3; i++) ledger.charge('claude', 'fx_rate', '0.01');
    ledger.charge('claude', 'fx_convert', '0.02');

    const { invoice, created } = await ledger.settle('claude');
    assert.equal(created, true);
    assert.equal(invoice.amount, '0.05');
    assert.equal(invoice.referenceId, `tab-claude-${isoWeek(new Date())}`);
    assert.equal(ledger.getTab('claude').status, 'settling');

    // Line items are "desc|qty|price" material, one bucket per tool+price.
    assert.deepEqual(invoice.lines, [
      { desc: 'fx_rate', qty: 3, unitPrice: '0.01' },
      { desc: 'fx_convert', qty: 1, unitPrice: '0.02' },
    ]);
    assert.equal(Ledger.lineTotal(invoice.lines), invoice.amount);

    // Exactly one invoice send, addressed to the buyer, collected by the seller wallet.
    assert.equal(adapter.invoiceCalls.length, 1);
    assert.equal(adapter.invoiceCalls[0]?.toEmail, 'buyer@example.com');
    assert.deepEqual(adapter.invoiceCalls[0]?.walletIds, ['stub_wallet_001']);
    assert.equal(adapter.invoiceCalls[0]?.memo, invoice.referenceId);
  });

  it('is idempotent: re-settling returns the same invoice and sends no second one', async () => {
    const { ledger, adapter } = newLedger('5.00');
    ledger.charge('claude', 'fx_rate', '0.01');

    const first = await ledger.settle('claude');
    const second = await ledger.settle('claude');
    const third = await ledger.settle('claude');

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(third.created, false);
    assert.equal(second.invoice.referenceId, first.invoice.referenceId);
    assert.equal(adapter.invoiceCalls.length, 1, 'invoice send must fire exactly once');
    assert.equal(ledger.listInvoices({ buyerId: 'claude' }).length, 1);
    assert.equal(
      ledger.getTab('claude').entries.filter((e) => e.type === 'invoice').length,
      1,
      'only one invoice entry on the tab',
    );
  });

  it('is idempotent under concurrent settle calls', async () => {
    const { ledger, adapter } = newLedger('5.00');
    ledger.charge('claude', 'fx_rate', '0.01');

    const results = await Promise.all([
      ledger.settle('claude'),
      ledger.settle('claude'),
      ledger.settle('claude'),
    ]);
    assert.equal(adapter.invoiceCalls.length, 1);
    assert.equal(new Set(results.map((r) => r.invoice.referenceId)).size, 1);
  });

  it('refuses to settle an empty tab', async () => {
    const { ledger } = newLedger('5.00');
    ledger.getTab('claude');
    await assert.rejects(() => ledger.settle('claude'), /NOTHING_TO_SETTLE/);
  });
});

describe('ledger.applyPayment', () => {
  it('clears the balance once, and ignores a replay of the same reference id', async () => {
    const { ledger, adapter } = newLedger('5.00');
    for (let i = 0; i < 50; i++) ledger.charge('claude', 'fx_rate', '0.01');
    const { invoice } = await ledger.settle('claude');
    assert.equal(invoice.amount, '0.50');

    // Buyer pays through the adapter, then reports it to the ledger.
    const payout = await adapter.sendPayout({
      amount: invoice.amount,
      chain: invoice.chain,
      stableCoin: invoice.stableCoin,
      referenceId: invoice.referenceId,
      receiverEmail: invoice.receiverEmail,
    });
    const first = ledger.applyPayment({
      referenceId: invoice.referenceId,
      amount: invoice.amount,
      payout,
    });
    assert.equal(first.applied, true);
    assert.equal(first.tab.balance, '0.00');
    assert.equal(first.tab.status, 'open');
    assert.equal(first.invoice.status, 'paid');

    // Replay: same reference id must not credit the tab a second time.
    const replay = ledger.applyPayment({
      referenceId: invoice.referenceId,
      amount: invoice.amount,
      payout,
    });
    assert.equal(replay.applied, false);
    assert.equal(replay.tab.balance, '0.00');
    assert.equal(
      ledger.getTab('claude').entries.filter((e) => e.type === 'payment').length,
      1,
      'exactly one payment entry after the replay',
    );

    // And the adapter itself treats the replayed reference id as a duplicate.
    const replayedPayout = await adapter.sendPayout({
      amount: invoice.amount,
      chain: invoice.chain,
      stableCoin: invoice.stableCoin,
      referenceId: invoice.referenceId,
      receiverEmail: invoice.receiverEmail,
    });
    assert.equal(replayedPayout.status, 'duplicate');
  });

  it('rejects a payment whose amount does not match the invoice', async () => {
    const { ledger } = newLedger('5.00');
    ledger.charge('claude', 'fx_rate', '0.01');
    const { invoice } = await ledger.settle('claude');
    assert.throws(
      () => ledger.applyPayment({ referenceId: invoice.referenceId, amount: '0.02' }),
      /AMOUNT_MISMATCH/,
    );
    assert.equal(ledger.getTab('claude').balance, '0.01');
  });

  it('rejects an unknown reference id', () => {
    const { ledger } = newLedger('5.00');
    assert.throws(
      () => ledger.applyPayment({ referenceId: 'tab-nobody-2026w01', amount: '0.01' }),
      /INVOICE_NOT_FOUND/,
    );
  });

  it('opens a fresh cycle after payment, keeping reference ids unique', async () => {
    const { ledger, adapter } = newLedger('5.00');
    ledger.charge('claude', 'fx_rate', '0.01');
    const a = await ledger.settle('claude');
    ledger.applyPayment({ referenceId: a.invoice.referenceId, amount: a.invoice.amount });

    ledger.charge('claude', 'fx_rate', '0.01');
    const b = await ledger.settle('claude');

    assert.equal(b.created, true);
    assert.notEqual(b.invoice.referenceId, a.invoice.referenceId);
    assert.match(b.invoice.referenceId, /^tab-claude-\d{4}w\d{2}(\.\d+)?$/);
    assert.equal(adapter.invoiceCalls.length, 2);
    assert.equal(ledger.getTab('claude').balance, '0.01');
  });

  it('bills only charges made since the previous invoice', async () => {
    const { ledger } = newLedger('5.00');
    ledger.charge('claude', 'fx_rate', '0.01');
    const a = await ledger.settle('claude');
    ledger.applyPayment({ referenceId: a.invoice.referenceId, amount: a.invoice.amount });

    ledger.charge('claude', 'fx_convert', '0.02');
    ledger.charge('claude', 'fx_convert', '0.02');
    const b = await ledger.settle('claude');

    assert.deepEqual(b.invoice.lines, [{ desc: 'fx_convert', qty: 2, unitPrice: '0.02' }]);
    assert.equal(b.invoice.amount, '0.04');
  });
});

describe('ledger.snapshot', () => {
  it('is a point-in-time copy that later charges cannot mutate', async () => {
    const { ledger } = newLedger('5.00');
    ledger.charge('claude', 'fx_rate', '0.01');
    const before = ledger.snapshot();

    ledger.charge('claude', 'fx_rate', '0.01');
    const { invoice } = await ledger.settle('claude');

    // The snapshot handed out earlier must still describe the earlier state.
    assert.equal(before.tabs[0]?.balance, '0.01');
    assert.equal(before.tabs[0]?.entries.length, 1);
    assert.equal(before.invoices.length, 0);
    assert.equal(before.cliLog.length, 0);

    const after = ledger.snapshot();
    assert.equal(after.tabs[0]?.balance, '0.02');
    assert.equal(after.invoices.length, 1);
    assert.equal(after.invoices[0]?.referenceId, invoice.referenceId);

    // And mutating a snapshot must not corrupt the ledger.
    after.tabs[0]!.balance = '99.00';
    assert.equal(ledger.getTab('claude').balance, '0.02');
  });
});

describe('ledger persistence', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'tab-ledger-'));
  });

  it('survives a restart', async () => {
    const file = path.join(dir, 'ledger.json');
    const first = new Ledger({ adapter: new StubAdapter(), file, defaultCreditLimit: '5.00' });
    first.charge('claude', 'fx_rate', '0.01');
    first.charge('claude', 'fx_convert', '0.02');
    const { invoice } = await first.settle('claude');

    const second = new Ledger({ adapter: new StubAdapter(), file, defaultCreditLimit: '5.00' });
    assert.equal(second.getTab('claude').balance, '0.03');
    assert.equal(second.getTab('claude').status, 'settling');
    assert.equal(second.getInvoice(invoice.referenceId)?.amount, '0.03');
    assert.equal(second.outstanding('claude'), '0.03');

    // A replay after restart is still rejected as already-invoiced.
    const again = await second.settle('claude');
    assert.equal(again.created, false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('isoWeek', () => {
  it('formats ISO week ids', () => {
    assert.equal(isoWeek(new Date('2026-08-11T00:00:00Z')), '2026w33');
    assert.equal(isoWeek(new Date('2026-01-01T00:00:00Z')), '2026w01');
  });
});
