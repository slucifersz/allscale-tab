/**
 * Money handling for Tab.
 *
 * Rule: money never touches a float. Amounts travel across module and process
 * boundaries as fixed-point decimal strings ("0.01", "12.50") and are computed
 * on as integer cents.
 */

/** Integer number of cents. */
export type Cents = number;

const DECIMAL_RE = /^(\d+)(?:\.(\d{1,2}))?$/;

/**
 * Parse a fixed-point decimal string (or an already-integer cent count) into cents.
 * Accepts an optional leading "$" and thousands separators for operator convenience.
 */
export function toCents(amount: string | number): Cents {
  if (typeof amount === 'number') {
    if (!Number.isInteger(amount)) {
      throw new Error(`INVALID_AMOUNT: numeric amounts must be integer cents, got ${amount}`);
    }
    return amount;
  }
  const cleaned = amount.trim().replace(/^\$/, '').replace(/,/g, '');
  const m = DECIMAL_RE.exec(cleaned);
  if (!m) {
    throw new Error(`INVALID_AMOUNT: "${amount}" is not a non-negative decimal with <= 2 places`);
  }
  const whole = Number.parseInt(m[1] as string, 10);
  const frac = (m[2] ?? '').padEnd(2, '0');
  return whole * 100 + Number.parseInt(frac, 10);
}

const LOOSE_DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/**
 * Parse an amount that may carry more precision than cents, truncating toward
 * zero.
 *
 * Tab's own money is always 2dp, but the CLI reports token/USD figures with more
 * (`used_usd: "4.837692"`, `funded_amount: "1.000000"`). Those must not be fed
 * to `toCents`, which rejects sub-cent precision on purpose. Truncating rather
 * than rounding keeps a remaining-budget check conservative: it never reports
 * more headroom than actually exists.
 */
export function toCentsFloor(amount: string | number): Cents {
  if (typeof amount === 'number') {
    if (!Number.isFinite(amount)) throw new Error(`INVALID_AMOUNT: ${amount}`);
    return Math.floor(amount * 100);
  }
  const cleaned = amount.trim().replace(/^\$/, '').replace(/,/g, '');
  const m = LOOSE_DECIMAL_RE.exec(cleaned);
  if (!m) {
    throw new Error(`INVALID_AMOUNT: "${amount}" is not a non-negative decimal`);
  }
  const whole = Number.parseInt(m[1] as string, 10);
  const frac = (m[2] ?? '').slice(0, 2).padEnd(2, '0');
  return whole * 100 + Number.parseInt(frac, 10);
}

/** Render cents as a 2-decimal fixed-point string, e.g. 50 -> "0.50". */
export function fromCents(cents: Cents): string {
  if (!Number.isInteger(cents)) {
    throw new Error(`INVALID_AMOUNT: cents must be an integer, got ${cents}`);
  }
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${String(frac).padStart(2, '0')}`;
}

/** Normalise any accepted amount representation to the canonical string form. */
export function normalizeAmount(amount: string | number): string {
  return fromCents(toCents(amount));
}

/** Multiply an amount by an integer quantity, staying in cents. */
export function multiplyAmount(amount: string | number, qty: number): string {
  if (!Number.isInteger(qty) || qty < 0) {
    throw new Error(`INVALID_QTY: quantity must be a non-negative integer, got ${qty}`);
  }
  return fromCents(toCents(amount) * qty);
}
