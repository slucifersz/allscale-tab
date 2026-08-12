#!/usr/bin/env node
/**
 * Buyer daemon: watches the seller's ledger and settles invoices automatically.
 *
 * Environment:
 *   TAB_ADAPTER            stub | cli            (default stub)
 *   TAB_LEDGER_API         seller ledger API     (default http://127.0.0.1:4788)
 *   TAB_BUYER_ID           only settle this buyer's invoices
 *   TAB_MAX_AUTO_PAY       buyer-side ceiling per invoice (default 5.00)
 *   TAB_POLL_INTERVAL_MS   poll interval         (default 1000)
 *   TAB_FENCE_*            fence caps for `payout enable`
 */
import {
  createAdapter,
  createLogger,
  echoPayoutEnable,
  isTabError,
  type EnableFenceParams,
} from '@tab/core';

import { BuyerKit } from '../buyer-kit.js';

const log = createLogger('buyer-kit');

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
};

const LEDGER_API = process.env.TAB_LEDGER_API ?? `http://127.0.0.1:${process.env.TAB_LEDGER_PORT ?? 4788}`;

const fenceParams: EnableFenceParams = {
  storeId: process.env.TAB_STORE_ID ?? 'stub_store_001',
  chain: process.env.TAB_CHAIN ?? 'base',
  coin: process.env.TAB_COIN ?? 'usdc',
  singleTxCap: process.env.TAB_FENCE_SINGLE_TX ?? '2.00',
  totalCap: process.env.TAB_FENCE_TOTAL_CAP ?? '20.00',
  expires: process.env.TAB_FENCE_EXPIRES ?? '2026-12-31',
};

async function main(): Promise<void> {
  const adapter = createAdapter();

  console.log(`${C.bold}Tab buyer kit${C.reset} ${C.dim}adapter=${adapter.kind} ledger=${LEDGER_API}${C.reset}`);
  console.log(`${C.dim}spending fence:${C.reset}`);
  console.log(`${C.bold}${C.green}→ ${echoPayoutEnable(fenceParams)}${C.reset}`);

  try {
    const fence = await adapter.enableFence(fenceParams);
    console.log(
      `${C.dim}  fence active · single-tx cap $${fence.singleTxCap} · remaining $${fence.remaining} of $${fence.totalCap} · expires ${fence.expires}${C.reset}`,
    );
  } catch (e) {
    // `payout enable` needs an interactive browser passkey, so with the real
    // CLI a human runs the command above. We then poll `payout status`.
    if (isTabError(e) && (e.code === 'CLI_NOT_AVAILABLE' || e.code === 'FENCE_NOT_ENABLED')) {
      console.log(
        `${C.yellow}  run the command above yourself (it needs a browser passkey), then this kit will pick up the fence via \`allscale payout status\`${C.reset}`,
      );
    } else {
      throw e;
    }
  }

  const kit = new BuyerKit({
    adapter,
    ledgerApi: LEDGER_API,
    ...(process.env.TAB_BUYER_ID ? { buyerId: process.env.TAB_BUYER_ID } : {}),
  });

  console.log(`${C.dim}waiting for the seller's ledger API…${C.reset}`);
  const up = await kit.waitForLedger();
  if (!up) {
    console.log(`${C.yellow}ledger API never answered at ${LEDGER_API} — still polling${C.reset}`);
  } else {
    console.log(`${C.dim}connected · watching for invoices${C.reset}\n`);
  }

  kit.start();
  log.log('started', { ledgerApi: LEDGER_API, adapter: adapter.kind });

  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      kit.stop();
      process.exit(0);
    });
  }
}

void main().catch((e: unknown) => {
  log.log('fatal', { error: (e as Error).message });
  process.exit(1);
});
