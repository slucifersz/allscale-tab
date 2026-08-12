/**
 * The 402 answer.
 *
 * Shape is x402-flavoured on purpose: an agent that already understands
 * "payment required" responses can read this without special-casing Tab.
 * Note the scope limit from the design brief §6 — this is the response *shape* only.
 * There is no protocol-level signature verification here.
 */
import type { TabStatus } from '@tab/core';

export interface PaymentRequired {
  code: 402;
  error: 'PAYMENT_REQUIRED';
  tab: {
    balance: string;
    creditLimit: string;
    settleUrl: string;
    status: TabStatus;
    /** Which rule refused the call. */
    reason: 'CREDIT_EXCEEDED' | 'TAB_DELINQUENT';
    /** Reference id of the invoice waiting to be paid, when there is one. */
    referenceId?: string;
    /** What the tool would have cost. */
    price?: string;
  };
}

export function paymentRequired(p: {
  balance: string;
  creditLimit: string;
  settleUrl: string;
  status: TabStatus;
  reason: 'CREDIT_EXCEEDED' | 'TAB_DELINQUENT';
  referenceId?: string;
  price?: string;
}): PaymentRequired {
  return {
    code: 402,
    error: 'PAYMENT_REQUIRED',
    tab: {
      balance: p.balance,
      creditLimit: p.creditLimit,
      settleUrl: p.settleUrl,
      status: p.status,
      reason: p.reason,
      ...(p.referenceId === undefined ? {} : { referenceId: p.referenceId }),
      ...(p.price === undefined ? {} : { price: p.price }),
    },
  };
}

/** Render the 402 as an MCP tool result: readable text plus machine-readable `_meta`. */
export function paymentRequiredResult(payload: PaymentRequired): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
  _meta: Record<string, unknown>;
} {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
    _meta: { 'tab/payment_required': payload },
  };
}
