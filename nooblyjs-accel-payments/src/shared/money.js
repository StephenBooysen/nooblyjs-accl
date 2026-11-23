// Money is integers (steering §3.1): integer minor units with an ISO 4217 currency, { amount: 2500, currency: 'USD' }.
// No floats: arithmetic is on integers (BigInt where a product could pass 2^53), and rounding happens only where a
// caller asks, half-even (banker's rounding).

/** Minor-unit exponents that are not 2. */
const EXPONENTS = { JPY: 0, KRW: 0, VND: 0, CLP: 0, ISK: 0, UGX: 0, XAF: 0, XOF: 0, BHD: 3, KWD: 3, OMR: 3, JOD: 3, TND: 3 };

export const exponentOf = (currency) => EXPONENTS[currency] ?? 2;

export function isCurrency(c) {
  return typeof c === 'string' && /^[A-Z]{3}$/.test(c);
}

/** Throws unless m is { amount: safe integer, currency: 'XXX' }. */
export function assertMoney(m, what = 'amount') {
  if (!m || !Number.isSafeInteger(m.amount) || !isCurrency(m.currency)) {
    throw Object.assign(new Error(`${what} must be { amount: integer minor units, currency: ISO 4217 }.`), { status: 422, code: 'invalid' });
  }
  return m;
}

export const money = (amount, currency) => {
  if (!Number.isSafeInteger(amount)) throw new Error(`Money amounts are integers (got ${amount}).`);
  if (!isCurrency(currency)) throw new Error(`A currency is three capital letters (got ${currency}).`);
  return { amount, currency };
};
export const zero = (currency) => money(0, currency);

function same(a, b) {
  if (a.currency !== b.currency) throw new Error(`Cannot combine ${a.currency} and ${b.currency}.`);
}
export const add = (a, b) => (same(a, b), money(a.amount + b.amount, a.currency));
export const sub = (a, b) => (same(a, b), money(a.amount - b.amount, a.currency));
export const neg = (a) => money(-a.amount, a.currency);
export const sum = (list, currency) => list.reduce((s, m) => add(s, m), zero(currency));
export const min = (a, b) => (same(a, b), a.amount <= b.amount ? a : b);
export const max = (a, b) => (same(a, b), a.amount >= b.amount ? a : b);

/**
 * n / d rounded half to even, on integers. n and d are integers (Number or BigInt); d is not zero.
 * @returns {number}
 */
export function divRound(n, d) {
  let N = BigInt(n);
  let D = BigInt(d);
  if (D === 0n) throw new Error('Division by zero.');
  if (D < 0n) { N = -N; D = -D; }
  const negative = N < 0n;
  const A = negative ? -N : N;
  let q = A / D;
  const r = A % D;
  const twice = r * 2n;
  if (twice > D || (twice === D && q % 2n === 1n)) q += 1n;
  const out = negative ? -q : q;
  if (out > BigInt(Number.MAX_SAFE_INTEGER) || out < BigInt(Number.MIN_SAFE_INTEGER)) throw new Error('Amount out of range.');
  return Number(out);
}

/** amount × num / den, rounded half-even once. */
export const mulDiv = (amount, num, den) => divRound(BigInt(amount) * BigInt(num), den);

/** A share of an amount in basis points (1500 = 15%), rounded half-even. */
export const basisPoints = (amount, bp) => mulDiv(amount, bp, 10_000);

/** Parses a decimal string in major units ("12.50") into minor units, exactly; null when it is not one. */
export function parseMajor(text, currency) {
  const exp = exponentOf(currency);
  const m = /^(-)?(\d{1,13})(?:\.(\d+))?$/.exec(String(text).trim());
  if (!m) return null;
  const frac = m[3] ?? '';
  if (frac.length > exp) return null;
  const value = Number(m[2]) * 10 ** exp + Number((frac + '0'.repeat(exp)).slice(0, exp) || 0);
  return m[1] ? -value : value;
}

const symbols = new Map();
function symbolOf(currency, locale) {
  const key = `${locale}:${currency}`;
  if (!symbols.has(key)) {
    let symbol = `${currency} `;
    let after = false;
    try {
      const parts = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'narrowSymbol' }).formatToParts(1);
      const i = parts.findIndex((p) => p.type === 'currency');
      const n = parts.findIndex((p) => p.type === 'integer');
      symbol = parts[i]?.value ?? symbol;
      after = i > n;
      if (/^[A-Za-z]+$/.test(symbol)) symbol = `${symbol} `;
    } catch { /* unknown currency: the code */ }
    symbols.set(key, { symbol, after });
  }
  return symbols.get(key);
}

/** "$1,234.50", "-R 12.00", "¥500": built from the integer, never through a float. */
export function format(m, { locale = 'en', code = false } = {}) {
  if (!m) return '';
  const exp = exponentOf(m.currency);
  const negative = m.amount < 0;
  const digits = String(Math.abs(m.amount)).padStart(exp + 1, '0');
  const whole = digits.slice(0, digits.length - exp).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const text = exp ? `${whole}.${digits.slice(-exp)}` : whole;
  if (code) return `${negative ? '-' : ''}${text} ${m.currency}`;
  const { symbol, after } = symbolOf(m.currency, locale);
  return `${negative ? '-' : ''}${after ? `${text} ${symbol.trim()}` : `${symbol}${text}`}`;
}
