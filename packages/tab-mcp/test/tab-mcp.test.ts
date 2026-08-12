/**
 * M4 acceptance: telling Tab "add billing, one cent per call" for a bare MCP
 * server produces a correct tab.config.json, through a real MCP client.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { Ledger, StubAdapter, startLedgerServer } from '@tab/core';
import { normalizeConfig, type TabConfig } from '@tab/middleware';

import { createTabMcpServer } from '../src/server.js';
import { tabStatus } from '../src/actions.js';

function text(r: CallToolResult): string {
  return (r.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
}

async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createTabMcpServer();
  const client = new Client({ name: 'claude', version: '0.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** A bare, unbilled MCP server on disk — the M3 server before Tab touches it. */
function bareServerProject(): { dir: string; serverFile: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'tab-mcp-'));
  const serverFile = path.join(dir, 'server.ts');
  writeFileSync(
    serverFile,
    `import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';\n` +
      `const server = new McpServer({ name: 'fx-example', version: '0.1.0' });\n`,
  );
  return { dir, serverFile };
}

describe('M4 — tab-mcp exposes the three configuration tools', () => {
  it('lists add_billing, set_pricing and tab_status', async () => {
    const { client, close } = await connect();
    const tools = await client.listTools();
    assert.deepEqual(
      tools.tools.map((t) => t.name).sort(),
      ['add_billing', 'set_pricing', 'tab_status'],
    );
    await close();
  });
});

describe('M4 acceptance — "add billing, one cent per call"', () => {
  it('generates a correct tab.config.json next to the bare server', async () => {
    const { dir, serverFile } = bareServerProject();
    const { client, close } = await connect();

    const r = (await client.callTool({
      name: 'add_billing',
      arguments: { serverPath: serverFile, defaultPrice: '0.01', billingCycle: 'threshold' },
    })) as CallToolResult;
    assert.notEqual(r.isError, true);

    const configFile = path.join(dir, 'tab.config.json');
    const written = JSON.parse(readFileSync(configFile, 'utf8')) as TabConfig;
    assert.deepEqual(written, {
      pricing: { default: '0.01', tools: {} },
      settleThreshold: '0.50',
      billingCycle: 'threshold',
      creditLimit: '5.00',
    });
    // Whatever we wrote must be loadable by the middleware unchanged.
    assert.deepEqual(normalizeConfig(written), written);

    // The report is what a human reads on the demo recording.
    const body = text(r);
    assert.match(body, /Created .*tab\.config\.json/);
    assert.match(body, /\$0\.01 per call/);
    assert.match(body, /attachBilling\(server, \{ ledger, config \}\)/);
    assert.match(body, /402 PAYMENT_REQUIRED/);

    rmSync(dir, { recursive: true, force: true });
    await close();
  });

  it('accepts a directory, and keeps existing per-tool prices when re-run', async () => {
    const { dir } = bareServerProject();
    const { client, close } = await connect();

    await client.callTool({
      name: 'add_billing',
      arguments: { serverPath: dir, defaultPrice: '0.01' },
    });
    await client.callTool({
      name: 'set_pricing',
      arguments: { toolName: 'fx_convert', price: '0.02', configPath: dir },
    });

    // Re-running add_billing with a new default must not wipe the override.
    const again = (await client.callTool({
      name: 'add_billing',
      arguments: { serverPath: dir, defaultPrice: '0.05', billingCycle: 'manual' },
    })) as CallToolResult;
    assert.match(text(again), /Updated .*tab\.config\.json/);

    const written = JSON.parse(
      readFileSync(path.join(dir, 'tab.config.json'), 'utf8'),
    ) as TabConfig;
    assert.equal(written.pricing.default, '0.05');
    assert.equal(written.pricing.tools?.['fx_convert'], '0.02');
    assert.equal(written.billingCycle, 'manual');

    rmSync(dir, { recursive: true, force: true });
    await close();
  });

  it('rejects a nonsense price instead of writing it', async () => {
    const { dir } = bareServerProject();
    const { client, close } = await connect();
    const r = (await client.callTool({
      name: 'add_billing',
      arguments: { serverPath: dir, defaultPrice: 'one cent' },
    })) as CallToolResult;
    assert.equal(r.isError, true);
    assert.match(text(r), /INVALID_AMOUNT/);
    rmSync(dir, { recursive: true, force: true });
    await close();
  });
});

describe('M4 — set_pricing', () => {
  it('reports the change and the resulting price list', async () => {
    const { dir } = bareServerProject();
    const { client, close } = await connect();
    await client.callTool({ name: 'add_billing', arguments: { serverPath: dir } });

    const first = (await client.callTool({
      name: 'set_pricing',
      arguments: { toolName: 'fx_rate', price: '0.03', configPath: dir },
    })) as CallToolResult;
    assert.match(text(first), /fx_rate: \$0\.03 per call \(was the \$0\.01 default\)/);

    const second = (await client.callTool({
      name: 'set_pricing',
      arguments: { toolName: 'fx_rate', price: '0.04', configPath: dir },
    })) as CallToolResult;
    assert.match(text(second), /fx_rate: \$0\.03 → \$0\.04 per call/);

    rmSync(dir, { recursive: true, force: true });
    await close();
  });
});

describe('M4 — tab_status', () => {
  it('reads a live ledger over the API', async () => {
    const ledger = new Ledger({ adapter: new StubAdapter(), ephemeral: true, defaultCreditLimit: '1.00' });
    const api = await startLedgerServer({ ledger, port: 0 });
    for (let i = 0; i < 7; i++) ledger.charge('claude', 'fx_rate', '0.01');
    await ledger.settle('claude');

    const result = await tabStatus({ buyerId: 'claude', ledgerApi: `http://127.0.0.1:${api.port}` });
    assert.equal(result.source, 'api');
    assert.match(result.report, /Buyer claude — SETTLING/);
    assert.match(result.report, /unbilled balance {3}\$0\.07 of \$1\.00 credit/);
    assert.match(result.report, /billed calls {7}7/);
    assert.match(result.report, /awaiting payout {4}tab-claude-\d{4}w\d{2} · \$0\.07/);
    assert.match(result.report, /allscale invoice send/);

    await api.close();
  });

  it('falls back to the ledger file when the API is down', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tab-status-'));
    const file = path.join(dir, 'ledger.json');
    const ledger = new Ledger({ adapter: new StubAdapter(), file, defaultCreditLimit: '1.00' });
    ledger.charge('claude', 'fx_rate', '0.01');

    const result = await tabStatus({
      buyerId: 'claude',
      // Nothing is listening here.
      ledgerApi: 'http://127.0.0.1:1',
      ledgerFile: file,
    });
    assert.equal(result.source, 'file');
    assert.match(result.report, /unbilled balance {3}\$0\.01/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('says so plainly when there is no ledger at all', async () => {
    const result = await tabStatus({
      ledgerApi: 'http://127.0.0.1:1',
      ledgerFile: path.join(tmpdir(), 'tab-does-not-exist', 'ledger.json'),
    });
    assert.equal(result.source, 'none');
    assert.match(result.report, /No ledger found/);
  });
});
