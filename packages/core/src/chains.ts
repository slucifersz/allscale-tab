/**
 * Chain and stablecoin identifiers.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * The CLI speaks two different chain languages:
 *
 *   - `payout send --chain` takes a SLUG from a fixed enum
 *     (ethereum|bsc|base|polygon|arbitrum|optimism|sepolia)
 *   - `payout status` reports `authorized_pairs[].chain` as an INTEGER
 *
 * To check "is this chain × coin delegated to me?" the two have to be compared,
 * so a mapping is unavoidable. It is NOT documented anywhere, so the table below
 * was read off live `allscale wallet list --json` output, whose rows carry
 * `chain`, `chain_name` and `eip155_chain_id` together. See
 * docs/cli-help/DIFF.md item D6.
 *
 * Because it is empirical, nothing here is treated as authoritative: an unknown
 * slug or id makes an authorization check return `unknown` rather than `denied`,
 * and the CLI stays the only thing that can actually refuse a payout.
 */

/** Chain slugs `payout send --chain` accepts (from docs/cli-help/payout-send.txt). */
export const PAYOUT_CHAIN_SLUGS = [
  'ethereum',
  'bsc',
  'base',
  'polygon',
  'arbitrum',
  'optimism',
  'sepolia',
] as const;

export type PayoutChainSlug = (typeof PAYOUT_CHAIN_SLUGS)[number];

/** Stablecoins `payout send --stable-coin` accepts. Case matters: uppercase. */
export const STABLE_COINS = ['USDT', 'USDC'] as const;
export type StableCoin = (typeof STABLE_COINS)[number];

export interface ChainInfo {
  /** AllScale's internal numeric chain id (`authorized_pairs[].chain`). */
  id: number;
  /** Human label as reported by `wallet list` (`chain_name`). */
  name: string;
  /** EIP-155 id where the chain has one. */
  eip155: number | null;
  /** Slug accepted by `payout send --chain`, when the chain has one. */
  slug?: PayoutChainSlug;
  /** True for test networks — only beta/loopback payout APIs accept these. */
  testnet?: boolean;
}

/**
 * Observed on 2026-08-12 from `allscale wallet list --json` against
 * api-base <internal test environment>.
 *
 * TODO: re-verify after any CLI/backend upgrade; ids are backend-defined and
 * could change. `npm run verify:chains` re-reads them from a live wallet list.
 */
export const CHAINS: readonly ChainInfo[] = [
  { id: 1, name: 'Ethereum', eip155: 1, slug: 'ethereum' },
  { id: 2, name: 'Solana', eip155: null },
  { id: 3, name: 'Tron', eip155: null },
  { id: 4, name: 'Aptos', eip155: null },
  { id: 5, name: 'Base', eip155: 8453, slug: 'base' },
  { id: 6, name: 'BSC (BEP20)', eip155: 56, slug: 'bsc' },
  { id: 7, name: 'Arbitrum', eip155: 42161, slug: 'arbitrum' },
  { id: 8, name: 'Polygon', eip155: 137, slug: 'polygon' },
  { id: 9, name: 'Optimism', eip155: 10, slug: 'optimism' },
  { id: 10, name: 'TON', eip155: null },
  { id: 11, name: 'Sepolia (Ethereum testnet)', eip155: 11_155_111, slug: 'sepolia', testnet: true },
];

export function chainBySlug(slug: string): ChainInfo | undefined {
  const want = slug.trim().toLowerCase();
  return CHAINS.find((c) => c.slug === want);
}

export function chainById(id: number): ChainInfo | undefined {
  return CHAINS.find((c) => c.id === id);
}

/** Numeric id for a slug, or undefined when the mapping is not known. */
export function chainIdForSlug(slug: string): number | undefined {
  return chainBySlug(slug)?.id;
}

/** Label for logs: "sepolia (id 11)" / "zkevm (id unknown)". */
export function describeChain(slug: string): string {
  const info = chainBySlug(slug);
  return info ? `${slug} (id ${info.id})` : `${slug} (id unknown)`;
}

/**
 * Normalise a chain slug for `payout send --chain`.
 * @throws when the slug is not in the CLI's enum — better to fail here than to
 *         let the CLI reject the whole invocation on a typo.
 */
export function normalizeChain(chain: string): PayoutChainSlug {
  const want = chain.trim().toLowerCase();
  const found = PAYOUT_CHAIN_SLUGS.find((s) => s === want);
  if (!found) {
    throw new Error(
      `INVALID_CHAIN: "${chain}" — payout send --chain accepts ${PAYOUT_CHAIN_SLUGS.join('|')}`,
    );
  }
  return found;
}

/**
 * Normalise a stablecoin for `payout send --stable-coin`, which is
 * case-sensitive (USDT|USDC).
 */
export function normalizeStableCoin(coin: string): StableCoin {
  const want = coin.trim().toUpperCase();
  const found = STABLE_COINS.find((c) => c === want);
  if (!found) {
    throw new Error(`INVALID_STABLE_COIN: "${coin}" — expected ${STABLE_COINS.join('|')}`);
  }
  return found;
}

/** `invoice send --payment-type`: 0 = fiat, 1 = USDT, 2 = USDC. */
export function paymentTypeForCoin(coin: string): 1 | 2 {
  return normalizeStableCoin(coin) === 'USDC' ? 2 : 1;
}

/** Defaults for the whole system: the pair this account has delegated and funded. */
export const DEFAULT_CHAIN: PayoutChainSlug = 'sepolia';
export const DEFAULT_STABLE_COIN: StableCoin = 'USDT';
