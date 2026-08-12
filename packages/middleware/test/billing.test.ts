import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { Ledger, StubAdapter } from '@tab/core';

import { attachBilling, type BillingController } from '../src/billing.js';
import { normalizeConfig, priceFor, DEFAULT_CONFIG, type TabConfig } from '../src/config.js';
import type { PaymentRequired } from '../src/payment-required.js';

interface Harness {
  client: Client;
  ledger: Ledger;
  billing: BillingController;
  close(): Promise<void>;
}

/** A tiny paid MCP server (echo + a failing tool) driven by a real MCP client. */
async function harness(
  config: Partial<TabConfig> = {},
  opts: { creditLimit?: string; registerBeforeAttach?: boolean } = {},
): Promise<Harness> {
  const ledger = new Ledger({
    adapter: new StubAdapter(),
    ephemeral: true,
    defaultCreditLimit: opts.creditLimit ?? '0.50',
  });
  const server = new McpServer({ name: 'test-server', version: '0.0.0' });

  const echo = async (args: { text: string }): Promise<CallToolResult> => ({
    content: [{ type: 'text', text: args.text }],
  });

  // A tool registered *before* attachBilling must still get billed.
  if (opts.registerBeforeAttach) {
    server.registerTool('early', { inputSchema: { text: z.string() } }, echo);
  }

  const billing = attachBilling(server, {
    ledger,
    config: normalizeConfig({ creditLimit: opts.creditLimit ?? '0.50', ...config }),
    buyerId: 'claude',
    settleUrl: 'http://127.0.0.1:4788/settle',
  });

  server.registerTool('cheap', { inputSchema: { text: z.string() } }, echo);
  server.registerTool('pricey', { inputSchema: { text: z.string() } }, echo);
  server.registerTool('free_tool', { inputSchema: { text: z.string() } }, echo);
  server.registerTool('broken', {}, async (): Promise<CallToolResult> => ({
    content: [{ type: 'text', text: 'boom' }],
    isError: true,
  }));

  const client = new Client({ name: 'claude', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    ledger,
    billing,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function paymentPayload(result: CallToolResult): PaymentRequired | undefined {
  return result._meta?.['tab/payment_required'] as PaymentRequired | undefined;
}

async function call(h: Harness, name: string, args: Record<string, unknown> = { text: 'hi' }) {
  return (await h.client.callTool({ name, arguments: args })) as CallToolResult;
}

describe('config', () => {
  it('resolves per-tool prices with a default fallback', () => {
    const config = normalizeConfig({
      pricing: { default: '0.01', tools: { fx_convert: '0.02' } },
    });
    assert.equal(priceFor(config, 'fx_convert'), '0.02');
    assert.equal(priceFor(config, 'fx_rate'), '0.01');
    assert.equal(priceFor(config, 'anything_else'), '0.01');
  });

  it('normalizes amounts and rejects nonsense', () => {
    assert.equal(normalizeConfig({ settleThreshold: '0.5' }).settleThreshold, '0.50');
    assert.throws(() => normalizeConfig({ pricing: { default: 'free' } }), /INVALID_AMOUNT/);
    // Money parsing stays strict: no leading-dot, no sub-cent precision.
    assert.throws(() => normalizeConfig({ settleThreshold: '.5' }), /INVALID_AMOUNT/);
    assert.throws(() => normalizeConfig({ pricing: { default: '0.001' } }), /INVALID_AMOUNT/);
    assert.throws(() => normalizeConfig({ billingCycle: 'weekly' as never }), /INVALID_CONFIG/);
  });

  it('ships sane defaults', () => {
    assert.equal(DEFAULT_CONFIG.pricing.default, '0.01');
    assert.equal(DEFAULT_CONFIG.settleThreshold, '0.50');
  });
});

describe('middleware — metering', () => {
  it('bills each successful call at its configured price', async () => {
    const h = await harness({
      pricing: { default: '0.01', tools: { pricey: '0.02' } },
      billingCycle: 'manual',
      creditLimit: '5.00',
    }, { creditLimit: '5.00' });

    const r1 = await call(h, 'cheap');
    assert.equal(r1.isError, undefined);
    assert.equal(h.ledger.getTab('claude').balance, '0.01');

    await call(h, 'pricey');
    assert.equal(h.ledger.getTab('claude').balance, '0.03');

    const entries = h.ledger.getTab('claude').entries.filter((e) => e.type === 'charge');
    assert.deepEqual(
      entries.map((e) => [e.toolName, e.amount]),
      [
        ['cheap', '0.01'],
        ['pricey', '0.02'],
      ],
    );
    await h.close();
  });

  it('bills tools that were registered before the middleware attached', async () => {
    const h = await harness({ billingCycle: 'manual' }, {
      creditLimit: '5.00',
      registerBeforeAttach: true,
    });
    await call(h, 'early');
    assert.equal(h.ledger.getTab('claude').balance, '0.01');
    await h.close();
  });

  it('lets a $0.00 tool through without touching the tab', async () => {
    const h = await harness({
      pricing: { default: '0.01', tools: { free_tool: '0.00' } },
      billingCycle: 'manual',
    });
    await call(h, 'free_tool');
    assert.equal(h.ledger.getTab('claude').balance, '0.00');
    await h.close();
  });

  it('does not bill a call the tool itself failed', async () => {
    const h = await harness({ billingCycle: 'manual' });
    const r = await call(h, 'broken', {});
    assert.equal(r.isError, true);
    assert.equal(h.ledger.getTab('claude').balance, '0.00');
    await h.close();
  });
});

describe('middleware — 402', () => {
  it('returns a 402-shaped refusal once the credit limit is reached', async () => {
    const h = await harness({ billingCycle: 'manual' }, { creditLimit: '0.05' });
    for (let i = 0; i < 5; i++) await call(h, 'cheap');
    assert.equal(h.ledger.getTab('claude').balance, '0.05');

    const refused = await call(h, 'cheap');
    assert.equal(refused.isError, true);

    const payload = paymentPayload(refused);
    assert.equal(payload?.code, 402);
    assert.equal(payload?.error, 'PAYMENT_REQUIRED');
    assert.equal(payload?.tab.balance, '0.05');
    assert.equal(payload?.tab.creditLimit, '0.05');
    assert.equal(payload?.tab.settleUrl, 'http://127.0.0.1:4788/settle');
    assert.equal(payload?.tab.reason, 'CREDIT_EXCEEDED');

    // The same JSON is in the text content, for clients that only read text.
    const text = (refused.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    assert.deepEqual(JSON.parse(text), payload);

    // A refused call costs nothing.
    assert.equal(h.ledger.getTab('claude').balance, '0.05');
    await h.close();
  });

  it('cuts service off for a delinquent tab', async () => {
    const h = await harness({ billingCycle: 'manual' }, { creditLimit: '5.00' });
    await call(h, 'cheap');
    h.ledger.cutoff('claude', 'overdue');

    const refused = await call(h, 'cheap');
    assert.equal(refused.isError, true);
    assert.equal(paymentPayload(refused)?.tab.reason, 'TAB_DELINQUENT');
    assert.equal(paymentPayload(refused)?.tab.status, 'delinquent');
    assert.equal(h.ledger.getTab('claude').balance, '0.01');

    h.ledger.reopen('claude');
    const ok = await call(h, 'cheap');
    assert.equal(ok.isError, undefined);
    await h.close();
  });
});

describe('middleware — threshold billing', () => {
  it('closes the cycle and invoices when the balance reaches settleThreshold', async () => {
    const h = await harness(
      { pricing: { default: '0.01' }, settleThreshold: '0.10', billingCycle: 'threshold' },
      { creditLimit: '5.00' },
    );

    for (let i = 0; i < 9; i++) await call(h, 'cheap');
    await h.billing.idle();
    assert.equal(h.ledger.listInvoices().length, 0, 'no invoice below the threshold');

    await call(h, 'cheap');
    await h.billing.idle();

    const invoices = h.ledger.listInvoices();
    assert.equal(invoices.length, 1);
    assert.equal(invoices[0]?.amount, '0.10');
    assert.equal(invoices[0]?.status, 'sent');
    assert.match(invoices[0]?.referenceId ?? '', /^tab-claude-\d{4}w\d{2}/);
    assert.equal(h.ledger.getTab('claude').status, 'settling');

    // Further calls past the threshold don't pile up extra invoices.
    await call(h, 'cheap');
    await h.billing.idle();
    assert.equal(h.ledger.listInvoices().length, 1);
    await h.close();
  });

  it('never invoices in manual mode', async () => {
    const h = await harness(
      { pricing: { default: '0.01' }, settleThreshold: '0.02', billingCycle: 'manual' },
      { creditLimit: '5.00' },
    );
    for (let i = 0; i < 5; i++) await call(h, 'cheap');
    await h.billing.idle();
    assert.equal(h.ledger.listInvoices().length, 0);
    assert.equal(h.ledger.getTab('claude').balance, '0.05');
    await h.close();
  });
});
