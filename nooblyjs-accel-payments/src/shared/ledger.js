// The double-entry ledger (spec §6 "Ledger postings"): append-only; every transaction balances (debits = credits, per
// currency). Entries are written as signed amounts (+ debit, − credit) and stored with both columns for reading.
import { invalid } from './errors.js';
import { newId } from './ids.js';

export const LEDGER_ACCOUNTS = ['receivable', 'cash', 'revenue', 'tax_payable', 'customer_credit', 'refunds', 'bad_debt'];

/**
 * @param {{ repo: ReturnType<import('./store.js').createRepo>, clock: { now(): number } }} o
 */
export function createLedger({ repo, clock }) {
  /**
   * Posts one balanced transaction.
   * @param {{ accountId: string, currency: string, ref: { type: string, id: string }, memo: string, lines: [string, number][], at?: string }} tx
   * @returns {Promise<string>} the transaction id
   */
  async function post({ accountId, currency, ref, memo, lines, at }) {
    const real = lines.filter(([, amount]) => amount !== 0);
    for (const [account, amount] of real) {
      if (!LEDGER_ACCOUNTS.includes(account)) throw invalid(`Unknown ledger account ${account}.`);
      if (!Number.isSafeInteger(amount)) throw invalid('Ledger amounts are integers.');
    }
    const total = real.reduce((s, [, a]) => s + a, 0);
    if (total !== 0) throw new Error(`Unbalanced ledger transaction for ${ref.type} ${ref.id}: off by ${total}.`);
    if (!real.length) return null;
    const txId = newId('tx');
    const when = at ?? new Date(clock.now()).toISOString();
    let n = 0;
    for (const [account, amount] of real) {
      n += 1;
      await repo.insert({
        id: `${txId}_${n}`, txId, accountId, account, currency, ref, memo, at: when,
        debit: amount > 0 ? amount : 0,
        credit: amount < 0 ? -amount : 0,
      });
    }
    return txId;
  }

  /** Balances (debit − credit) per ledger account, for one billing account or all, in one currency. */
  function balances({ accountId, currency } = {}) {
    const out = Object.fromEntries(LEDGER_ACCOUNTS.map((a) => [a, 0]));
    for (const e of repo.list((x) => (!accountId || x.accountId === accountId) && (!currency || x.currency === currency))) {
      out[e.account] += e.debit - e.credit;
    }
    return out;
  }

  /** Transactions that do not balance (should always be empty). */
  function unbalanced() {
    const totals = new Map();
    for (const e of repo.list()) {
      const key = `${e.txId}:${e.currency}`;
      totals.set(key, (totals.get(key) ?? 0) + e.debit - e.credit);
    }
    return [...totals].filter(([, v]) => v !== 0).map(([k]) => k);
  }

  const entries = ({ accountId, refId } = {}) => repo.list((e) => (!accountId || e.accountId === accountId) && (!refId || e.ref?.id === refId))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));

  return { post, balances, unbalanced, entries };
}
