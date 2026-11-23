// Pure modules (spec §11): money (integer arithmetic, half-even rounding, formatting), rating and proration, with
// table tests including rounding edge cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { money, rateItem, monthHours, graduated, prorate, prorationLines, nextBoundary } from '../index.js';

const { divRound, mulDiv, basisPoints, format, parseMajor, add, assertMoney } = money;

test('half-even rounding on integers', () => {
  for (const [n, d, want] of [[5, 2, 2], [7, 2, 4], [-5, 2, -2], [-7, 2, -4], [1, 3, 0], [2, 3, 1], [10, 4, 2], [14, 4, 4], [15, 10, 2], [25, 10, 2], [35, 10, 4], [0, 7, 0], [5, -2, -2]]) {
    assert.equal(divRound(n, d), want, `${n}/${d}`);
  }
  assert.equal(mulDiv(360, 500, 720), 250);
  assert.equal(mulDiv(9_007_199_254_740, 1000, 1000), 9_007_199_254_740, 'big products go through BigInt');
  assert.equal(basisPoints(1000, 1500), 150);
  assert.equal(basisPoints(333, 1500), 50, '49.95 → 50');
  assert.equal(basisPoints(3, 1500), 0, '0.45 → 0');
  assert.equal(basisPoints(1, 5000), 0, '0.5 → 0 (even)');
  assert.equal(basisPoints(3, 5000), 2, '1.5 → 2 (even)');
});

test('money: no floats, one currency at a time, formatting from the integer', () => {
  assert.throws(() => money.money(1.5, 'USD'));
  assert.throws(() => money.money(1, 'usd'));
  assert.throws(() => add(money.money(1, 'USD'), money.money(1, 'ZAR')));
  assert.throws(() => assertMoney({ amount: 1.1, currency: 'USD' }), { status: 422 });
  assert.equal(format({ amount: 123450, currency: 'USD' }), '$1,234.50');
  assert.equal(format({ amount: -5, currency: 'USD' }), '-$0.05');
  assert.equal(format({ amount: 1999, currency: 'ZAR' }), 'R 19.99');
  assert.equal(format({ amount: 500, currency: 'JPY' }), '¥500');
  assert.equal(format({ amount: 1234567, currency: 'KWD' }), 'KWD 1,234.567');
  assert.equal(format({ amount: 250, currency: 'USD' }, { code: true }), '2.50 USD');
  assert.equal(parseMajor('12.5', 'USD'), 1250);
  assert.equal(parseMajor('12.505', 'USD'), null);
  assert.equal(parseMajor('500', 'JPY'), 500);
  assert.equal(parseMajor('1e3', 'USD'), null);
});

test('rating: a monthly price billed by the hour comes to the monthly price for a whole month, whatever its length', () => {
  const price = { id: 'p', type: 'metered', currency: 'USD', unitAmount: 500, divideBy: 'month_hours', aggregate: 'sum', meterId: 'm' };
  const product = { id: 'x', name: 'Standard instance', unitLabel: 'service-hour' };
  for (const [start, hours] of [['2026-02-01', 672], ['2026-03-01', 744], ['2026-04-01', 720]]) {
    assert.equal(monthHours(Date.parse(start)), hours);
    const period = { start: `${start}T00:00:00.000Z`, end: new Date(nextBoundary(Date.parse(start))).toISOString() };
    const one = rateItem({ price, product, usage: [{ quantity: hours, at: period.start }], period });
    assert.equal(one.amount.amount, 500, start);
    const three = rateItem({ price, product, usage: [{ quantity: hours * 3, at: period.start }], period });
    assert.equal(three.amount.amount, 1500);
    const half = rateItem({ price, product, usage: [{ quantity: hours / 2, at: period.start }], period });
    assert.equal(half.amount.amount, 250);
  }
  const period = { start: '2026-03-01T00:00:00.000Z', end: '2026-04-01T00:00:00.000Z' };
  assert.equal(rateItem({ price, product, usage: [{ quantity: 1, at: period.start }], period }).amount.amount, 1, '500/744 = 0.67 → 1');
  assert.equal(rateItem({ price, product, usage: [], period }), null, 'no usage, no line');
  assert.match(rateItem({ price, product, usage: [{ quantity: 744, at: period.start }], period }).description, /744 service-hours/);
});

test('rating: allowances, sum and max, graduated tiers, per unit', () => {
  const product = { id: 'x', name: 'Bandwidth', unitLabel: 'GB' };
  const period = { start: '2026-03-01T00:00:00.000Z', end: '2026-04-01T00:00:00.000Z' };
  const usage = [{ quantity: 60, at: '2026-03-02T00:00:00Z' }, { quantity: 70, at: '2026-03-03T00:00:00Z' }];
  assert.equal(rateItem({ price: { id: 'p', type: 'metered', currency: 'USD', unitAmount: 10, freeAllowance: 100, meterId: 'm' }, product, usage, period }).amount.amount, 300);
  assert.equal(rateItem({ price: { id: 'p', type: 'metered', currency: 'USD', unitAmount: 10, freeAllowance: 200, meterId: 'm' }, product, usage, period }).amount.amount, 0, 'floored at 0');
  assert.equal(rateItem({ price: { id: 'p', type: 'metered', currency: 'USD', unitAmount: 10, aggregate: 'max', meterId: 'm' }, product, usage, period }).amount.amount, 700);
  const tiers = [{ upTo: 10, unitAmount: 100 }, { upTo: 100, unitAmount: 50, flatAmount: 200 }, { upTo: null, unitAmount: 10 }];
  assert.equal(graduated(5, tiers), 500);
  assert.equal(graduated(10, tiers), 1000);
  assert.equal(graduated(11, tiers), 1000 + 50 + 200);
  assert.equal(graduated(150, tiers), 1000 + 90 * 50 + 200 + 50 * 10);
  assert.equal(rateItem({ price: { id: 's', type: 'per_unit', currency: 'USD', unitAmount: 1000 }, product: { id: 'y', name: 'Seat' }, quantity: 3, period }).amount.amount, 3000);
});

test('proration by day, half-even, counting the day of the change', () => {
  const p = { periodStart: '2026-04-01T00:00:00.000Z', periodEnd: '2026-05-01T00:00:00.000Z' };
  assert.equal(prorate(3000, { ...p, at: '2026-04-01T09:00:00Z' }), 3000, 'whole period');
  assert.equal(prorate(3000, { ...p, at: '2026-04-16T23:00:00Z' }), 1500, '15 of 30 days');
  assert.equal(prorate(1000, { ...p, at: '2026-04-30T12:00:00Z' }), 33, '1 of 30 → 33.33');
  assert.equal(prorate(1000, { ...p, at: '2026-05-02T00:00:00Z' }), 0);
  const lines = prorationLines({ old: [{ amount: 1000, description: 'Seat × 1', priceId: 'a' }], next: [{ amount: 3000, description: 'Seat × 3', priceId: 'a' }], at: '2026-04-16T10:00:00Z', period: { start: p.periodStart, end: p.periodEnd }, currency: 'USD' });
  assert.deepEqual(lines.map((l) => l.amount.amount), [-500, 1500]);
  assert.match(lines[0].description, /^Unused time on Seat × 1/);
});

test('billing periods: calendar months and years, and anchored on a day (clamped to the month end)', () => {
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  assert.equal(iso(nextBoundary(Date.parse('2026-01-15T10:00:00Z'))), '2026-02-01');
  assert.equal(iso(nextBoundary(Date.parse('2026-12-31T23:00:00Z'))), '2027-01-01');
  assert.equal(iso(nextBoundary(Date.parse('2026-03-05T00:00:00Z'), { interval: 'year' })), '2027-01-01');
  assert.equal(iso(nextBoundary(Date.parse('2026-01-31T00:00:00Z'), { anchor: 'creation', anchorDay: 31 })), '2026-02-28');
  assert.equal(iso(nextBoundary(Date.parse('2026-02-28T00:00:00Z'), { anchor: 'creation', anchorDay: 31 })), '2026-03-31');
});
