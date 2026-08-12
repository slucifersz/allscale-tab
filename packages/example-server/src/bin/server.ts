#!/usr/bin/env node
/**
 * Paid FX MCP server over stdio.
 *
 * This process owns the ledger — it is the only writer. The ledger UI and the
 * buyer kit read it over the HTTP API started here.
 *
 * stdout belongs to the MCP protocol, so structured logs go to stderr.
 */
process.env.TAB_LOG_STREAM = 'stderr';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createLogger, startLedgerServer } from '@tab/core';
import { createRuntime } from '@tab/middleware';

import { createExampleServer } from '../server.js';

const log = createLogger('example-server');

async function main(): Promise<void> {
  const runtime = createRuntime();
  const { server, billing } = createExampleServer({
    ledger: runtime.ledger,
    config: runtime.config,
  });

  // TAB_LEDGER_PORT=off runs the MCP server without the HTTP read API.
  const portSetting = process.env.TAB_LEDGER_PORT ?? '4788';
  let ledgerUrl: string | undefined;
  if (portSetting !== 'off' && portSetting !== '0') {
    const api = await startLedgerServer({ ledger: runtime.ledger, port: Number(portSetting) });
    ledgerUrl = `http://127.0.0.1:${api.port}`;
    const shutdown = (): void => {
      void api.close().then(() => process.exit(0));
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  await server.connect(new StdioServerTransport());

  log.log('ready', {
    transport: 'stdio',
    tools: ['fx_rate', 'fx_convert'],
    pricing: billing.config.pricing,
    billingCycle: billing.config.billingCycle,
    settleThreshold: billing.config.settleThreshold,
    adapter: runtime.adapter.kind,
    configFile: runtime.configFile,
    configFound: runtime.configFound,
    ...(ledgerUrl === undefined ? {} : { ledgerApi: ledgerUrl }),
  });
}

void main().catch((e: unknown) => {
  log.log('fatal', { error: (e as Error).message, stack: (e as Error).stack });
  process.exit(1);
});
