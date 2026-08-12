/**
 * Buyer-side settlement loop.
 *
 * The buyer sets a fence once (single-tx cap, total cap, expiry) and then this
 * loop does the rest: watch for invoices, check each one against the fence and
 * the buyer's own rules, pay it, and tell the seller's ledger it is paid.
 *
 * Validation happens before any money moves:
 *   - the reference id must match `tab-{buyerId}-{cycle}`
 *   - the amount must be positive and within maxAutoPay and the fence caps
 *   - the invoice must still be unpaid
 *
 * Anything that fails validation is left alone and reported, never paid.
 */
import {
  TabError,
  createLogger,
  echoClaim,
  echoPayoutSend,
  fromCents,
  isTabError,
  toCents,
  toCentsFloor,
  type ClaimResult,
  type FenceStatus,
  type LedgerInvoice,
  type Logger,
  type PayoutResult,
  type SettlementAdapter,
} from '@tab/core';

/** `tab-{buyerId}-{cycle}` where cycle is an ISO week, optionally `.n`. */
export const REFERENCE_ID_RE = /^tab-([A-Za-z0-9._:-]+)-(\d{4}w\d{2}(?:\.\d+)?)$/;

export interface BuyerKitOptions {
  adapter: SettlementAdapter;
  /** Base URL of the seller's ledger API. */
  ledgerApi: string;
  /** Only settle invoices for this buyer. Defaults to all. */
  buyerId?: string;
  /** Refuse to auto-pay anything larger than this. */
  maxAutoPay?: string;
  /** Poll interval, ms. */
  intervalMs?: number;
  logger?: Logger;
  /** Where the CLI-command echo goes. Defaults to stdout. */
  print?: (line: string) => void;
  fetchImpl?: typeof fetch;
  /**
   * Claim into this EVM address (Path-A) instead of the authenticated AllScale
   * wallet. Defaults to TAB_CLAIM_TO_ADDRESS, else the wallet.
   */
  claimToAddress?: string;
}

export type SkipReason =
  | 'ALREADY_PAID'
  | 'BAD_REFERENCE_ID'
  | 'BUYER_MISMATCH'
  | 'ZERO_AMOUNT'
  | 'OVER_MAX_AUTO_PAY'
  | 'OVER_FENCE_SINGLE_TX'
  | 'OVER_FENCE_REMAINING'
  | 'FENCE_NOT_ENABLED';

export interface SettleOutcome {
  referenceId: string;
  amount: string;
  /** True only when the money was funded AND claimed — funding alone is not payment. */
  paid: boolean;
  /** Set when the ledger reported this reference id as already settled. */
  duplicate?: boolean;
  skipped?: SkipReason;
  payout?: PayoutResult;
  claim?: ClaimResult;
  /**
   * Set when funding succeeded but the claim did not. The buyer's money is in a
   * claim link that will expire and refund — the invoice stays unpaid.
   */
  fundedButUnclaimed?: boolean;
  error?: string;
}

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
};

export class BuyerKit {
  private readonly adapter: SettlementAdapter;
  private readonly ledgerApi: string;
  private readonly buyerId: string | undefined;
  private readonly maxAutoPay: string;
  private readonly intervalMs: number;
  private readonly log: Logger;
  private readonly print: (line: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly handled = new Set<string>();
  private readonly claimToAddress: string | undefined;
  /** Serialises fund+claim pairs — see settleInvoice for why. */
  private settlementLock: Promise<void> = Promise.resolve();
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(opts: BuyerKitOptions) {
    this.adapter = opts.adapter;
    this.ledgerApi = opts.ledgerApi.replace(/\/$/, '');
    this.buyerId = opts.buyerId;
    this.maxAutoPay = opts.maxAutoPay ?? process.env.TAB_MAX_AUTO_PAY ?? '5.00';
    this.intervalMs = opts.intervalMs ?? Number(process.env.TAB_POLL_INTERVAL_MS ?? 1000);
    this.log = opts.logger ?? createLogger('buyer-kit');
    this.print = opts.print ?? ((l) => process.stdout.write(l + '\n'));
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.claimToAddress = opts.claimToAddress ?? process.env.TAB_CLAIM_TO_ADDRESS;
  }

  /** Invoices waiting to be paid, oldest first. */
  async pendingInvoices(): Promise<LedgerInvoice[]> {
    const url = new URL(`${this.ledgerApi}/invoices`);
    url.searchParams.set('status', 'sent');
    if (this.buyerId) url.searchParams.set('buyerId', this.buyerId);
    const res = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`LEDGER_API_ERROR: GET /invoices -> ${res.status}`);
    const body = (await res.json()) as { invoices?: LedgerInvoice[] };
    return body.invoices ?? [];
  }

  /**
   * Check an invoice against the buyer's rules and the fence.
   * Returns the reason to skip, or undefined when it is safe to pay.
   */
  validate(invoice: LedgerInvoice, fence: FenceStatus | undefined): SkipReason | undefined {
    if (invoice.status !== 'sent') return 'ALREADY_PAID';

    const m = REFERENCE_ID_RE.exec(invoice.referenceId);
    if (!m) return 'BAD_REFERENCE_ID';
    if (m[1] !== invoice.buyerId) return 'BUYER_MISMATCH';
    if (this.buyerId !== undefined && invoice.buyerId !== this.buyerId) return 'BUYER_MISMATCH';

    const amount = toCents(invoice.amount);
    if (amount <= 0) return 'ZERO_AMOUNT';
    if (amount > toCents(this.maxAutoPay)) return 'OVER_MAX_AUTO_PAY';

    if (fence) {
      if (!fence.enabled) return 'FENCE_NOT_ENABLED';
      if (amount > toCentsFloor(fence.singleTxCap)) return 'OVER_FENCE_SINGLE_TX';
      if (amount > toCentsFloor(fence.remaining)) return 'OVER_FENCE_REMAINING';
    }
    return undefined;
  }

  /**
   * Validate, pay, and report one invoice.
   *
   * FORCED SERIAL (one settlement at a time, no concurrency)
   * -------------------------------------------------------
   * `payout send` does not transfer to the seller: it funds a **Claim Link** and
   * returns a one-time bearer token. That token is the only way to claim the
   * money — `claim-link list` / `get` do not expose it — and the link expires
   * within minutes (~21 observed on the sandbox). An expired link is refunded to
   * the buyer, so the bill silently stays unpaid.
   *
   * So funding and claiming must be one indivisible step, and two of them must
   * never overlap:
   *
   *   1. an interleaved second payout can push the first link past its expiry
   *      before its claim runs — that is real money bounced back and a bill left
   *      open;
   *   2. the partner API rejects a concurrent create for a reference id already
   *      in flight (DUPLICATE_REFERENCE), which the CLI surfaces as a retryable
   *      error — needless churn;
   *   3. a crash between the two calls loses the token, and the only recovery is
   *      re-running `payout send` with the SAME reference id, which is safe only
   *      when nothing else is mid-flight.
   *
   * Hence the mutex below. It costs throughput and buys correctness: settlements
   * are rare (once per billing cycle) while the failure mode is lost money.
   */
  async settleInvoice(invoice: LedgerInvoice, fence?: FenceStatus): Promise<SettleOutcome> {
    const previous = this.settlementLock;
    let release!: () => void;
    this.settlementLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.settleInvoiceExclusive(invoice, fence);
    } finally {
      release();
    }
  }

  private async settleInvoiceExclusive(
    invoice: LedgerInvoice,
    fence?: FenceStatus,
  ): Promise<SettleOutcome> {
    const skipped = this.validate(invoice, fence);
    if (skipped) {
      this.log.log('invoice_skipped', {
        referenceId: invoice.referenceId,
        amount: invoice.amount,
        reason: skipped,
      });
      this.print(
        `${C.yellow}✗ not paying ${invoice.referenceId} — ${skipped}${C.reset} ` +
          `${C.dim}(amount ${invoice.amount}, maxAutoPay ${this.maxAutoPay})${C.reset}`,
      );
      return { referenceId: invoice.referenceId, amount: invoice.amount, paid: false, skipped };
    }

    const params = {
      amount: invoice.amount,
      chain: invoice.chain,
      stableCoin: invoice.stableCoin,
      referenceId: invoice.referenceId,
      receiverEmail: invoice.receiverEmail,
    };
    const command = echoPayoutSend(params);

    // The money shot: the exact command that settles this bill for real.
    this.print('');
    this.print(
      `${C.bold}${C.green}→ ${command}${C.reset}`,
    );

    let payout: PayoutResult | undefined;
    try {
      // Step 1 — fund the claim link.
      payout = await this.adapter.sendPayout(params);
      this.print(
        `${C.dim}  funded claim link ${payout.claimLinkId}` +
          `${payout.idempotentHit ? ' (idempotent hit — same link)' : ''}${C.reset}`,
      );

      // An unresolved funding has no token to claim. Leave the invoice open and
      // let the next poll re-run the same reference id, which the backend
      // deduplicates onto the same link.
      if (!payout.claimToken) {
        const reason =
          payout.status === 'pending'
            ? `funding still settling (${payout.backendStatus ?? 'unknown'})`
            : 'no claim token returned';
        this.log.log('claim_deferred', {
          referenceId: invoice.referenceId,
          claimLinkId: payout.claimLinkId,
          status: payout.status,
          backendStatus: payout.backendStatus,
        });
        this.print(`${C.yellow}  ${reason} — will retry the same reference id${C.reset}`);
        return {
          referenceId: invoice.referenceId,
          amount: invoice.amount,
          paid: false,
          fundedButUnclaimed: true,
          payout,
          error: reason,
        };
      }

      // Step 2 — claim it, immediately. The window is minutes, not hours.
      const claimEcho = echoClaim({
        claimToken: payout.claimToken,
        ...(this.claimToAddress ? { toAddress: this.claimToAddress } : {}),
      });
      this.print(`${C.dim}  waiting for the deposit to confirm, then claiming…${C.reset}`);
      this.print(`${C.bold}${C.green}→ ${claimEcho}${C.reset}`);
      const claim = await this.adapter.claimPayout({
        claimToken: payout.claimToken,
        referenceId: invoice.referenceId,
        ...(this.claimToAddress ? { toAddress: this.claimToAddress } : {}),
      });

      // Only now is the seller actually paid.
      const applied = await this.reportPayment(invoice, payout, claim, [command, claimEcho]);
      this.log.log('invoice_settled', {
        referenceId: invoice.referenceId,
        amount: invoice.amount,
        status: payout.status,
        claimLinkId: payout.claimLinkId,
        claimTxHash: claim.claimTxHash,
        applied: applied.applied,
        balanceAfter: applied.balance,
      });
      this.print(
        `${C.dim}  claimed to ${claim.destination}` +
          `${claim.claimTxHash ? ` · tx ${claim.claimTxHash}` : ''} · ` +
          `tab balance now $${applied.balance}${applied.applied ? '' : ' (replay ignored)'}${C.reset}`,
      );
      return {
        referenceId: invoice.referenceId,
        amount: invoice.amount,
        paid: true,
        ...(applied.applied ? {} : { duplicate: true }),
        payout,
        claim,
      };
    } catch (e) {
      const message = e instanceof TabError ? e.message : (e as Error).message;

      // A failed claim on an idempotent hit means this reference id was already
      // resolved on an earlier attempt — the link is claimed (or already
      // refunded), and nothing new was funded now. That is a replay, not the
      // dangerous funded-but-unclaimed state, and must not be reported as one.
      if (payout?.idempotentHit === true) {
        this.log.log('settle_replay_already_resolved', {
          referenceId: invoice.referenceId,
          claimLinkId: payout.claimLinkId,
          error: message,
        });
        this.print(
          `${C.dim}  reference id already resolved earlier (${payout.claimLinkId}) — nothing re-funded${C.reset}`,
        );
        return {
          referenceId: invoice.referenceId,
          amount: invoice.amount,
          paid: false,
          duplicate: true,
          payout,
          error: message,
        };
      }

      // The deposit has not confirmed inside our budget. The link is still
      // valid and the money is not lost — retry on the next pass rather than
      // raising the alarm reserved for a link that will actually expire.
      if (isTabError(e) && e.code === 'CLAIM_NOT_READY') {
        this.log.log('claim_not_ready', {
          referenceId: invoice.referenceId,
          claimLinkId: payout?.claimLinkId,
          error: message,
        });
        this.print(
          `${C.yellow}  deposit not confirmed yet — link still valid, will retry${C.reset}`,
        );
        return {
          referenceId: invoice.referenceId,
          amount: invoice.amount,
          paid: false,
          fundedButUnclaimed: true,
          ...(payout ? { payout } : {}),
          error: message,
        };
      }

      const fundedButUnclaimed = payout !== undefined;
      this.log.log('settle_failed', {
        referenceId: invoice.referenceId,
        error: message,
        ...(isTabError(e) ? { code: e.code } : {}),
        fundedButUnclaimed,
        ...(payout ? { claimLinkId: payout.claimLinkId } : {}),
      });
      if (fundedButUnclaimed) {
        // The worst case, and the reason the two calls are serialized: the buyer
        // paid out but the receiver never got it. Say so loudly — the link will
        // expire and refund, and the invoice must stay open.
        this.print(
          `${C.red}  FUNDED BUT NOT CLAIMED — ${message}${C.reset}\n` +
            `${C.red}  claim link ${payout?.claimLinkId} will expire and refund; invoice stays unpaid${C.reset}`,
        );
      } else {
        this.print(`${C.red}  payout failed: ${message}${C.reset}`);
      }
      return {
        referenceId: invoice.referenceId,
        amount: invoice.amount,
        paid: false,
        ...(fundedButUnclaimed ? { fundedButUnclaimed: true, payout } : {}),
        error: message,
      };
    }
  }

  /** Tell the seller's ledger the invoice is paid. Idempotent on the ledger side. */
  private async reportPayment(
    invoice: LedgerInvoice,
    payout: PayoutResult,
    claim: ClaimResult,
    commands: string[],
  ): Promise<{ applied: boolean; balance: string }> {
    // Neither the bearer token nor the claim URL (which embeds it) leaves this
    // process — the ledger is persisted to disk and rendered in the UI.
    const { claimToken: _claimToken, claimUrl: _claimUrl, ...safePayout } = payout;
    const res = await this.fetchImpl(`${this.ledgerApi}/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        referenceId: invoice.referenceId,
        amount: invoice.amount,
        payout: safePayout,
        claim,
        cliEcho: commands,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`LEDGER_API_ERROR: POST /payments -> ${res.status} ${body.slice(0, 200)}`);
    }
    const body = (await res.json()) as { applied: boolean; tab: { balance: string } };
    return { applied: body.applied, balance: body.tab.balance };
  }

  /** One pass: settle everything currently outstanding. */
  async runOnce(): Promise<SettleOutcome[]> {
    const invoices = await this.pendingInvoices();
    const fresh = invoices.filter((i) => !this.handled.has(i.referenceId));
    if (fresh.length === 0) return [];

    let fence: FenceStatus | undefined;
    try {
      fence = await this.adapter.fenceStatus();
    } catch (e) {
      // No fence status available (e.g. the CLI adapter is not wired up yet).
      // Fall through with buyer-side limits only.
      this.log.log('fence_status_unavailable', { error: (e as Error).message });
    }

    const outcomes: SettleOutcome[] = [];
    for (const invoice of fresh) {
      this.print(
        `${C.bold}new invoice${C.reset} ${invoice.referenceId} ${C.dim}$${invoice.amount} · ` +
          `${invoice.lines.map((l) => `${l.desc}×${l.qty}@${l.unitPrice}`).join(', ')}${C.reset}`,
      );
      const outcome = await this.settleInvoice(invoice, fence);
      // Only stop tracking an invoice once it is resolved; transient failures
      // are retried on the next pass.
      if (outcome.paid || outcome.skipped) this.handled.add(invoice.referenceId);
      outcomes.push(outcome);
      if (fence && outcome.paid) {
        fence = {
          ...fence,
          remaining: fromCents(toCentsFloor(fence.remaining) - toCents(outcome.amount)),
        };
      }
    }
    return outcomes;
  }

  /** Poll until stopped. */
  start(): void {
    const loop = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        await this.runOnce();
      } catch (e) {
        this.log.log('poll_failed', { error: (e as Error).message });
      }
      if (!this.stopped) this.timer = setTimeout(() => void loop(), this.intervalMs);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Wait until the ledger API answers, so start-up order doesn't matter. */
  async waitForLedger(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !this.stopped) {
      try {
        const res = await this.fetchImpl(`${this.ledgerApi}/health`);
        if (res.ok) return true;
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  }
}
