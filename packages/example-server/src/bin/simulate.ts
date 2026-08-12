#!/usr/bin/env node
/**
 * Demo consumption driver: acts as the paying agent.
 *
 * It spawns the paid FX server over stdio exactly as an MCP client would, then
 * calls tools on a timer so the ledger page has something to animate. The MCP
 * client name is the buyer id, which is how the middleware identifies the tab.
 *
 * Usage: simulate.js [--calls 60] [--delay 250] [--buyer claude] [--hold]
 *
 * With --hold the MCP session stays open after the last call, which keeps the
 * server process (and with it the ledger API the page polls) alive until Ctrl-C.
 */
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_BIN = path.resolve(HERE, 'server.js');

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  cyan: '\u001b[36m',
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

const CALLS = Number(arg('calls', '60'));
const DELAY = Number(arg('delay', '250'));
const BUYER = arg('buyer', process.env.TAB_BUYER_ID ?? 'claude');

const PAIRS: Array<[string, string]> = [
  ['USD', 'EUR'],
  ['USD', 'JPY'],
  ['EUR', 'GBP'],
  ['USD', 'SGD'],
  ['CNY', 'USD'],
];

function text(r: CallToolResult): string {
  return (r.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
}

const LEDGER_API =
  process.env.TAB_LEDGER_API ?? `http://127.0.0.1:${process.env.TAB_LEDGER_PORT ?? 4788}`;

async function ledgerPost(route: string, body: unknown): Promise<void> {
  const res = await fetch(`${LEDGER_API}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${route} -> ${res.status} ${await res.text()}`);
}

/**
 * Show the enforcement end of the deal.
 *
 * A real delinquency takes a whole billing period to develop, which is too slow
 * to watch, so this cuts the tab off deliberately — the same call the seller
 * would make on an overdue account — and then restores it.
 */
async function demoCutoff(client: Client): Promise<void> {
  console.log(
    `\n${C.bold}── settlement missed: the seller cuts the tab off ──${C.reset} ${C.dim}(POST /cutoff)${C.reset}`,
  );
  await ledgerPost('/cutoff', { buyerId: BUYER, reason: 'demo: overdue' });

  for (let i = 0; i < 2; i++) {
    const r = (await client.callTool({
      name: 'fx_rate',
      arguments: { from: 'USD', to: 'EUR' },
    })) as CallToolResult;
    const p = r._meta?.['tab/payment_required'] as
      | { code: number; error: string; tab: { reason: string; status: string; settleUrl: string } }
      | undefined;
    console.log(
      p
        ? `${C.red}  ${p.code} ${p.error}${C.reset} ${C.dim}${p.tab.reason} · tab ${p.tab.status} · settle at ${p.tab.settleUrl}${C.reset}`
        : `${C.yellow}  unexpectedly served: ${text(r).slice(0, 60)}${C.reset}`,
    );
    await new Promise((res) => setTimeout(res, 400));
  }

  console.log(`\n${C.bold}── tab settled, service restored ──${C.reset} ${C.dim}(POST /reopen)${C.reset}`);
  await ledgerPost('/reopen', { buyerId: BUYER });
  const r = (await client.callTool({
    name: 'fx_rate',
    arguments: { from: 'USD', to: 'EUR' },
  })) as CallToolResult;
  console.log(
    r.isError === true
      ? `${C.red}  still refused: ${text(r).slice(0, 80)}${C.reset}`
      : `${C.green}  served again${C.reset} ${C.dim}${JSON.parse(text(r)).pair} @ ${JSON.parse(text(r)).rate}${C.reset}`,
  );
}

async function main(): Promise<void> {
  // The seller's structured logs are verbose. With TAB_SERVER_LOG set they go to
  // that file, keeping the console readable for a demo recording.
  const serverLog = process.env.TAB_SERVER_LOG;

  const client = new Client({ name: BUYER, version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_BIN],
    // Inherit the environment so TAB_* settings (adapter, ports, ledger file)
    // reach the server process.
    env: process.env as Record<string, string>,
    stderr: serverLog ? 'pipe' : 'inherit',
  });
  await client.connect(transport);

  if (serverLog) {
    mkdirSync(path.dirname(path.resolve(serverLog)), { recursive: true });
    transport.stderr?.pipe(createWriteStream(path.resolve(serverLog), { flags: 'a' }));
  }

  const tools = await client.listTools();
  console.log(
    `${C.cyan}${C.bold}agent "${BUYER}" connected${C.reset} — tools: ${tools.tools
      .map((t) => t.name)
      .join(', ')}`,
  );
  console.log(`${C.dim}making ${CALLS} paid calls, ${DELAY}ms apart…${C.reset}\n`);

  let served = 0;
  let refused = 0;

  for (let i = 1; i <= CALLS; i++) {
    const pair = PAIRS[i % PAIRS.length] as [string, string];
    // Every 5th call uses the pricier convert tool.
    const useConvert = i % 5 === 0;
    const r = (await client.callTool(
      useConvert
        ? { name: 'fx_convert', arguments: { amount: '100.00', from: pair[0], to: pair[1] } }
        : { name: 'fx_rate', arguments: { from: pair[0], to: pair[1] } },
    )) as CallToolResult;

    const label = `${String(i).padStart(3)}/${CALLS}`;
    const payload = r._meta?.['tab/payment_required'] as
      | { tab: { balance: string; creditLimit: string; reason: string; settleUrl: string } }
      | undefined;

    if (payload) {
      refused += 1;
      console.log(
        `${C.red}${label} 402 PAYMENT_REQUIRED${C.reset} ${C.dim}${payload.tab.reason} · balance $${payload.tab.balance} of $${payload.tab.creditLimit} · settle at ${payload.tab.settleUrl}${C.reset}`,
      );
    } else if (r.isError === true) {
      console.log(`${C.yellow}${label} tool error${C.reset} ${C.dim}${text(r).slice(0, 80)}${C.reset}`);
    } else {
      served += 1;
      const body = JSON.parse(text(r)) as { pair: string; rate: string; result?: string };
      const tool = useConvert ? 'fx_convert $0.02' : 'fx_rate   $0.01';
      const detail = body.result ? `100.00 ${body.pair} → ${body.result}` : `${body.pair} @ ${body.rate}`;
      console.log(`${C.green}${label} ok${C.reset} ${C.dim}${tool}${C.reset}  ${detail}`);
    }

    if (i < CALLS && DELAY > 0) await new Promise((res) => setTimeout(res, DELAY));
  }

  console.log(
    `\n${C.bold}done${C.reset} — ${C.green}${served} served${C.reset}, ${C.red}${refused} refused with 402${C.reset}`,
  );

  if (process.argv.includes('--demo-cutoff')) await demoCutoff(client);

  if (process.argv.includes('--hold')) {
    console.log(
      `${C.dim}holding the MCP session open so the ledger API stays up — press ctrl-c to stop${C.reset}`,
    );
    await new Promise<void>((resolve) => {
      process.on('SIGINT', () => resolve());
      process.on('SIGTERM', () => resolve());
    });
  }
  await client.close();
}

void main().catch((e: unknown) => {
  console.error(`${C.red}simulate failed:${C.reset}`, (e as Error).message);
  process.exit(1);
});
