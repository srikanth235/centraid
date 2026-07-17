// Sidebar region: the smart nav (all/reconnect/upcoming/starred), the list
// list (with inline create/rename editors + delete), the journal/activity nav,
// and the storage footprint — four separate React roots in app.jsx (#smartNav
// / #listList / #journalNav / #storage), so this file exports several
// top-level components rather than one.
import { useEffect, useRef } from '../react-core.min.js';
import { armConfirm } from '../kit.js';
import { I } from '../icons.js';
import { listColor, daysSince } from '../format.js';
import { Icon } from './Shared.jsx';

function NavItem({ icon, label, active, count, onClick }) {
  return (
    <button type="button" className="d-nav-item" aria-current={String(!!active)} onClick={onClick}>
      <Icon svg={icon} />
      <span className="lbl">{label}</span>
      {count != null ? <span className="d-nav-count">{count}</span> : null}
    </button>
  );
}

export function SmartNav({ navKind, people, onSelectNav }) {
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
function ListCreateEdit({ onCommit, onCancel }) {
  const inputRef = useRef(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const commit = () => {
    const name = inputRef.current.value.trim();
    if (name) onCommit(name);
    else onCancel();
  };
  return (
    <div className="d-folder-edit">
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

function ListRenameEdit({ c, onCommit, onCancel }) {
  const inputRef = useRef(null);
  useEffect(() => {
    const node = inputRef.current;
    if (node) {
      node.focus();
      node.select();
    }
  }, []);
  const commit = () => {
    const name = inputRef.current.value.trim();
    if (name && name !== c.name) onCommit(c.list_id, name);
    else onCancel();
  };
  return (
    <div className="d-folder-edit">
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
}) {
  if (renamingListId === c.list_id)
    return <ListRenameEdit c={c} onCommit={onRenameCommit} onCancel={onRenameCancel} />;
  const count = people.filter((p) => (p.list_id ?? null) === c.list_id).length;
  const active = navKind === 'list' && navListId === c.list_id;
  return (
    <div className="d-folder">
      <button
        type="button"
        className="d-nav-item"
        aria-current={String(active)}
        onClick={() => onSelectNav({ kind: 'list', listId: c.list_id })}
      >
        <span className="d-nav-dot" style={{ background: listColor(c.list_id) }}></span>
        <span className="lbl">{c.name}</span>
        <span className="d-nav-count">{count || ''}</span>
      </button>
      <span className="d-folder-tools">
        <button
          type="button"
          className="d-tool-btn"
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
          className="d-tool-btn danger"
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

export function JournalNav({ navKind, onSelectNav }) {
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

export function Storage({ people, lists }) {
  const count = people.length;
  return (
    <>
      <div className="d-storage-top">
        <span className="lbl">People</span>
        <span className="val">{count}</span>
      </div>
      <div className="d-storage-label">
        {count} {count === 1 ? 'person' : 'people'} across {lists.length} list
        {lists.length === 1 ? '' : 's'}
      </div>
    </>
  );
}
