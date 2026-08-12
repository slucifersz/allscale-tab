#!/usr/bin/env node
/**
 * End-to-end self test — the checklist from the design brief §7, items 3-5, run
 * against live processes rather than unit-test doubles:
 *
 *   3. charges accumulate → threshold invoices → buyer kit settles → tab zeroed
 *   4. over-limit calls return the 402 object; a cut-off tab is refused service
 *   5. settlement is idempotent — replaying a reference id makes no second payment
 *
 * Run after `npm run build`:  node demo/self-test.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { Ledger, StubAdapter, startLedgerServer } from '@tab/core';
import { normalizeConfig } from '@tab/middleware';
import { createExampleServer } from '@tab/example-server';
import { BuyerKit } from '@tab/buyer-kit';

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  cyan: '\u001b[36m',
};

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures += 1;
  console.log(
    `  ${ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`} ${label} ` +
      `${C.dim}${ok ? a : `expected ${e}, got ${a}`}${C.reset}`,
  );
}
function section(n, title) {
  console.log(`\n${C.cyan}${C.bold}§7.${n} ${title}${C.reset}`);
}

const text = (r) => r.content?.[0]?.text ?? '';
const payment402 = (r) => r._meta?.['tab/payment_required'];

async function scenario({ creditLimit, settleThreshold, billingCycle = 'threshold' }) {
  const ledger = new Ledger({ adapter: new StubAdapter(), ephemeral: true });
  const api = await startLedgerServer({ ledger, port: 0 });
  const { server, billing } = createExampleServer({
    ledger,
    config: normalizeConfig({
      pricing: { default: '0.01', tools: { fx_convert: '0.02' } },
      settleThreshold,
      billingCycle,
      creditLimit,
    }),
    buyerId: 'claude',
    settleUrl: `http://127.0.0.1:${api.port}/settle`,
  });
  const client = new Client({ name: 'claude', version: '0.1.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);

  const kitLines = [];
  const kit = new BuyerKit({
    adapter: new StubAdapter({ fence: { singleTxCap: '2.00', totalCap: '20.00' } }),
    ledgerApi: `http://127.0.0.1:${api.port}`,
    buyerId: 'claude',
    intervalMs: 100,
    print: (l) => kitLines.push(l),
  });

  const callRate = async () => {
    const r = await client.callTool({ name: 'fx_rate', arguments: { from: 'USD', to: 'EUR' } });
    await billing.idle();
    return r;
  };

  return {
    ledger,
    api,
    kit,
    kitLines,
    callRate,
    close: async () => {
      kit.stop();
      await client.close();
      await server.close();
      await api.close();
    },
  };
}

// ---------------------------------------------------------------------------
section(3, 'accumulate → invoice at the threshold → auto-settle → zeroed');
{
  const s = await scenario({ creditLimit: '5.00', settleThreshold: '0.50' });
  for (let i = 0; i < 49; i++) await s.callRate();
  check('balance after 49 calls', s.ledger.getTab('claude').balance, '0.49');
  check('invoices so far', s.ledger.listInvoices().length, 0);

  await s.callRate();
  const invoice = s.ledger.listInvoices()[0];
  check('threshold closed the cycle', s.ledger.listInvoices().length, 1);
  check('invoice amount', invoice.amount, '0.50');
  check('reference id format', /^tab-claude-\d{4}w\d{2}(\.\d+)?$/.test(invoice.referenceId), true);
  check('line items', invoice.lines, [{ desc: 'fx_rate', qty: 50, unitPrice: '0.01' }]);
  check('tab status', s.ledger.getTab('claude').status, 'settling');

  // Buyer kit settles it.
  const t0 = Date.now();
  s.kit.start();
  while (Date.now() - t0 < 5_000) {
    if (s.ledger.getInvoice(invoice.referenceId).status === 'paid') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const elapsed = Date.now() - t0;
  check('invoice paid', s.ledger.getInvoice(invoice.referenceId).status, 'paid');
  check('settled within 5s', elapsed < 5_000, true);
  check('balance cleared', s.ledger.getTab('claude').balance, '0.00');
  check('tab reopened', s.ledger.getTab('claude').status, 'open');
  console.log(`  ${C.dim}settled in ${elapsed}ms${C.reset}`);

  const cli = s.ledger.snapshot().cliLog.map((c) => `${c.actor}: ${c.command}`);
  console.log(`\n  ${C.bold}equivalent CLI commands recorded${C.reset}`);
  for (const line of cli) console.log(`  ${C.dim}${line}${C.reset}`);
  check('invoice send echoed once', cli.filter((l) => l.includes('invoice send')).length, 1);
  check('payout send echoed once', cli.filter((l) => l.includes('payout send')).length, 1);
  check('claim echoed once', cli.filter((l) => l.includes('claim-link claim')).length, 1);
  check('claim recorded on the invoice', s.ledger.getInvoice(invoice.referenceId).claim?.claimed, true);
  check('bearer token never persisted', JSON.stringify(s.ledger.snapshot()).includes('stub_claim_token'), false);

  await s.close();
}

// ---------------------------------------------------------------------------
section(4, 'over-limit returns 402 · a cut-off tab is refused service');
{
  const s = await scenario({ creditLimit: '0.05', settleThreshold: '5.00' });
  for (let i = 0; i < 5; i++) await s.callRate();
  check('balance at the limit', s.ledger.getTab('claude').balance, '0.05');

  const refused = await s.callRate();
  const p = payment402(refused);
  console.log(`  ${C.dim}${text(refused).replace(/\n\s*/g, ' ')}${C.reset}`);
  check('isError', refused.isError, true);
  check('code', p.code, 402);
  check('error', p.error, 'PAYMENT_REQUIRED');
  check('tab.balance', p.tab.balance, '0.05');
  check('tab.creditLimit', p.tab.creditLimit, '0.05');
  check('tab.reason', p.tab.reason, 'CREDIT_EXCEEDED');
  check('settleUrl present', typeof p.tab.settleUrl === 'string' && p.tab.settleUrl.length > 0, true);
  check('refused call was not billed', s.ledger.getTab('claude').balance, '0.05');

  // Now cut the tab off explicitly.
  s.ledger.cutoff('claude', 'overdue');
  const cutoffRefused = await s.callRate();
  const p2 = payment402(cutoffRefused);
  check('delinquent → isError', cutoffRefused.isError, true);
  check('delinquent → reason', p2.tab.reason, 'TAB_DELINQUENT');
  check('delinquent → status', p2.tab.status, 'delinquent');

  // Reopening alone does not restore service: the balance is still at the
  // limit, so the buyer has to actually pay before calls are served again.
  s.ledger.reopen('claude');
  const stillRefused = await s.callRate();
  check('reopen alone is not enough', payment402(stillRefused).tab.reason, 'CREDIT_EXCEEDED');

  const { invoice } = await s.ledger.settle('claude');
  const outcome = await s.kit.settleInvoice(invoice);
  check('buyer paid the outstanding cycle', outcome.paid, true);
  check('balance cleared', s.ledger.getTab('claude').balance, '0.00');
  const served = await s.callRate();
  check('service restored once paid', served.isError, undefined);

  await s.close();
}

// ---------------------------------------------------------------------------
section(5, 'settlement is idempotent under replay');
{
  const s = await scenario({ creditLimit: '5.00', settleThreshold: '0.10' });
  for (let i = 0; i < 10; i++) await s.callRate();
  const invoice = s.ledger.listInvoices()[0];
  check('one invoice', s.ledger.listInvoices().length, 1);

  // Replay settle: no second invoice.
  const again = await s.ledger.settle('claude');
  check('settle replay created nothing', again.created, false);
  check('same reference id', again.invoice.referenceId, invoice.referenceId);
  check('still one invoice', s.ledger.listInvoices().length, 1);

  // Pay it, then replay the payment twice more.
  const first = await s.kit.settleInvoice(invoice);
  check('first payout applied', first.paid, true);
  check('first payout was not a duplicate', first.duplicate, undefined);

  const replay = await s.kit.settleInvoice({ ...s.ledger.getInvoice(invoice.referenceId), status: 'sent' });
  check('replayed payout reported duplicate', replay.duplicate, true);
  check('replay funded nothing new', replay.payout?.idempotentHit, true);
  check('replay is not mislabelled as funded-but-unclaimed', replay.fundedButUnclaimed, undefined);

  const entries = s.ledger.getTab('claude').entries;
  check('exactly one payment entry', entries.filter((e) => e.type === 'payment').length, 1);
  check('balance still zero', s.ledger.getTab('claude').balance, '0.00');
  check('invoice paid once', s.ledger.getInvoice(invoice.referenceId).status, 'paid');

  await s.close();
}

console.log(
  failures === 0
    ? `\n${C.green}${C.bold}all checks passed${C.reset}`
    : `\n${C.red}${C.bold}${failures} check(s) failed${C.reset}`,
);
process.exit(failures === 0 ? 0 : 1);
