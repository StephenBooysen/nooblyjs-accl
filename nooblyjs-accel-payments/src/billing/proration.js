// Proration and billing periods (spec §6), pure. Proration is by day: round_half_even(amount × daysRemaining /
// daysInPeriod), counting the day of the change. Periods: calendar months or years (UTC), or anchored on the day the
// subscription began (clamped to the month's last day).
import { mulDiv } from '../shared/money.js';
import { DAY } from './rating.js';

export const startOfDay = (ms) => {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** The boundary after `ms`: the next calendar month/year start, or the next anchor day. */
export function nextBoundary(ms, { interval = 'month', anchor = 'calendar', anchorDay = 1 } = {}) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  if (interval === 'year') {
    if (anchor === 'calendar') return Date.UTC(y + 1, 0, 1);
    const day = Math.min(anchorDay, daysInMonth(y + 1, m));
    return Date.UTC(y + 1, m, day);
  }
  if (anchor === 'calendar') return Date.UTC(y, m + 1, 1);
  // Anchored: the anchor day in this month if still ahead, else next month's.
  const thisMonth = Date.UTC(y, m, Math.min(anchorDay, daysInMonth(y, m)));
  if (thisMonth > ms) return thisMonth;
  return Date.UTC(y, m + 1, Math.min(anchorDay, daysInMonth(y, m + 1)));
}

/** The period that starts at `startMs`: { start, end } as ISO strings. */
export function periodFrom(startMs, cycle) {
  return { start: new Date(startMs).toISOString(), end: new Date(nextBoundary(startMs, cycle)).toISOString() };
}

/** Whole days from the start of `fromMs`'s day to `toMs` (a boundary at midnight). */
export const daysUntil = (fromMs, toMs) => Math.max(0, Math.round((toMs - startOfDay(fromMs)) / DAY));

/**
 * The share of `amount` for the rest of a period from `at` (the day of the change counts).
 * @returns {number} integer minor units
 */
export function prorate(amount, { at, periodStart, periodEnd }) {
  const s = Date.parse(periodStart);
  const e = Date.parse(periodEnd);
  const total = daysUntil(s, e);
  if (total <= 0) return 0;
  const remaining = Math.min(total, daysUntil(Date.parse(at), e));
  return mulDiv(amount, remaining, total);
}

/**
 * The lines a mid-period change of licensed items adds: a credit for what is left of each old item, a charge for what
 * is left of each new one (both for the rest of the period).
 * @param {{ old: { amount: number, description: string, priceId: string }[], next: { amount: number, description: string, priceId: string }[], at: string, period: { start: string, end: string }, currency: string }} o
 */
export function prorationLines({ old, next, at, period, currency }) {
  const lines = [];
  const p = { at, periodStart: period.start, periodEnd: period.end };
  const rest = { start: new Date(startOfDay(Date.parse(at))).toISOString(), end: period.end };
  for (const item of old) {
    const amount = prorate(item.amount, p);
    if (amount) lines.push({ kind: 'proration', description: `Unused time on ${item.description}`, priceId: item.priceId, quantity: item.quantity ?? 1, unitAmount: null, amount: { amount: -amount, currency }, period: rest });
  }
  for (const item of next) {
    const amount = prorate(item.amount, p);
    if (amount) lines.push({ kind: 'proration', description: `Remaining time on ${item.description}`, priceId: item.priceId, quantity: item.quantity ?? 1, unitAmount: null, amount: { amount, currency }, period: rest });
  }
  return lines;
}
