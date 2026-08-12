#!/usr/bin/env node
/**
 * Exercise every SettlementAdapter method against the real CLI and report what
 * is live-verified vs. blocked, side by side with the stub.
 *
 *   node scripts/cli-probe.mjs            read-only live calls + argv dry-runs
 *   node scripts/cli-probe.mjs --write    ALSO send a real invoice (see below)
 *
 * Read-only calls (`payout status`, `transaction list`) run for real. The write
 * paths are only argv-checked by default, because they have side effects a
 * script must not take on its own:
 *
 *   - `invoice send` emails an invoice and can auto-create a contact
 *   - `payout send` moves sandbox funds and needs STORE credentials
 *
 * Pass --write --to <email> to actually send an invoice to an address you own.
 */
import {
  CliAdapter,
  StubAdapter,
  invoiceSendArgv,
  payoutSendArgv,
  claimArgv,
  payoutStatusArgv,
  transactionListArgv,
  renderCommand,
  chainIdForSlug,
} from '@tab/core';

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
  cyan: '\u001b[36m',
};

const argv = process.argv.slice(2);
const WRITE = argv.includes('--write');
const CHAIN = process.env.TAB_CHAIN ?? 'sepolia';
const COIN = process.env.TAB_STABLE_COIN ?? 'USDT';

/**
 * Read a flag's value, refusing to swallow the next flag as if it were a value.
 * `--write --to` used to hand `undefined` (or worse, `--to`) downstream.
 */
function flagValue(name) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) {
    fail(`--${name} needs a value (got ${v === undefined ? 'nothing' : `the flag ${v}`})`);
  }
  return v;
}

function fail(message) {
  process.stderr.write(`\u001b[31mrefusing to run:\u001b[0m ${message}\n`);
  process.exit(2);
}

/** Deliberately strict: one @, a dotted domain, no spaces or angle brackets. */
const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;.]+(\.[^\s@<>",;.]+)+$/;

const TO = flagValue('to');

// --write sends a real invoice by email. Validate the destination BEFORE any
// side effect, and never fall back to a placeholder address.
if (WRITE) {
  if (TO === undefined) {
    fail('--write needs --to <email>; refusing to email an invoice to a placeholder address');
  }
  if (!EMAIL_RE.test(TO)) {
    fail(`--to "${TO}" is not a valid email address`);
  }
}

const rows = [];
function record(method, mode, verdict, detail) {
  rows.push({ method, mode, verdict, detail });
  const colour =
    verdict === 'live-ok' ? C.green : verdict === 'blocked' ? C.yellow : verdict === 'argv-only' ? C.cyan : C.red;
  console.log(
    `  ${colour}${verdict.padEnd(9)}${C.reset} ${method.padEnd(18)} ${C.dim}${detail}${C.reset}`,
  );
}

const cli = new CliAdapter({ chain: CHAIN, stableCoin: COIN });
const stub = new StubAdapter({ chain: CHAIN, stableCoin: COIN });

const REFERENCE_ID = `tab-probe-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;

console.log(`${C.bold}Tab · CliAdapter probe${C.reset} ${C.dim}chain=${CHAIN} coin=${COIN}${C.reset}\n`);

// ---------------------------------------------------------------------------
console.log(`${C.bold}fenceStatus — allscale payout status${C.reset}`);
let fence;
try {
  fence = await cli.fenceStatus();
  record(
    'fenceStatus',
    'cli',
    'live-ok',
    `provisioned=${fence.provisioned} active=${fence.active} remaining=${fence.remaining} ` +
      `perTx=${fence.singleTxCap} expires=${fence.expires} pairs=${fence.authorizedPairs.length}`,
  );
  const want = chainIdForSlug(CHAIN);
  const authorized = fence.authorizedPairs.some(
    (p) => p.chain === want && p.tokenSymbol.toUpperCase() === COIN,
  );
  record(
    'authorization',
    'cli',
    authorized ? 'live-ok' : 'blocked',
    `${CHAIN}(id ${want}) × ${COIN} ${authorized ? 'is delegated' : 'is NOT delegated'} · ` +
      `pairs: ${fence.authorizedPairs.map((p) => `${p.chain}/${p.tokenSymbol}`).join(' ')}`,
  );
} catch (e) {
  record('fenceStatus', 'cli', 'error', `${e.code ?? ''} ${e.message}`.trim());
}
const stubFence = await stub.fenceStatus();
record(
  'fenceStatus',
  'stub',
  'live-ok',
  `provisioned=${stubFence.provisioned} remaining=${stubFence.remaining} pairs=${stubFence.authorizedPairs.length}`,
);

// ---------------------------------------------------------------------------
console.log(`\n${C.bold}listTransactions — allscale transaction list${C.reset}`);
try {
  const txs = await cli.listTransactions();
  const withAmount = txs.filter((t) => t.amount !== undefined).length;
  record('listTransactions', 'cli', 'live-ok', `${txs.length} rows, ${withAmount} with amount_coins`);
} catch (e) {
  record('listTransactions', 'cli', 'error', `${e.code ?? ''} ${e.message}`.trim());
}
record('listTransactions', 'stub', 'live-ok', `${(await stub.listTransactions()).length} rows`);

// ---------------------------------------------------------------------------
console.log(`\n${C.bold}enableFence — dashboard + payout status${C.reset}`);
const fenceParams = {
  storeId: process.env.TAB_STORE_ID ?? '',
  chain: CHAIN,
  coin: COIN,
  singleTxCap: fence?.singleTxCap ?? '200',
  totalCap: fence?.totalCap ?? '20000',
  expires: fence?.expires ?? '',
};
try {
  const confirmed = await cli.enableFence(fenceParams);
  record('enableFence', 'cli', 'live-ok', `confirmed via payout status · remaining=${confirmed.remaining}`);
} catch (e) {
  record('enableFence', 'cli', e.code === 'FENCE_NOT_AUTHORIZED' ? 'blocked' : 'error', `${e.code ?? ''} ${e.message}`.trim());
}

// ---------------------------------------------------------------------------
console.log(`\n${C.bold}sendInvoice — allscale invoice send${C.reset}`);
const invoiceParams = {
  toEmail: TO ?? 'buyer@example.com',
  amount: '0.50',
  walletIds: process.env.TAB_SELLER_WALLET_ID ? [process.env.TAB_SELLER_WALLET_ID] : [],
  stableCoin: COIN,
  lines: [{ desc: 'fx_rate', qty: 50, unitPrice: '0.01' }],
  memo: REFERENCE_ID,
};
console.log(`  ${C.dim}${renderCommand(invoiceSendArgv(invoiceParams))}${C.reset}`);
if (WRITE) {
  try {
    const inv = await cli.sendInvoice(invoiceParams);
    record('sendInvoice', 'cli', 'live-ok', `payment_id=${inv.id} amount=${inv.amount}`);
  } catch (e) {
    record('sendInvoice', 'cli', 'error', `${e.code ?? ''} ${e.message}`.trim());
  }
} else {
  record(
    'sendInvoice',
    'cli',
    'argv-only',
    'not sent: it emails an invoice / can auto-create a contact. Re-run with --write --to <your email>',
  );
}
const stubInvoice = await stub.sendInvoice(invoiceParams);
record('sendInvoice', 'stub', 'live-ok', `id=${stubInvoice.id} amount=${stubInvoice.amount}`);

// ---------------------------------------------------------------------------
console.log(`\n${C.bold}sendPayout — allscale payout send${C.reset}`);
const payoutParams = {
  amount: '0.50',
  chain: CHAIN,
  stableCoin: COIN,
  referenceId: REFERENCE_ID,
  receiverEmail: process.env.TAB_SELLER_EMAIL ?? '',
};
console.log(`  ${C.dim}${renderCommand(payoutSendArgv(payoutParams))}${C.reset}`);
const haveStoreKeys = Boolean(
  process.env.ALLSCALE_STORE_API_KEY && process.env.ALLSCALE_STORE_API_SECRET,
);
if (WRITE && haveStoreKeys) {
  try {
    const payout = await cli.sendPayout(payoutParams);
    record(
      'sendPayout',
      'cli',
      'live-ok',
      `claim_link_id=${payout.claimLinkId} status=${payout.backendStatus} idempotent=${payout.idempotentHit}`,
    );
    if (payout.claimToken) {
      try {
        // Funding is asynchronous: claimPayout polls `claim-link status` until
        // is_claimable, then claims. Without that wait the backend refuses with
        // pending_deposit (exit 12).
        const pre = await cli.claimLinkStatus({ claimToken: payout.claimToken });
        console.log(
          `  ${C.dim}claim-link status: ${pre.status} · is_claimable=${pre.isClaimable} · expires ${pre.expiresAt}${C.reset}`,
        );
        const claim = await cli.claimPayout({
          claimToken: payout.claimToken,
          referenceId: REFERENCE_ID,
        });
        record(
          'claimPayout',
          'cli',
          'live-ok',
          `outcome=${claim.outcome ?? 'claimed'} tx=${claim.claimTxHash ?? '—'} → ${claim.destination}`,
        );
      } catch (e) {
        // CLAIM_NOT_READY means the deposit is still confirming and the link is
        // intact — retryable, so report it as blocked rather than an error.
        const retryable = e.code === 'CLAIM_NOT_READY';
        record(
          'claimPayout',
          'cli',
          retryable ? 'blocked' : 'error',
          `${e.code ?? ''} ${e.message}`.trim(),
        );
        if (payout.claimLinkId) {
          console.log(
            `  ${C.dim}recover later with: allscale claim-link get ${payout.claimLinkId} --select 'claim_url' --json${C.reset}`,
          );
        }
      }
    } else {
      record('claimPayout', 'cli', 'blocked', 'no claim token returned (funding still in flight)');
    }
  } catch (e) {
    record('sendPayout', 'cli', 'error', `${e.code ?? ''} ${e.message}`.trim());
  }
} else {
  record(
    'sendPayout',
    'cli',
    'blocked',
    haveStoreKeys
      ? 'store keys present — re-run with --write to fund a real claim link'
      : 'ALLSCALE_STORE_API_KEY / ALLSCALE_STORE_API_SECRET not set (payout send uses the STORE key, not your login)',
  );
  record('claimPayout', 'cli', 'blocked', 'depends on a claim token from payout send');
}
const stubPayout = await stub.sendPayout(payoutParams);
record('sendPayout', 'stub', 'live-ok', `claim_link_id=${stubPayout.claimLinkId} status=${stubPayout.backendStatus}`);
const stubClaim = await stub.claimPayout({ claimToken: stubPayout.claimToken, referenceId: REFERENCE_ID });
record('claimPayout', 'stub', 'live-ok', `claimed to ${stubClaim.destination}`);

// ---------------------------------------------------------------------------
console.log(`\n${C.bold}argv the CliAdapter would run${C.reset}`);
for (const [label, list] of [
  ['payout status', payoutStatusArgv()],
  ['transaction list', transactionListArgv()],
  ['payout send', payoutSendArgv(payoutParams)],
  ['claim-link claim', claimArgv({ claimToken: '<token>' })],
  ['invoice send', invoiceSendArgv(invoiceParams)],
]) {
  console.log(`  ${C.dim}${label.padEnd(17)}${C.reset} ${renderCommand(list)}`);
}

// ---------------------------------------------------------------------------
const live = rows.filter((r) => r.mode === 'cli' && r.verdict === 'live-ok').length;
const blocked = rows.filter((r) => r.mode === 'cli' && r.verdict === 'blocked').length;
const errored = rows.filter((r) => r.mode === 'cli' && r.verdict === 'error').length;
const argvOnly = rows.filter((r) => r.mode === 'cli' && r.verdict === 'argv-only').length;
console.log(
  `\n${C.bold}cli:${C.reset} ${C.green}${live} live-ok${C.reset} · ` +
    `${C.cyan}${argvOnly} argv-only${C.reset} · ${C.yellow}${blocked} blocked${C.reset} · ` +
    `${errored > 0 ? C.red : C.dim}${errored} error${C.reset}`,
);
process.exit(errored > 0 ? 1 : 0);
