/**
 * CliAdapter — real settlement through the AllScale CLI.
 *
 * Every flag and field name here was verified against the installed CLI; the
 * captured `--help` output lives in docs/cli-help/ and the differences from the
 * original design assumptions are itemised in docs/cli-help/DIFF.md.
 *
 * THREE THINGS THAT SHAPE THIS FILE
 * ---------------------------------
 * 1. There is no `payout enable`. Authorization is granted in the dashboard, per
 *    chain × token pair, and the CLI can only inspect it (`payout status`).
 * 2. `payout send` does not pay anybody. It funds a **Claim Link** with a short
 *    expiry (~21 min observed); the receiver must claim it or the money is
 *    refunded to the sender. The bearer token comes back exactly once.
 * 3. Some outcomes are genuinely ambiguous — the transfer may be in flight after
 *    the CLI stops reporting. Those are NEVER treated as failures: Tab reconciles
 *    with `payout status` first, then retries the SAME reference id, which the
 *    backend deduplicates.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

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
} from './chains.js';
import {
  claimArgv,
  claimLinkStatusArgv,
  claimUrlRecoveryArgv,
  echoClaim,
  echoClaimStatus,
  echoInvoiceSend,
  echoPayoutEnable,
  echoPayoutSend,
  echoPayoutStatus,
  echoTransactionList,
  invoiceSendArgv,
  payoutSendArgv,
  payoutStatusArgv,
  transactionListArgv,
} from './cli-echo.js';
import { TabError, type TabErrorCode } from './errors.js';
import { createLogger } from './log.js';
import { normalizeAmount, toCentsFloor } from './money.js';
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

const log = createLogger('cli-adapter');

/**
 * Exit codes the CLI documents as stable buckets (from its own source table).
 * 9 = ambiguous mutation, 12 = non-completion, 8 = rate limited / in flight.
 */
const EXIT = {
  OK: 0,
  INPUT_OR_CONFIG: 2,
  BRIDGE_OR_CREDENTIAL: 3,
  NO_TOKEN: 4,
  TOKEN_EXPIRED: 5,
  PERMISSION_DENIED: 6,
  NOT_FOUND: 7,
  RATE_LIMITED: 8,
  AMBIGUOUS: 9,
  RAW_DISABLED: 10,
  UPGRADE_REQUIRED: 11,
  NON_COMPLETION: 12,
} as const;

/** CLI error codes that mean "the mutation may have happened — reconcile". */
const AMBIGUOUS_CODES = new Set([
  'claim_link.funding_ambiguous',
  'claim.payout_ambiguous',
  'wallet.transaction_status_unknown',
  'wallet.bridge_invalid_response',
  'backend.internal',
]);

/**
 * Backend lifecycle strings that mean the funding is still settling.
 * The vocabulary is backend-defined and not enumerated by the CLI, so this set
 * is a best-effort filter, never an exhaustive match.
 * TODO: confirm the full list with the payout API team.
 */
const PAYOUT_IN_FLIGHT_STATUS = new Set([
  'funding_pending',
  'funding',
  'pending',
  'created',
  'processing',
]);

/** Backend lifecycle strings that mean the money arrived. */
const PAYOUT_SETTLED_STATUS = new Set(['funded', 'claimed', 'completed']);

export interface CliAdapterOptions extends AdapterOptions {
  /** Binary to invoke. Override for a local build or a wrapper script. */
  bin?: string;
  /** Per-call timeout, ms. `payout send` alone can legitimately take ~2 min. */
  timeoutMs?: number;
  /** Where `captureHelp()` writes its output. */
  helpDir?: string;
  /** Chain × coin pair this adapter settles on. */
  chain?: string;
  stableCoin?: string;
  /** Store whose fence is in play. Only used for display — see FenceStatus. */
  storeId?: string;
  /** How many times to re-resolve an ambiguous payout. Default 3. */
  ambiguousRetries?: number;
  /** Delay between those attempts, ms. Default 4000. */
  ambiguousRetryDelayMs?: number;
  /** Claim into this EVM address instead of the AllScale wallet. */
  claimToAddress?: string;
  /**
   * How long to wait for a funded deposit to confirm before giving up and
   * returning CLAIM_NOT_READY. Default 5 min — well under the ~21-minute claim
   * window, so a caller can retry rather than lose the link.
   */
  claimWaitMs?: number;
  /** Poll interval while waiting. Default 5 s. */
  claimPollIntervalMs?: number;
}

export interface CliRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The last JSON object on stdout — see parseJsonStream. */
  json?: RawCliPayload;
  /** Every JSON object on stdout, in order (progress events, then the result). */
  events: RawCliPayload[];
}

/**
 * Subcommands whose `--help` we capture as the source of truth for flag names.
 *
 * `payout enable` is deliberately still in the list: it does NOT exist on the
 * real CLI, and having its failure recorded in docs/cli-help/ is the evidence
 * for that (see docs/cli-help/DIFF.md).
 */
export const HELP_TARGETS: string[][] = [
  [],
  ['build-info'],
  ['payout'],
  ['payout', 'enable'],
  ['payout', 'send'],
  ['payout', 'status'],
  ['claim-link'],
  ['claim-link', 'create'],
  ['claim-link', 'claim'],
  ['claim-link', 'get'],
  ['claim-link', 'status'],
  ['claim-link', 'list'],
  ['claim-link', 'preview'],
  ['invoice'],
  ['invoice', 'send'],
  ['invoice', 'get'],
  ['invoice', 'list'],
  ['invoice', 'sent'],
  ['invoice', 'received'],
  ['invoice', 'pay'],
  ['invoice', 'update'],
  ['transaction'],
  ['transaction', 'list'],
  ['transaction', 'get'],
  ['wallet'],
  ['wallet', 'list'],
  ['wallet', 'send'],
  ['store', 'create'],
  ['whoami'],
  ['scope'],
];

export class CliAdapter implements SettlementAdapter {
  readonly kind = 'cli' as const;

  private readonly bin: string;
  private readonly timeoutMs: number;
  private readonly helpDir: string;
  private readonly chain: string;
  private readonly stableCoin: string;
  private readonly storeId: string;
  private readonly ambiguousRetries: number;
  private readonly ambiguousRetryDelayMs: number;
  private readonly claimToAddress: string | undefined;
  private readonly claimWaitMs: number;
  private readonly claimPollIntervalMs: number;
  private onCliEcho: AdapterOptions['onCliEcho'];

  constructor(opts: CliAdapterOptions = {}) {
    this.bin = opts.bin ?? process.env.ALLSCALE_CLI_BIN ?? 'allscale';
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.TAB_CLI_TIMEOUT_MS ?? 150_000);
    this.helpDir = opts.helpDir ?? 'docs/cli-help';
    this.chain = normalizeChain(opts.chain ?? process.env.TAB_CHAIN ?? 'sepolia');
    this.stableCoin = normalizeStableCoin(opts.stableCoin ?? process.env.TAB_STABLE_COIN ?? 'USDT');
    this.storeId = opts.storeId ?? process.env.TAB_STORE_ID ?? '';
    this.ambiguousRetries = opts.ambiguousRetries ?? Number(process.env.TAB_AMBIGUOUS_RETRIES ?? 3);
    this.ambiguousRetryDelayMs =
      opts.ambiguousRetryDelayMs ?? Number(process.env.TAB_AMBIGUOUS_RETRY_MS ?? 4_000);
    this.claimToAddress = opts.claimToAddress ?? process.env.TAB_CLAIM_TO_ADDRESS;
    this.claimWaitMs = opts.claimWaitMs ?? Number(process.env.TAB_CLAIM_WAIT_MS ?? 300_000);
    this.claimPollIntervalMs =
      opts.claimPollIntervalMs ?? Number(process.env.TAB_CLAIM_POLL_MS ?? 5_000);
    this.onCliEcho = opts.onCliEcho;
  }

  setCliEchoSink(sink: NonNullable<AdapterOptions['onCliEcho']>): void {
    this.onCliEcho = sink;
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  /**
   * Spawn the CLI and capture stdout/stderr. Credentials are inherited from the
   * environment and never logged; argv is logged with secret values redacted.
   */
  async run(argv: string[]): Promise<CliRunResult> {
    log.log('cli_spawn', { bin: this.bin, argv: redactArgv(argv) });
    return await new Promise<CliRunResult>((resolve, reject) => {
      const child = spawn(this.bin, argv, {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        child.kill('SIGKILL');
        // A killed mutation is the ambiguous case, not a failure: the transfer
        // may already be in flight. Callers reconcile by reference id.
        reject(
          new TabError('ADAPTER_AMBIGUOUS', `allscale ${argv[0] ?? ''} timed out after ${this.timeoutMs}ms`, {
            argv: redactArgv(argv),
            timeoutMs: this.timeoutMs,
          }),
        );
      }, this.timeoutMs);

      child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      child.on('error', (err) => {
        if (settled) return;
        clearTimeout(timer);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(
            new TabError(
              'CLI_NOT_AVAILABLE',
              `${this.bin} not found on PATH — install the AllScale CLI (private beta)`,
              { bin: this.bin },
            ),
          );
          return;
        }
        reject(new TabError('ADAPTER_ERROR', err.message, { argv: redactArgv(argv) }));
      });
      child.on('close', (code) => {
        if (settled) return;
        clearTimeout(timer);
        const events = parseJsonStream(stdout);
        const result: CliRunResult = { code, stdout, stderr, events };
        const last = events.at(-1);
        if (last) result.json = last;
        log.log('cli_exit', { argv: redactArgv(argv), code, events: events.length });
        resolve(result);
      });
    });
  }

  /** Run a command, require success, and return its final JSON `data` payload. */
  async runJson(argv: string[]): Promise<RawCliPayload> {
    const r = await this.run(argv);
    if (r.code !== EXIT.OK) throw this.classify(argv, r);
    if (!r.json) {
      throw new TabError('ADAPTER_ERROR', 'expected JSON on stdout', {
        argv: redactArgv(argv),
        stdoutHead: r.stdout.slice(0, 400),
      });
    }
    return unwrapData(r.json);
  }

  /**
   * Map a failed invocation onto a TabError.
   *
   * The CLI's exit codes are documented stable buckets, and its JSON error
   * envelope carries a machine code (`error.code`). Both are used: the code
   * decides the semantics, the exit code is the fallback.
   */
  private classify(argv: string[], r: CliRunResult): TabError {
    const envelope = findErrorEnvelope(r);
    const cliCode = typeof envelope?.code === 'string' ? envelope.code : undefined;
    const message = typeof envelope?.message === 'string' ? envelope.message : undefined;
    const detail = {
      argv: redactArgv(argv),
      exitCode: r.code,
      cliCode,
      reason: message ?? tail(r.stderr) ?? tail(r.stdout),
    };
    const say = (code: TabErrorCode, text: string): TabError =>
      new TabError(code, `${text}${message ? ` — ${message}` : ''}`, detail);

    // Ambiguity first: these must never be reported as clean failures.
    if (cliCode && AMBIGUOUS_CODES.has(cliCode)) {
      return say('ADAPTER_AMBIGUOUS', `outcome unresolved (${cliCode})`);
    }
    if (r.code === EXIT.AMBIGUOUS) {
      return say('ADAPTER_AMBIGUOUS', 'outcome unresolved (exit 9)');
    }

    // Authorization: the store key is not delegated for what we asked.
    if (cliCode === 'auth.permission_denied' || isNotDelegated(message)) {
      return say('FENCE_NOT_AUTHORIZED', 'this store key is not authorized for that payout');
    }
    if (cliCode === 'auth.no_token' || cliCode === 'auth.token_expired') {
      return say('CLI_AUTH_MISSING', 'no usable CLI session — run `allscale device-login`');
    }
    if (cliCode === 'auth.signature_rejected') {
      return say('CLI_NOT_AVAILABLE', 'this CLI build was rejected by the backend — upgrade it');
    }
    if (cliCode === 'claim.expired' || cliCode === 'claim.not_claimable') {
      // Exit 12 is the CLI's "did not happen" bucket, and it covers BOTH a link
      // whose deposit has not confirmed yet (transient — the funding is still
      // settling) and one that is permanently gone. Only the latter is terminal,
      // so the reason text decides. Observed transient reason: pending_deposit.
      if (isPendingDeposit(message)) {
        return say('CLAIM_NOT_READY', 'the funded deposit has not confirmed yet');
      }
      return say('CLAIM_EXPIRED', 'the claim link can no longer be claimed');
    }
    if (cliCode === 'rate_limited') {
      return say('ADAPTER_BUSY', 'rate limited or a create for this reference id is in flight');
    }

    switch (r.code) {
      case EXIT.NO_TOKEN:
      case EXIT.TOKEN_EXPIRED:
        return say('CLI_AUTH_MISSING', 'no usable CLI session');
      case EXIT.PERMISSION_DENIED:
        return say('FENCE_NOT_AUTHORIZED', 'permission denied for that operation');
      case EXIT.RATE_LIMITED:
        return say('ADAPTER_BUSY', 'rate limited');
      case EXIT.NOT_FOUND:
        return say('ADAPTER_ERROR', 'not found');
      case EXIT.UPGRADE_REQUIRED:
        return say('CLI_NOT_AVAILABLE', 'CLI upgrade required');
      case EXIT.NON_COMPLETION:
        if (isPendingDeposit(message)) {
          return say('CLAIM_NOT_READY', 'the funded deposit has not confirmed yet');
        }
        return say('ADAPTER_DECLINED', 'the operation did not happen');
      case EXIT.INPUT_OR_CONFIG:
      case EXIT.BRIDGE_OR_CREDENTIAL:
      case EXIT.RAW_DISABLED:
      default:
        return say('ADAPTER_ERROR', `allscale ${argv.slice(0, 2).join(' ')} failed (exit ${r.code})`);
    }
  }

  /** Fail loudly when payout credentials are absent. Values are never read into logs. */
  private requirePayoutCredentials(): void {
    const missing = ['ALLSCALE_STORE_API_KEY', 'ALLSCALE_STORE_API_SECRET'].filter(
      (k) => !process.env[k],
    );
    if (missing.length > 0) {
      throw new TabError(
        'CLI_AUTH_MISSING',
        `missing environment variables: ${missing.join(', ')} — payout send authenticates with the STORE key, not your login`,
        { missing },
      );
    }
  }

  /** Capture `--help` for every command we depend on. */
  async captureHelp(): Promise<string[]> {
    await mkdir(this.helpDir, { recursive: true });
    const written: string[] = [];
    for (const target of HELP_TARGETS) {
      const argv = [...target, '--help'];
      let body: string;
      try {
        const r = await this.run(argv);
        body = `$ ${this.bin} ${argv.join(' ')}\n\n${r.stdout}${r.stderr}`;
      } catch (e) {
        body = `$ ${this.bin} ${argv.join(' ')}\n\nFAILED: ${(e as Error).message}\n`;
      }
      const name = (target.length > 0 ? target.join('-') : 'root') + '.txt';
      const file = path.join(this.helpDir, name);
      await writeFile(file, body, 'utf8');
      written.push(file);
    }
    log.log('help_captured', { files: written.length, dir: this.helpDir });
    return written;
  }

  // -------------------------------------------------------------------------
  // Fence
  // -------------------------------------------------------------------------

  async fenceStatus(): Promise<FenceStatus> {
    const argv = payoutStatusArgv();
    this.onCliEcho?.(echoPayoutStatus(), 'buyer');
    const data = await this.runJson(argv);
    return this.toFenceStatus(data);
  }

  private toFenceStatus(data: RawCliPayload): FenceStatus {
    const pairs: AuthorizedPair[] = Array.isArray(data['authorized_pairs'])
      ? (data['authorized_pairs'] as RawCliPayload[]).flatMap((p) => {
          const chain = p['chain'];
          const tokenSymbol = p['token_symbol'];
          if (typeof chain !== 'number' || typeof tokenSymbol !== 'string') return [];
          return [
            {
              chain,
              tokenSymbol,
              policyId: typeof p['policy_id'] === 'string' ? p['policy_id'] : '',
            },
          ];
        })
      : [];

    const provisioned = data['provisioned'] === true;
    const active = data['active'] === true;
    return {
      enabled: provisioned && active,
      provisioned,
      active,
      singleTxCap: str(data['per_transaction_limit']),
      totalCap: str(data['total_cap_usd']),
      used: str(data['used_usd']),
      remaining: str(data['remaining_usd']),
      expires: str(data['session_expires_at']),
      authorizedPairs: pairs,
      chain: this.chain,
      coin: this.stableCoin,
      storeId: this.storeId,
      raw: data,
    };
  }

  /**
   * `payout enable` does not exist. Print what a human has to do in the
   * dashboard, then confirm via `payout status` — never claim to have created a
   * fence, and never blind-retry.
   */
  async enableFence(p: EnableFenceParams): Promise<FenceStatus> {
    this.onCliEcho?.(echoPayoutEnable(p), 'buyer');
    log.log('fence_requires_dashboard', {
      storeId: p.storeId,
      chain: p.chain,
      coin: p.coin,
      instruction: 'app.allscale.io → Store Settings → Payout Authorization',
    });

    const fence = await this.fenceStatus();
    if (!fence.provisioned) {
      throw new TabError(
        'FENCE_NOT_ENABLED',
        'no auto-payout session on this account — grant it in the dashboard (Store Settings → Payout Authorization), then re-run',
        { storeId: p.storeId, chain: p.chain, coin: p.coin },
      );
    }
    if (!fence.active) {
      throw new TabError('FENCE_NOT_ENABLED', 'the auto-payout session exists but is not active', {
        expires: fence.expires,
      });
    }
    const verdict = this.checkPairAuthorized(fence, p.chain, p.coin);
    if (verdict === 'denied') {
      throw new TabError(
        'FENCE_NOT_AUTHORIZED',
        `${describeChain(p.chain)} × ${p.coin} is not among the delegated pairs — authorization is per chain × token`,
        { requested: { chain: p.chain, coin: p.coin }, authorizedPairs: fence.authorizedPairs },
      );
    }
    log.log('fence_confirmed', {
      chain: fence.chain,
      coin: fence.coin,
      remaining: fence.remaining,
      expires: fence.expires,
      pairs: fence.authorizedPairs.length,
      authorization: verdict,
    });
    return fence;
  }

  /**
   * Is this chain × coin delegated?
   *
   * Returns `unknown` when the slug has no known numeric id — the mapping in
   * chains.ts is empirical, so an unrecognised chain must not be reported as
   * denied. In that case the CLI remains the authority.
   */
  private checkPairAuthorized(
    fence: FenceStatus,
    chain: string,
    coin: string,
  ): 'allowed' | 'denied' | 'unknown' {
    const wantId = chainIdForSlug(chain);
    const wantCoin = coin.trim().toUpperCase();
    if (wantId === undefined) return 'unknown';
    if (fence.authorizedPairs.length === 0) return 'unknown';
    return fence.authorizedPairs.some(
      (p) => p.chain === wantId && p.tokenSymbol.toUpperCase() === wantCoin,
    )
      ? 'allowed'
      : 'denied';
  }

  // -------------------------------------------------------------------------
  // payout send  (fund a claim link)
  // -------------------------------------------------------------------------

  async sendPayout(p: SendPayoutParams): Promise<PayoutResult> {
    this.requirePayoutCredentials();
    const chain = normalizeChain(p.chain);
    const stableCoin = normalizeStableCoin(p.stableCoin);
    const params = { ...p, chain, stableCoin };
    const command = echoPayoutSend(params);
    this.onCliEcho?.(command, 'buyer');

    // Pre-flight: refuse an undelegated pair before spending a network call, and
    // report it as an authorization problem rather than a generic backend error.
    // Skipped when the fence cannot be read — the CLI will still enforce it.
    try {
      const fence = await this.fenceStatus();
      const verdict = this.checkPairAuthorized(fence, chain, stableCoin);
      if (verdict === 'denied') {
        throw new TabError(
          'FENCE_NOT_AUTHORIZED',
          `${describeChain(chain)} × ${stableCoin} is not a delegated pair`,
          {
            requested: { chain, coin: stableCoin },
            authorizedPairs: fence.authorizedPairs,
            referenceId: p.referenceId,
          },
        );
      }
      if (!fence.enabled) {
        throw new TabError('FENCE_NOT_ENABLED', 'the auto-payout session is not active', {
          provisioned: fence.provisioned,
          active: fence.active,
        });
      }
      if (toCentsFloor(p.amount) > toCentsFloor(fence.singleTxCap)) {
        throw new TabError('FENCE_EXCEEDED', 'amount exceeds the per-transaction limit', {
          amount: p.amount,
          singleTxCap: fence.singleTxCap,
        });
      }
    } catch (e) {
      // Propagate real verdicts; tolerate an unreadable fence.
      if (e instanceof TabError && e.code.startsWith('FENCE_')) throw e;
      log.log('fence_preflight_skipped', { error: (e as Error).message });
    }

    return await this.sendPayoutWithReconcile(params, payoutSendArgv(params));
  }

  /**
   * Run `payout send`, and when the outcome is ambiguous, resolve it the way the
   * CLI itself prescribes: check `payout status`, then re-run with the SAME
   * `--reference-id` (the backend deduplicates, so this cannot double-fund).
   */
  private async sendPayoutWithReconcile(
    p: SendPayoutParams,
    argv: string[],
  ): Promise<PayoutResult> {
    let lastAmbiguity: TabError | undefined;

    for (let attempt = 1; attempt <= this.ambiguousRetries + 1; attempt++) {
      let result: PayoutResult | undefined;
      try {
        const data = await this.runJson(argv);
        result = this.toPayoutResult(p, data);
      } catch (e) {
        const err = e as TabError;
        const retryable =
          err instanceof TabError &&
          (err.code === 'ADAPTER_AMBIGUOUS' || err.code === 'ADAPTER_BUSY');
        if (!retryable) throw e;
        lastAmbiguity = err;
        log.log('payout_ambiguous', {
          referenceId: p.referenceId,
          attempt,
          code: err.code,
          message: err.message,
        });
      }

      if (result) {
        // A settled or duplicate result is done. An in-flight one is retried:
        // the same reference id resolves to the same link.
        if (result.status !== 'pending') return result;
        log.log('payout_in_flight', {
          referenceId: p.referenceId,
          attempt,
          backendStatus: result.backendStatus,
        });
        lastAmbiguity = new TabError(
          'ADAPTER_AMBIGUOUS',
          `payout still settling (${result.backendStatus ?? 'unknown status'})`,
          { referenceId: p.referenceId },
        );
        // Hold on to the funded link: if retries run out we still return it, so
        // the caller can attempt the claim rather than lose the token.
        if (attempt > this.ambiguousRetries) return result;
      }

      if (attempt > this.ambiguousRetries) break;

      // Doc discipline: when the result is unclear, look before leaping.
      await this.reportFenceBeforeRetry(p.referenceId);
      await sleep(this.ambiguousRetryDelayMs * attempt);
    }

    throw (
      lastAmbiguity ??
      new TabError('ADAPTER_AMBIGUOUS', 'payout outcome unresolved', {
        referenceId: p.referenceId,
      })
    );
  }

  /** Log the fence before retrying an unclear payout; never let this throw. */
  private async reportFenceBeforeRetry(referenceId: string): Promise<void> {
    try {
      const fence = await this.fenceStatus();
      log.log('payout_status_checked', {
        referenceId,
        provisioned: fence.provisioned,
        active: fence.active,
        remaining: fence.remaining,
        used: fence.used,
        expires: fence.expires,
      });
      if (!fence.enabled) {
        log.log('payout_retry_pointless', {
          referenceId,
          reason: 'session not active — retrying will not help',
        });
      }
    } catch (e) {
      log.log('payout_status_unreadable', { referenceId, error: (e as Error).message });
    }
  }

  private toPayoutResult(p: SendPayoutParams, data: RawCliPayload): PayoutResult {
    const backendStatus = typeof data['status'] === 'string' ? data['status'] : undefined;
    const idempotentHit = data['idempotent_hit'] === true;
    const lower = backendStatus?.toLowerCase();

    let status: PayoutResult['status'] = 'submitted';
    if (idempotentHit) status = 'duplicate';
    if (lower && PAYOUT_IN_FLIGHT_STATUS.has(lower) && !PAYOUT_SETTLED_STATUS.has(lower)) {
      status = 'pending';
    }

    const claimToken = typeof data['token'] === 'string' ? data['token'] : undefined;
    const result: PayoutResult = {
      amount: normalizeAmount(p.amount),
      chain: p.chain,
      stableCoin: p.stableCoin,
      referenceId: p.referenceId,
      receiverEmail: p.receiverEmail,
      status,
      claimLinkId: str(data['claim_link_id']),
      ...(typeof data['chain_id'] === 'number' ? { chainId: data['chain_id'] } : {}),
      ...(typeof data['token_symbol'] === 'string' ? { tokenSymbol: data['token_symbol'] } : {}),
      ...(backendStatus === undefined ? {} : { backendStatus }),
      ...(claimToken === undefined ? {} : { claimToken }),
      ...(typeof data['claim_url'] === 'string' ? { claimUrl: data['claim_url'] } : {}),
      ...(typeof data['funding_tx_hash'] === 'string'
        ? { fundingTxHash: data['funding_tx_hash'] }
        : {}),
      ...(data['funded_amount'] === null || data['funded_amount'] === undefined
        ? {}
        : { fundedAmount: str(data['funded_amount']) }),
      idempotentHit,
      // The bearer token is stripped: this payload is persisted to the ledger
      // and rendered in the UI.
      raw: redactPayload(data),
    };
    log.log('payout_sent', {
      referenceId: p.referenceId,
      amount: result.amount,
      claimLinkId: result.claimLinkId,
      backendStatus,
      idempotentHit,
      hasClaimToken: claimToken !== undefined,
    });
    return result;
  }

  // -------------------------------------------------------------------------
  // claim-link claim  (deliver the money)
  // -------------------------------------------------------------------------

  /** `claim-link status` — the receiver-facing snapshot. */
  async claimLinkStatus(p: { claimToken?: string; claimUrl?: string }): Promise<ClaimLinkStatus> {
    const source = p.claimToken ? { claimToken: p.claimToken } : { claimUrl: p.claimUrl ?? '' };
    const data = await this.runJson(claimLinkStatusArgv(source));
    return {
      status: str(data['status']),
      // The authoritative gate. Absent → assume not claimable rather than risk
      // an exit-12 claim attempt.
      isClaimable: data['is_claimable'] === true,
      ...(data['amount'] === undefined ? {} : { amount: str(data['amount']) }),
      ...(typeof data['token_symbol'] === 'string' ? { tokenSymbol: data['token_symbol'] } : {}),
      ...(typeof data['chain'] === 'number' ? { chain: data['chain'] } : {}),
      ...(typeof data['expiry_at'] === 'string' ? { expiresAt: data['expiry_at'] } : {}),
      ...(typeof data['claim_tx_hash'] === 'string' ? { claimTxHash: data['claim_tx_hash'] } : {}),
      raw: redactPayload(data),
    };
  }

  /**
   * Wait until the funded deposit has confirmed and the link is claimable.
   *
   * Funding is asynchronous: `payout send` returns once the transfer is
   * dispatched, so an immediate claim races the on-chain deposit and the backend
   * rejects it (`pending_deposit`, exit 12). Polling `claim-link status` and
   * gating on `is_claimable` is the documented way to know when to proceed.
   *
   * The budget is deliberately far below the claim window (~21 min observed):
   * running out leaves time to retry on the next pass instead of burning the
   * whole window in one call.
   */
  private async waitForClaimable(
    source: { claimToken?: string; claimUrl?: string },
    referenceId?: string,
  ): Promise<ClaimLinkStatus | undefined> {
    const deadline = Date.now() + this.claimWaitMs;
    let last: ClaimLinkStatus | undefined;
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt += 1;
      try {
        last = await this.claimLinkStatus(source);
      } catch (e) {
        // A status read that fails must not abort the claim: fall through and
        // let the claim itself produce the authoritative verdict.
        log.log('claim_status_unreadable', { referenceId, attempt, error: (e as Error).message });
        return undefined;
      }

      if (last.isClaimable) {
        log.log('claim_ready', { referenceId, attempt, status: last.status });
        return last;
      }
      if (isExpiredStatus(last.status) || isPastExpiry(last.expiresAt)) {
        throw new TabError(
          'CLAIM_EXPIRED',
          `the claim window closed before the deposit confirmed (status ${last.status})`,
          { referenceId, status: last.status, expiresAt: last.expiresAt },
        );
      }

      log.log('claim_waiting', {
        referenceId,
        attempt,
        status: last.status,
        expiresAt: last.expiresAt,
        msLeft: deadline - Date.now(),
      });
      if (Date.now() + this.claimPollIntervalMs >= deadline) break;
      await sleep(this.claimPollIntervalMs);
    }

    throw new TabError(
      'CLAIM_NOT_READY',
      `the deposit had not confirmed after ${Math.round(this.claimWaitMs / 1000)}s (status ${last?.status ?? 'unknown'}) — the link is still valid, so retry`,
      {
        referenceId,
        status: last?.status,
        expiresAt: last?.expiresAt,
        waitedMs: this.claimWaitMs,
      },
    );
  }

  async claimPayout(p: ClaimPayoutParams): Promise<ClaimResult> {
    const toAddress = p.toAddress ?? this.claimToAddress;
    const source = p.claimToken ? { claimToken: p.claimToken } : { claimUrl: p.claimUrl ?? '' };
    const argvParams = { ...source, ...(toAddress ? { toAddress } : {}) };

    // Wait for the deposit before spending an attempt on a claim that would be
    // refused. Skipped only when the caller opts out.
    if (p.waitForDeposit !== false) {
      this.onCliEcho?.(echoClaimStatus(source), 'buyer');
      const ready = await this.waitForClaimable(source, p.referenceId);
      if (ready?.claimTxHash) {
        // Already claimed by someone (a replay of ours, most likely).
        log.log('claim_already_settled', {
          referenceId: p.referenceId,
          claimTxHash: ready.claimTxHash,
        });
      }
    }

    this.onCliEcho?.(echoClaim(argvParams), 'buyer');
    const data = await this.runJson(claimArgv(argvParams));
    const claimTxHash = typeof data['claim_tx_hash'] === 'string' ? data['claim_tx_hash'] : undefined;
    const outcome = typeof data['outcome'] === 'string' ? data['outcome'] : undefined;
    const result: ClaimResult = {
      // Exit 0 already means an on-chain-proven claim, per the CLI's own
      // contract ("Only an on-chain-proven claimed outcome exits 0").
      claimed: true,
      destination: toAddress ?? 'allscale-wallet',
      ...(typeof data['claim_link_id'] === 'string' ? { claimLinkId: data['claim_link_id'] } : {}),
      ...(claimTxHash === undefined ? {} : { claimTxHash }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(data['confirmations'] === undefined
        ? {}
        : { confirmations: data['confirmations'] as number | null }),
      ...(data['required_confirmations'] === undefined
        ? {}
        : { requiredConfirmations: data['required_confirmations'] as number | null }),
      raw: redactPayload(data),
    };
    log.log('payout_claimed', {
      referenceId: p.referenceId,
      claimLinkId: result.claimLinkId,
      destination: result.destination,
      outcome,
      claimTxHash,
    });
    return result;
  }

  /**
   * Recover the claim credential for a link this account owns.
   *
   * `payout send` returns the bearer token once. If the process dies between
   * funding and claiming, the owner can still get the equivalent credential from
   * `claim-link get <id> --select 'claim_url'` — the URL embeds the token. This
   * is the only way to rescue a funded link whose token was lost.
   *
   * The returned value is SECRET: do not log or persist it.
   */
  async recoverClaimUrl(claimLinkId: string): Promise<string | undefined> {
    const data = await this.runJson(claimUrlRecoveryArgv(claimLinkId));
    const link = (typeof data['claim_link'] === 'object' && data['claim_link'] !== null
      ? data['claim_link']
      : data) as RawCliPayload;
    const url = link['claim_url'];
    log.log('claim_url_recovered', { claimLinkId, found: typeof url === 'string' && url !== '' });
    return typeof url === 'string' && url !== '' ? url : undefined;
  }

  // -------------------------------------------------------------------------
  // invoice send
  // -------------------------------------------------------------------------

  async sendInvoice(p: SendInvoiceParams): Promise<InvoiceResult> {
    const params: SendInvoiceParams = {
      ...p,
      stableCoin: normalizeStableCoin(p.stableCoin ?? this.stableCoin),
    };
    const command = echoInvoiceSend(params);
    this.onCliEcho?.(command, 'seller');

    const data = await this.runJson(invoiceSendArgv(params));
    // `invoice send` returns a fixed summary (payment_id, contact, amount,
    // wallet count) — no GraphQL selection, and notably no status.
    const result: InvoiceResult = {
      id: str(data['payment_id'] ?? data['id']),
      amount: normalizeAmount(p.amount),
      toEmail: p.toEmail,
      walletId: p.walletIds[0] ?? '',
      lines: p.lines,
      ...(p.memo === undefined ? {} : { memo: p.memo }),
      raw: data,
    };
    log.log('invoice_sent', { id: result.id, amount: result.amount, lines: p.lines.length });
    return result;
  }

  // -------------------------------------------------------------------------
  // transaction list
  // -------------------------------------------------------------------------

  async listTransactions(): Promise<Transaction[]> {
    this.onCliEcho?.(echoTransactionList(), 'seller');
    const data = await this.runJson(transactionListArgv());
    const items = Array.isArray(data['items']) ? (data['items'] as RawCliPayload[]) : [];
    return items.map((row) => ({
      ...(typeof row['id'] === 'string' ? { id: row['id'] } : {}),
      // `amount_coins` is the token-unit amount; `amount_cents` is the fiat one.
      ...(row['amount_coins'] === undefined ? {} : { amount: str(row['amount_coins']) }),
      ...(typeof row['payment_id'] === 'string' ? { referenceId: row['payment_id'] } : {}),
      raw: row,
    }));
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * The CLI can print several JSON documents on stdout — progress events first
 * (e.g. `{"event":"payout_destination",…}`), then the result. A single
 * JSON.parse over the whole stream fails on that, so parse line-oriented and
 * fall back to whole-buffer parsing for pretty-printed output.
 */
export function parseJsonStream(stdout: string): RawCliPayload[] {
  const out: RawCliPayload[] = [];
  const text = stdout.trim();
  if (text === '') return out;

  // Fast path: one pretty-printed document.
  const whole = tryParse(text);
  if (whole) return [whole];

  // Otherwise: concatenated documents, one or more per line.
  let buffer = '';
  for (const line of text.split('\n')) {
    buffer = buffer === '' ? line.trim() : `${buffer}\n${line}`;
    const parsed = tryParse(buffer.trim());
    if (parsed) {
      out.push(parsed);
      buffer = '';
    }
  }
  return out;
}

function tryParse(s: string): RawCliPayload | undefined {
  if (!(s.startsWith('{') || s.startsWith('['))) return undefined;
  try {
    const v = JSON.parse(s) as unknown;
    return typeof v === 'object' && v !== null ? (v as RawCliPayload) : undefined;
  } catch {
    return undefined;
  }
}

/** The CLI wraps success payloads in `{ "data": … }`. */
function unwrapData(payload: RawCliPayload): RawCliPayload {
  const data = payload['data'];
  return typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as RawCliPayload)
    : payload;
}

/** Find `{ "error": { code, message } }` anywhere in the output. */
function findErrorEnvelope(r: CliRunResult): RawCliPayload | undefined {
  for (const event of [...r.events].reverse()) {
    const err = event['error'];
    if (typeof err === 'object' && err !== null) return err as RawCliPayload;
  }
  // Errors sometimes arrive on stderr instead.
  for (const line of r.stderr.split('\n').reverse()) {
    const parsed = tryParse(line.trim());
    const err = parsed?.['error'];
    if (typeof err === 'object' && err !== null) return err as RawCliPayload;
  }
  return undefined;
}

/**
 * Does this message describe an authorization refusal?
 * The backend's wording is not a stable contract, so this only ever *adds*
 * precision on top of the CLI's own error code.
 */
function isNotDelegated(message?: string): boolean {
  if (!message) return false;
  return /not delegated|not authoriz|no delegation|missing .*scope|not allowed/i.test(message);
}

const SECRET_FLAGS = new Set(['--claim-token', '--api-secret', '--api-key', '--token']);
/**
 * Keys whose values are bearer credentials. `claim_url` counts: it embeds the
 * claim token (…/claim/<token>), so anyone holding the URL can take the money.
 */
const SECRET_KEYS = /^(token|claim_token|claimToken|claim_url|claimUrl|secret|api_key|api_secret|authorization)$/i;

/** Replace secret flag values with *** for logging. */
export function redactArgv(argv: string[]): string[] {
  const out = [...argv];
  for (let i = 0; i < out.length - 1; i++) {
    if (SECRET_FLAGS.has(out[i] as string)) out[i + 1] = '***';
  }
  return out;
}

/** Strip bearer tokens from a payload before it is persisted or displayed. */
export function redactPayload(payload: RawCliPayload): RawCliPayload {
  const out: RawCliPayload = {};
  for (const [k, v] of Object.entries(payload)) {
    out[k] = SECRET_KEYS.test(k) && typeof v === 'string' && v !== '' ? '***' : v;
  }
  return out;
}

/**
 * Does this message describe a deposit that has not confirmed yet?
 * Transient — the link is fine, the money is simply still landing.
 * TODO: confirm the full set of reason codes with the payout API team; the
 * observed one is `pending_deposit`.
 */
function isPendingDeposit(message?: string): boolean {
  if (!message) return false;
  return /pending[_ ]?deposit|deposit .*pending|not (yet )?funded|awaiting (the )?deposit|funding[_ ]?pending/i.test(
    message,
  );
}

/** Status strings that mean the window is gone for good. */
function isExpiredStatus(status: string): boolean {
  return /expired|refunded|cancel/i.test(status);
}

function isPastExpiry(expiresAt?: string): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t <= Date.now();
}

function str(v: unknown): string {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : String(v);
}

function tail(s: string | undefined): string | undefined {
  const t = s?.trim();
  if (!t) return undefined;
  return t.slice(-400);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
