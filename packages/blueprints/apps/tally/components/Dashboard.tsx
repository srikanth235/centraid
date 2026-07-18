// The dashboard: fresh-vault welcome state, the balance summary, "you
// owe"/"you are owed" lists and the groups grid. Pure function of the
// dashboard snapshot (`dash`) plus navigation/modal callbacks.
import { balLabelGroup, money, tint } from '../format.ts';
import type { Dash, Friend, Group } from '../types.ts';
import { KitAvatar } from './Shared.tsx';
import styles from './Dashboard.module.css';
import shared from './shared.module.css';

// Money-tone modifiers, mapped from the computed cls (never a computed
// styles[expr]).
const TONE = {
  pos: shared.pos!,
  neg: shared.neg!,
  muted: shared.muted!,
} as const;

function BalRow({
  p,
  kind,
  currency,
  onOpen,
}: {
  p: Friend;
  kind: 'owe' | 'owed';
  currency: string;
  onOpen: (partyId: string) => void;
}) {
  const amtCls = kind === 'owe' ? 'neg' : 'pos';
  return (
    <button type="button" className={styles.balRow} onClick={() => onOpen(p.party_id)}>
      <KitAvatar name={p.name} size="34px" color={p.color} initials={p.initials} />
      <span className={styles.balMain}>
        <span className={styles.balName}>{p.name}</span>
        <span className={styles.balSub}>{kind === 'owe' ? 'you owe' : 'owes you'}</span>
      </span>
      <span className={`${styles.balAmt} ${TONE[amtCls]}`}>{money(p.net_minor, currency)}</span>
    </button>
  );
}

function GroupCard({
  g,
  currency,
  onOpen,
}: {
  g: Group;
  currency: string;
  onOpen: (groupId: string) => void;
}) {
  const { cls, label } = balLabelGroup(g.owner_net_minor, currency);
  return (
    <button type="button" className={styles.gcard} onClick={() => onOpen(g.group_id)}>
      <div className={styles.gcardTop}>
        <span
          className={shared.gicon}
          style={{ width: '38px', height: '38px', fontSize: '19px', background: tint(g.color) }}
        >
          {g.icon || '👥'}
        </span>
        <div>
          <div className={styles.gcardName}>{g.name}</div>
          <div className={styles.gcardMem}>
            {g.member_count} member{g.member_count === 1 ? '' : 's'}
          </div>
        </div>
      </div>
      <div className={`${styles.gcardBal} ${TONE[cls]}`}>{label}</div>
    </button>
  );
}

export function Dashboard({
  dash,
  onOpenFriend,
  onOpenGroup,
  onOpenAddFriend,
  onOpenNewGroup,
}: {
  dash: Dash;
  onOpenFriend: (friendId: string) => void;
  onOpenGroup: (groupId: string) => void;
  onOpenAddFriend: () => void;
  onOpenNewGroup: () => void;
}) {
  const { friends, groups, currency } = dash;

  // A fresh vault: no friends and no groups — invite the first steps.
  if (friends.length === 0 && groups.length === 0) {
    return (
      <div className={styles.dashEmpty}>
        <div className={styles.t}>Welcome to Tally</div>
        <div className={styles.d}>
          Add a friend, then create a group and start splitting shared costs. Balances update the
          moment you record an expense or a payment.
        </div>
        <div className={styles.row}>
          <button type="button" className="kit-btn primary" onClick={onOpenAddFriend}>
            Add a friend
          </button>
          <button type="button" className="kit-btn" onClick={onOpenNewGroup}>
            Create a group
          </button>
        </div>
      </div>
    );
  }

  const owed = dash.owed_total_minor;
  const owe = dash.owe_total_minor;
  const net = owed - owe;
  const netCls: '' | 'pos' | 'neg' = Math.abs(net) < 1 ? '' : net > 0 ? 'pos' : 'neg';
  const netLabel = (net >= 0 ? '+' : '−') + money(net, currency);

  const oweList = friends.filter((f) => f.net_minor < -1);
  const owedList = friends.filter((f) => f.net_minor > 1);

  return (
    <>
      <div className={styles.summary}>
        <div className={styles.stat}>
          <div className={styles.k}>Total balance</div>
          <div className={`${styles.v} ${netCls ? TONE[netCls] : ''}`}>{netLabel}</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.k}>You owe</div>
          <div className={`${styles.v} ${TONE.neg}`}>{money(owe, currency)}</div>
        </div>
        <div className={styles.stat}>
          <div className={styles.k}>You are owed</div>
          <div className={`${styles.v} ${TONE.pos}`}>{money(owed, currency)}</div>
        </div>
      </div>
      <div className={styles.cols}>
        <div className={styles.card}>
          <div className={styles.cardH}>You owe</div>
          {oweList.length === 0 ? (
            <div className={shared.emptyRow}>You're all settled up.</div>
          ) : (
            oweList.map((p) => (
              <BalRow key={p.party_id} p={p} kind="owe" currency={currency} onOpen={onOpenFriend} />
            ))
          )}
        </div>
        <div className={styles.card}>
          <div className={styles.cardH}>You are owed</div>
          {owedList.length === 0 ? (
            <div className={shared.emptyRow}>Nobody owes you right now.</div>
          ) : (
            owedList.map((p) => (
              <BalRow
                key={p.party_id}
                p={p}
                kind="owed"
                currency={currency}
                onOpen={onOpenFriend}
              />
            ))
          )}
        </div>
      </div>
      <div className={styles.sectionTitle}>Your groups</div>
      {groups.length === 0 ? (
        <div className={styles.card}>
          <div className={shared.emptyRow} style={{ padding: '28px 16px' }}>
            No groups yet.
            <button
              type="button"
              style={{
                border: 'none',
                background: 'none',
                color: 'var(--accd)',
                fontWeight: 600,
                cursor: 'pointer',
              }}
              onClick={onOpenNewGroup}
            >
              Create one
            </button>
            to start splitting.
          </div>
        </div>
      ) : (
        <div className={styles.groupgrid}>
          {groups.map((g) => (
            <GroupCard key={g.group_id} g={g} currency={currency} onOpen={onOpenGroup} />
          ))}
        </div>
      )}
    </>
  );
}
