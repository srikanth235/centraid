// The dashboard: fresh-vault welcome state, the balance summary, "you
// owe"/"you are owed" lists and the groups grid. Pure function of the
// dashboard snapshot (`dash`) plus navigation/modal callbacks.
import { balLabelGroup, money, tint } from '../format.js';

function BalRow({ p, kind, currency, onOpen }) {
  const amtCls = kind === 'owe' ? 'neg' : 'pos';
  return (
    <button type="button" className="s-bal-row" onClick={() => onOpen(p.party_id)}>
      <kit-avatar name={p.name} size="34px" color={p.color} initials={p.initials} />
      <span className="s-bal-main">
        <span className="s-bal-name">{p.name}</span>
        <span className="s-bal-sub">{kind === 'owe' ? 'you owe' : 'owes you'}</span>
      </span>
      <span className={`s-bal-amt ${amtCls}`}>{money(p.net_minor, currency)}</span>
    </button>
  );
}

function GroupCard({ g, currency, onOpen }) {
  const { cls, label } = balLabelGroup(g.owner_net_minor, currency);
  return (
    <button type="button" className="s-gcard" onClick={() => onOpen(g.group_id)}>
      <div className="s-gcard-top">
        <span
          className="s-gicon"
          style={{ width: '38px', height: '38px', fontSize: '19px', background: tint(g.color) }}
        >
          {g.icon || '👥'}
        </span>
        <div>
          <div className="s-gcard-name">{g.name}</div>
          <div className="s-gcard-mem">
            {g.member_count} member{g.member_count === 1 ? '' : 's'}
          </div>
        </div>
      </div>
      <div className={`s-gcard-bal ${cls}`}>{label}</div>
    </button>
  );
}

export function Dashboard({ dash, onOpenFriend, onOpenGroup, onOpenAddFriend, onOpenNewGroup }) {
  const { friends, groups, currency } = dash;

  // A fresh vault: no friends and no groups — invite the first steps.
  if (friends.length === 0 && groups.length === 0) {
    return (
      <div className="s-dash-empty">
        <div className="t">Welcome to Tally</div>
        <div className="d">
          Add a friend, then create a group and start splitting shared costs. Balances update the
          moment you record an expense or a payment.
        </div>
        <div className="row">
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
  const netCls = Math.abs(net) < 1 ? '' : net > 0 ? 'pos' : 'neg';
  const netLabel = (net >= 0 ? '+' : '−') + money(net, currency);

  const oweList = friends.filter((f) => f.net_minor < -1);
  const owedList = friends.filter((f) => f.net_minor > 1);

  return (
    <>
      <div className="s-summary">
        <div className="s-stat">
          <div className="k">Total balance</div>
          <div className={`v ${netCls}`}>{netLabel}</div>
        </div>
        <div className="s-stat">
          <div className="k">You owe</div>
          <div className="v neg">{money(owe, currency)}</div>
        </div>
        <div className="s-stat">
          <div className="k">You are owed</div>
          <div className="v pos">{money(owed, currency)}</div>
        </div>
      </div>
      <div className="s-cols">
        <div className="s-card">
          <div className="s-card-h">You owe</div>
          {oweList.length === 0 ? (
            <div className="s-empty-row">You're all settled up.</div>
          ) : (
            oweList.map((p) => (
              <BalRow key={p.party_id} p={p} kind="owe" currency={currency} onOpen={onOpenFriend} />
            ))
          )}
        </div>
        <div className="s-card">
          <div className="s-card-h">You are owed</div>
          {owedList.length === 0 ? (
            <div className="s-empty-row">Nobody owes you right now.</div>
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
      <div className="s-section-title">Your groups</div>
      {groups.length === 0 ? (
        <div className="s-card">
          <div className="s-empty-row" style={{ padding: '28px 16px' }}>
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
        <div className="s-groupgrid">
          {groups.map((g) => (
            <GroupCard key={g.group_id} g={g} currency={currency} onOpen={onOpenGroup} />
          ))}
        </div>
      )}
    </>
  );
}
