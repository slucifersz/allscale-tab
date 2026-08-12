/**
 * The Tab ledger — in-memory state with a JSON file behind it.
 *
 * A charge is a local bookkeeping entry: no money moves, no network call, so
 * billing a tool call costs nothing measurable. Money only moves at settlement,
 * and only through the SettlementAdapter.
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { SettlementAdapter } from './adapter.js';
import {
  DEFAULT_CHAIN,
  DEFAULT_STABLE_COIN,
  normalizeChain,
  normalizeStableCoin,
} from './chains.js';
import { TabError } from './errors.js';
import { createLogger, type Logger } from './log.js';
import { fromCents, multiplyAmount, normalizeAmount, toCents } from './money.js';
import type {
  ClaimResult,
  CliEcho,
  Entry,
  InvoiceLine,
  LedgerInvoice,
  LedgerSnapshot,
  PayoutResult,
  Tab,
} from './types.js';

const LEDGER_VERSION = 1;
const CLI_LOG_LIMIT = 200;

/**
 * Who is billed and who gets paid.
 *
 * Note the asymmetry in the CLI: `invoice send --to-email` addresses the BUYER
 * (they receive the bill), while `payout send --receiver-email` addresses the
 * SELLER (they receive the money).
 */
export interface BillingIdentity {
  /** Buyer contact the invoice is addressed to (`invoice send --to-email`). */
  buyerEmail: string;
  /** Seller wallet that collects (`invoice send --wallet-id`). */
  sellerWalletId: string;
  /** Seller contact the payout is sent to (`payout send --receiver-email`). */
  sellerEmail: string;
}

export interface LedgerOptions {
  adapter: SettlementAdapter;
  /** Persistence path. Default `.tab/ledger.json`. */
  file?: string;
  /** Credit limit applied to a tab the first time a buyer shows up. */
  defaultCreditLimit?: string;
  identity?: Partial<BillingIdentity>;
  /** Payout rail the buyer is expected to settle on — echoed into invoices. */
  chain?: string;
  stableCoin?: string;
  logger?: Logger;
  /** Skip disk persistence (used by tests). */
  ephemeral?: boolean;
}

interface LedgerState {
  version: number;
  tabs: Record<string, Tab>;
  invoices: LedgerInvoice[];
  cliLog: CliEcho[];
}

export interface ChargeResult {
  tab: Tab;
  entry: Entry;
}

export interface SettleResult {
  invoice: LedgerInvoice;
  /** False when an existing unpaid invoice was returned instead of a new one. */
  created: boolean;
}

export interface ApplyPaymentParams {
  referenceId: string;
  amount: string;
  /** The funding step (`payout send`). */
  payout?: PayoutResult;
  /**
   * The delivery step (`claim-link claim`). Funding alone does not settle a
   * bill — an unclaimed link expires and refunds the buyer.
   */
  claim?: ClaimResult;
  /**
   * Equivalent CLI command(s) the buyer ran, for the ledger UI. Settlement is
   * two commands (fund, then claim), so an array keeps them as separate lines.
   */
  cliEcho?: string | string[];
}

export interface ApplyPaymentResult {
  invoice: LedgerInvoice;
  /** False when the invoice was already paid — a replay. */
  applied: boolean;
  tab: Tab;
}

export class Ledger extends EventEmitter {
  readonly adapter: SettlementAdapter;
  readonly identity: BillingIdentity;
  readonly chain: string;
  readonly stableCoin: string;

  private readonly file: string;
  private readonly ephemeral: boolean;
  private readonly defaultCreditLimit: string;
  private readonly log: Logger;
  private state: LedgerState;
  /** Serialises settle() per buyer so a burst of charges can't double-invoice. */
  private readonly settling = new Map<string, Promise<SettleResult>>();

  constructor(opts: LedgerOptions) {
    super();
    this.adapter = opts.adapter;
    this.file = path.resolve(opts.file ?? process.env.TAB_LEDGER_FILE ?? '.tab/ledger.json');
    this.ephemeral = opts.ephemeral ?? false;
    this.defaultCreditLimit = normalizeAmount(
      opts.defaultCreditLimit ?? process.env.TAB_CREDIT_LIMIT ?? '5.00',
    );
    this.identity = {
      buyerEmail: opts.identity?.buyerEmail ?? process.env.TAB_BUYER_EMAIL ?? 'buyer@example.com',
      sellerWalletId:
        opts.identity?.sellerWalletId ?? process.env.TAB_SELLER_WALLET_ID ?? 'stub_wallet_001',
      sellerEmail: opts.identity?.sellerEmail ?? process.env.TAB_SELLER_EMAIL ?? 'seller@example.com',
    };
    this.chain = normalizeChain(opts.chain ?? process.env.TAB_CHAIN ?? DEFAULT_CHAIN);
    this.stableCoin = normalizeStableCoin(
      opts.stableCoin ?? process.env.TAB_STABLE_COIN ?? DEFAULT_STABLE_COIN,
    );
    this.log = opts.logger ?? createLogger('ledger');
    this.state = this.load();
    // Everything the adapter would run for real shows up in this ledger's echo
    // log, so the UI never depends on the caller remembering to wire it.
    this.adapter.setCliEchoSink?.(this.cliEchoSink);
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private load(): LedgerState {
    const empty: LedgerState = { version: LEDGER_VERSION, tabs: {}, invoices: [], cliLog: [] };
    if (this.ephemeral || !existsSync(this.file)) return empty;
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as LedgerState;
      if (parsed.version !== LEDGER_VERSION) {
        this.log.log('ledger_version_mismatch', { found: parsed.version, want: LEDGER_VERSION });
        return empty;
      }
      return {
        version: LEDGER_VERSION,
        tabs: parsed.tabs ?? {},
        invoices: parsed.invoices ?? [],
        cliLog: parsed.cliLog ?? [],
      };
    } catch (e) {
      this.log.log('ledger_load_failed', { file: this.file, error: (e as Error).message });
      return empty;
    }
  }

  private save(): void {
    if (this.ephemeral) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    renameSync(tmp, this.file);
  }

  /** Reset persisted state — demo scripts call this for a clean run. */
  reset(): void {
    this.state = { version: LEDGER_VERSION, tabs: {}, invoices: [], cliLog: [] };
    this.save();
    this.emit('change', this.snapshot());
  }

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------

  getTab(buyerId: string, creditLimit?: string): Tab {
    const existing = this.state.tabs[buyerId];
    if (existing) {
      if (creditLimit !== undefined) existing.creditLimit = normalizeAmount(creditLimit);
      return existing;
    }
    const now = new Date().toISOString();
    const tab: Tab = {
      buyerId,
      creditLimit: normalizeAmount(creditLimit ?? this.defaultCreditLimit),
      balance: '0.00',
      status: 'open',
      entries: [],
      createdAt: now,
      updatedAt: now,
    };
    this.state.tabs[buyerId] = tab;
    this.log.log('tab_opened', { buyerId, creditLimit: tab.creditLimit });
    this.save();
    return tab;
  }

  listTabs(): Tab[] {
    return Object.values(this.state.tabs);
  }

  private appendEntry(tab: Tab, entry: Omit<Entry, 'id' | 'ts' | 'balanceAfter'>): Entry {
    const full: Entry = {
      id: `e${String(tab.entries.length + 1).padStart(5, '0')}`,
      ts: new Date().toISOString(),
      balanceAfter: tab.balance,
      ...entry,
    };
    tab.entries.push(full);
    tab.updatedAt = full.ts;
    return full;
  }

  /**
   * Would this charge be allowed? Same rules as `charge`, but nothing is
   * written. Lets a caller refuse a request up front and only bill once the
   * work actually succeeded.
   *
   * @throws TabError CREDIT_EXCEEDED | TAB_DELINQUENT
   */
  precheck(buyerId: string, toolName: string, price: string): void {
    const tab = this.getTab(buyerId);
    if (tab.status === 'delinquent') {
      throw new TabError('TAB_DELINQUENT', 'tab is cut off pending settlement', {
        buyerId,
        balance: tab.balance,
      });
    }
    if (toCents(tab.balance) + toCents(price) > toCents(tab.creditLimit)) {
      throw new TabError('CREDIT_EXCEEDED', 'charge would exceed the tab credit limit', {
        buyerId,
        toolName,
        price: normalizeAmount(price),
        balance: tab.balance,
        creditLimit: tab.creditLimit,
      });
    }
  }

  /**
   * Bill one tool call against a buyer's tab. Pure bookkeeping — no network.
   * @throws TabError CREDIT_EXCEEDED | TAB_DELINQUENT
   */
  charge(buyerId: string, toolName: string, price: string): ChargeResult {
    this.precheck(buyerId, toolName, price);
    const tab = this.getTab(buyerId);
    const nextCents = toCents(tab.balance) + toCents(price);
    tab.balance = fromCents(nextCents);
    const entry = this.appendEntry(tab, {
      type: 'charge',
      toolName,
      amount: normalizeAmount(price),
    });
    this.save();
    this.log.log('charge', {
      buyerId,
      toolName,
      amount: entry.amount,
      balance: tab.balance,
      creditLimit: tab.creditLimit,
    });
    this.emit('charge', { tab, entry });
    this.emit('change', this.snapshot());
    return { tab, entry };
  }

  /** Cut a buyer off — charges are refused until the tab is settled. */
  cutoff(buyerId: string, reason = 'overdue'): Tab {
    const tab = this.getTab(buyerId);
    tab.status = 'delinquent';
    const entry = this.appendEntry(tab, { type: 'cutoff', amount: '0.00', meta: { reason } });
    this.save();
    this.log.log('cutoff', { buyerId, reason, balance: tab.balance });
    this.emit('cutoff', { tab, entry });
    this.emit('change', this.snapshot());
    return tab;
  }

  /** Restore service after settlement. */
  reopen(buyerId: string): Tab {
    const tab = this.getTab(buyerId);
    tab.status = 'open';
    const entry = this.appendEntry(tab, { type: 'reopen', amount: '0.00' });
    this.save();
    this.log.log('reopen', { buyerId, balance: tab.balance });
    this.emit('reopen', { tab, entry });
    this.emit('change', this.snapshot());
    return tab;
  }

  // -------------------------------------------------------------------------
  // Settlement
  // -------------------------------------------------------------------------

  /**
   * Close the current billing cycle: aggregate unbilled charges into line
   * items, issue an invoice through the adapter, and mark the tab `settling`.
   *
   * Idempotent: while an unpaid invoice exists for a buyer, calling settle
   * again returns that same invoice (`created: false`) — no second invoice, no
   * second charge.
   */
  async settle(buyerId: string): Promise<SettleResult> {
    const inFlight = this.settling.get(buyerId);
    if (inFlight) return await inFlight;
    const p = this.settleInner(buyerId).finally(() => this.settling.delete(buyerId));
    this.settling.set(buyerId, p);
    return await p;
  }

  private async settleInner(buyerId: string): Promise<SettleResult> {
    const tab = this.getTab(buyerId);

    const open = this.state.invoices.find((i) => i.buyerId === buyerId && i.status === 'sent');
    if (open) {
      this.log.log('settle_idempotent', { buyerId, referenceId: open.referenceId });
      return { invoice: open, created: false };
    }

    const lines = this.unbilledLines(tab);
    if (lines.length === 0 || toCents(tab.balance) === 0) {
      throw new TabError('NOTHING_TO_SETTLE', 'no unbilled charges on this tab', { buyerId });
    }

    const cycle = this.nextCycle(buyerId);
    const referenceId = `tab-${buyerId}-${cycle}`;
    const amount = tab.balance;

    const adapterInvoice = await this.adapter.sendInvoice({
      toEmail: this.identity.buyerEmail,
      amount,
      // `--wallet-id` is repeatable; one seller wallet is the normal case.
      walletIds: this.identity.sellerWalletId ? [this.identity.sellerWalletId] : [],
      lines,
      stableCoin: this.stableCoin,
      // The reference id rides in the memo so the buyer can match the invoice
      // to the payout it must send.
      memo: referenceId,
    });

    const invoice: LedgerInvoice = {
      referenceId,
      buyerId,
      cycle,
      amount,
      status: 'sent',
      createdAt: new Date().toISOString(),
      lines,
      receiverEmail: this.identity.sellerEmail,
      chain: this.chain,
      stableCoin: this.stableCoin,
      adapter: adapterInvoice,
    };
    this.state.invoices.push(invoice);
    tab.status = 'settling';
    const entry = this.appendEntry(tab, {
      type: 'invoice',
      amount,
      referenceId,
      meta: { invoiceId: adapterInvoice.id, lines: lines.length },
    });
    this.save();
    this.log.log('invoice_issued', {
      buyerId,
      referenceId,
      amount,
      invoiceId: adapterInvoice.id,
      lines,
    });
    this.emit('invoice', { tab, entry, invoice });
    this.emit('change', this.snapshot());
    return { invoice, created: true };
  }

  /**
   * Aggregate charges since the last invoice into `desc|qty|price` line items,
   * one per tool and unit price.
   */
  private unbilledLines(tab: Tab): InvoiceLine[] {
    const lastInvoiceIdx = findLastIndex(tab.entries, (e) => e.type === 'invoice');
    const since = tab.entries.slice(lastInvoiceIdx + 1);
    const buckets = new Map<string, InvoiceLine>();
    for (const e of since) {
      if (e.type !== 'charge') continue;
      const desc = e.toolName ?? 'tool_call';
      const key = `${desc}@${e.amount}`;
      const found = buckets.get(key);
      if (found) found.qty += 1;
      else buckets.set(key, { desc, qty: 1, unitPrice: e.amount });
    }
    return [...buckets.values()];
  }

  /**
   * Billing cycle id. Base is the ISO week (`2026w33`); repeat cycles inside the
   * same week get a `.n` suffix so each reference id stays unique while keeping
   * the `tab-{buyerId}-{cycle}` shape.
   */
  private nextCycle(buyerId: string): string {
    const week = isoWeek(new Date());
    const used = this.state.invoices.filter(
      (i) => i.buyerId === buyerId && i.cycle.split('.')[0] === week,
    ).length;
    return used === 0 ? week : `${week}.${used + 1}`;
  }

  /** Look up an invoice by its reference id. */
  getInvoice(referenceId: string): LedgerInvoice | undefined {
    return this.state.invoices.find((i) => i.referenceId === referenceId);
  }

  listInvoices(filter?: { buyerId?: string; status?: 'sent' | 'paid' }): LedgerInvoice[] {
    return this.state.invoices.filter(
      (i) =>
        (filter?.buyerId === undefined || i.buyerId === filter.buyerId) &&
        (filter?.status === undefined || i.status === filter.status),
    );
  }

  /**
   * Record that an invoice was paid, clearing it off the tab.
   *
   * Idempotent on referenceId: replaying a payment for an already-paid invoice
   * is a no-op (`applied: false`) and never credits the tab twice.
   */
  applyPayment(p: ApplyPaymentParams): ApplyPaymentResult {
    const invoice = this.getInvoice(p.referenceId);
    if (!invoice) {
      throw new TabError('INVOICE_NOT_FOUND', 'no invoice with that reference id', {
        referenceId: p.referenceId,
      });
    }
    const tab = this.getTab(invoice.buyerId);
    if (invoice.status === 'paid') {
      this.log.log('payment_replay_ignored', { referenceId: p.referenceId, amount: invoice.amount });
      return { invoice, applied: false, tab };
    }
    if (toCents(p.amount) !== toCents(invoice.amount)) {
      throw new TabError('AMOUNT_MISMATCH', 'payment amount does not match the invoice', {
        referenceId: p.referenceId,
        paid: normalizeAmount(p.amount),
        invoiced: invoice.amount,
      });
    }

    invoice.status = 'paid';
    invoice.paidAt = new Date().toISOString();
    if (p.payout) invoice.payment = p.payout;
    if (p.claim) invoice.claim = p.claim;
    if (p.payout && !p.claim) {
      // Funded but not proven delivered. Recorded rather than rejected (manual
      // reconciliation goes through the same path), but it is worth flagging.
      this.log.log('payment_without_claim', {
        referenceId: p.referenceId,
        claimLinkId: p.payout.claimLinkId,
        note: 'funding recorded with no claim proof — verify the link was claimed',
      });
    }
    tab.balance = fromCents(toCents(tab.balance) - toCents(invoice.amount));
    tab.status = 'open';
    const entry = this.appendEntry(tab, {
      type: 'payment',
      amount: `-${invoice.amount}`,
      referenceId: invoice.referenceId,
      meta: { invoiceId: invoice.adapter.id },
    });
    for (const command of toArray(p.cliEcho)) this.pushCliEcho(command, 'buyer');
    this.save();
    this.log.log('payment_applied', {
      buyerId: tab.buyerId,
      referenceId: invoice.referenceId,
      amount: invoice.amount,
      balance: tab.balance,
    });
    this.emit('payment', { tab, entry, invoice });
    this.emit('change', this.snapshot());
    return { invoice, applied: true, tab };
  }

  // -------------------------------------------------------------------------
  // CLI echo log (demo surface)
  // -------------------------------------------------------------------------

  /** Record the equivalent real CLI command for something that just happened. */
  pushCliEcho(command: string, actor: 'seller' | 'buyer'): void {
    this.state.cliLog.push({
      ts: new Date().toISOString(),
      actor,
      command,
      adapter: this.adapter.kind,
    });
    if (this.state.cliLog.length > CLI_LOG_LIMIT) {
      this.state.cliLog.splice(0, this.state.cliLog.length - CLI_LOG_LIMIT);
    }
    this.save();
    this.emit('cli-echo', { command, actor });
    this.emit('change', this.snapshot());
  }

  /** Bind this ledger's echo log to an adapter's echo hook. */
  cliEchoSink = (command: string, actor: 'seller' | 'buyer'): void => {
    this.pushCliEcho(command, actor);
  };

  // -------------------------------------------------------------------------
  // Read model
  // -------------------------------------------------------------------------

  /**
   * Point-in-time read model. Deep-copied on purpose: a caller that holds on to
   * a snapshot (a poller diffing against the previous one, say) must not see it
   * mutate as new charges land.
   */
  snapshot(): LedgerSnapshot {
    return structuredClone({
      version: LEDGER_VERSION,
      adapter: this.adapter.kind,
      tabs: this.listTabs(),
      invoices: this.state.invoices,
      cliLog: this.state.cliLog,
      updatedAt: new Date().toISOString(),
    });
  }

  /** Total of everything invoiced but not yet paid, in canonical string form. */
  outstanding(buyerId: string): string {
    return fromCents(
      this.listInvoices({ buyerId, status: 'sent' }).reduce((s, i) => s + toCents(i.amount), 0),
    );
  }

  /** Amount a set of line items adds up to. */
  static lineTotal(lines: InvoiceLine[]): string {
    return fromCents(lines.reduce((s, l) => s + toCents(multiplyAmount(l.unitPrice, l.qty)), 0));
  }
}

function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function findLastIndex<T>(arr: T[], pred: (t: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i] as T)) return i;
  }
  return -1;
}

/** ISO-8601 week id, e.g. `2026w33`. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${t.getUTCFullYear()}w${String(week).padStart(2, '0')}`;
}
