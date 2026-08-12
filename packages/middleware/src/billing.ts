/**
 * Billing middleware for MCP servers.
 *
 * `attachBilling(server, { ledger })` makes every tool on an existing MCP
 * server paid, without touching the tool implementations:
 *
 *   - a call inside the buyer's credit → charged locally and let through
 *     (bookkeeping only: no network call, no perceptible latency)
 *   - over the limit, or a cut-off tab → a 402-shaped refusal
 *   - balance reaches settleThreshold → the cycle closes and invoices itself
 *
 * A tool call is only billed if it actually succeeded: the credit check runs
 * before the handler, the charge lands after it. Failed calls are free.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createLogger, isTabError, toCents, type Ledger, type Logger } from '@tab/core';

import { loadConfig, priceFor, type TabConfig } from './config.js';
import { paymentRequired, paymentRequiredResult, type PaymentRequired } from './payment-required.js';

export interface BillingOptions {
  ledger: Ledger;
  /** Defaults to `tab.config.json`, or built-in defaults when absent. */
  config?: TabConfig;
  /** Where a buyer settles. Defaults to the ledger API's /settle. */
  settleUrl?: string;
  /**
   * Who to bill. Defaults to the connected MCP client's name, falling back to
   * `TAB_BUYER_ID` and then `anonymous`.
   */
  buyerId?: string | (() => string);
  logger?: Logger;
}

/** Tool handlers are `(args?, extra)` — shapes vary, so bill around them opaquely. */
type AnyHandler = (...args: unknown[]) => unknown;

export class BillingController {
  readonly ledger: Ledger;
  readonly config: TabConfig;
  readonly settleUrl: string;

  private readonly server: McpServer;
  private readonly buyerIdOption: BillingOptions['buyerId'];
  private readonly log: Logger;
  private readonly settleTasks = new Set<Promise<unknown>>();

  constructor(server: McpServer, opts: BillingOptions) {
    this.server = server;
    this.ledger = opts.ledger;
    this.config = opts.config ?? loadConfig().config;
    this.settleUrl =
      opts.settleUrl ??
      process.env.TAB_SETTLE_URL ??
      `http://127.0.0.1:${process.env.TAB_LEDGER_PORT ?? 4788}/settle`;
    this.buyerIdOption = opts.buyerId;
    this.log = opts.logger ?? createLogger('middleware');
  }

  /** Identify the paying agent. */
  resolveBuyerId(): string {
    if (typeof this.buyerIdOption === 'function') return this.buyerIdOption();
    if (typeof this.buyerIdOption === 'string') return this.buyerIdOption;
    const client = this.server.server.getClientVersion?.();
    return client?.name ?? process.env.TAB_BUYER_ID ?? 'anonymous';
  }

  priceFor(toolName: string): string {
    return priceFor(this.config, toolName);
  }

  /** Build the 402 payload for a buyer that cannot be served right now. */
  private refuse(
    buyerId: string,
    toolName: string,
    reason: 'CREDIT_EXCEEDED' | 'TAB_DELINQUENT',
  ): PaymentRequired {
    const tab = this.ledger.getTab(buyerId);
    const openInvoice = this.ledger.listInvoices({ buyerId, status: 'sent' })[0];
    const payload = paymentRequired({
      balance: tab.balance,
      creditLimit: tab.creditLimit,
      settleUrl: this.settleUrl,
      status: tab.status,
      reason,
      price: this.priceFor(toolName),
      ...(openInvoice ? { referenceId: openInvoice.referenceId } : {}),
    });
    this.log.log('payment_required', { buyerId, toolName, ...payload.tab });
    return payload;
  }

  /**
   * Meter one tool call: check credit, run the tool, then bill it.
   * Returns the tool's own result, or a 402 result when the tab is not good.
   */
  async meter(toolName: string, run: () => Promise<CallToolResult>): Promise<CallToolResult> {
    const buyerId = this.resolveBuyerId();
    const price = this.priceFor(toolName);

    // tab.config.json is the source of truth for the credit limit, so apply it
    // to the tab (opening it on first sight) before checking anything.
    if (this.config.creditLimit !== undefined) {
      this.ledger.getTab(buyerId, this.config.creditLimit);
    }

    if (toCents(price) === 0) {
      this.log.log('free_call', { buyerId, toolName });
      return await run();
    }

    try {
      this.ledger.precheck(buyerId, toolName, price);
    } catch (e) {
      if (isTabError(e) && (e.code === 'CREDIT_EXCEEDED' || e.code === 'TAB_DELINQUENT')) {
        return paymentRequiredResult(this.refuse(buyerId, toolName, e.code)) as CallToolResult;
      }
      throw e;
    }

    const result = await run();

    // Don't bill for a call that failed.
    if (result?.isError === true) {
      this.log.log('charge_skipped_tool_error', { buyerId, toolName, price });
      return result;
    }

    this.ledger.charge(buyerId, toolName, price);
    this.maybeSettle(buyerId);
    return result;
  }

  /** Close the cycle when the balance reaches the threshold. */
  private maybeSettle(buyerId: string): void {
    if (this.config.billingCycle !== 'threshold') return;
    const tab = this.ledger.getTab(buyerId);
    if (toCents(tab.balance) < toCents(this.config.settleThreshold)) return;

    this.log.log('threshold_reached', {
      buyerId,
      balance: tab.balance,
      settleThreshold: this.config.settleThreshold,
    });
    // Settlement runs outside the tool response path — the caller never waits
    // on it. Ledger.settle is idempotent, so a burst of calls is harmless.
    const task = this.ledger
      .settle(buyerId)
      .then((r) => {
        this.log.log('settle_triggered', {
          buyerId,
          referenceId: r.invoice.referenceId,
          amount: r.invoice.amount,
          created: r.created,
        });
      })
      .catch((e: unknown) => {
        this.log.log('settle_failed', { buyerId, error: (e as Error).message });
      })
      .finally(() => this.settleTasks.delete(task));
    this.settleTasks.add(task);
  }

  /** Wait for background settlements to finish. Used by tests and the demo. */
  async idle(): Promise<void> {
    while (this.settleTasks.size > 0) {
      await Promise.all([...this.settleTasks]);
    }
  }
}

/**
 * Make every tool on `server` billable — those already registered, and any
 * registered later.
 */
export function attachBilling(server: McpServer, opts: BillingOptions): BillingController {
  const controller = new BillingController(server, opts);
  const log = opts.logger ?? createLogger('middleware');

  const wrap = (toolName: string, handler: AnyHandler): AnyHandler => {
    return async (...args: unknown[]) =>
      await controller.meter(toolName, async () => {
        return (await handler(...args)) as CallToolResult;
      });
  };

  // Tools registered before we attached. The SDK keeps them in a private map;
  // there is no public accessor, so reach for it defensively.
  const existing = (server as unknown as { _registeredTools?: Record<string, unknown> })
    ._registeredTools;
  if (existing) {
    for (const [name, tool] of Object.entries(existing)) {
      const entry = tool as { handler?: unknown };
      if (typeof entry.handler === 'function') {
        entry.handler = wrap(name, entry.handler as AnyHandler);
        log.log('tool_billed', { tool: name, price: controller.priceFor(name), phase: 'existing' });
      } else {
        // Experimental task-based handler: not billed. Say so loudly rather
        // than letting a paid tool serve traffic for free.
        log.log('tool_not_billed', { tool: name, reason: 'unsupported_handler_shape' });
      }
    }
  }

  // Tools registered from here on. Both the current API and the deprecated one
  // take the handler as their last argument.
  const patch = (method: 'registerTool' | 'tool'): void => {
    const target = server as unknown as Record<string, unknown>;
    const original = target[method];
    if (typeof original !== 'function') return;
    target[method] = function patched(this: unknown, ...args: unknown[]): unknown {
      const name = args[0];
      const lastIdx = args.length - 1;
      const handler = args[lastIdx];
      if (typeof name === 'string' && typeof handler === 'function') {
        args[lastIdx] = wrap(name, handler as AnyHandler);
        log.log('tool_billed', { tool: name, price: controller.priceFor(name), phase: 'register' });
      }
      return (original as (...a: unknown[]) => unknown).apply(server, args);
    };
  };
  patch('registerTool');
  patch('tool');

  log.log('billing_attached', {
    pricing: controller.config.pricing,
    settleThreshold: controller.config.settleThreshold,
    billingCycle: controller.config.billingCycle,
    adapter: controller.ledger.adapter.kind,
  });
  return controller;
}
