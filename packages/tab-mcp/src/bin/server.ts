#!/usr/bin/env node
/**
 * Tab's configuration MCP server, over stdio.
 *
 * Register it with an agent (e.g. `claude mcp add tab -- node
 * packages/tab-mcp/dist/src/bin/server.js`) and "add billing to my server, one
 * cent per call" becomes a single tool call.
 *
 * stdout is the MCP channel, so logs go to stderr.
 */
process.env.TAB_LOG_STREAM = 'stderr';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createLogger } from '@tab/core';

import { createTabMcpServer } from '../server.js';

const log = createLogger('tab-mcp');

async function main(): Promise<void> {
  const server = createTabMcpServer();
  await server.connect(new StdioServerTransport());
  log.log('ready', {
    transport: 'stdio',
    tools: ['add_billing', 'set_pricing', 'tab_status'],
    cwd: process.cwd(),
  });
}

void main().catch((e: unknown) => {
  log.log('fatal', { error: (e as Error).message });
  process.exit(1);
});
