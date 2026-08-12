# Real CLI vs. the assumed surface in the design brief §4

Captured from `@allscale/cli/0.1.0 darwin-arm64` on 2026-08-12, against an internal
pre-release environment. Every claim below was verified against that CLI's own `--help`
output and live responses.

The raw `--help` capture is deliberately NOT published — it is the complete command surface
of an unreleased product. Reproduce it locally with `npm run capture:help`, which writes to
the git-ignored `docs/cli-help/`. Hostnames and environment names are replaced with
placeholders throughout.

Legend: **S** = shape difference (the design assumed the wrong model) · **F** = flag/field
difference · **B** = behavioural difference that can lose money.

---

## D1 · `payout enable` does not exist — **S**

the design brief §4 lists `payout enable --store --chain --coin --single-tx --total-cap --expires`.
There is no such command.

```
$ allscale payout enable --help
{"error":{"code":"input.invalid","message":"Unknown command `payout enable`. Run `allscale --help` to list available commands."}}
```
→ captured from `allscale payout enable --help`

The `payout` topic says so explicitly:

> Auto-payout authorization is set up in the AllScale dashboard: Store Settings → Payout
> Authorization. This CLI inspects the resulting session (`payout status`) and sends payouts
> from it (`payout send`).

**What Tab does now.** `enableFence()` never claims to create anything. It prints the
dashboard instruction, then verifies with `payout status`, and fails with `FENCE_NOT_ENABLED`
(not provisioned / not active) or `FENCE_NOT_AUTHORIZED` (pair not delegated). No blind
retry — §5's "check status first" discipline.

## D2 · `payout send` funds a claim link; it does not pay anyone — **S**, **B**

> Create and auto-fund a claim link from this store's enabled auto-payout wallet.

Settlement is **two** steps, not one: `payout send` → `claim-link claim`. The original
`SettlementAdapter` had no claim step at all, so a "successful" payout would have left the
money unclaimed.

Evidence that this loses money if ignored — a real link from an earlier run:

```json
{ "id":"6a7bf4c0e2eb941d437f9fd9", "status":5, "amount":"1", "chain":11,
  "created_at":"2026-08-12T04:21:20.899000Z",
  "expiry_at":"2026-08-12T04:47:01.635000Z",
  "claimed_via":null, "claim_tx_hash":null,
  "refund_tx_hash":"0xa47d4b70…", "refunded_at":"2026-08-12T04:50:37.723000Z" }
```

Funded, never claimed, **refunded ~26 minutes later**. The bill would have stayed unpaid
while the buyer believed it was settled.

**What Tab does now.** `SettlementAdapter` gains `claimPayout()`; `LedgerInvoice` records
`claim` alongside `payment`; the ledger logs `payment_without_claim` if a payment is
recorded with no claim proof; buyer-kit runs fund→claim as one serialised step and reports
`fundedButUnclaimed` when the claim fails.

## D3 · The claim window is minutes, and `payout send` has no `--expires` — **F**, **B**

`claim-link create` has `--expires` (`[default: 14d]`, range `1m-30d`).
`payout send` has **no** `--expires` flag (`allscale payout send --help`).

Observed windows on links created by `payout send`:

| created_at | expiry_at | window |
| --- | --- | --- |
| 05:26:17 | 05:47:13 | ~20m 56s |
| 04:21:20 | 04:47:01 | ~25m 41s |

**What Tab does now.** The claim is issued immediately after funding, in the same critical
section (see `settleInvoice`). The stub models a 21-minute TTL and a `-1` TTL is used in
tests to prove the expiry path is handled.

## D4 · `--line` takes a LINE TOTAL, not a unit price — **F**, **B**

the design brief §4: `--line "desc|qty|price"`. The CLI:

> `--line` … Two forms: `"<description>"` (qty=1, amount=full --amount) or
> `"<description>|<quantity>|<amount>"` (all explicit; same decimal units as --amount) …
> With three-field lines you may omit --amount entirely and **the CLI sums them**.

→ captured from `allscale invoice send --help`

The third field is summed as-is. Sending a unit price would have produced
`--line "fx_rate|50|0.01"` → an invoice total of **$0.01** instead of **$0.50**.

**What Tab does now.** `renderInvoiceLine()` emits `qty × unitPrice`
(`fx_rate|50|0.50`) and `--amount` is always passed explicitly as the authority. Asserted
char-exact in `stub-adapter.test.ts` and in the M2 end-to-end test.

## D5 · Authorization is isolated per chain × token — **S**

`payout status` reports `authorized_pairs { chain token_symbol policy_id }`. Live:

```json
"authorized_pairs":[
  {"chain":6,"token_symbol":"USDT","policy_id":"10c5b2d1-…"},
  {"chain":11,"token_symbol":"USDT","policy_id":"2270e6c6-…"},
  {"chain":6,"token_symbol":"USDC","policy_id":"39d04cbc-…"},
  {"chain":11,"token_symbol":"USDC","policy_id":"f89ef133-…"}]
```

A session delegated for Sepolia/USDT cannot pay Base/USDC. The original single
`chain`/`coin` fence could not express this.

**What Tab does now.** `FenceStatus.authorizedPairs`, a pre-flight pair check, and a
dedicated `FENCE_NOT_AUTHORIZED` error rather than a generic backend failure.

## D6 · `chain` is an integer in responses, a slug in flags — **F**

`payout send --chain` takes `ethereum|bsc|base|polygon|arbitrum|optimism|sepolia`, while
`authorized_pairs[].chain` is a number. The mapping is undocumented; it was read off live
`wallet list` output, which returns `chain`, `chain_name` and `eip155_chain_id` together:

| id | chain_name | eip155 | payout slug |
| --- | --- | --- | --- |
| 1 | Ethereum | 1 | `ethereum` |
| 2 | Solana | – | – |
| 3 | Tron | – | – |
| 4 | Aptos | – | – |
| 5 | Base | 8453 | `base` |
| 6 | BSC (BEP20) | 56 | `bsc` |
| 7 | Arbitrum | 42161 | `arbitrum` |
| 8 | Polygon | 137 | `polygon` |
| 9 | Optimism | 10 | `optimism` |
| 10 | TON | – | – |
| 11 | Sepolia (Ethereum testnet) | 11155111 | `sepolia` |

**What Tab does now.** `chains.ts` holds the table, flagged as empirical. An unknown slug
makes the authorization check return `unknown`, never `denied` — the CLI stays the authority.
`npm run verify:chains` re-derives the table from a live `wallet list` and fails on drift.

## D7 · The payout API is a separate origin, derived from the session — **F**

`payout send` is store-HMAC against a partner API, not the GraphQL base:

> `--payout-api-base` … Defaults to the trusted partner API matching the configured session
> environment, otherwise `<partner payout API default>`.

With this gamma-bound build the derived origin is printed on stdout as an event:

```json
{"version":"1","event":"payout_destination","payout_api_base":"<derived payout API>"}
```

Also: `--chain sepolia` is "accepted only by beta or loopback payout APIs", which is
consistent with the sandbox origin above.

**What Tab does now.** Nothing is hard-coded; the CLI's own default is used and the emitted
`payout_destination` event is captured with the rest of the output.

## D8 · stdout is a JSON *stream*, not one document — **F**

As shown above, `payout send` prints an event line and then the result. The original
`JSON.parse(stdout)` would have thrown on every payout.

**What Tab does now.** `parseJsonStream()` collects every JSON document in order and treats
the last as the result; the earlier ones are kept as `events`. Success payloads are unwrapped
from `{ "data": … }`.

## D9 · `--json` is required to get JSON at all — **F**

`--json` is a global flag, not the default (`payout status` prints prose without it).

**What Tab does now.** Every argv builder appends `--json`.

## D10 · Error semantics are a documented code table — **F**

The CLI maps failures onto stable exit codes; the ones that matter here:

| exit | meaning | Tab error |
| --- | --- | --- |
| 9 | **ambiguous mutation** (`claim_link.funding_ambiguous`, `claim.payout_ambiguous`, `wallet.transaction_status_unknown`) | `ADAPTER_AMBIGUOUS` |
| 12 | non-completion (`claim.expired`, `claim.not_claimable`, `user.cancelled`) | `CLAIM_EXPIRED` / `ADAPTER_DECLINED` |
| 8 | `rate_limited`, incl. "a create for this reference_id is already in flight" | `ADAPTER_BUSY` |
| 6 | `auth.permission_denied` — incl. "store key not authorized for auto-payout" | `FENCE_NOT_AUTHORIZED` |
| 4 / 5 | `auth.no_token` / `auth.token_expired` | `CLI_AUTH_MISSING` |
| 11 | `auth.signature_rejected` — CLI build too old | `CLI_NOT_AVAILABLE` |
| 2 | input/config, incl. `claim_link.intent_conflict` | `ADAPTER_ERROR` |

Ambiguity is never reported as failure. On exit 9 or a timeout, Tab logs `payout status`
first (the CLI's own `CREATE_ERROR` message tells you to), then re-runs the **same**
`--reference-id`, which the backend deduplicates (`idempotent_hit: true`).

## D11 · `payout send` response fields — **F**

From the CLI's own response validator: `claim_link_id`, `reference_id`, `amount`,
`token_symbol`, `chain_id`, `status`, `token`, `claim_url`, `funding_tx_hash`,
`funded_amount`, `idempotent_hit`.

- `token` is the **one-time bearer claim token**. It is not in the default selection of
  `claim-link list` / `get`, but the owner CAN recover an equivalent credential:
  `claim-link get <id> --select 'claim_url'` returns the URL, which embeds the token.
  **Correction:** an earlier revision of this document said the credential was unrecoverable.
  It is not — that recovery path is how the stranded link below was rescued, and it is
  implemented as `CliAdapter.recoverClaimUrl()`.
- `status` is a backend string the CLI does not enumerate. Observed across the CLI and live
  data: `created`, `funding`, `funded`, `claimed`, `expired`. Tab treats
  `funding_pending`/`funding`/`pending`/`created`/`processing` as in-flight and keeps the raw
  value; it never matches the vocabulary exhaustively.
- **`claim_url` is also a credential** — it embeds the token. Tab redacts both before
  anything is persisted or displayed.

## D12 · `invoice send` returns a fixed summary, with no status — **F**

> Returns a fixed summary (payment_id, contact, amount, wallet count) rather than a GraphQL
> selection, which is why there is no --select here.

So the id field is `payment_id`, and there is no status to read.
`InvoiceResult.status` is therefore optional and left **absent** rather than filled with an
invented `"sent"`.

Two more from the same page, worth knowing:

- Minimum invoice amount is **0.10** for USDT/USDC. A `settleThreshold` below that cannot be
  invoiced.
- Direction gotcha: "an invoice you send lists YOU as the payee, so it appears under
  `invoice received`, not `invoice sent`."

## D13 · Denomination is `--payment-type`, not a coin name — **F**

`--payment-type`: `0` = fiat (with `--currency-int`), `1` = USDT, `2` = USDC.
`--currency-label` is display-only. Tab derives it with `paymentTypeForCoin()`.

## D14 · `--stable-coin` is case-sensitive and defaults to USDT — **F**

`<options: USDT|USDC>`, `[default: USDT]`. The first implementation used lowercase
`usdc`. All chain/coin handling now goes through `normalizeStableCoin()`.

## D15 · CLI amounts carry more precision than cents — **F**

`payout status` returns `used_usd: "4.837692"`, `remaining_usd: "19995.162308"`;
`funded_amount` comes back as `"1.000000"`. Tab's `toCents` rejects sub-cent input on
purpose, so these would have thrown inside the buyer-kit's fence check.

**What Tab does now.** `toCentsFloor()` truncates toward zero for CLI-reported figures —
conservative for a remaining-budget check. Regression-tested with the real 6-decimal values.

Related unit mismatch: the caps are **USD** (`total_cap_usd`, `per_transaction_limit`) while
`--amount` is in **token units**. For USDT/USDC that is ~1:1, but it is not the same unit, so
Tab treats its own cap comparison as advisory and lets the backend be the authority.

## D16 · Other commands, corrected — **F**

| the design brief §4 | Real |
| --- | --- |
| `invoice list --select "id,status,amount"` | `--select` takes a **GraphQL fragment**, e.g. `items { id status amount_coins … }`; `-s` is the short form |
| `transaction list --all`, "default my_transactions" | `--scope mine\|business\|activities` selects the view; amounts are `amount_coins` / `amount_cents`; `tx_hash` etc. under `items` |
| `wallet list` → "wallet id, name, network, address, asset, balance" | `id_str`, `chain`, `address`, `coin_balances { coin_type balance }`, enriched with `chain_name` / `coin_name` / `eip155_chain_id` |

## D17 · Funding is asynchronous — an immediate claim is refused — **S**, **B**

`payout send` returns as soon as the transfer is dispatched, **before** the on-chain deposit
confirms. Claiming right away fails:

```
claim-link claim → exit 12, reason: pending_deposit
```

Exit 12 is the CLI's "did not happen" bucket, which also covers a permanently dead link — so
the exit code alone cannot distinguish *not yet* from *never*. Treating it as terminal loses a
perfectly good link (and its money) to a race.

`claim-link status` is the gate. Live output for a funded link:

```json
{ "status": "LINK_SENT", "is_claimable": true, "amount": "0.50", "token_symbol": "USDT",
  "chain": 11, "expiry_at": "2026-08-12T08:36:01.445000+00:00", "claim_tx_hash": null }
```

`is_claimable` is the authoritative signal; the `status` string is informational and its
vocabulary is undocumented (observed: `LINK_SENT`).

**What Tab does now.** `claimPayout` polls `claim-link status` every 5 s for up to 5 min
(`TAB_CLAIM_POLL_MS` / `TAB_CLAIM_WAIT_MS`) and only claims once `is_claimable` is true. The
budget is deliberately far below the ~21-minute window so a timeout leaves room to retry.
Classification:

| Condition | Verdict |
| --- | --- |
| exit 12 + reason matches `pending_deposit` / not funded | `CLAIM_NOT_READY` — **transient**, retry |
| status expired/refunded/cancelled, or past `expiry_at` | `CLAIM_EXPIRED` — terminal |
| budget exhausted, link still valid | `CLAIM_NOT_READY` — retry next pass |

The stub models the same thing via `depositDelayMs`, so the polling path is tested without a
network.

## D18 · `claim-link claim` result fields — **F**

```json
{ "outcome": "claimed", "claim_link_id": "6a7c2b77e2eb941d437f9fe2",
  "claim_tx_hash": "0xb9f80573c68d591ce2d2505e61415916383c0c5c342dfe1a037771f08e0b4ec1",
  "confirmations": null, "required_confirmations": null }
```

`outcome` is the verdict field (observed value `claimed`); `confirmations` /
`required_confirmations` may be null. Mapped onto `ClaimResult`, with the raw payload kept.

## D19 · Numeric claim-link `status` values, partially confirmed — **F**

Observed on real links: **2** = funded and claimable, **4** = claimed, **5** = refunded.
Confirmed by watching one link move 2 → 4 after a successful claim. Still inferred rather than
documented, so nothing in the code branches on these numbers — the code uses
`claim-link status`.`is_claimable` instead.

---

## Still unverified (not guessed anywhere in the code)

1. The full `status` vocabulary of the payout API (D11) — Tab keeps the raw string.
2. Numeric `status` on claim links (2/4/5 per D19 — inferred, and not relied upon in code).
3. Whether `<derived payout API>` accepts `--chain sepolia` — this needs one real
   `payout send`, which needs store credentials (see below).
4. The undocumented internal chain ids (D6) — empirical, and `verify:chains` re-checks them.

## What could not be exercised live

`payout send` authenticates with **store** API credentials
(`ALLSCALE_STORE_API_KEY` / `ALLSCALE_STORE_API_SECRET`), not the CLI login. They are not
present in this environment:

```
$ allscale payout send --amount 0.10 --chain base --stable-coin USDT --reference-id tab-probe-unauth-001 --json
{"version":"1","event":"payout_destination","payout_api_base":"<derived payout API>"}
{"error":{"code":"input.invalid","message":"Missing store API key. Pass --api-key or set ALLSCALE_STORE_API_KEY."}}
```

Everything reachable with the current agent-key session (scopes `invoice:all`,
`claim_link:all`, `wallet:read_only`, `transaction:read_only`, `store:all`) **was** exercised
live: `payout status`, `wallet list`, `claim-link list`, `invoice send`, `transaction list`.
See [`cli-mode-report.md`](cli-mode-report.md).
