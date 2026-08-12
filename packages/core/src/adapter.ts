import type {
  ClaimLinkStatus,
  ClaimResult,
  FenceStatus,
  InvoiceLine,
  PayoutResult,
  InvoiceResult,
  Transaction,
} from './types.js';

/**
 * The single exit for every money movement in Tab.
 *
 * Nothing else in the codebase may talk to AllScale. Swap the implementation
 * (stub for local dev, CLI for real settlement) and the rest of the system is
 * unchanged.
 */
export interface SettlementAdapter {
  /** Which implementation this is — surfaced in logs and the ledger UI. */
  readonly kind: 'stub' | 'cli';

  /**
   * Buyer side: confirm the spending fence is in force.
   *
   * There is NO `payout enable` command — authorization is granted in the
   * AllScale dashboard (Store Settings → Payout Authorization). So the real
   * implementation prints the human instruction and then verifies via
   * `payout status`; it never claims to have created a fence itself.
   */
  enableFence(p: EnableFenceParams): Promise<FenceStatus>;

  /**
   * Buyer side: fund a settlement.
   * Real implementation: `allscale payout send` (store-key HMAC auth, idempotent
   * on `--reference-id`).
   *
   * This does NOT complete the payment: it creates and funds a Claim Link that
   * the receiver must claim, and the link expires within minutes. Always follow
   * it with `claimPayout` — see buyer-kit for the serialised pairing.
   */
  sendPayout(p: SendPayoutParams): Promise<PayoutResult>;

  /**
   * Buyer side: deliver the funded payout to the receiver.
   * Real implementation: `allscale claim-link claim`.
   *
   * Separate from sendPayout because reality is two steps, not the one the
   * original design assumed (the design brief §4). Only an on-chain-proven claim
   * counts as delivered.
   */
  claimPayout(p: ClaimPayoutParams): Promise<ClaimResult>;

  /** Seller side: issue an invoice. Real implementation: `allscale invoice send`. */
  sendInvoice(p: SendInvoiceParams): Promise<InvoiceResult>;

  /** Remaining fence allowance. Real implementation: `allscale payout status`. */
  fenceStatus(): Promise<FenceStatus>;

  /** Real implementation: `allscale transaction list`. */
  listTransactions(): Promise<Transaction[]>;

  /**
   * Optional: the receiver-facing snapshot of a claim link
   * (`allscale claim-link status`). Used to wait for an asynchronous deposit to
   * confirm before claiming, and for reconciliation.
   */
  claimLinkStatus?(p: { claimToken?: string; claimUrl?: string }): Promise<ClaimLinkStatus>;

  /**
   * Redirect this adapter's "equivalent CLI command" reports. A Ledger calls
   * this on construction so the commands always reach the ledger the UI reads.
   */
  setCliEchoSink?(sink: CliEchoSink): void;
}

export interface EnableFenceParams {
  storeId: string;
  chain: string;
  coin: string;
  singleTxCap: string;
  totalCap: string;
  expires: string;
}

export interface SendPayoutParams {
  amount: string;
  chain: string;
  stableCoin: string;
  referenceId: string;
  receiverEmail: string;
}

export interface SendInvoiceParams {
  toEmail: string;
  /** Total to charge. The backend charges this regardless of the line items. */
  amount: string;
  /** `--wallet-id` is repeatable; the backend validates the ids. */
  walletIds: string[];
  lines: InvoiceLine[];
  /** Denomination: decides `--payment-type` (1 = USDT, 2 = USDC). */
  stableCoin: string;
  memo?: string;
  /** ISO 8601 due date. Defaults to 30 days out when omitted. */
  due?: string;
  /** Create the contact if the email is unknown. Defaults to true. */
  autoCreateContact?: boolean;
}

export interface ClaimPayoutParams {
  /** Bearer token from `payout send`. SECRET — never logged. */
  claimToken?: string;
  /**
   * Canonical claim URL — the other accepted source, and equally SECRET (it
   * embeds the token). Use it to rescue a link whose token was lost; recover it
   * with `claim-link get <id> --select 'claim_url'`.
   */
  claimUrl?: string;
  /** Path-A destination address. Omit to claim into the AllScale wallet. */
  toAddress?: string;
  /** For logging/reconciliation only. */
  referenceId?: string;
  /**
   * Poll `claim-link status` until the funded deposit confirms before claiming.
   * Default true — funding is asynchronous, so claiming immediately after
   * `payout send` races the deposit and is refused with exit 12.
   */
  waitForDeposit?: boolean;
}

/**
 * Called with the equivalent real CLI command whenever an adapter performs an
 * action. Drives the "what this would run for real" panel in the ledger UI.
 */
export type CliEchoSink = (command: string, actor: 'seller' | 'buyer') => void;

export interface AdapterOptions {
  onCliEcho?: CliEchoSink;
}
