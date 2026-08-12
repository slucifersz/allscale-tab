/**
 * Domain types for Tab.
 *
 * FIDELITY DISCIPLINE (see the design brief §4 M1)
 * -----------------------------------------
 * Types that model AllScale CLI *results* only carry field names whose
 * vocabulary appears in the documented command surface:
 *
 *   payout enable      --store --chain --coin --single-tx --total-cap --expires
 *   payout send        --amount --chain --stable-coin --reference-id --receiver-email
 *   payout status      (read-only: remaining allowance + expiry)
 *   invoice send       --to-email --amount --wallet-id --line "desc|qty|price" --memo --due
 *                      --auto-create-contact
 *   invoice list/get   --all --select "id,status,amount"
 *   transaction list   --all
 *   wallet list        (wallet id, name, network, address, asset, balance)
 *
 * Anything not covered above is NOT invented as a typed field. It lands in the
 * `raw` bag together with a TODO, to be verified against `--help` before the
 * CliAdapter is wired up.
 */

/** Verbatim JSON as printed by the CLI. Authoritative until fields are verified. */
export type RawCliPayload = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Settlement adapter results
// ---------------------------------------------------------------------------

/**
 * One delegated chain × token pair, from `payout status`.`authorized_pairs`.
 * Authorization is granted per pair — a session delegated for Sepolia/USDT
 * cannot pay out Base/USDC.
 */
export interface AuthorizedPair {
  /** AllScale's internal numeric chain id. See chains.ts for the slug mapping. */
  chain: number;
  /** `token_symbol`, e.g. "USDT". */
  tokenSymbol: string;
  policyId: string;
}

/**
 * The buyer's spending fence, as reported by `allscale payout status`.
 *
 * Field names below map 1:1 onto that command's documented default selection
 * set: `provisioned active session_expires_at total_cap_usd used_usd
 * remaining_usd per_transaction_limit authorized_pairs { chain token_symbol
 * policy_id }` (`allscale payout status --help`).
 *
 * NOTE the unit mismatch: caps are USD (`*_usd`), while a payout amount is in
 * token units. For USDT/USDC that is ~1:1 but it is NOT the same unit, so Tab
 * treats cap comparisons as advisory and lets the backend be the authority.
 */
export interface FenceStatus {
  /** Tab's own roll-up: provisioned && active. Not a CLI field. */
  enabled: boolean;
  /** Has an auto-payout session ever been set up? */
  provisioned: boolean;
  /** Is that session currently usable? */
  active: boolean;
  /** `per_transaction_limit`, USD. */
  singleTxCap: string;
  /** `total_cap_usd`. */
  totalCap: string;
  /** `used_usd`. */
  used: string;
  /** `remaining_usd`. */
  remaining: string;
  /** `session_expires_at`. */
  expires: string;
  /** Every delegated chain × token pair. */
  authorizedPairs: AuthorizedPair[];
  /**
   * The pair Tab is configured to settle on. Not from the CLI — it is our own
   * configuration, echoed here so callers can see what was checked.
   */
  chain: string;
  coin: string;
  /**
   * Store the fence belongs to. NOT reported by `payout status`; comes from
   * TAB_STORE_ID when set, otherwise empty.
   */
  storeId: string;
  /** Full CLI payload, authoritative over the mapped fields above. */
  raw: RawCliPayload;
}

/**
 * Result of `payout send`.
 *
 * IMPORTANT: `payout send` does not transfer to the seller. It creates and funds
 * a **Claim Link**, which the receiver must then claim (see `ClaimResult`). The
 * link carries a short expiry — observed ~21 minutes on the sandbox — after
 * which the funds are refunded to the sender and the bill stays unpaid.
 *
 * Field names come from the CLI's own response validator
 * (`claim_link_id reference_id amount token_symbol chain_id status token
 * claim_url funding_tx_hash funded_amount idempotent_hit`).
 */
export interface PayoutResult {
  amount: string;
  chain: string;
  stableCoin: string;
  referenceId: string;
  receiverEmail: string;
  /** Tab's own coarse verdict, derived from `status` + `idempotent_hit`. */
  status: 'submitted' | 'duplicate' | 'pending';
  /** `claim_link_id` — the link this payout funded. */
  claimLinkId: string;
  /** Numeric chain id the backend funded on (`chain_id`). */
  chainId?: number;
  /** `token_symbol` as the backend recorded it. */
  tokenSymbol?: string;
  /**
   * Backend lifecycle string, passed through verbatim.
   * Observed values: created | funding | funded | claimed | expired, plus
   * funding_pending. The vocabulary is backend-defined and NOT enumerated by
   * the CLI, so it is never matched exhaustively — see PAYOUT_IN_FLIGHT_STATUS.
   */
  backendStatus?: string;
  /**
   * The bearer claim token. SECRET — never log or persist it.
   *
   * `payout send` is the only place it is returned. It is not in the default
   * selection of `claim-link list` / `get`, but the owner CAN recover the
   * equivalent credential with
   * `claim-link get <id> --select 'claim_url'` — see recoverClaimUrl(). That is
   * the recovery path when a process dies between funding and claiming.
   */
  claimToken?: string;
  /** SECRET too: the URL embeds the claim token. */
  claimUrl?: string;
  fundingTxHash?: string;
  fundedAmount?: string;
  /** True when this reference id had already been used (safe retry). */
  idempotentHit?: boolean;
  /** Full CLI payload, minus secrets. */
  raw: RawCliPayload;
}

/** Result of `claim-link claim` — the step that actually delivers the money. */
export interface ClaimResult {
  claimLinkId?: string;
  /** Only an on-chain-proven claim exits 0, so this is meaningful. */
  claimed: boolean;
  /** Where it was claimed to: an EVM address (`--to`) or the AllScale wallet. */
  destination: string;
  claimTxHash?: string;
  /** Backend verdict, passed through verbatim. Observed: `claimed`. */
  outcome?: string;
  confirmations?: number | null;
  requiredConfirmations?: number | null;
  raw: RawCliPayload;
}

/**
 * The receiver-facing snapshot from `allscale claim-link status`.
 *
 * Funding a claim link is asynchronous: `payout send` returns as soon as the
 * transfer is dispatched, and the link is not claimable until the deposit
 * confirms on chain. `is_claimable` is the authoritative gate — the `status`
 * string is informational, and its full vocabulary is not documented
 * (observed: `LINK_SENT`).
 */
export interface ClaimLinkStatus {
  /** Backend lifecycle label, verbatim. */
  status: string;
  /** The only reliable "may I claim now?" signal. */
  isClaimable: boolean;
  amount?: string;
  tokenSymbol?: string;
  /** Numeric chain id. */
  chain?: number;
  /** When the claim window closes. */
  expiresAt?: string;
  claimTxHash?: string;
  raw: RawCliPayload;
}

/**
 * Result of `invoice send`.
 *
 * `id`, `status` and `amount` are documented via `invoice list --select
 * "id,status,amount"`. Everything else echoes documented input flags.
 */
export interface InvoiceResult {
  /** `payment_id` from the `invoice send` summary. */
  id: string;
  /**
   * Absent from `invoice send`, which returns a fixed summary with no status —
   * read it back with `invoice get <payment_id>` if you need one. Tab does not
   * invent a value here.
   */
  status?: string;
  amount: string;
  toEmail: string;
  walletId: string;
  lines: InvoiceLine[];
  memo?: string;
  /** TODO: verify against `allscale invoice send --help`. */
  raw: RawCliPayload;
}

/** One `--line "desc|qty|price"` entry. */
export interface InvoiceLine {
  desc: string;
  qty: number;
  unitPrice: string;
}

/**
 * A row from `transaction list`.
 *
 * The output columns are NOT documented, so every field here is optional and
 * `raw` is the authoritative payload.
 * TODO: verify against `allscale transaction list --help`.
 */
export interface Transaction {
  id?: string;
  amount?: string;
  referenceId?: string;
  raw: RawCliPayload;
}

// ---------------------------------------------------------------------------
// Ledger entities (Tab's own model — no CLI fidelity constraint here)
// ---------------------------------------------------------------------------

export type TabStatus = 'open' | 'settling' | 'delinquent';

export type EntryType = 'charge' | 'invoice' | 'payment' | 'cutoff' | 'reopen';

export interface Entry {
  id: string;
  ts: string;
  type: EntryType;
  /** Tool that was billed, for `charge` entries. */
  toolName?: string;
  /** Signed amount: charges are positive, payments negative. */
  amount: string;
  /** Tab balance right after this entry was applied. */
  balanceAfter: string;
  referenceId?: string;
  meta?: Record<string, unknown>;
}

export interface Tab {
  buyerId: string;
  creditLimit: string;
  balance: string;
  status: TabStatus;
  entries: Entry[];
  createdAt: string;
  updatedAt: string;
}

export type InvoiceStatus = 'sent' | 'paid';

/** A billing cycle that has been invoiced. */
export interface LedgerInvoice {
  referenceId: string;
  buyerId: string;
  cycle: string;
  amount: string;
  status: InvoiceStatus;
  createdAt: string;
  paidAt?: string;
  lines: InvoiceLine[];
  /** Where the buyer must send the payout (`payout send --receiver-email`). */
  receiverEmail: string;
  /** Rail the payout is expected on (`payout send --chain / --stable-coin`). */
  chain: string;
  stableCoin: string;
  /** What the adapter returned for `invoice send`. */
  adapter: InvoiceResult;
  /** What the adapter returned for `payout send` — the funding step. */
  payment?: PayoutResult;
  /**
   * What the adapter returned for `claim-link claim` — the delivery step.
   * A funded payout without this is money in limbo: the link expires and the
   * amount is refunded to the buyer, leaving the bill unpaid.
   */
  claim?: ClaimResult;
}

/** An "equivalent real CLI command" line, for the demo ledger UI. */
export interface CliEcho {
  ts: string;
  actor: 'seller' | 'buyer';
  command: string;
  /** Whether this ran against the real CLI or the stub. */
  adapter: 'stub' | 'cli';
}

export interface LedgerSnapshot {
  version: number;
  adapter: 'stub' | 'cli';
  tabs: Tab[];
  invoices: LedgerInvoice[];
  cliLog: CliEcho[];
  updatedAt: string;
}
