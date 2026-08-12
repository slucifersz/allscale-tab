/**
 * StubAdapter — local stand-in for the AllScale CLI.
 *
 * It moves no money. It exists so the system can be developed, tested and
 * demoed without credentials or a network.
 *
 * It now mirrors the real CLI's *shape*, which the first version got wrong:
 *
 *   - there is no `payout enable`; the fence is granted out-of-band and this
 *     adapter only reports it (`payout status`)
 *   - authorization is per chain × token pair, so an undelegated pair is
 *     refused with FENCE_NOT_AUTHORIZED
 *   - `payout send` funds a **claim link** and returns a one-time bearer token;
 *     the money only arrives once `claimPayout` succeeds, and the link expires
 *
 * FIDELITY RULES (the design brief §4 M1)
 * --------------------------------
 * Field names mirror the verified CLI surface (docs/cli-help/). Anything the
 * real CLI does not document stays under `raw`, and stub-generated values are
 * prefixed `stub_` so no demo output can be mistaken for a real settlement.
 */
import type {
  AdapterOptions,
  ClaimPayoutParams,
  EnableFenceParams,
  SendInvoiceParams,
  SendPayoutParams,
  SettlementAdapter,
} from './adapter.js';
import {
  chainIdForSlug,
  describeChain,
  normalizeChain,
  normalizeStableCoin,
  DEFAULT_CHAIN,
  DEFAULT_STABLE_COIN,
} from './chains.js';
import {
  echoClaim,
  echoInvoiceSend,
  echoPayoutEnable,
  echoPayoutSend,
  echoPayoutStatus,
  echoTransactionList,
} from './cli-echo.js';
import { TabError } from './errors.js';
import { createLogger } from './log.js';
import { fromCents, toCents, toCentsFloor } from './money.js';
import type {
  AuthorizedPair,
  ClaimLinkStatus,
  ClaimResult,
  FenceStatus,
  InvoiceResult,
  PayoutResult,
  RawCliPayload,
  Transaction,
} from './types.js';

const log = createLogger('stub-adapter');

/** Mirrors the sandbox account: Sepolia + BSC, each for USDT and USDC. */
const DEFAULT_AUTHORIZED_PAIRS: AuthorizedPair[] = [
  { chain: 11, tokenSymbol: 'USDT', policyId: 'stub_policy_sepolia_usdt' },
  { chain: 11, tokenSymbol: 'USDC', policyId: 'stub_policy_sepolia_usdc' },
  { chain: 6, tokenSymbol: 'USDT', policyId: 'stub_policy_bsc_usdt' },
  { chain: 6, tokenSymbol: 'USDC', policyId: 'stub_policy_bsc_usdc' },
];

export interface StubFenceOptions {
  provisioned?: boolean;
  active?: boolean;
  singleTxCap?: string;
  totalCap?: string;
  expires?: string;
  storeId?: string;
  authorizedPairs?: AuthorizedPair[];
}

export interface StubAdapterOptions extends AdapterOptions {
  fence?: StubFenceOptions;
  /** Simulated latency per call, ms. Default 0. */
  latencyMs?: number;
  chain?: string;
  stableCoin?: string;
  /**
   * Force `payout send` to report an in-flight status this many times before it
   * settles — used to exercise the ambiguous-outcome path.
   */
  pendingRounds?: number;
  /** Claim window in ms. Default 21 min, matching observed sandbox behaviour. */
  claimTtlMs?: number;
  /**
   * How long a funded link stays un-claimable while the deposit "confirms".
   * Models the real asynchronous funding that makes an immediate claim fail with
   * `pending_deposit` (exit 12). Default 0 — claimable at once.
   */
  depositDelayMs?: number;
  /** Budget for waiting on the simulated deposit. Mirrors CliAdapter. */
  claimWaitMs?: number;
  /** Poll interval while waiting. Mirrors CliAdapter. */
  claimPollIntervalMs?: number;
}

interface StubClaimLink {
  claimLinkId: string;
  token: string;
  referenceId: string;
  amount: string;
  chain: string;
  stableCoin: string;
  expiresAt: number;
  /** When the simulated on-chain deposit confirms. */
  claimableAt: number;
  claimed: boolean;
  claimTxHash?: string;
}

const DEFAULT_FENCE: Required<Omit<StubFenceOptions, 'authorizedPairs'>> = {
  provisioned: true,
  active: true,
  singleTxCap: '200',
  totalCap: '20000',
  expires: '2026-09-11T04:25:27+00:00',
  storeId: 'stub_store_001',
};

/** Observed claim window on the sandbox: ~21 minutes from funding. */
const OBSERVED_CLAIM_TTL_MS = 21 * 60 * 1000;

export class StubAdapter implements SettlementAdapter {
  readonly kind = 'stub' as const;

  private fence: Required<Omit<StubFenceOptions, 'authorizedPairs'>> & {
    authorizedPairs: AuthorizedPair[];
  };
  private readonly chain: string;
  private readonly stableCoin: string;
  private readonly latencyMs: number;
  private readonly claimTtlMs: number;
  private readonly depositDelayMs: number;
  private readonly claimWaitMs: number;
  private readonly claimPollIntervalMs: number;
  private pendingRounds: number;
  private onCliEcho: AdapterOptions['onCliEcho'];

  private usedCents = 0;
  private invoiceSeq = 0;
  private payoutSeq = 0;
  /** payout send is idempotent on --reference-id. */
  private readonly payoutsByReference = new Map<string, PayoutResult>();
  private readonly linksByToken = new Map<string, StubClaimLink>();
  private readonly transactions: Transaction[] = [];

  constructor(opts: StubAdapterOptions = {}) {
    this.onCliEcho = opts.onCliEcho;
    this.latencyMs = opts.latencyMs ?? 0;
    this.claimTtlMs = opts.claimTtlMs ?? OBSERVED_CLAIM_TTL_MS;
    this.depositDelayMs = opts.depositDelayMs ?? 0;
    this.claimWaitMs = opts.claimWaitMs ?? Number(process.env.TAB_CLAIM_WAIT_MS ?? 300_000);
    this.claimPollIntervalMs =
      opts.claimPollIntervalMs ?? Number(process.env.TAB_CLAIM_POLL_MS ?? 50);
    this.pendingRounds = opts.pendingRounds ?? 0;
    this.chain = normalizeChain(opts.chain ?? process.env.TAB_CHAIN ?? DEFAULT_CHAIN);
    this.stableCoin = normalizeStableCoin(
      opts.stableCoin ?? process.env.TAB_STABLE_COIN ?? DEFAULT_STABLE_COIN,
    );
    this.fence = {
      ...DEFAULT_FENCE,
      ...stripUndefined(opts.fence ?? {}),
      authorizedPairs: opts.fence?.authorizedPairs ?? DEFAULT_AUTHORIZED_PAIRS,
    };
  }

  setCliEchoSink(sink: NonNullable<AdapterOptions['onCliEcho']>): void {
    this.onCliEcho = sink;
  }

  private async tick(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
  }

  private echo(command: string, actor: 'seller' | 'buyer'): void {
    this.onCliEcho?.(command, actor);
  }

  /**
   * The part of a real CLI response we do not model.
   * TODO: the real payout API response carries fields beyond those mapped in
   * types.ts; re-verify after any backend change.
   */
  private stubRaw(command: string, extra: RawCliPayload = {}): RawCliPayload {
    return {
      stub: true,
      stub_note: 'StubAdapter output — no money moved',
      stub_command: command,
      ...extra,
    };
  }

  // -------------------------------------------------------------------------
  // Fence
  // -------------------------------------------------------------------------

  async enableFence(p: EnableFenceParams): Promise<FenceStatus> {
    await this.tick();
    // Mirrors the real adapter: the fence is not created here, only reported.
    this.echo(echoPayoutEnable(p), 'buyer');
    if (p.singleTxCap) this.fence.singleTxCap = p.singleTxCap;
    if (p.totalCap) this.fence.totalCap = p.totalCap;
    if (p.expires) this.fence.expires = p.expires;
    if (p.storeId) this.fence.storeId = p.storeId;

    const fence = this.snapshotFence();
    if (!fence.enabled) {
      throw new TabError('FENCE_NOT_ENABLED', 'no active auto-payout session', {
        provisioned: fence.provisioned,
        active: fence.active,
      });
    }
    if (this.authorization(p.chain, p.coin) === 'denied') {
      throw new TabError(
        'FENCE_NOT_AUTHORIZED',
        `${describeChain(p.chain)} × ${p.coin} is not among the delegated pairs`,
        { requested: { chain: p.chain, coin: p.coin }, authorizedPairs: fence.authorizedPairs },
      );
    }
    log.log('fence_confirmed', { chain: p.chain, coin: p.coin, remaining: fence.remaining });
    return fence;
  }

  async fenceStatus(): Promise<FenceStatus> {
    await this.tick();
    this.echo(echoPayoutStatus(), 'buyer');
    return this.snapshotFence();
  }

  private snapshotFence(): FenceStatus {
    const remaining = toCentsFloor(this.fence.totalCap) - this.usedCents;
    return {
      enabled: this.fence.provisioned && this.fence.active,
      provisioned: this.fence.provisioned,
      active: this.fence.active,
      singleTxCap: this.fence.singleTxCap,
      totalCap: this.fence.totalCap,
      used: fromCents(this.usedCents),
      remaining: fromCents(remaining),
      expires: this.fence.expires,
      authorizedPairs: this.fence.authorizedPairs,
      chain: this.chain,
      coin: this.stableCoin,
      storeId: this.fence.storeId,
      raw: this.stubRaw(echoPayoutStatus()),
    };
  }

  /** Same per-pair rule the real backend enforces. */
  private authorization(chain: string, coin: string): 'allowed' | 'denied' | 'unknown' {
    const id = chainIdForSlug(chain);
    if (id === undefined) return 'unknown';
    const want = coin.trim().toUpperCase();
    return this.fence.authorizedPairs.some(
      (p) => p.chain === id && p.tokenSymbol.toUpperCase() === want,
    )
      ? 'allowed'
      : 'denied';
  }

  // -------------------------------------------------------------------------
  // payout send / claim
  // -------------------------------------------------------------------------

  async sendPayout(p: SendPayoutParams): Promise<PayoutResult> {
    await this.tick();
    const chain = normalizeChain(p.chain);
    const stableCoin = normalizeStableCoin(p.stableCoin);
    const command = echoPayoutSend({ ...p, chain, stableCoin });

    // Idempotency first: a replayed reference id must not fund twice.
    const seen = this.payoutsByReference.get(p.referenceId);
    if (seen) {
      this.echo(command, 'buyer');
      log.log('payout_duplicate', { command, referenceId: p.referenceId });
      return { ...seen, status: 'duplicate', idempotentHit: true };
    }

    if (!this.fence.provisioned || !this.fence.active) {
      throw new TabError('FENCE_NOT_ENABLED', 'no active auto-payout session for this store', {
        referenceId: p.referenceId,
      });
    }
    if (this.authorization(chain, stableCoin) === 'denied') {
      throw new TabError(
        'FENCE_NOT_AUTHORIZED',
        `${describeChain(chain)} × ${stableCoin} is not a delegated pair`,
        {
          requested: { chain, coin: stableCoin },
          authorizedPairs: this.fence.authorizedPairs,
          referenceId: p.referenceId,
        },
      );
    }
    const amountCents = toCents(p.amount);
    if (amountCents > toCentsFloor(this.fence.singleTxCap)) {
      throw new TabError('FENCE_EXCEEDED', 'amount exceeds the per-transaction limit', {
        amount: p.amount,
        singleTxCap: this.fence.singleTxCap,
      });
    }
    if (this.usedCents + amountCents > toCentsFloor(this.fence.totalCap)) {
      throw new TabError('FENCE_EXCEEDED', 'amount exceeds the remaining total cap', {
        amount: p.amount,
        totalCap: this.fence.totalCap,
        used: fromCents(this.usedCents),
      });
    }

    // Optionally report the funding as still in flight, to exercise the
    // caller's ambiguous-outcome handling.
    if (this.pendingRounds > 0) {
      this.pendingRounds -= 1;
      this.echo(command, 'buyer');
      log.log('payout_pending', { referenceId: p.referenceId, remainingRounds: this.pendingRounds });
      return {
        amount: p.amount,
        chain,
        stableCoin,
        referenceId: p.referenceId,
        receiverEmail: p.receiverEmail,
        status: 'pending',
        claimLinkId: `stub_link_${String(this.payoutSeq + 1).padStart(4, '0')}`,
        backendStatus: 'funding_pending',
        idempotentHit: false,
        raw: this.stubRaw(command, { stub_pending: true }),
      };
    }

    this.usedCents += amountCents;
    this.payoutSeq += 1;
    const seq = String(this.payoutSeq).padStart(4, '0');
    const link: StubClaimLink = {
      claimLinkId: `stub_link_${seq}`,
      token: `stub_claim_token_${seq}`,
      referenceId: p.referenceId,
      amount: p.amount,
      chain,
      stableCoin,
      expiresAt: Date.now() + this.claimTtlMs,
      claimableAt: Date.now() + this.depositDelayMs,
      claimed: false,
    };
    this.linksByToken.set(link.token, link);

    const result: PayoutResult = {
      amount: p.amount,
      chain,
      stableCoin,
      referenceId: p.referenceId,
      receiverEmail: p.receiverEmail,
      status: 'submitted',
      claimLinkId: link.claimLinkId,
      ...(chainIdForSlug(chain) === undefined ? {} : { chainId: chainIdForSlug(chain) }),
      tokenSymbol: stableCoin,
      backendStatus: 'funded',
      claimToken: link.token,
      claimUrl: `https://stub.invalid/claim/${link.token}`,
      fundedAmount: p.amount,
      idempotentHit: false,
      raw: this.stubRaw(command, {
        // The bearer token never goes into a persisted payload — and neither
        // does the claim URL, which embeds it.
        token: '***',
        claim_url: '***',
        stub_claim_link_id: link.claimLinkId,
        stub_expires_at: new Date(link.expiresAt).toISOString(),
      }),
    };
    this.payoutsByReference.set(p.referenceId, result);
    this.transactions.push({
      amount: p.amount,
      referenceId: p.referenceId,
      raw: this.stubRaw(echoTransactionList(), {
        stub_kind: 'payout',
        stub_claim_link_id: link.claimLinkId,
      }),
    });
    this.echo(command, 'buyer');
    log.log('payout_sent', {
      command,
      referenceId: p.referenceId,
      amount: p.amount,
      claimLinkId: link.claimLinkId,
    });
    return result;
  }

  /** `claim-link status` — the gate a caller polls before claiming. */
  async claimLinkStatus(p: { claimToken?: string; claimUrl?: string }): Promise<ClaimLinkStatus> {
    await this.tick();
    const link = this.findLink(p);
    if (!link) {
      throw new TabError('CLAIM_EXPIRED', 'unknown claim token', {});
    }
    const expired = Date.now() > link.expiresAt;
    const funded = Date.now() >= link.claimableAt;
    const status = link.claimed
      ? 'CLAIMED'
      : expired
        ? 'EXPIRED'
        : funded
          ? 'LINK_SENT'
          : 'PENDING_DEPOSIT';
    return {
      status,
      isClaimable: funded && !expired && !link.claimed,
      amount: link.amount,
      tokenSymbol: link.stableCoin,
      ...(chainIdForSlug(link.chain) === undefined ? {} : { chain: chainIdForSlug(link.chain) }),
      expiresAt: new Date(link.expiresAt).toISOString(),
      ...(link.claimTxHash === undefined ? {} : { claimTxHash: link.claimTxHash }),
      raw: this.stubRaw('allscale claim-link status', { stub_status: status }),
    };
  }

  private findLink(p: { claimToken?: string; claimUrl?: string }): StubClaimLink | undefined {
    if (p.claimToken) return this.linksByToken.get(p.claimToken);
    if (p.claimUrl) {
      const token = p.claimUrl.split('/').pop() ?? '';
      return this.linksByToken.get(token);
    }
    return undefined;
  }

  async claimPayout(p: ClaimPayoutParams): Promise<ClaimResult> {
    await this.tick();
    const source = p.claimToken ? { claimToken: p.claimToken } : { claimUrl: p.claimUrl ?? '' };
    this.echo(echoClaim({ ...source, ...(p.toAddress ? { toAddress: p.toAddress } : {}) }), 'buyer');

    const link = this.findLink(p);
    if (!link) {
      throw new TabError('CLAIM_EXPIRED', 'unknown claim token', { referenceId: p.referenceId });
    }

    // Same contract as CliAdapter: poll until the deposit confirms, bounded.
    if (p.waitForDeposit !== false && !link.claimed) {
      const deadline = Date.now() + this.claimWaitMs;
      while (Date.now() < link.claimableAt && Date.now() < link.expiresAt) {
        if (Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, this.claimPollIntervalMs));
      }
    }

    if (link.claimed) {
      // The real CLI reports a non-claimable link rather than paying twice.
      throw new TabError('CLAIM_EXPIRED', 'this claim link was already claimed', {
        referenceId: link.referenceId,
        claimLinkId: link.claimLinkId,
      });
    }
    if (Date.now() > link.expiresAt) {
      throw new TabError(
        'CLAIM_EXPIRED',
        'the claim link expired before it was claimed — the funds are refunded to the sender',
        { referenceId: link.referenceId, claimLinkId: link.claimLinkId },
      );
    }
    if (Date.now() < link.claimableAt) {
      // What the real backend does when the deposit has not confirmed: exit 12
      // with a pending_deposit reason. Transient, not terminal.
      throw new TabError('CLAIM_NOT_READY', 'pending_deposit: the deposit has not confirmed yet', {
        referenceId: link.referenceId,
        claimLinkId: link.claimLinkId,
        claimableInMs: link.claimableAt - Date.now(),
      });
    }

    link.claimed = true;
    link.claimTxHash = `0xstub${link.claimLinkId.replace(/\D/g, '').padStart(8, '0')}`;
    const result: ClaimResult = {
      claimLinkId: link.claimLinkId,
      claimed: true,
      destination: p.toAddress ?? 'allscale-wallet',
      outcome: 'claimed',
      ...(link.claimTxHash === undefined ? {} : { claimTxHash: link.claimTxHash }),
      raw: this.stubRaw('allscale claim-link claim', {
        stub_claim_link_id: link.claimLinkId,
        stub_claimed_amount: link.amount,
      }),
    };
    this.transactions.push({
      amount: link.amount,
      referenceId: link.referenceId,
      raw: this.stubRaw(echoTransactionList(), {
        stub_kind: 'claim',
        stub_claim_link_id: link.claimLinkId,
      }),
    });
    log.log('payout_claimed', {
      referenceId: link.referenceId,
      claimLinkId: link.claimLinkId,
      destination: result.destination,
    });
    return result;
  }

  // -------------------------------------------------------------------------
  // invoice send
  // -------------------------------------------------------------------------

  async sendInvoice(p: SendInvoiceParams): Promise<InvoiceResult> {
    await this.tick();
    const params: SendInvoiceParams = {
      ...p,
      stableCoin: normalizeStableCoin(p.stableCoin ?? this.stableCoin),
    };
    const command = echoInvoiceSend(params);
    this.invoiceSeq += 1;
    const result: InvoiceResult = {
      // The real `invoice send` returns payment_id and no status.
      id: `stub_inv_${String(this.invoiceSeq).padStart(4, '0')}`,
      amount: p.amount,
      toEmail: p.toEmail,
      walletId: p.walletIds[0] ?? '',
      lines: p.lines,
      ...(p.memo === undefined ? {} : { memo: p.memo }),
      raw: this.stubRaw(command, { stub_payment_id: `stub_inv_${this.invoiceSeq}` }),
    };
    this.transactions.push({
      id: result.id,
      amount: p.amount,
      raw: this.stubRaw(echoTransactionList(), { stub_kind: 'invoice' }),
    });
    this.echo(command, 'seller');
    log.log('invoice_sent', { command, id: result.id, amount: result.amount });
    return result;
  }

  async listTransactions(): Promise<Transaction[]> {
    await this.tick();
    this.echo(echoTransactionList(), 'seller');
    return [...this.transactions];
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
