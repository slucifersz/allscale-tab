# Stub vs CLI — mode comparison

Run 2026-08-12 against `@allscale/cli/0.1.0`, api-base `<internal test environment>`,
derived payout API `<derived payout API>`.

## 1. Test suite, both modes

```
TAB_ADAPTER=stub   # tests 108 # pass 108 # fail 0 # skipped 0
TAB_ADAPTER=cli    # tests 108 # pass 108 # fail 0 # skipped 0
```

**Read this carefully:** 102 of those 108 tests inject a `StubAdapter` directly, so they are
adapter-agnostic by construction — passing under `TAB_ADAPTER=cli` proves the env var causes
no regression, **not** that the CLI path works. The identical counts are the expected result,
not evidence.

The 6 tests that do exercise the real CLI are in
`packages/core/test/cli-adapter.live.test.ts`. They spawn `allscale` and are read-only:

```
ok 1 - maps payout status onto FenceStatus
ok 2 - maps transaction list rows
ok 3 - refuses an undelegated chain × token pair, decided from live authorization
ok 4 - confirms the configured pair is delegated, or says why not
ok 5 - fails closed on payout send without STORE credentials, before any network call
ok 6 - captures --help for every command the adapter depends on
# tests 6 # pass 6 # fail 0
```

They skip themselves with a reason when the CLI or its session is missing
(`TAB_SKIP_LIVE_CLI=1` → `# skipped 6`), so the suite stays portable.

## 2. `npm run self-test` (§7 items 3–5), both modes

```
TAB_ADAPTER=stub   44 checks, all passed
TAB_ADAPTER=cli    44 checks, all passed
```

Same caveat: the self-test builds its own `StubAdapter`, because completing it end to end on
the CLI would move real funds on every run.

## 3. Per-method verification against the real CLI

From `node scripts/cli-probe.mjs`:

| Adapter method | Real command | CLI verdict | Evidence |
| --- | --- | --- | --- |
| `fenceStatus` | `payout status --json` | **live-ok** | `provisioned=true active=true remaining=19993.371795 perTx=200 expires=2026-09-11T04:25:27+00:00 pairs=4` |
| `enableFence` | (dashboard) + `payout status` | **live-ok** | confirmed via status; refuses undelegated pairs |
| authorization check | `payout status`.`authorized_pairs` | **live-ok** | `sepolia(id 11) × USDT is delegated · pairs: 6/USDT 11/USDT 6/USDC 11/USDC` |
| `listTransactions` | `transaction list --json` | **live-ok** | 11 rows, 11 with `amount_coins` |
| `sendInvoice` | `invoice send --json` | **live-ok** | sent for real: `payment_id=6a7c2e355e6314ae1628920c`, read back as `status:1 amount_coins:"0.50" memo:"tab-probe-20260812082618"` |
| `sendPayout` | `payout send --json` | **blocked** | `ALLSCALE_STORE_API_KEY` / `ALLSCALE_STORE_API_SECRET` absent — `payout send` authenticates with the STORE key, not the CLI login |
| `claimPayout` | `claim-link claim --json` | **blocked** | needs a claim token from `payout send` |

Totals: **5 live-ok · 0 argv-only · 2 blocked · 0 error.**

`sendInvoice` requires `--write --to <a valid email>`; without it the probe refuses to run
rather than mailing a placeholder address (exit 2).

### The claim leg, and one real rescue

A first `--write` run (with store credentials present in that shell) funded a link and then
tried to claim it immediately. It failed: **exit 12, `pending_deposit`** — funding is
asynchronous, so the claim raced the on-chain deposit. That link was then rescued:

```
allscale claim-link get 6a7c2b77e2eb941d437f9fe2 --select 'id status … claim_url' --json
allscale claim-link status --claim-url <redacted> --json
  → {"status":"LINK_SENT","is_claimable":true,"amount":"0.50","expiry_at":"2026-08-12T08:36:01Z"}
allscale claim-link claim --claim-url <redacted> --to-wallet --json
  → {"outcome":"claimed","claim_link_id":"6a7c2b77e2eb941d437f9fe2",
     "claim_tx_hash":"0xb9f80573c68d591ce2d2505e61415916383c0c5c342dfe1a037771f08e0b4ec1"}
```

The link went `status 2 → 4` and the Sepolia wallet went `→ 195.371795 USDT`. Claimed with
~16 minutes still on the clock.

`claimPayout` now polls `claim-link status` until `is_claimable` before claiming — see D17/D18
in `cli-help/DIFF.md`.

## 4. Behavioural differences between the modes

| | stub | cli |
| --- | --- | --- |
| Money | none | real sandbox funds on Sepolia |
| Fence | in-memory, pairs configurable | read from `payout status`; granted only in the dashboard |
| Authorization | same per-pair rule, simulated | enforced by the backend, pre-checked by Tab |
| `payout send` | returns a `stub_claim_token_NNNN` immediately | funds a claim link via `<derived payout API>`; ~21-minute claim window |
| Claim | in-memory; TTL and deposit delay configurable (`claimTtlMs`, `depositDelayMs`) | on-chain; only an on-chain-proven claim exits 0 |
| Deposit confirmation | simulated delay, same polling contract | asynchronous; `pending_deposit` until `is_claimable` |
| Ambiguous outcomes | simulated with `pendingRounds` | real: exit 9 / timeouts → `payout status`, then retry the same reference id |
| Latency | ~0 ms (`latencyMs` configurable) | `payout status` ~0.6 s; `payout send` up to 120 s (CLI's own timeout) |
| Credentials | none | agent-key session + store key/secret |

## 5. What remains unverified, and exactly what it needs

**`payout send` has not run through this code against the live API** — it needs the STORE
credentials, which are not present in this environment. The claim half HAS now been proven
live (see the rescue above), and every other method is live-verified. To close the last gap:

```bash
export ALLSCALE_STORE_API_KEY=ak_…          # store key, NOT your login
export ALLSCALE_STORE_API_SECRET=…          # never pass as a flag — shell history
node scripts/cli-probe.mjs --write          # funds one 0.50 USDT claim link, then claims it
```

That single run would confirm, in order:

1. `<derived payout API>` accepts `--chain sepolia` (D7 in `cli-help/DIFF.md`);
2. the `payout send` response field names (`claim_link_id`, `token`, `claim_url`,
   `idempotent_hit`, `status`) as mapped in `toPayoutResult`;
3. the real `status` vocabulary, including whether `funding_pending` appears
   (`claim-link status` is confirmed to return `LINK_SENT` + `is_claimable`);
4. that `claim-link claim --claim-token … --to-wallet` delivers, and what `claim_tx_hash`
   looks like;
5. the actual claim window on a `payout send`-created link.

Until then the code fails closed rather than guessing: no store key → `CLI_AUTH_MISSING`
before any network call.

The seller leg can be confirmed separately, and only emails yourself:

```bash
node scripts/cli-probe.mjs --write --to <your own email>
```
