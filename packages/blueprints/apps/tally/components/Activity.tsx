// The activity feed: expenses and settlements, newest first, each folded
// into one sentence with an optional "you get back / you owe" suffix.
import { MS, cat, first, money, todayKey } from '../format.ts';
import type { ActivityRow, ViewData } from '../types.ts';
import { KitSkeleton } from './Shared.tsx';
import styles from './Activity.module.css';
import shared from './shared.module.css';

const TONE = {
  pos: shared.pos!,
  neg: shared.neg!,
  muted: shared.muted!,
} as const;

function ActivityItem({
  a,
  me,
  currency,
}: {
  a: ActivityRow;
  me: string | null;
  currency: string;
}) {
  const d = new Date((a.date || todayKey()) + 'T12:00:00');
  const when = `${MS[d.getMonth()]} ${d.getDate()}`;
  let icon: string;
  let text: string;
  let suffix = '';
  let cls: 'pos' | 'neg' | 'muted' = 'muted';
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
    <div className={styles.act}>
      <span className={styles.actIc}>{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className={styles.actT}>{text}</div>
        <div className={styles.actD}>
          {when}
          {suffix ? <span className={TONE[cls]}>{suffix}</span> : null}
        </div>
      </div>
    </div>
  );
}

export function ActivityFeed({
  viewData,
  me,
  currency,
}: {
  viewData: ViewData | null;
  me: string | null;
  currency: string;
}) {
  if (!viewData) {
    return (
      <div>
        <KitSkeleton rows={6} />
      </div>
    );
  }
  const items = viewData.activity ?? [];
  if (items.length === 0) {
    return (
      <div className={shared.explist}>
        <div className={shared.emptyRow} style={{ padding: '40px 16px' }}>
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
