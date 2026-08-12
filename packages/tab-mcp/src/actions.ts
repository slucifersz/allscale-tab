/**
 * The work behind Tab's own MCP tools.
 *
 * These are plain functions returning human-readable reports: the point of M4
 * is that a developer says "add billing, one cent per call" in their agent and
 * gets a correct tab.config.json plus the three lines they need to paste.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { normalizeAmount, type LedgerSnapshot, type Tab } from '@tab/core';
import {
  CONFIG_FILENAME,
  DEFAULT_CONFIG,
  loadConfig,
  normalizeConfig,
  priceFor,
  writeConfig,
  type TabConfig,
} from '@tab/middleware';

export interface AddBillingParams {
  /** Path to the MCP server file, or to the project that holds it. */
  serverPath: string;
  defaultPrice?: string;
  billingCycle?: 'manual' | 'threshold';
  settleThreshold?: string;
  creditLimit?: string;
}

export interface AddBillingResult {
  configFile: string;
  created: boolean;
  config: TabConfig;
  report: string;
}

/** Where the config for a given server path belongs. */
function configTargetFor(serverPath: string): { dir: string; configFile: string; serverFile?: string } {
  const resolved = path.resolve(serverPath);
  const isDir = existsSync(resolved) && statSync(resolved).isDirectory();
  const dir = isDir ? resolved : path.dirname(resolved);
  return {
    dir,
    configFile: path.join(dir, CONFIG_FILENAME),
    ...(isDir ? {} : { serverFile: resolved }),
  };
}

const SNIPPET = `import { createRuntime, attachBilling } from '@tab/middleware';

const { ledger, config } = createRuntime();          // 1. load tab.config.json + adapter
attachBilling(server, { ledger, config });           // 2. every tool is now paid
await startLedgerServer({ ledger });                 // 3. optional: expose GET /ledger`;

/** Generate (or update) tab.config.json for a server and explain the wiring. */
export function addBilling(p: AddBillingParams): AddBillingResult {
  const { dir, configFile, serverFile } = configTargetFor(p.serverPath);
  const existed = existsSync(configFile);

  // Keep any per-tool prices that are already configured.
  const previous = existed ? loadConfig(configFile).config : undefined;

  const config = normalizeConfig({
    pricing: {
      default: p.defaultPrice ?? previous?.pricing.default ?? DEFAULT_CONFIG.pricing.default,
      tools: previous?.pricing.tools ?? {},
    },
    settleThreshold: p.settleThreshold ?? previous?.settleThreshold ?? DEFAULT_CONFIG.settleThreshold,
    billingCycle: p.billingCycle ?? previous?.billingCycle ?? DEFAULT_CONFIG.billingCycle,
    creditLimit: p.creditLimit ?? previous?.creditLimit ?? DEFAULT_CONFIG.creditLimit,
  });
  writeConfig(configFile, config);

  const cycleLine =
    config.billingCycle === 'threshold'
      ? `invoices automatically once the tab reaches $${config.settleThreshold}`
      : 'invoices only when you ask (POST /settle)';

  const report = [
    `${existed ? 'Updated' : 'Created'} ${configFile}`,
    '',
    '```json',
    JSON.stringify(config, null, 2),
    '```',
    '',
    `Every tool now costs $${config.pricing.default} per call by default.`,
    `Billing cycle: ${config.billingCycle} — ${cycleLine}.`,
    `Credit limit: $${config.creditLimit} — calls past it get a 402 PAYMENT_REQUIRED instead of service.`,
    '',
    serverFile ? `Add these three lines to ${serverFile}:` : 'Add these three lines where you build the MCP server:',
    '',
    '```ts',
    SNIPPET,
    '```',
    '',
    'Then, to watch and settle it:',
    `  npm run ledger:ui       # live ledger page on http://127.0.0.1:${process.env.TAB_UI_PORT ?? 4790}`,
    '  npm run buyer-kit       # buyer side: pays invoices automatically',
    '',
    `Adapter: ${process.env.TAB_ADAPTER ?? 'stub'} (set TAB_ADAPTER=cli to settle through the AllScale CLI).`,
    `Per-tool overrides: use set_pricing, or edit pricing.tools in ${CONFIG_FILENAME}.`,
    `Working directory: ${dir}`,
  ].join('\n');

  return { configFile, created: !existed, config, report };
}

export interface SetPricingParams {
  toolName: string;
  price: string;
  /** Config file to edit. Defaults to ./tab.config.json. */
  configPath?: string;
}

export interface SetPricingResult {
  configFile: string;
  toolName: string;
  price: string;
  previous?: string;
  config: TabConfig;
  report: string;
}

/** Set the price of one tool. */
export function setPricing(p: SetPricingParams): SetPricingResult {
  const target = p.configPath
    ? configTargetFor(p.configPath).configFile
    : path.resolve(process.env.TAB_CONFIG ?? CONFIG_FILENAME);
  const loaded = loadConfig(target);
  const price = normalizeAmount(p.price);
  const previous = loaded.config.pricing.tools?.[p.toolName];

  const config = normalizeConfig({
    ...loaded.config,
    pricing: {
      default: loaded.config.pricing.default,
      tools: { ...loaded.config.pricing.tools, [p.toolName]: price },
    },
  });
  writeConfig(target, config);

  const report = [
    previous
      ? `${p.toolName}: $${previous} → $${price} per call`
      : `${p.toolName}: $${price} per call (was the $${loaded.config.pricing.default} default)`,
    `Saved to ${target}. Restart the server to pick it up.`,
    '',
    'Current prices:',
    ...Object.entries(config.pricing.tools ?? {}).map(([t, v]) => `  ${t.padEnd(16)} $${v}`),
    `  ${'(anything else)'.padEnd(16)} $${config.pricing.default}`,
  ].join('\n');

  return {
    configFile: target,
    toolName: p.toolName,
    price,
    ...(previous === undefined ? {} : { previous }),
    config,
    report,
  };
}

export interface TabStatusParams {
  buyerId?: string;
  /** Ledger API base URL. Falls back to reading the ledger file. */
  ledgerApi?: string;
  ledgerFile?: string;
  fetchImpl?: typeof fetch;
}

export interface TabStatusResult {
  source: 'api' | 'file' | 'none';
  snapshot?: LedgerSnapshot;
  report: string;
}

/** Read the current tab state — live from the API if it is up, else off disk. */
export async function tabStatus(p: TabStatusParams = {}): Promise<TabStatusResult> {
  const api = (p.ledgerApi ?? process.env.TAB_LEDGER_API ?? `http://127.0.0.1:${process.env.TAB_LEDGER_PORT ?? 4788}`).replace(/\/$/, '');
  const file = path.resolve(p.ledgerFile ?? process.env.TAB_LEDGER_FILE ?? '.tab/ledger.json');
  const doFetch = p.fetchImpl ?? fetch;

  let snapshot: LedgerSnapshot | undefined;
  let source: TabStatusResult['source'] = 'none';

  try {
    const res = await doFetch(`${api}/ledger`, { headers: { accept: 'application/json' } });
    if (res.ok) {
      snapshot = (await res.json()) as LedgerSnapshot;
      source = 'api';
    }
  } catch {
    // API not running — fall back to the file the server persists.
  }

  if (!snapshot && existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
        tabs?: Record<string, Tab>;
        invoices?: LedgerSnapshot['invoices'];
        cliLog?: LedgerSnapshot['cliLog'];
      };
      snapshot = {
        version: 1,
        adapter: 'stub',
        tabs: Object.values(parsed.tabs ?? {}),
        invoices: parsed.invoices ?? [],
        cliLog: parsed.cliLog ?? [],
        updatedAt: new Date().toISOString(),
      };
      source = 'file';
    } catch {
      source = 'none';
    }
  }

  if (!snapshot) {
    return {
      source: 'none',
      report: [
        'No ledger found.',
        `Tried the API at ${api}/ledger and the file ${file}.`,
        'Start a billed MCP server first — the server process owns the ledger.',
      ].join('\n'),
    };
  }

  const tabs = p.buyerId ? snapshot.tabs.filter((t) => t.buyerId === p.buyerId) : snapshot.tabs;
  if (tabs.length === 0) {
    return {
      source,
      snapshot,
      report: p.buyerId
        ? `No tab for buyer "${p.buyerId}" yet (read from ${source}).`
        : `No tabs open yet (read from ${source}).`,
    };
  }

  const lines: string[] = [`Ledger read from ${source === 'api' ? api : file} · adapter ${snapshot.adapter}`, ''];
  for (const tab of tabs) {
    const charges = tab.entries.filter((e) => e.type === 'charge');
    const invoices = snapshot.invoices.filter((i) => i.buyerId === tab.buyerId);
    const unpaid = invoices.filter((i) => i.status === 'sent');
    const paid = invoices.filter((i) => i.status === 'paid');
    lines.push(
      `Buyer ${tab.buyerId} — ${tab.status.toUpperCase()}`,
      `  unbilled balance   $${tab.balance} of $${tab.creditLimit} credit`,
      `  billed calls       ${charges.length}`,
      `  cycles settled     ${paid.length}`,
      unpaid[0]
        ? `  awaiting payout    ${unpaid[0].referenceId} · $${unpaid[0].amount}`
        : '  awaiting payout    none',
    );
    const recent = charges.slice(-5).reverse();
    if (recent.length > 0) {
      lines.push('  recent calls:');
      for (const e of recent) {
        lines.push(`    ${e.ts.slice(11, 19)}  ${(e.toolName ?? '').padEnd(12)} $${e.amount}`);
      }
    }
    lines.push('');
  }

  const cli = snapshot.cliLog.slice(-3);
  if (cli.length > 0) {
    lines.push('Last settlement commands:');
    for (const c of cli) lines.push(`  ${c.actor}: ${c.command}`);
  }

  return { source, snapshot, report: lines.join('\n') };
}

/** Prices currently in effect, for display. */
export function pricingTable(config: TabConfig, toolNames: string[] = []): string {
  const rows = new Set([...Object.keys(config.pricing.tools ?? {}), ...toolNames]);
  return [
    ...[...rows].map((t) => `  ${t.padEnd(16)} $${priceFor(config, t)}`),
    `  ${'(anything else)'.padEnd(16)} $${config.pricing.default}`,
  ].join('\n');
}
