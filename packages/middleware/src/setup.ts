/**
 * One-call wiring for a seller: config + adapter + ledger.
 *
 * Every process that owns a ledger starts here, so the adapter's CLI echo
 * always lands in the ledger the UI is reading.
 */
import { Ledger, createAdapter, createLogger, type SettlementAdapter } from '@tab/core';

import { loadConfig, type TabConfig } from './config.js';

export interface RuntimeOptions {
  /** Path to tab.config.json. Defaults to $TAB_CONFIG or ./tab.config.json. */
  configFile?: string;
  /** Ledger persistence path. Defaults to $TAB_LEDGER_FILE or .tab/ledger.json. */
  ledgerFile?: string;
  /** Don't touch disk (tests). */
  ephemeral?: boolean;
  config?: TabConfig;
}

export interface Runtime {
  config: TabConfig;
  configFile: string;
  configFound: boolean;
  adapter: SettlementAdapter;
  ledger: Ledger;
}

export function createRuntime(opts: RuntimeOptions = {}): Runtime {
  const log = createLogger('middleware.setup');
  const loaded = loadConfig(opts.configFile);
  const config = opts.config ?? loaded.config;

  // The Ledger binds the adapter's CLI echo to its own log on construction.
  const adapter = createAdapter();

  const ledger = new Ledger({
    adapter,
    ...(opts.ledgerFile === undefined ? {} : { file: opts.ledgerFile }),
    ...(opts.ephemeral === undefined ? {} : { ephemeral: opts.ephemeral }),
    ...(config.creditLimit === undefined ? {} : { defaultCreditLimit: config.creditLimit }),
  });
  log.log('runtime_ready', {
    adapter: adapter.kind,
    configFile: loaded.file,
    configFound: loaded.found,
    billingCycle: config.billingCycle,
    settleThreshold: config.settleThreshold,
    creditLimit: config.creditLimit,
  });

  return {
    config,
    configFile: loaded.file,
    configFound: loaded.found,
    adapter,
    ledger,
  };
}
