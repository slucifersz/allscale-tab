/**
 * A minimal paid MCP server: two FX tools, billed by @tab/middleware.
 *
 * The tools themselves know nothing about money. Pricing lives in
 * tab.config.json; `attachBilling` is the only line that makes them paid.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { attachBilling, type BillingController, type TabConfig } from '@tab/middleware';
import type { Ledger } from '@tab/core';

import { SUPPORTED_CURRENCIES, convert, quote } from './rates.js';

export const EXAMPLE_SERVER_INFO = { name: 'fx-example', version: '0.1.0' } as const;

/** Prices this server ships with, unless tab.config.json says otherwise. */
export const EXAMPLE_PRICING = { fx_rate: '0.01', fx_convert: '0.02' } as const;

export interface ExampleServerOptions {
  ledger: Ledger;
  config?: TabConfig;
  /** Override buyer identity; by default the connected client's name is used. */
  buyerId?: string;
  settleUrl?: string;
}

export interface ExampleServer {
  server: McpServer;
  billing: BillingController;
}

function json(payload: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function failed(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function createExampleServer(opts: ExampleServerOptions): ExampleServer {
  const server = new McpServer(EXAMPLE_SERVER_INFO);

  const billing = attachBilling(server, {
    ledger: opts.ledger,
    ...(opts.config === undefined ? {} : { config: opts.config }),
    ...(opts.buyerId === undefined ? {} : { buyerId: opts.buyerId }),
    ...(opts.settleUrl === undefined ? {} : { settleUrl: opts.settleUrl }),
  });

  const currency = z
    .string()
    .describe(`ISO currency code, one of: ${SUPPORTED_CURRENCIES.join(', ')}`);

  server.registerTool(
    'fx_rate',
    {
      title: 'FX rate',
      description: 'Current exchange rate for a currency pair.',
      inputSchema: { from: currency, to: currency },
    },
    async ({ from, to }): Promise<CallToolResult> => {
      try {
        return json(quote(from, to));
      } catch (e) {
        return failed((e as Error).message);
      }
    },
  );

  server.registerTool(
    'fx_convert',
    {
      title: 'FX convert',
      description: 'Convert an amount from one currency to another.',
      inputSchema: {
        amount: z.string().describe('Amount to convert, e.g. "125.00"'),
        from: currency,
        to: currency,
      },
    },
    async ({ amount, from, to }): Promise<CallToolResult> => {
      try {
        return json(convert(amount, from, to));
      } catch (e) {
        return failed((e as Error).message);
      }
    },
  );

  return { server, billing };
}
