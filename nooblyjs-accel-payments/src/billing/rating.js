// Rating (spec §6), pure: a price, its quantity or usage, and the period → an invoice line. Integers only.
//
// Price types: flat (one amount a period), per_unit (quantity × unit amount), metered (usage aggregated over the period,
// less a free allowance, × unit amount), tiered (graduated tiers over the quantity or the usage), one_off.
// `divideBy` (an extension of the spec, like Stripe's transform_quantity) prices a metered unit as a share of the unit
// amount: amount = round_half_even(quantity × unitAmount / divideBy). 'month_hours' divides by the hours of the
// calendar month the period starts in, so a monthly price billed by the hour comes to exactly the monthly price for a
// whole month, whatever its length.
import { mulDiv, money } from '../shared/money.js';

export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;

/** Hours in the UTC calendar month that contains `ms`. */
export function monthHours(ms) {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const end = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  return (end - start) / HOUR;
}

/** sum | max | last of usage records' quantities (each { quantity, at }). */
export function aggregate(usage, how = 'sum') {
  if (!usage.length) return 0;
  if (how === 'max') return usage.reduce((m, u) => Math.max(m, u.quantity), 0);
  if (how === 'last') return [...usage].sort((a, b) => (a.at < b.at ? -1 : 1)).at(-1).quantity;
  return usage.reduce((s, u) => s + u.quantity, 0);
}

/**
 * Graduated tiers: [{ upTo: number|null, unitAmount, flatAmount? }], upTo ascending, the last null (no limit).
 * Each unit is priced by the tier it falls in; a tier's flat amount is added once it is reached.
 */
export function graduated(quantity, tiers) {
  let amount = 0;
  let below = 0;
  for (const tier of tiers) {
    if (quantity <= below) break;
    const top = tier.upTo === null || tier.upTo === undefined ? quantity : Math.min(quantity, tier.upTo);
    const units = top - below;
    if (units > 0) amount += units * tier.unitAmount + (tier.flatAmount ?? 0);
    below = tier.upTo ?? quantity;
  }
  return amount;
}

const fmt = (n) => n.toLocaleString('en');

/**
 * One invoice line for a price over a period.
 * @param {object} o
 * @param {object} o.price      { id, type, currency, unitAmount, tiers?, aggregate?, freeAllowance?, divideBy? }
 * @param {object} o.product    { id, name, unitLabel? }
 * @param {number} [o.quantity] per_unit / flat / one_off quantity (default 1)
 * @param {{ quantity: number, at: string }[]} [o.usage]   metered usage in the period
 * @param {{ start: string, end: string }} o.period
 * @returns {object|null} the line, or null when a metered price has no usage at all
 */
export function rateItem({ price, product, quantity = 1, usage = [], period }) {
  const currency = price.currency;
  const unit = product.unitLabel ?? 'unit';
  const plural = (n) => (n === 1 ? unit : `${unit}s`);
  if (price.type === 'metered' || (price.type === 'tiered' && price.meterId)) {
    if (!usage.length) return null;
    const used = aggregate(usage, price.aggregate ?? 'sum');
    const free = price.freeAllowance ?? 0;
    const billable = Math.max(0, used - free);
    let amount;
    if (price.tiers?.length) amount = graduated(billable, price.tiers);
    else if (price.divideBy) amount = mulDiv(billable, price.unitAmount, price.divideBy === 'month_hours' ? monthHours(Date.parse(period.start)) : price.divideBy);
    else amount = billable * price.unitAmount;
    return {
      kind: 'usage',
      description: `${product.name} · ${fmt(used)} ${plural(used)}${free ? ` (${fmt(Math.min(used, free))} free)` : ''}`,
      priceId: price.id, productId: product.id,
      quantity: billable, usageQuantity: used, freeAllowance: free,
      unitAmount: price.unitAmount ?? null,
      divideBy: price.divideBy ?? null,
      amount: money(amount, currency),
      period,
    };
  }
  const q = quantity;
  const amount = price.tiers?.length ? graduated(q, price.tiers) : q * price.unitAmount;
  return {
    kind: price.type === 'one_off' ? 'one_off' : 'licensed',
    description: q === 1 ? product.name : `${product.name} × ${fmt(q)}`,
    priceId: price.id, productId: product.id,
    quantity: q, unitAmount: price.unitAmount ?? null,
    amount: money(amount, currency),
    period,
  };
}

/** What a metered price would come to for a whole calendar month at a steady `perHour` usage (for estimates). */
export function monthlyAt(price, perHour, at) {
  const hours = monthHours(at);
  const used = perHour * hours;
  const billable = Math.max(0, used - (price.freeAllowance ?? 0));
  if (price.tiers?.length) return graduated(billable, price.tiers);
  if (price.divideBy) return mulDiv(billable, price.unitAmount, price.divideBy === 'month_hours' ? hours : price.divideBy);
  return billable * price.unitAmount;
}
