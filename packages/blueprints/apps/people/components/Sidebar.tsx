// Sidebar region: the smart nav (all/reconnect/upcoming/starred), the list
// list (with inline create/rename editors + delete), the journal/activity nav,
// and the storage footprint — four separate React roots in app.tsx (#smartNav
// / #listList / #journalNav / #storage), so this file exports several
// top-level components rather than one. The static containers stay global in
// app.css; the JSX-only rows moved into Sidebar.module.css.
import { useEffect, useRef } from 'react';
import { armConfirm } from '../kit.ts';
import { I } from '../icons.ts';
import { listColor, daysSince } from '../format.ts';
import type { Nav, Person, PersonList } from '../types.ts';
import { Icon } from './Shared.tsx';
import styles from './Sidebar.module.css';

function NavItem({
  icon,
  label,
  active,
  count,
  onClick,
}: {
  icon: string;
  label: string;
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button type="button" className={styles.navItem} aria-current={!!active} onClick={onClick}>
      <Icon svg={icon} />
      <span className={styles.lbl}>{label}</span>
      {count != null ? <span className={styles.navCount}>{count}</span> : null}
    </button>
  );
}

export function SmartNav({
  navKind,
  people,
  onSelectNav,
}: {
  navKind: Nav['kind'];
  people: Person[];
  onSelectNav: (nav: Nav) => void;
}) {
  const counts = {
    all: people.length,
    reconnect: people.filter((p) => daysSince(p) >= (p.cadence_days ?? 30)).length,
    upcoming: people.filter((p) => (p.reminders || []).length > 0).length,
    starred: people.filter((p) => p.starred).length,
  };
  return (
    <>
      <NavItem
        icon={I.people}
        label="All people"
        active={navKind === 'all'}
        count={counts.all}
        onClick={() => onSelectNav({ kind: 'all' })}
      />
      <NavItem
        icon={I.clock}
        label="Reconnect"
        active={navKind === 'reconnect'}
        count={counts.reconnect}
        onClick={() => onSelectNav({ kind: 'reconnect' })}
      />
      <NavItem
        icon={I.bell}
        label="Upcoming"
        active={navKind === 'upcoming'}
        count={counts.upcoming}
        onClick={() => onSelectNav({ kind: 'upcoming' })}
      />
      <NavItem
        icon={I.star}
        label="Favorites"
        active={navKind === 'starred'}
        count={counts.starred}
        onClick={() => onSelectNav({ kind: 'starred' })}
      />
    </>
  );
}

// The new-list editor row: an uncontrolled input, focused + selected once on
// mount — the React analogue of the old kit `h()` island's `setTimeout(focus)`.
function ListCreateEdit({
  onCommit,
  onCancel,
}: {
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const commit = () => {
    const name = inputRef.current?.value.trim() ?? '';
    if (name) onCommit(name);
    else onCancel();
  };
  return (
    <div className={styles.folderEdit}>
      <input
        type="text"
        placeholder="List name…"
        aria-label="New list name"
        ref={inputRef}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') onCancel();
        }}
      />
      <button type="button" onClick={commit}>
        Create
      </button>
    </div>
  );
}

function ListRenameEdit({
  c,
  onCommit,
  onCancel,
}: {
  c: PersonList;
  onCommit: (listId: string, name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const node = inputRef.current;
    if (node) {
      node.focus();
      node.select();
    }
  }, []);
  const commit = () => {
    const name = inputRef.current?.value.trim() ?? '';
    if (name && name !== c.name) onCommit(c.list_id, name);
    else onCancel();
  };
  return (
    <div className={styles.folderEdit}>
      <input
        type="text"
        aria-label="List name"
        defaultValue={c.name}
        ref={inputRef}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') onCancel();
        }}
      />
      <button type="button" onClick={commit}>
        Save
      </button>
    </div>
  );
}

function ListNavRow({
  c,
  people,
  navKind,
  navListId,
  renamingListId,
  onSelectNav,
  onStartRename,
  onDeleteList,
  onRenameCommit,
  onRenameCancel,
}: {
  c: PersonList;
  people: Person[];
  navKind: Nav['kind'];
  navListId?: string;
  renamingListId: string | null;
  onSelectNav: (nav: Nav) => void;
  onStartRename: (listId: string) => void;
  onDeleteList: (c: PersonList) => void;
  onRenameCommit: (listId: string, name: string) => void;
  onRenameCancel: () => void;
}) {
  if (renamingListId === c.list_id)
    return <ListRenameEdit c={c} onCommit={onRenameCommit} onCancel={onRenameCancel} />;
  const count = people.filter((p) => (p.list_id ?? null) === c.list_id).length;
  const active = navKind === 'list' && navListId === c.list_id;
  return (
    <div className={styles.folder}>
      <button
        type="button"
        className={styles.navItem}
        aria-current={active}
        onClick={() => onSelectNav({ kind: 'list', listId: c.list_id })}
      >
        <span className={styles.navDot} style={{ background: listColor(c.list_id) }}></span>
        <span className={styles.lbl}>{c.name}</span>
        <span className={styles.navCount}>{count || ''}</span>
      </button>
      <span className={styles.folderTools}>
        <button
          type="button"
          className={styles.toolBtn}
          aria-label={`Rename ${c.name}`}
          onClick={(e) => {
            e.stopPropagation();
            onStartRename(c.list_id);
          }}
        >
          <Icon svg={I.rename} />
        </button>
        <button
          type="button"
          className={`${styles.toolBtn} ${styles.danger}`}
          aria-label={`Delete ${c.name}`}
          onClick={(e) => {
            e.stopPropagation();
            if (!armConfirm(e.currentTarget, { armedLabel: '×?' })) return;
            onDeleteList(c);
          }}
        >
          <Icon svg={I.del} />
        </button>
      </span>
    </div>
  );
}

export function ListList({
  lists,
  people,
  navKind,
  navListId,
  renamingListId,
  creatingList,
  onSelectNav,
  onStartRename,
  onDeleteList,
  onRenameCommit,
  onRenameCancel,
  onCreateCommit,
  onCreateCancel,
}: {
  lists: PersonList[];
  people: Person[];
  navKind: Nav['kind'];
  navListId?: string;
  renamingListId: string | null;
  creatingList: boolean;
  onSelectNav: (nav: Nav) => void;
  onStartRename: (listId: string) => void;
  onDeleteList: (c: PersonList) => void;
  onRenameCommit: (listId: string, name: string) => void;
  onRenameCancel: () => void;
  onCreateCommit: (name: string) => void;
  onCreateCancel: () => void;
}) {
  return (
    <>
      {lists.map((c) => (
        <ListNavRow
          key={c.list_id}
          c={c}
          people={people}
          navKind={navKind}
          navListId={navListId}
          renamingListId={renamingListId}
          onSelectNav={onSelectNav}
          onStartRename={onStartRename}
          onDeleteList={onDeleteList}
          onRenameCommit={onRenameCommit}
          onRenameCancel={onRenameCancel}
        />
      ))}
      {creatingList ? <ListCreateEdit onCommit={onCreateCommit} onCancel={onCreateCancel} /> : null}
    </>
  );
}

export function JournalNav({
  navKind,
  onSelectNav,
}: {
  navKind: Nav['kind'];
  onSelectNav: (nav: Nav) => void;
}) {
  return (
    <>
      <NavItem
        icon={I.journal}
        label="Journal"
        active={navKind === 'journal'}
        onClick={() => onSelectNav({ kind: 'journal' })}
      />
      <NavItem
        icon={I.activity}
        label="Activity"
        active={navKind === 'activity'}
        onClick={() => onSelectNav({ kind: 'activity' })}
      />
    </>
  );
}

export function Storage({ people, lists }: { people: Person[]; lists: PersonList[] }) {
  const count = people.length;
  return (
    <>
      <div className={styles.storageTop}>
        <span className={styles.lbl}>People</span>
        <span className={styles.val}>{count}</span>
      </div>
      <div className={styles.storageLabel}>
        {count} {count === 1 ? 'person' : 'people'} across {lists.length} list
        {lists.length === 1 ? '' : 's'}
      </div>
    </>
  );
}
