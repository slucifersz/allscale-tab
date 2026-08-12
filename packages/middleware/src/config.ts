/**
 * `tab.config.json` — everything a seller has to decide to start charging.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { normalizeAmount } from '@tab/core';

export interface TabPricing {
  /** Charged for any tool without an explicit price. */
  default: string;
  /** Per-tool overrides. `"0.00"` makes a tool free. */
  tools?: Record<string, string>;
}

export interface TabConfig {
  pricing: TabPricing;
  /** Balance at which a `threshold` cycle closes and invoices. */
  settleThreshold: string;
  /**
   * `threshold` — invoice automatically once settleThreshold is reached.
   * `manual` — only invoice when someone asks (POST /settle).
   */
  billingCycle: 'manual' | 'threshold';
  /** Credit a new buyer gets. Charges past this are refused with a 402. */
  creditLimit?: string;
}

export const DEFAULT_CONFIG: TabConfig = {
  pricing: { default: '0.01', tools: {} },
  settleThreshold: '0.50',
  billingCycle: 'threshold',
  creditLimit: '5.00',
};

export const CONFIG_FILENAME = 'tab.config.json';

/** Validate and fill in a config object. Throws on malformed money. */
export function normalizeConfig(input: unknown): TabConfig {
  const raw = (input ?? {}) as Partial<TabConfig>;
  const cycle = raw.billingCycle ?? DEFAULT_CONFIG.billingCycle;
  if (cycle !== 'manual' && cycle !== 'threshold') {
    throw new Error(`INVALID_CONFIG: billingCycle must be "manual" or "threshold", got "${cycle}"`);
  }
  const tools: Record<string, string> = {};
  for (const [tool, price] of Object.entries(raw.pricing?.tools ?? {})) {
    tools[tool] = normalizeAmount(price);
  }
  return {
    pricing: {
      default: normalizeAmount(raw.pricing?.default ?? DEFAULT_CONFIG.pricing.default),
      tools,
    },
    settleThreshold: normalizeAmount(raw.settleThreshold ?? DEFAULT_CONFIG.settleThreshold),
    billingCycle: cycle,
    creditLimit: normalizeAmount(raw.creditLimit ?? DEFAULT_CONFIG.creditLimit ?? '5.00'),
  };
}

/** Load `tab.config.json`, falling back to defaults when it is absent. */
export function loadConfig(file?: string): { config: TabConfig; file: string; found: boolean } {
  const target = path.resolve(file ?? process.env.TAB_CONFIG ?? CONFIG_FILENAME);
  if (!existsSync(target)) {
    return { config: normalizeConfig(DEFAULT_CONFIG), file: target, found: false };
  }
  const parsed = JSON.parse(readFileSync(target, 'utf8')) as unknown;
  return { config: normalizeConfig(parsed), file: target, found: true };
}

export function writeConfig(file: string, config: TabConfig): void {
  writeFileSync(path.resolve(file), JSON.stringify(normalizeConfig(config), null, 2) + '\n', 'utf8');
}

/** Price for a tool: explicit override, else the default. */
export function priceFor(config: TabConfig, toolName: string): string {
  return config.pricing.tools?.[toolName] ?? config.pricing.default;
}
