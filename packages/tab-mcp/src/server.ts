/**
 * Tab's own MCP server: three tools that let an agent put billing on an
 * existing MCP server in one sentence.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { addBilling, setPricing, tabStatus } from './actions.js';

export const TAB_MCP_INFO = { name: 'tab', version: '0.1.0' } as const;

function report(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function failure(e: unknown): CallToolResult {
  return { content: [{ type: 'text', text: `Tab could not do that: ${(e as Error).message}` }], isError: true };
}

export function createTabMcpServer(): McpServer {
  const server = new McpServer(TAB_MCP_INFO);

  server.registerTool(
    'add_billing',
    {
      title: 'Add billing to an MCP server',
      description:
        'Generate tab.config.json for an MCP server and explain how to wire the billing middleware in. ' +
        'Use this when someone wants to charge for their MCP tools.',
      inputSchema: {
        serverPath: z
          .string()
          .describe('Path to the MCP server file, or the project directory that contains it'),
        defaultPrice: z
          .string()
          .optional()
          .describe('Price per call in USD, e.g. "0.01" for one cent. Default "0.01"'),
        billingCycle: z
          .enum(['manual', 'threshold'])
          .optional()
          .describe('"threshold" invoices automatically; "manual" waits to be asked. Default "threshold"'),
        settleThreshold: z
          .string()
          .optional()
          .describe('Balance that closes a billing cycle, e.g. "0.50"'),
        creditLimit: z
          .string()
          .optional()
          .describe('How much a buyer may run up before calls are refused with a 402'),
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        return report(addBilling(args).report);
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'set_pricing',
    {
      title: 'Set the price of one tool',
      description: 'Override the per-call price of a single tool in tab.config.json.',
      inputSchema: {
        toolName: z.string().describe('Tool name as registered on the MCP server'),
        price: z.string().describe('Price per call in USD, e.g. "0.02"'),
        configPath: z
          .string()
          .optional()
          .describe('tab.config.json to edit, or the directory holding it. Default ./tab.config.json'),
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        return report(setPricing(args).report);
      } catch (e) {
        return failure(e);
      }
    },
  );

  server.registerTool(
    'tab_status',
    {
      title: 'Tab status',
      description:
        'Show the current tab: unbilled balance, credit limit, recent billed calls, invoices awaiting payout.',
      inputSchema: {
        buyerId: z.string().optional().describe('Only show this buyer, e.g. "claude"'),
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const result = await tabStatus(args);
        return report(result.report);
      } catch (e) {
        return failure(e);
      }
    },
  );

  return server;
}
