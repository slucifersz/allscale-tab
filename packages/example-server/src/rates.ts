/**
 * A stand-in FX rate source: a static table plus a small deterministic drift.
 * No external API — this package exists to be *billed*, not to be accurate.
 *
 * Rates are held as integers in micro-units of USD (1 USD = 1_000_000µ) so no
 * conversion ever touches a float.
 */

/** How many micro-units of the currency one USD buys. */
const USD_MICRO: Record<string, number> = {
  USD: 1_000_000,
  USDC: 1_000_000,
  EUR: 920_000,
  GBP: 790_000,
  CHF: 890_000,
  CAD: 1_370_000,
  AUD: 1_520_000,
  SGD: 1_350_000,
  CNY: 7_240_000,
  HKD: 7_810_000,
  JPY: 157_200_000,
  KRW: 1_380_500_000,
  INR: 83_500_000,
  BRL: 5_450_000,
};

export const SUPPORTED_CURRENCIES = Object.keys(USD_MICRO);

/** Largest drift applied to a rate, in parts per million (0.2%). */
const DRIFT_PPM = 2_000;

export class UnknownCurrencyError extends Error {
  constructor(readonly currency: string) {
    super(
      `UNKNOWN_CURRENCY: ${currency} — supported: ${SUPPORTED_CURRENCIES.join(', ')}`,
    );
    this.name = 'UnknownCurrencyError';
  }
}

function baseMicro(code: string): number {
  const micro = USD_MICRO[code.toUpperCase()];
  if (micro === undefined) throw new UnknownCurrencyError(code);
  return micro;
}

/** Deterministic pseudo-random drift in [-DRIFT_PPM, DRIFT_PPM], stable within a minute. */
function driftPpm(pair: string, minuteBucket: number): number {
  let h = 2166136261;
  const seed = `${pair}:${minuteBucket}`;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % (2 * DRIFT_PPM + 1)) - DRIFT_PPM;
}

export interface RateQuote {
  pair: string;
  from: string;
  to: string;
  /** Units of `to` per single unit of `from`, 6 decimal places. */
  rate: string;
  asOf: string;
  source: 'tab-example-static-table';
}

/** Rate in micro-units of `to` per one unit of `from`. */
function rateMicro(from: string, to: string, at: Date): number {
  const f = baseMicro(from);
  const t = baseMicro(to);
  const pair = `${from.toUpperCase()}${to.toUpperCase()}`;
  const exact = Math.round((t * 1_000_000) / f);
  if (pair.slice(0, 3) === pair.slice(3)) return exact;
  const minuteBucket = Math.floor(at.getTime() / 60_000);
  const ppm = driftPpm(pair, minuteBucket);
  return exact + Math.round((exact * ppm) / 1_000_000);
}

function formatMicro(micro: number): string {
  const sign = micro < 0 ? '-' : '';
  const abs = Math.abs(micro);
  return `${sign}${Math.floor(abs / 1_000_000)}.${String(abs % 1_000_000).padStart(6, '0')}`;
}

export function quote(from: string, to: string, at: Date = new Date()): RateQuote {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  return {
    pair: `${f}/${t}`,
    from: f,
    to: t,
    rate: formatMicro(rateMicro(f, t, at)),
    asOf: at.toISOString(),
    source: 'tab-example-static-table',
  };
}

export interface ConversionResult extends RateQuote {
  amount: string;
  /** `amount` converted at `rate`, 2 decimal places. */
  result: string;
}

/** Parse a positive decimal amount into hundredths, without floats. */
function toHundredths(amount: string): number {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim().replace(/,/g, ''));
  if (!m) throw new Error(`INVALID_AMOUNT: "${amount}" must be a non-negative decimal (<= 2 dp)`);
  return Number.parseInt(m[1] as string, 10) * 100 + Number.parseInt((m[2] ?? '').padEnd(2, '0'), 10);
}

export function convert(
  amount: string,
  from: string,
  to: string,
  at: Date = new Date(),
): ConversionResult {
  const q = quote(from, to, at);
  const hundredths = toHundredths(amount);
  const micro = rateMicro(q.from, q.to, at);
  // hundredths * micro / 1e6, rounded to the nearest hundredth.
  const out = Math.round((hundredths * micro) / 1_000_000);
  return {
    ...q,
    amount: `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`,
    result: `${Math.floor(out / 100)}.${String(out % 100).padStart(2, '0')}`,
  };
}
