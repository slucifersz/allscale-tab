/**
 * Read-mostly HTTP surface over a Ledger.
 *
 * The MCP server process owns the Ledger (single writer). The ledger UI and the
 * buyer kit are separate processes and talk to it through here.
 *
 *   GET  /health
 *   GET  /ledger                    full snapshot (ledger UI polls this)
 *   GET  /invoices?status=sent      open bills (buyer kit polls this)
 *   POST /payments                  {referenceId, amount, payout?, cliEcho?}
 *   POST /settle                    {buyerId}          — manual cycle close
 *   POST /cutoff                    {buyerId, reason?} — demo: cut service off
 *   POST /reopen                    {buyerId}
 */
import http from 'node:http';

import { isTabError } from './errors.js';
import type { Ledger } from './ledger.js';
import { createLogger } from './log.js';

const log = createLogger('ledger-api');

export interface LedgerServerOptions {
  ledger: Ledger;
  port?: number;
  host?: string;
}

export interface LedgerServer {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...CORS,
  });
  res.end(payload);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string' || v === '') throw new Error(`BAD_REQUEST: "${field}" is required`);
  return v;
}

export async function startLedgerServer(opts: LedgerServerOptions): Promise<LedgerServer> {
  const { ledger } = opts;
  const port = opts.port ?? Number(process.env.TAB_LEDGER_PORT ?? 4788);
  const host = opts.host ?? process.env.TAB_LEDGER_HOST ?? '127.0.0.1';

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      if (isTabError(e)) {
        send(res, 409, { error: e.code, message: e.message, details: e.details });
        return;
      }
      const message = (e as Error).message ?? 'internal error';
      send(res, message.startsWith('BAD_REQUEST') ? 400 : 500, { error: 'ERROR', message });
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);
    const route = `${req.method} ${url.pathname}`;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return;
    }

    switch (route) {
      case 'GET /health':
        send(res, 200, { ok: true, adapter: ledger.adapter.kind });
        return;

      case 'GET /ledger':
        send(res, 200, ledger.snapshot());
        return;

      case 'GET /invoices': {
        const status = url.searchParams.get('status');
        const buyerId = url.searchParams.get('buyerId');
        send(res, 200, {
          invoices: ledger.listInvoices({
            ...(status === 'sent' || status === 'paid' ? { status } : {}),
            ...(buyerId ? { buyerId } : {}),
          }),
        });
        return;
      }

      case 'POST /payments': {
        const body = await readJson(req);
        const result = ledger.applyPayment({
          referenceId: str(body['referenceId'], 'referenceId'),
          amount: str(body['amount'], 'amount'),
          ...(body['payout'] ? { payout: body['payout'] as never } : {}),
          // The claim is the leg that proves delivery — without it a payment is
          // only funded. It must not be dropped on the way in.
          ...(body['claim'] ? { claim: body['claim'] as never } : {}),
          ...(typeof body['cliEcho'] === 'string' || Array.isArray(body['cliEcho'])
            ? { cliEcho: body['cliEcho'] as string | string[] }
            : {}),
        });
        send(res, 200, {
          applied: result.applied,
          invoice: result.invoice,
          tab: result.tab,
        });
        return;
      }

      case 'POST /settle': {
        const body = await readJson(req);
        const result = await ledger.settle(str(body['buyerId'], 'buyerId'));
        send(res, 200, result);
        return;
      }

      case 'POST /cutoff': {
        const body = await readJson(req);
        const reason = typeof body['reason'] === 'string' ? body['reason'] : undefined;
        send(res, 200, {
          tab: ledger.cutoff(str(body['buyerId'], 'buyerId'), ...(reason ? [reason] : [])),
        });
        return;
      }

      case 'POST /reopen': {
        const body = await readJson(req);
        send(res, 200, { tab: ledger.reopen(str(body['buyerId'], 'buyerId')) });
        return;
      }

      default:
        send(res, 404, { error: 'NOT_FOUND', route });
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  // With port 0 the OS picks one, so report what we actually got.
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  log.log('listening', { url: `http://${host}:${boundPort}`, adapter: ledger.adapter.kind });

  return {
    server,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
