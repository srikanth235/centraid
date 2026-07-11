// The activity feed: expenses and settlements, newest first, each folded
// into one sentence with an optional "you get back / you owe" suffix.
import { MS, cat, first, money, todayKey } from '../format.js';

function ActivityItem({ a, me, currency }) {
  const d = new Date((a.date || todayKey()) + 'T12:00:00');
  const when = `${MS[d.getMonth()]} ${d.getDate()}`;
  let icon;
  let text;
  let suffix = '';
  let cls = 'muted';
  if (a.kind === 'expense') {
    icon = cat(a.category).icon;
    const who = a.paid_by === me ? 'You' : first(a.paid_by_name);
    text = `${who} added “${a.description}”${a.group_name ? ' in ' + a.group_name : ''}`;
    if (a.your_role === 'lent') {
      suffix = '  ·  you get back ' + money(a.your_amount_minor, currency);
      cls = 'pos';
    } else if (a.your_role === 'borrowed') {
      suffix = '  ·  you owe ' + money(a.your_amount_minor, currency);
      cls = 'neg';
    }
  } else {
    icon = '💸';
    const toWho = a.to_party === me ? 'you' : first(a.to_name);
    text =
      a.from_party === me
        ? `You paid ${first(a.to_name)} ${money(a.amount_minor, currency)}`
        : `${first(a.from_name)} paid ${toWho} ${money(a.amount_minor, currency)}`;
  }
  return (
    <div className="s-act">
      <span className="s-act-ic">{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="s-act-t">{text}</div>
        <div className="s-act-d">
          {when}
          {suffix ? <span className={cls}>{suffix}</span> : null}
        </div>
      </div>
    </div>
  );
}

export function ActivityFeed({ viewData, me, currency }) {
  if (!viewData) {
    return (
      <div>
        <kit-skeleton rows={6}></kit-skeleton>
      </div>
    );
  }
  const items = viewData.activity ?? [];
  if (items.length === 0) {
    return (
      <div className="s-explist">
        <div className="s-empty-row" style={{ padding: '40px 16px' }}>
          Nothing has happened yet.
        </div>
      </div>
    );
  }
  return (
    <>
      {items.map((a, i) => (
        <ActivityItem
          key={a.expense_id ?? a.settlement_id ?? i}
          a={a}
          me={me}
          currency={currency}
        />
      ))}
    </>
  );
}
