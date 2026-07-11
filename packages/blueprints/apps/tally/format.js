// Pure, JSX-free helpers: category/colour constants, money formatting
// (currency threaded explicitly — no closure over the dashboard snapshot),
// the split-resolution math and the balance-label sentences. No app state,
// no vault IO — every function is a plain projection of its arguments so
// app.jsx and the components can both call them without a circular import.
// Same role as tasks/format.js and notes/format.js.
import { fmtMoney, localDayKey } from './kit.js';

export const MS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

// The closed category set — emoji + tint, straight from the prototype.
export const CATS = {
  food: { icon: '🍔', color: '#E2603A' },
  groceries: { icon: '🛒', color: '#57A55A' },
  rent: { icon: '🏠', color: '#4E68DD' },
  utilities: { icon: '💡', color: '#E8923C' },
  transport: { icon: '🚕', color: '#3AA6B9' },
  fun: { icon: '🎬', color: '#7C5BD9' },
  travel: { icon: '✈️', color: '#0FA678' },
  shopping: { icon: '🛍️', color: '#E0567A' },
  general: { icon: '🧾', color: '#5C677D' },
};
export const CAT_LIST = [
  'food',
  'groceries',
  'rent',
  'utilities',
  'transport',
  'fun',
  'travel',
  'shopping',
  'general',
];
export const GROUP_ICONS = ['🏠', '✈️', '🎲', '🍽️', '🏖️', '🎉', '🏔️', '🚗'];
export const FRIEND_COLORS = [
  '#7C5BD9',
  '#4E68DD',
  '#E0567A',
  '#E8923C',
  '#2EA098',
  '#3AA6B9',
  '#57A55A',
  '#D9536F',
];

export function cat(c) {
  return CATS[c] || CATS.general;
}
export function tint(color) {
  return `color-mix(in oklab, ${color || '#5C677D'} 16%, transparent)`;
}

// ---------- Formatting (money is minor units end-to-end) ----------

// Absolute value, localized via the kit — the dashboard's currency, not a
// hardcoded "$" (callers phrase direction themselves: "owes you …"). Callers
// pass the active `currency` explicitly (dash.currency) instead of this
// module closing over app state.
export function money(minor, currency) {
  return fmtMoney(Math.abs(Number(minor ?? 0)), currency || 'USD');
}
// The bare currency symbol for the amount-input prefixes. Every rendered
// amount already follows the vault's base currency via fmtMoney (₹, €, …),
// so a hard-coded "$" next to the input lies whenever the vault isn't USD —
// derive the symbol from the same currency instead.
export function curSymbolFor(currency) {
  const cur = currency || 'USD';
  try {
    return (
      new Intl.NumberFormat(undefined, { style: 'currency', currency: cur })
        .formatToParts(0)
        .find((p) => p.type === 'currency')?.value ?? cur
    );
  } catch {
    return cur;
  }
}
// Parse a decimal-dollar string → integer cents.
export function toCents(str) {
  const n = parseFloat(str);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100);
}
export function todayKey() {
  return localDayKey(new Date());
}
export function first(name) {
  return String(name ?? '').split(/\s+/)[0] || name || '';
}

export function balLabelFriend(v, currency) {
  if (Math.abs(v) < 1) return { cls: 'muted', label: 'settled up' };
  return v > 0
    ? { cls: 'pos', label: 'owes you ' + money(v, currency) }
    : { cls: 'neg', label: 'you owe ' + money(v, currency) };
}
export function balLabelGroup(v, currency) {
  if (Math.abs(v) < 1) return { cls: 'muted', label: 'settled up' };
  return v > 0
    ? { cls: 'pos', label: 'you are owed ' + money(v, currency) }
    : { cls: 'neg', label: 'you owe ' + money(v, currency) };
}

// ---------- Split resolution → minor-unit splits array ----------

// Port of the prototype's computeSplits, in cents. `include` is a Set of
// party ids; exact/percent are maps of party_id → decimal-string. `members`
// is the current modal's member list (the app.js original closed over
// `state.modalMembers`; here it's threaded in explicitly so this stays a
// pure function of its arguments). Returns [{party_id, share_minor}] summing
// to amountCents, or null if invalid. The rounding remainder always lands on
// the last participant.
export function resolveSplits(model, amountCents, members) {
  const parts = members.map((m) => m.party_id).filter((id) => model.include.has(id));
  if (parts.length === 0 || !(amountCents > 0)) return null;
  const out = [];
  if (model.method === 'equal') {
    const per = Math.round(amountCents / parts.length);
    let acc = 0;
    parts.forEach((id, i) => {
      const share = i === parts.length - 1 ? amountCents - acc : per;
      out.push({ party_id: id, share_minor: share });
      acc += share;
    });
  } else if (model.method === 'exact') {
    let sum = 0;
    for (const id of parts) {
      const c = toCents(model.exact[id]) || 0;
      out.push({ party_id: id, share_minor: c });
      sum += c;
    }
    if (Math.abs(sum - amountCents) > 1) return null; // allow a single-cent rounding wobble
  } else {
    // percent
    let pctSum = 0;
    for (const id of parts) pctSum += parseFloat(model.percent[id]) || 0;
    if (Math.abs(pctSum - 100) > 0.1) return null;
    let acc = 0;
    parts.forEach((id, i) => {
      const share =
        i === parts.length - 1
          ? amountCents - acc
          : Math.round((amountCents * (parseFloat(model.percent[id]) || 0)) / 100);
      out.push({ party_id: id, share_minor: share });
      acc += share;
    });
  }
  return out;
}

// The live sum/validity line under the split rows — computed fresh on every
// render (a controlled re-render keeps the focused input in place, so there
// is no need for a separate "update just the sum" path; every keystroke can
// safely recompute this).
export function splitSumInfo(exp, members, currency) {
  const cents = toCents(exp.amount) || 0;
  const parts = members.filter((m) => exp.include.has(m.party_id));
  if (exp.method === 'exact') {
    const sum = parts.reduce((a, m) => a + (toCents(exp.exact[m.party_id]) || 0), 0);
    const diff = cents - sum;
    const bad = Math.abs(diff) > 1;
    return {
      bad,
      text:
        money(sum, currency) +
        ' of ' +
        money(cents, currency) +
        (bad ? ' · ' + money(Math.abs(diff), currency) + (diff > 0 ? ' left' : ' over') : ' ✓'),
    };
  }
  if (exp.method === 'percent') {
    const sum = parts.reduce((a, m) => a + (parseFloat(exp.percent[m.party_id]) || 0), 0);
    const bad = Math.abs(sum - 100) > 0.1;
    return { bad, text: sum.toFixed(0) + '% of 100%' + (!bad ? ' ✓' : '') };
  }
  const per = parts.length && cents > 0 ? cents / parts.length : 0;
  return {
    bad: false,
    text: parts.length
      ? money(per, currency) + ' each · ' + parts.length + ' people'
      : 'Select who splits',
  };
}
