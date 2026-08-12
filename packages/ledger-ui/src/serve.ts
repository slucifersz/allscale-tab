#!/usr/bin/env node
/**
 * Static host for the live ledger page.
 *
 * It serves one HTML file plus `/config.json`, which tells the page where the
 * ledger API lives and what the invoicing threshold is (for the progress-bar
 * marker). No build step, no framework.
 */
import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, '../../public');

const PORT = Number(process.env.TAB_UI_PORT ?? 4790);
const HOST = process.env.TAB_UI_HOST ?? '127.0.0.1';
const API_BASE =
  process.env.TAB_LEDGER_API ?? `http://127.0.0.1:${process.env.TAB_LEDGER_PORT ?? 4788}`;

function log(event: string, data: Record<string, unknown> = {}): void {
  const stream = process.env.TAB_LOG_STREAM === 'stderr' ? process.stderr : process.stdout;
  stream.write(JSON.stringify({ ts: new Date().toISOString(), module: 'ledger-ui', event, data }) + '\n');
}

/** Read settleThreshold out of tab.config.json when it is available. */
function settleThreshold(): string | undefined {
  const file = path.resolve(process.env.TAB_CONFIG ?? 'tab.config.json');
  if (!existsSync(file)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { settleThreshold?: string };
    return parsed.settleThreshold;
  } catch {
    return undefined;
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);

  if (url.pathname === '/config.json') {
    const threshold = settleThreshold();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ apiBase: API_BASE, ...(threshold ? { settleThreshold: threshold } : {}) }));
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const file = path.join(PUBLIC_DIR, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`missing ${file}`);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, HOST, () => {
  log('listening', { url: `http://${HOST}:${PORT}`, apiBase: API_BASE, publicDir: PUBLIC_DIR });
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
