/** Error codes raised by the ledger and the settlement adapters. */
export type TabErrorCode =
  | 'CREDIT_EXCEEDED'
  | 'TAB_DELINQUENT'
  | 'TAB_SETTLING'
  | 'INVOICE_NOT_FOUND'
  | 'AMOUNT_MISMATCH'
  | 'NOTHING_TO_SETTLE'
  | 'FENCE_EXCEEDED'
  | 'FENCE_EXPIRED'
  | 'FENCE_NOT_ENABLED'
  /** The session exists but this chain × token pair is not delegated to it. */
  | 'FENCE_NOT_AUTHORIZED'
  | 'ADAPTER_ERROR'
  /**
   * The mutation may or may not have happened. NEVER treat as a failure: the
   * transfer can still be in flight. Reconcile with the same reference id.
   */
  | 'ADAPTER_AMBIGUOUS'
  /** Rate limited, or a create for this reference id is already in flight. */
  | 'ADAPTER_BUSY'
  /** The operation definitively did not happen (CLI exit 12). */
  | 'ADAPTER_DECLINED'
  /** The claim link expired, or is otherwise permanently unclaimable. Terminal. */
  | 'CLAIM_EXPIRED'
  /**
   * The link exists but is not claimable YET — the on-chain deposit has not
   * confirmed. Transient: poll `claim-link status` and try again.
   */
  | 'CLAIM_NOT_READY'
  | 'CLI_NOT_AVAILABLE'
  | 'CLI_AUTH_MISSING';

export class TabError extends Error {
  readonly code: TabErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: TabErrorCode, message: string, details: Record<string, unknown> = {}) {
    // The code leads the message so it survives every place an Error is
    // stringified — logs, assertions, MCP error payloads.
    super(`${code}: ${message}`);
    this.name = 'TabError';
    this.code = code;
    this.details = details;
  }
}

export function isTabError(e: unknown): e is TabError {
  return e instanceof TabError;
}
