/**
 * Adapter selection. `TAB_ADAPTER=stub|cli` decides which implementation the
 * whole system runs on; stub is the default (the design brief §5).
 */
import type { AdapterOptions, SettlementAdapter } from './adapter.js';
import { CliAdapter, type CliAdapterOptions } from './cli-adapter.js';
import { createLogger } from './log.js';
import { StubAdapter, type StubAdapterOptions } from './stub-adapter.js';

const log = createLogger('factory');

export type AdapterKind = 'stub' | 'cli';

/** Resolve the configured adapter kind. `ADAPTER` is accepted as an alias. */
export function resolveAdapterKind(explicit?: string): AdapterKind {
  const raw = (explicit ?? process.env.TAB_ADAPTER ?? process.env.ADAPTER ?? 'stub')
    .trim()
    .toLowerCase();
  if (raw === 'cli') return 'cli';
  if (raw === 'stub' || raw === '') return 'stub';
  throw new Error(`INVALID_ADAPTER: "${raw}" — expected "stub" or "cli"`);
}

export interface CreateAdapterOptions extends AdapterOptions {
  kind?: string;
  stub?: StubAdapterOptions;
  cli?: CliAdapterOptions;
}

export function createAdapter(opts: CreateAdapterOptions = {}): SettlementAdapter {
  const kind = resolveAdapterKind(opts.kind);
  log.log('adapter_selected', { kind });
  const shared: AdapterOptions = opts.onCliEcho ? { onCliEcho: opts.onCliEcho } : {};
  return kind === 'cli'
    ? new CliAdapter({ ...shared, ...opts.cli })
    : new StubAdapter({ ...shared, ...opts.stub });
}
