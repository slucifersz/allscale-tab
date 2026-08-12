/**
 * The equivalent real `allscale` command for an adapter action.
 *
 * This module is the single source of truth for flag names and ordering: the
 * CliAdapter builds its argv from the same helpers that render these strings,
 * so what the demo prints is what actually runs (modulo redacted secrets).
 *
 * Every flag here was read off the CLI's own `--help`; see docs/DIFF.md.
 */
import type { EnableFenceParams, SendInvoiceParams, SendPayoutParams } from './adapter.js';
import { normalizeChain, normalizeStableCoin, paymentTypeForCoin } from './chains.js';
import { multiplyAmount } from './money.js';
import type { InvoiceLine } from './types.js';

function quote(v: string): string {
  return /[\s"|]/.test(v) ? `"${v.replace(/"/g, '\\"')}"` : v;
}

/** Render an argv array as a copy-pasteable command line. */
export function renderCommand(argv: string[]): string {
  return ['allscale', ...argv.map(quote)].join(' ');
}

// ---------------------------------------------------------------------------
// payout status
// ---------------------------------------------------------------------------

export function payoutStatusArgv(): string[] {
  return ['payout', 'status', '--json'];
}

export function echoPayoutStatus(): string {
  return renderCommand(payoutStatusArgv());
}

// ---------------------------------------------------------------------------
// payout send
//
// NOTE: there is no --expires here. `claim-link create` has one (default 14d);
// `payout send` does not, so the claim window is whatever the payout API
// assigns — observed ~21 minutes. See docs/DIFF.md item D3.
// ---------------------------------------------------------------------------

export function payoutSendArgv(p: SendPayoutParams): string[] {
  const argv = [
    'payout',
    'send',
    '--amount',
    p.amount,
    '--chain',
    normalizeChain(p.chain),
    '--stable-coin',
    normalizeStableCoin(p.stableCoin),
    '--reference-id',
    p.referenceId,
  ];
  if (p.receiverEmail) argv.push('--receiver-email', p.receiverEmail);
  argv.push('--json');
  return argv;
}

export function echoPayoutSend(p: SendPayoutParams): string {
  return renderCommand(payoutSendArgv(p));
}

// ---------------------------------------------------------------------------
// claim-link claim — the step that actually delivers the money
// ---------------------------------------------------------------------------

export interface ClaimArgvParams {
  /** Bearer claim token from `payout send`. SECRET. */
  claimToken?: string;
  /** Canonical claim URL — also SECRET, it embeds the token. */
  claimUrl?: string;
  /** Receiver EVM address (Path-A), or omit to claim into the AllScale wallet. */
  toAddress?: string;
}

/** `--claim-token` and `--claim-url` are the two accepted sources; exactly one. */
function claimSource(p: ClaimArgvParams): string[] {
  if (p.claimToken) return ['--claim-token', p.claimToken];
  if (p.claimUrl) return ['--claim-url', p.claimUrl];
  throw new Error('CLAIM_SOURCE_MISSING: pass a claimToken or a claimUrl');
}

export function claimArgv(p: ClaimArgvParams): string[] {
  const argv = ['claim-link', 'claim', ...claimSource(p)];
  if (p.toAddress) argv.push('--to', p.toAddress);
  else argv.push('--to-wallet');
  argv.push('--json');
  return argv;
}

/**
 * `claim-link status` — the receiver-facing snapshot used to wait for the
 * deposit to confirm before claiming.
 */
export function claimLinkStatusArgv(p: ClaimArgvParams): string[] {
  return ['claim-link', 'status', ...claimSource(p), '--json'];
}

export function echoClaimStatus(p: ClaimArgvParams): string {
  return renderCommand(
    claimLinkStatusArgv(
      p.claimToken ? { claimToken: '***' } : { claimUrl: '***' },
    ),
  );
}

/** `claim-link get <id> --select 'claim_url'` — owner-side credential recovery. */
export function claimUrlRecoveryArgv(claimLinkId: string): string[] {
  return ['claim-link', 'get', claimLinkId, '--select', 'id status claim_url', '--json'];
}

/**
 * Echo for the claim step with the bearer token REDACTED — it is a secret that
 * would otherwise land in the ledger, the UI and the demo recording.
 */
export function echoClaim(p: ClaimArgvParams): string {
  return renderCommand(
    claimArgv({
      ...p,
      ...(p.claimToken ? { claimToken: '***' } : {}),
      ...(p.claimUrl ? { claimUrl: '***' } : {}),
    }),
  );
}

// ---------------------------------------------------------------------------
// invoice send
//
// NOTE the --line semantics: "<description>|<quantity>|<amount>" where amount is
// the LINE TOTAL, not a unit price. With three-field lines the CLI sums them to
// derive the invoice total. See docs/DIFF.md item D4.
// ---------------------------------------------------------------------------

/** `desc|qty|lineTotal` — qty × unitPrice, not the unit price. */
export function renderInvoiceLine(line: InvoiceLine): string {
  return `${line.desc}|${line.qty}|${multiplyAmount(line.unitPrice, line.qty)}`;
}

export function invoiceSendArgv(p: SendInvoiceParams): string[] {
  const argv = ['invoice', 'send', '--to-email', p.toEmail, '--amount', p.amount];
  for (const line of p.lines) argv.push('--line', renderInvoiceLine(line));
  for (const walletId of p.walletIds) argv.push('--wallet-id', walletId);
  argv.push('--payment-type', String(paymentTypeForCoin(p.stableCoin)));
  if (p.memo) argv.push('--memo', p.memo);
  if (p.due) argv.push('--due', p.due);
  if (p.autoCreateContact !== false) argv.push('--auto-create-contact');
  argv.push('--json');
  return argv;
}

export function echoInvoiceSend(p: SendInvoiceParams): string {
  return renderCommand(invoiceSendArgv(p));
}

// ---------------------------------------------------------------------------
// transaction list
// ---------------------------------------------------------------------------

export function transactionListArgv(): string[] {
  return ['transaction', 'list', '--json'];
}

export function echoTransactionList(): string {
  return renderCommand(transactionListArgv());
}

// ---------------------------------------------------------------------------
// The fence is NOT a CLI command
// ---------------------------------------------------------------------------

/**
 * `payout enable` does not exist. Auto-payout authorization is granted in the
 * AllScale dashboard (Store Settings → Payout Authorization); the CLI can only
 * inspect the resulting session. This renders the human instruction plus the
 * read-only command Tab polls to confirm it took effect.
 */
export function echoPayoutEnable(p: EnableFenceParams): string {
  return [
    '# Auto-payout authorization is not a CLI action — grant it in the dashboard:',
    '#   app.allscale.io → Store Settings → Payout Authorization',
    `#   store ${p.storeId || '<your store>'} · chain ${p.chain} · coin ${p.coin}` +
      ` · per-tx ${p.singleTxCap} · total ${p.totalCap}` +
      (p.expires ? ` · until ${p.expires}` : ''),
    '# then confirm it with:',
    echoPayoutStatus(),
  ].join('\n');
}
