#!/usr/bin/env node
/**
 * Re-derive the chain id ↔ slug table from a live `allscale wallet list` and
 * fail if it has drifted from chains.ts.
 *
 * The numeric chain ids are backend-defined and undocumented (see
 * docs/DIFF.md item D6), so the table in chains.ts is empirical. This
 * script is how it gets re-checked rather than trusted indefinitely.
 *
 *   node scripts/verify-chains.mjs
 *
 * Needs a CLI session with wallet:read_only. Exits 0 when consistent, 1 on
 * drift, 2 when the CLI cannot be reached (skipped, not failed).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { CHAINS } from '@tab/core';

const run = promisify(execFile);
const bin = process.env.ALLSCALE_CLI_BIN ?? 'allscale';

let stdout;
try {
  ({ stdout } = await run(bin, ['wallet', 'list', '--json'], { maxBuffer: 4 << 20 }));
} catch (e) {
  console.error(`skipped: could not run \`${bin} wallet list --json\` — ${e.message.split('\n')[0]}`);
  process.exit(2);
}

const wallets = JSON.parse(stdout).data?.wallets ?? [];
if (wallets.length === 0) {
  console.error('skipped: no wallets returned');
  process.exit(2);
}

const known = new Map(CHAINS.map((c) => [c.id, c]));
let drift = 0;

for (const w of wallets) {
  const live = { id: w.chain, name: w.chain_name ?? '?', eip155: w.eip155_chain_id ?? null };
  const ours = known.get(live.id);
  if (!ours) {
    drift += 1;
    console.error(`NEW    id ${live.id} = ${live.name} (eip155 ${live.eip155}) is not in chains.ts`);
    continue;
  }
  if (ours.eip155 !== live.eip155) {
    drift += 1;
    console.error(
      `DRIFT  id ${live.id} (${live.name}): eip155 ${ours.eip155} in chains.ts, ${live.eip155} live`,
    );
    continue;
  }
  console.log(`ok     id ${String(live.id).padStart(2)} ${live.name.padEnd(28)} eip155=${live.eip155}`);
}

if (drift > 0) {
  console.error(`\n${drift} difference(s) — update packages/core/src/chains.ts`);
  process.exit(1);
}
console.log(`\n${wallets.length} chains match chains.ts`);
