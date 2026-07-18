// Sidebar region: the smart-section nav (Dashboard / Activity), the groups
// list and the friends list — three React roots (#smartNav, #groupsNav,
// #friendsNav). The brand row, "Add an expense" button and the
// groups/friends section headers (with their own add buttons) are static
// HTML in index.html (stable, no per-render data), wired once in chrome.ts.
// Same three-root shape as tasks/notes' Sidebar.tsx.
import { balLabelFriend, balLabelGroup, tint } from '../format.ts';
import { I } from '../icons.ts';
import type { BalLabel, Friend, Group, NavPatch, View } from '../types.ts';
import { Icon, KitAvatar } from './Shared.tsx';
import styles from './Sidebar.module.css';
import shared from './shared.module.css';

// The money-tone modifier for a balance label — an explicit lookup map keyed by
// the `cls` the format helpers return (never a computed styles[expr]).
const TONE: Record<BalLabel['cls'], string> = {
  pos: shared.pos!,
  neg: shared.neg!,
  muted: shared.muted!,
};

export function SmartNav({ view, onSelect }: { view: View; onSelect: (patch: NavPatch) => void }) {
  return (
    <>
      <button
        type="button"
        className={styles.navItem}
        aria-current={view === 'dashboard'}
        onClick={() => onSelect({ view: 'dashboard', search: '' })}
      >
        <Icon svg={I.dashboard!} />
        <span className={styles.lbl}>Dashboard</span>
      </button>
      <button
        type="button"
        className={styles.navItem}
        aria-current={view === 'activity'}
        onClick={() => onSelect({ view: 'activity', search: '' })}
      >
        <Icon svg={I.activity!} />
        <span className={styles.lbl}>Activity</span>
      </button>
    </>
  );
}

export function GroupsNav({
  groups,
  view,
  groupId,
  currency,
  onSelect,
}: {
  groups: Group[];
  view: View;
  groupId: string | null;
  currency: string;
  onSelect: (patch: NavPatch) => void;
}) {
  return (
    <>
      {groups.map((g) => {
        const { cls, label } = balLabelGroup(g.owner_net_minor, currency);
        return (
          <button
            key={g.group_id}
            type="button"
            className={styles.listitem}
            aria-current={view === 'group' && groupId === g.group_id}
            onClick={() => onSelect({ view: 'group', groupId: g.group_id, search: '' })}
          >
            <span className={shared.gicon} style={{ background: tint(g.color) }}>
              {g.icon || '👥'}
            </span>
            <span className={styles.liMain}>
              <span className={styles.liName}>{g.name}</span>
              <span className={`${styles.liSub} ${TONE[cls]}`}>{label}</span>
            </span>
          </button>
        );
      })}
    </>
  );
}

export function FriendsNav({
  friends,
  view,
  friendId,
  currency,
  onSelect,
}: {
  friends: Friend[];
  view: View;
  friendId: string | null;
  currency: string;
  onSelect: (patch: NavPatch) => void;
}) {
  return (
    <>
      {friends.map((f) => {
        const { cls, label } = balLabelFriend(f.net_minor, currency);
        return (
          <button
            key={f.party_id}
            type="button"
            className={styles.listitem}
            aria-current={view === 'friend' && friendId === f.party_id}
            onClick={() => onSelect({ view: 'friend', friendId: f.party_id, search: '' })}
          >
            <KitAvatar name={f.name} size="28px" color={f.color} initials={f.initials} />
            <span className={styles.liMain}>
              <span className={styles.liName}>{f.name}</span>
              <span className={`${styles.liSub} ${TONE[cls]}`}>{label}</span>
            </span>
          </button>
        );
      })}
    </>
  );
}
