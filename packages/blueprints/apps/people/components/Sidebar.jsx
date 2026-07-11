// Sidebar region: the smart nav (all/reconnect/upcoming/starred), the circle
// list (with inline create/rename editors + delete), the journal/activity nav,
// and the storage footprint — four separate React roots in app.jsx (#smartNav
// / #circleList / #journalNav / #storage), so this file exports several
// top-level components rather than one.
import { useEffect, useRef } from '../react-core.min.js';
import { armConfirm } from '../kit.js';
import { I } from '../icons.js';
import { circleColor, daysSince } from '../format.js';
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

// The new-circle editor row: an uncontrolled input, focused + selected once on
// mount — the React analogue of the old kit `h()` island's `setTimeout(focus)`.
function CircleCreateEdit({ onCommit, onCancel }) {
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
        placeholder="Circle name…"
        aria-label="New circle name"
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

function CircleRenameEdit({ c, onCommit, onCancel }) {
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
    if (name && name !== c.name) onCommit(c.circle_id, name);
    else onCancel();
  };
  return (
    <div className="d-folder-edit">
      <input
        type="text"
        aria-label="Circle name"
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

function CircleRow({
  c,
  people,
  navKind,
  navCircleId,
  renamingCircleId,
  onSelectNav,
  onStartRename,
  onDeleteCircle,
  onRenameCommit,
  onRenameCancel,
}) {
  if (renamingCircleId === c.circle_id)
    return <CircleRenameEdit c={c} onCommit={onRenameCommit} onCancel={onRenameCancel} />;
  const count = people.filter((p) => (p.circle_id ?? null) === c.circle_id).length;
  const active = navKind === 'circle' && navCircleId === c.circle_id;
  return (
    <div className="d-folder">
      <button
        type="button"
        className="d-nav-item"
        aria-current={String(active)}
        onClick={() => onSelectNav({ kind: 'circle', circleId: c.circle_id })}
      >
        <span className="d-nav-dot" style={{ background: circleColor(c.circle_id) }}></span>
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
            onStartRename(c.circle_id);
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
            onDeleteCircle(c);
          }}
        >
          <Icon svg={I.del} />
        </button>
      </span>
    </div>
  );
}

export function CircleList({
  circles,
  people,
  navKind,
  navCircleId,
  renamingCircleId,
  creatingCircle,
  onSelectNav,
  onStartRename,
  onDeleteCircle,
  onRenameCommit,
  onRenameCancel,
  onCreateCommit,
  onCreateCancel,
}) {
  return (
    <>
      {circles.map((c) => (
        <CircleRow
          key={c.circle_id}
          c={c}
          people={people}
          navKind={navKind}
          navCircleId={navCircleId}
          renamingCircleId={renamingCircleId}
          onSelectNav={onSelectNav}
          onStartRename={onStartRename}
          onDeleteCircle={onDeleteCircle}
          onRenameCommit={onRenameCommit}
          onRenameCancel={onRenameCancel}
        />
      ))}
      {creatingCircle ? (
        <CircleCreateEdit onCommit={onCreateCommit} onCancel={onCreateCancel} />
      ) : null}
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

export function Storage({ people, circles }) {
  const count = people.length;
  return (
    <>
      <div className="d-storage-top">
        <span className="lbl">People</span>
        <span className="val">{count}</span>
      </div>
      <div className="d-storage-label">
        {count} {count === 1 ? 'person' : 'people'} across {circles.length} circle
        {circles.length === 1 ? '' : 's'}
      </div>
    </>
  );
}
