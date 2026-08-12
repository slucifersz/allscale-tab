/**
 * M2 + M3 acceptance: a real MCP client against the example server with the
 * billing middleware attached.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { Ledger, StubAdapter } from '@tab/core';
import { normalizeConfig, type PaymentRequired } from '@tab/middleware';

import { createExampleServer } from '../src/server.js';
import { SUPPORTED_CURRENCIES, convert, quote } from '../src/rates.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_BIN = path.resolve(HERE, '../src/bin/server.js');

function text(r: CallToolResult): string {
  return (r.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
}

function payment(r: CallToolResult): PaymentRequired | undefined {
  return r._meta?.['tab/payment_required'] as PaymentRequired | undefined;
}

describe('fx rates', () => {
  it('quotes a pair and round-trips through USD', () => {
    const q = quote('USD', 'EUR');
    assert.equal(q.pair, 'USD/EUR');
    assert.match(q.rate, /^\d+\.\d{6}$/);
    assert.equal(quote('USD', 'USD').rate, '1.000000');
    assert.ok(SUPPORTED_CURRENCIES.includes('JPY'));
  });

  it('converts without floating-point drift', () => {
    const c = convert('100.00', 'USD', 'USD');
    assert.equal(c.result, '100.00');
    assert.equal(convert('0.00', 'USD', 'JPY').result, '0.00');
    assert.match(convert('125.50', 'USD', 'EUR').result, /^\d+\.\d{2}$/);
  });

  it('rejects unknown currencies and bad amounts', () => {
    assert.throws(() => quote('USD', 'XYZ'), /UNKNOWN_CURRENCY/);
    assert.throws(() => convert('1.234', 'USD', 'EUR'), /INVALID_AMOUNT/);
  });
});

describe('M3 — MCP client can use the paid server', () => {
  it('lists and calls both tools', async () => {
    const ledger = new Ledger({ adapter: new StubAdapter(), ephemeral: true });
    const { server } = createExampleServer({
      ledger,
      config: normalizeConfig({
        pricing: { default: '0.01', tools: { fx_convert: '0.02' } },
        billingCycle: 'manual',
        creditLimit: '5.00',
      }),
      buyerId: 'claude',
    });
    const client = new Client({ name: 'claude', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((t) => t.name).sort(),
      ['fx_convert', 'fx_rate'],
    );

    const rate = (await client.callTool({
      name: 'fx_rate',
      arguments: { from: 'USD', to: 'JPY' },
    })) as CallToolResult;
    const rateBody = JSON.parse(text(rate)) as { pair: string; rate: string };
    assert.equal(rateBody.pair, 'USD/JPY');
    assert.equal(ledger.getTab('claude').balance, '0.01');

    const conv = (await client.callTool({
      name: 'fx_convert',
      arguments: { amount: '250.00', from: 'USD', to: 'EUR' },
    })) as CallToolResult;
    const convBody = JSON.parse(text(conv)) as { result: string };
    assert.match(convBody.result, /^\d+\.\d{2}$/);
    assert.equal(ledger.getTab('claude').balance, '0.03', 'fx_convert costs 0.02');

    // A tool-level failure is not billed.
    const bad = (await client.callTool({
      name: 'fx_rate',
      arguments: { from: 'USD', to: 'XYZ' },
    })) as CallToolResult;
    assert.equal(bad.isError, true);
    assert.match(text(bad), /UNKNOWN_CURRENCY/);
    assert.equal(ledger.getTab('claude').balance, '0.03');

    await client.close();
    await server.close();
  });

  it('serves a client over real stdio from the built binary', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tab-stdio-'));
    writeFileSync(
      path.join(dir, 'tab.config.json'),
      JSON.stringify({
        pricing: { default: '0.01', tools: { fx_convert: '0.02' } },
        settleThreshold: '0.50',
        billingCycle: 'manual',
        creditLimit: '5.00',
      }),
    );
    const client = new Client({ name: 'claude', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_BIN],
      cwd: dir,
      env: {
        PATH: process.env.PATH ?? '',
        TAB_ADAPTER: 'stub',
        // Don't bind a port in tests.
        TAB_LEDGER_PORT: 'off',
        TAB_LEDGER_FILE: path.join(dir, '.tab/ledger.json'),
      },
      stderr: 'pipe',
    });
    await client.connect(transport);

    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name).sort(), ['fx_convert', 'fx_rate']);

    const r = (await client.callTool({
      name: 'fx_convert',
      arguments: { amount: '10.00', from: 'USD', to: 'GBP' },
    })) as CallToolResult;
    assert.equal(r.isError, undefined);
    const body = JSON.parse(text(r)) as { pair: string; result: string };
    assert.equal(body.pair, 'USD/GBP');

    await client.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('M2 acceptance — 60 calls against the paid server', () => {
  it('bills 50, invoices at the $0.50 threshold, then answers 402', async () => {
    const ledger = new Ledger({ adapter: new StubAdapter(), ephemeral: true });
    const { server, billing } = createExampleServer({
      ledger,
      config: normalizeConfig({
        pricing: { default: '0.01' },
        settleThreshold: '0.50',
        billingCycle: 'threshold',
        creditLimit: '0.50',
      }),
      buyerId: 'claude',
      settleUrl: 'http://127.0.0.1:4788/settle',
    });
    const client = new Client({ name: 'claude', version: '0.0.0' });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(st), client.connect(ct)]);

    const allowed: number[] = [];
    const refused: number[] = [];
    const balances: string[] = [];

    for (let i = 1; i <= 60; i++) {
      const r = (await client.callTool({
        name: 'fx_rate',
        arguments: { from: 'USD', to: 'EUR' },
      })) as CallToolResult;
      await billing.idle();
      if (r.isError === true) {
        refused.push(i);
        const p = payment(r);
        assert.equal(p?.code, 402, `call ${i} must carry a 402 payload`);
        assert.equal(p?.error, 'PAYMENT_REQUIRED');
        assert.equal(p?.tab.reason, 'CREDIT_EXCEEDED');
        assert.equal(p?.tab.balance, '0.50');
        assert.equal(p?.tab.creditLimit, '0.50');
        assert.equal(p?.tab.settleUrl, 'http://127.0.0.1:4788/settle');
      } else {
        allowed.push(i);
        balances.push(ledger.getTab('claude').balance);
      }
    }

    // 1..50 served, 51..60 refused.
    assert.equal(allowed.length, 50);
    assert.equal(refused.length, 10);
    assert.equal(allowed[0], 1);
    assert.equal(allowed.at(-1), 50);
    assert.equal(refused[0], 51);
    assert.equal(refused.at(-1), 60);

    // Balance stepped by exactly one cent per served call.
    assert.equal(balances[0], '0.01');
    assert.equal(balances[9], '0.10');
    assert.equal(balances[49], '0.50');

    // Threshold closed the cycle: exactly one invoice, for the full balance.
    const invoices = ledger.listInvoices({ buyerId: 'claude' });
    assert.equal(invoices.length, 1);
    assert.equal(invoices[0]?.amount, '0.50');
    assert.equal(invoices[0]?.status, 'sent');
    assert.deepEqual(invoices[0]?.lines, [{ desc: 'fx_rate', qty: 50, unitPrice: '0.01' }]);
    assert.equal(ledger.getTab('claude').status, 'settling');
    assert.equal(ledger.outstanding('claude'), '0.50');

    // The invoice is visible as an equivalent CLI command for the demo UI.
    const invoiceEcho = ledger.snapshot().cliLog.filter((c) => c.command.startsWith('allscale invoice send'));
    assert.equal(invoiceEcho.length, 1);
    // `--line` carries "desc|qty|LINE TOTAL", not a unit price: the CLI sums the
    // third field to derive the invoice total, so 50 × $0.01 must render as 0.50.
    assert.match(invoiceEcho[0]?.command ?? '', /--line "fx_rate\|50\|0\.50"/);
    assert.match(invoiceEcho[0]?.command ?? '', /--amount 0\.50 /);
    assert.match(invoiceEcho[0]?.command ?? '', /--memo tab-claude-\d{4}w\d{2}/);
    assert.match(invoiceEcho[0]?.command ?? '', /--payment-type 1\b/, 'USDT');

    // 60 calls, 50 charges, one invoice entry.
    const entries = ledger.getTab('claude').entries;
    assert.equal(entries.filter((e) => e.type === 'charge').length, 50);
    assert.equal(entries.filter((e) => e.type === 'invoice').length, 1);

    await client.close();
    await server.close();
  });
});
