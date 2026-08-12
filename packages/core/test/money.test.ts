import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fromCents, multiplyAmount, normalizeAmount, toCents } from '../src/money.js';

describe('money', () => {
  it('parses fixed-point strings into cents without floats', () => {
    assert.equal(toCents('0.01'), 1);
    assert.equal(toCents('0.50'), 50);
    assert.equal(toCents('1'), 100);
    assert.equal(toCents('1.5'), 150);
    assert.equal(toCents('12.34'), 1234);
    assert.equal(toCents('$0.02'), 2);
    assert.equal(toCents('1,000.00'), 100_000);
  });

  it('rejects malformed amounts', () => {
    for (const bad of ['', 'abc', '0.001', '-1.00', '1.2.3', '1e2']) {
      assert.throws(() => toCents(bad), /INVALID_AMOUNT/, `should reject ${JSON.stringify(bad)}`);
    }
  });

  it('renders cents back to 2-decimal strings', () => {
    assert.equal(fromCents(0), '0.00');
    assert.equal(fromCents(1), '0.01');
    assert.equal(fromCents(50), '0.50');
    assert.equal(fromCents(100), '1.00');
    assert.equal(fromCents(1234), '12.34');
  });

  it('survives an accumulation that would drift in floating point', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point; in cents it is exact.
    let cents = 0;
    for (let i = 0; i < 100; i++) cents += toCents('0.01');
    assert.equal(fromCents(cents), '1.00');
    assert.equal(fromCents(toCents('0.10') + toCents('0.20')), '0.30');
  });

  it('multiplies by integer quantities', () => {
    assert.equal(multiplyAmount('0.01', 50), '0.50');
    assert.equal(multiplyAmount('0.02', 3), '0.06');
    assert.equal(multiplyAmount('0.01', 0), '0.00');
    assert.throws(() => multiplyAmount('0.01', 1.5), /INVALID_QTY/);
  });

  it('normalizes to canonical form', () => {
    assert.equal(normalizeAmount('1.5'), '1.50');
    assert.equal(normalizeAmount('0.1'), '0.10');
  });
});
