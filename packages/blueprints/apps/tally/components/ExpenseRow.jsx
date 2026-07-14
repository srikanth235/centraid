// One expense row from a decorated ledger/search row (already carries
// splits). Shared by Ledger.jsx (group/friend view) and Search.jsx —
// `groupSuffix` folds the group name into the sub line for search results,
// like the prototype does.
import { MS, cat, first, money, tint, todayKey } from '../format.js';

export function ExpenseRow({ row, currency, groupSuffix = false, onOpen }) {
  const c = cat(row.category);
  const d = new Date((row.spent_on || todayKey()) + 'T12:00:00');
  let rLabel, amt, cls, sub;
  if (row.your_role === 'lent') {
    rLabel = 'you lent';
    amt = money(row.your_amount_minor, currency);
    cls = 'pos';
    sub = 'you paid ' + money(row.amount_minor, currency);
  } else if (row.your_role === 'borrowed') {
    rLabel = 'you borrowed';
    amt = money(row.your_amount_minor, currency);
    cls = 'neg';
    sub = first(row.paid_by_name) + ' paid ' + money(row.amount_minor, currency);
  } else {
    rLabel = 'not involved';
    amt = money(row.amount_minor, currency);
    cls = 'muted';
    sub = first(row.paid_by_name) + ' paid';
  }
  if (groupSuffix && row.group_name) sub = `${sub} · ${row.group_name}`;

  // Optimistic / parked rows (issue #404): the kit's shared pending
  // treatment — accent rail on the row, spinning mono chip where the role
  // label sits — and no detail popover (there is no receipt or server row to
  // show yet; the doorbell refresh swaps in the real one).
  const pending = Boolean(row.pending);
  return (
    <button
      type="button"
      className={pending ? 's-exrow kit-pending' : 's-exrow'}
      onClick={pending ? undefined : () => onOpen(row)}
    >
      <span className="s-exdate">
        <span className="mo">{MS[d.getMonth()]}</span>
        <span className="dy">{String(d.getDate())}</span>
      </span>
      <span className="s-excat" style={{ background: tint(c.color) }}>
        {c.icon}
      </span>
      <span className="s-exmain">
        <span className="s-exdesc">{row.description}</span>
        <span className="s-exsub">{sub}</span>
      </span>
      <span className="s-exright">
        {pending ? (
          <span className="kit-pending-chip">pending</span>
        ) : (
          <span className="s-exlabel">{rLabel}</span>
        )}
        <span className={`s-examt ${cls}`}>{amt}</span>
      </span>
    </button>
  );
}
