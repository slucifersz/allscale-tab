# Tab

**Credit and settlement for the AI agent economy.** Put one middleware in front of any
MCP server and the agents calling it can run a tab: consume now, settle on terms.

The buyer sets a spending fence once — per-transaction cap, total cap, expiry. After that,
every paid tool call is a local ledger entry: no payment round-trip, no per-call latency, no
money moving. When the tab hits a threshold or the billing period closes, Tab invoices,
the buyer's kit pays, and the tab clears. Miss the settlement and service stops.

```
agent ──MCP──▶ [ tab middleware ] ──▶ your tools
                     │
                     ├─ charge locally (no network, no money moves)
                     ├─ over the limit → 402 PAYMENT_REQUIRED
                     └─ threshold hit  → invoice ──▶ buyer kit ──▶ payout ──▶ tab cleared
                                                          │
                                        every money move goes through one
                                        SettlementAdapter → AllScale CLI
```

## Quickstart

```bash
npm install
npm test              # unit + end-to-end tests (100)
npm run self-test     # live checklist: accumulate → invoice → fund → claim → 402
./demo/run-demo.sh
```

With the AllScale CLI installed and logged in, these check it directly:

```bash
npm run capture:help    # capture the CLI surface locally (git-ignored)
npm run verify:chains   # re-derive the chain id table, fail on drift
node scripts/cli-probe.mjs   # per-method: live-ok / argv-only / blocked
npm run test:cli        # the suite with TAB_ADAPTER=cli
```

The demo builds everything, starts the live ledger page on <http://127.0.0.1:4790>, starts the
buyer's settlement daemon, then runs an agent that makes 60 paid calls. You will see the balance
climb, the cycle close itself with an `allscale invoice send`, the buyer answer with an
`allscale payout send` + `allscale claim-link claim`, the balance drop to zero, and — once the
tab is cut off — calls come back as `402 PAYMENT_REQUIRED` before service resumes.

Everything runs on the **stub adapter** by default: no credentials, no network, no money.

## Make your own MCP server paid

Three lines:

```ts
import { createRuntime, attachBilling } from '@tab/middleware';
import { startLedgerServer } from '@tab/core';

const { ledger, config } = createRuntime();     // reads tab.config.json, picks the adapter
attachBilling(server, { ledger, config });      // every tool on `server` is now billed
await startLedgerServer({ ledger });            // optional: GET /ledger for the UI
```

Or let an agent do it — Tab ships its own MCP server (`@tab/tab-mcp`) with `add_billing`,
`set_pricing` and `tab_status`:

```bash
claude mcp add tab -- node packages/tab-mcp/dist/src/bin/server.js
# then: "add billing to ./packages/example-server, one cent per call"
```

### tab.config.json

```json
{
  "pricing": { "default": "0.01", "tools": { "fx_rate": "0.01", "fx_convert": "0.02" } },
  "settleThreshold": "0.50",
  "billingCycle": "threshold",
  "creditLimit": "0.60"
}
```

| Field | Meaning |
| --- | --- |
| `pricing.default` | Charged for any tool without an override. `"0.00"` makes a tool free. |
| `pricing.tools` | Per-tool prices. |
| `settleThreshold` | Balance that closes a billing cycle. |
| `billingCycle` | `threshold` invoices automatically; `manual` waits for `POST /settle`. |
| `creditLimit` | How far a buyer may run up before calls are refused with a 402. |

All amounts are fixed-point decimal strings and are computed on as integer cents. No floats
touch money.

### The 402

A call that cannot be served is answered in an x402-shaped envelope, both as text and in the
result's `_meta['tab/payment_required']`:

```json
{
  "code": 402,
  "error": "PAYMENT_REQUIRED",
  "tab": {
    "balance": "0.50",
    "creditLimit": "0.50",
    "settleUrl": "http://127.0.0.1:4788/settle",
    "status": "settling",
    "reason": "CREDIT_EXCEEDED",
    "referenceId": "tab-claude-2026w33"
  }
}
```

This is the response *shape* only — protocol-level x402 signature verification is not
implemented (see Roadmap).

## Packages

| Package | What it is |
| --- | --- |
| `@tab/core` | Ledger engine, `SettlementAdapter` contract, stub + CLI adapters, read-only HTTP API |
| `@tab/middleware` | `attachBilling(server, …)` — makes any MCP server's tools paid |
| `@tab/example-server` | A paid MCP server (`fx_rate`, `fx_convert`) plus the demo consumption driver |
| `@tab/tab-mcp` | Tab's own MCP server: `add_billing`, `set_pricing`, `tab_status` |
| `@tab/buyer-kit` | Buyer daemon: validates invoices against the fence, pays them, echoes the real CLI command |
| `@tab/ledger-ui` | Single-page live ledger (vanilla JS, polls `GET /ledger`) |

### Ledger API

Owned by the MCP server process — the single writer.

| Route | Purpose |
| --- | --- |
| `GET /ledger` | Full snapshot: tabs, entries, invoices, CLI echo log |
| `GET /invoices?status=sent` | Bills awaiting payment |
| `POST /payments` | Report a funded **and claimed** payout (idempotent on `referenceId`) |
| `POST /settle` | Close the current cycle manually |
| `POST /cutoff` · `POST /reopen` | Suspend or restore service |

## Settlement

Every money movement — and only these — goes through `SettlementAdapter`:

| Adapter call | Real command |
| --- | --- |
| `enableFence` | *(no CLI command — granted in the dashboard)*, confirmed with `allscale payout status --json` |
| `fenceStatus` | `allscale payout status --json` |
| `sendPayout` | `allscale payout send --amount … --chain … --stable-coin … --reference-id … [--receiver-email …] --json` |
| `claimPayout` | `allscale claim-link claim --claim-token … --to-wallet --json` |
| `sendInvoice` | `allscale invoice send --to-email … --amount … --line "desc\|qty\|total" --wallet-id … --payment-type 1 --memo … --json` |
| `listTransactions` | `allscale transaction list --json` |

**Settlement is two steps, not one.** `payout send` does not pay the seller: it funds a
**Claim Link** which the receiver must then claim, and the link expires within minutes
(~21 observed) — an unclaimed link is refunded to the buyer and the bill stays unpaid. So the
buyer kit funds and claims as one serialised step, and a bill is only marked paid once the
claim is proven. Authorization is granted per **chain × token pair** in the dashboard
(Store Settings → Payout Authorization); an undelegated pair is refused with
`FENCE_NOT_AUTHORIZED`.

Defaults are `sepolia` / `USDT`, set with `TAB_CHAIN` and `TAB_STABLE_COIN`.

`TAB_ADAPTER=stub` (default) runs the local stub. `TAB_ADAPTER=cli` targets the real CLI.

**The CLI adapter requires the AllScale CLI, which is in private beta.** It is implemented
against the real command surface: every flag was read off `--help`, and every difference from
the original design assumptions is itemised in [`docs/DIFF.md`](docs/DIFF.md). What has and has
not been verified against the live API is recorded in
[`docs/cli-mode-report.md`](docs/cli-mode-report.md) — notably the payout + claim leg needs
store credentials to exercise, and fails closed without them.

Ambiguous outcomes are never treated as failures: on an ambiguous exit or a timeout, Tab
checks `payout status` first, then retries the **same** `--reference-id`, which the backend
deduplicates.

Stub output follows the same discipline: fields whose names are not documented are not
invented — they live under `raw` with a TODO, and stub-generated values are prefixed `stub_`
so no demo output can be mistaken for a real settlement. The stub also models the two-step
claim flow, per-pair authorization, claim-link expiry and in-flight funding, so the failure
modes are reachable without touching money.

The claim token — and the claim URL, which embeds it — are bearer credentials. Neither is
logged, persisted to the ledger, or shown in the UI.

### Credentials

Read from the environment only, never from code or a config file, never logged:

| Variable | Used by |
| --- | --- |
| `ALLSCALE_STORE_API_KEY` | `payout send` (store-key HMAC — **not** your CLI login) |
| `ALLSCALE_STORE_API_SECRET` | `payout send` (prefer the env var; a flag value leaks via shell history) |

The other commands use the CLI's own session (`allscale device-login`), which needs the
`invoice:all`, `claim_link:all`, `wallet:read_only` and `transaction:read_only` scopes.

See [`.env.example`](.env.example) for the full list of settings (names only, no values).
`.env`, `credentials`, and `*.key` are git-ignored.

## Roadmap (not implemented)

Deliberately out of scope for this build:

- Usage-tier / volume pricing
- Multi-currency tabs (one stablecoin per tab today)
- Credit scoring and dynamic limits
- Dispute and arbitration flow
- Protocol-level x402 signature verification (only the response shape is implemented)

## Requirements

Node.js ≥ 20.10, npm. TypeScript is compiled to `dist/` — no runtime type-stripping needed.
