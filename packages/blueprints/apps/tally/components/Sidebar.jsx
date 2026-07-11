// Sidebar region: the smart-section nav (Dashboard / Activity), the groups
// list and the friends list — three React roots (#smartNav, #groupsNav,
// #friendsNav). The brand row, "Add an expense" button and the
// groups/friends section headers (with their own add buttons) are static
// HTML in index.html (stable, no per-render data), wired once in chrome.js.
// Same three-root shape as tasks/notes' Sidebar.jsx.
import { balLabelFriend, balLabelGroup, tint } from '../format.js';
import { I } from '../icons.js';
import { Icon } from './Shared.jsx';

export function SmartNav({ view, onSelect }) {
  return (
    <>
      <button
        type="button"
        className="s-nav-item"
        aria-current={String(view === 'dashboard')}
        onClick={() => onSelect({ view: 'dashboard', search: '' })}
      >
        <Icon svg={I.dashboard} />
        <span className="lbl">Dashboard</span>
      </button>
      <button
        type="button"
        className="s-nav-item"
        aria-current={String(view === 'activity')}
        onClick={() => onSelect({ view: 'activity', search: '' })}
      >
        <Icon svg={I.activity} />
        <span className="lbl">Activity</span>
      </button>
    </>
  );
}

export function GroupsNav({ groups, view, groupId, currency, onSelect }) {
  return (
    <>
      {groups.map((g) => {
        const { cls, label } = balLabelGroup(g.owner_net_minor, currency);
        return (
          <button
            key={g.group_id}
            type="button"
            className="s-listitem"
            aria-current={String(view === 'group' && groupId === g.group_id)}
            onClick={() => onSelect({ view: 'group', groupId: g.group_id, search: '' })}
          >
            <span className="s-gicon" style={{ background: tint(g.color) }}>
              {g.icon || '👥'}
            </span>
            <span className="s-li-main">
              <span className="s-li-name">{g.name}</span>
              <span className={`s-li-sub ${cls}`}>{label}</span>
            </span>
          </button>
        );
      })}
    </>
  );
}

export function FriendsNav({ friends, view, friendId, currency, onSelect }) {
  return (
    <>
      {friends.map((f) => {
        const { cls, label } = balLabelFriend(f.net_minor, currency);
        return (
          <button
            key={f.party_id}
            type="button"
            className="s-listitem"
            aria-current={String(view === 'friend' && friendId === f.party_id)}
            onClick={() => onSelect({ view: 'friend', friendId: f.party_id, search: '' })}
          >
            <kit-avatar name={f.name} size="28px" color={f.color} initials={f.initials} />
            <span className="s-li-main">
              <span className="s-li-name">{f.name}</span>
              <span className={`s-li-sub ${cls}`}>{label}</span>
            </span>
          </button>
        );
      })}
    </>
  );
}
