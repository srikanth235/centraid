import { displayText } from "../../_shared/untrusted.ts";
// List view: each row (#list root's mapped children), the head row
// (#listHead root) and the truncation footer (#windowFoot root).
import {
  avatarColor,
  listName,
  daysSince,
  shortFmt,
  statusOf,
} from "../format.ts";
import { I } from "../icons.ts";
import type { AppData, Person } from "../types.ts";
import { Icon, KitAvatar, Snippet } from "./Shared.tsx";

import styles from "./List.module.css";

export function ListRow({
  p,
  data,
  selectedIds,
  search,
  pending,
  onOpenDetails,
  onToggleSelect,
  onOpenMenu,
}: {
  p: Person;
  data: AppData;
  selectedIds: Set<string>;
  search: string;
  /** An add/edit/trash write for this row is unsettled (issue #738). */
  pending?: boolean;
  onOpenDetails: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onOpenMenu: (anchor: HTMLElement, p: Person) => void;
}) {
  const color = avatarColor(p);
  const st = statusOf(p);
  const selected = selectedIds.has(p.party_id);
  const name = displayText(p.name);
  return (
    <div
      className={pending ? `${styles.row} kit-pending` : styles.row}
      data-selected={String(selected)}
    >
      {/* The whole row opens the profile. One stretched button carries that
          (issue #573) instead of a click handler on each static cell — the
          row's own controls (select, avatar, kebab) sit above it. */}
      <button
        type="button"
        className="kit-stretch-btn"
        aria-label={`Open ${name}`}
        onClick={() => onOpenDetails(p.party_id)}
      />
      <button
        type="button"
        className={styles.check}
        aria-pressed={selected}
        aria-label={`Select ${name}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect(p.party_id);
        }}
      >
        {selected ? <Icon svg={I.check} /> : null}
      </button>
      <KitAvatar
        style={{ cursor: "pointer", position: "relative" }}
        name={name}
        size="34px"
        color={color}
        onClick={(e) => {
          e.stopPropagation();
          onOpenDetails(p.party_id);
        }}
      />
      <div className={styles.rowMain}>
        <div className={styles.rowTitle}>
          {name}
          {p.starred ? (
            <span className={styles.starInd} aria-label="Favorite">
              ★
            </span>
          ) : null}
        </div>
        <div className={styles.rowRole}>{displayText(p.role)}</div>
        {search.trim() && p.snippet ? (
          <Snippet snippet={p.snippet} className={styles.rowRole} />
        ) : null}
      </div>
      <span className={`${styles.cell} ${styles.list}`}>
        {displayText(listName(data, p.list_id ?? null))}
      </span>
      <span className={`${styles.cell} ${styles.last}`}>
        {shortFmt(daysSince(p))}
      </span>
      <span className={`${styles.cell} ${styles.status}`}>
        <span className="kit-dotmini" style={{ background: st.color }} />
        {st.label}
      </span>
      {pending ? <span className="kit-pending-chip">pending</span> : null}
      <div className={styles.rowEnd}>
        <button
          type="button"
          className={styles.kebab}
          aria-label={`Actions for ${name}`}
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation();
            onOpenMenu(e.currentTarget, p);
          }}
        >
          <Icon svg={I.dots} />
        </button>
      </div>
    </div>
  );
}

export function ListHead({
  rows,
  selectedIds,
  onToggleAll,
}: {
  rows: Person[];
  selectedIds: Set<string>;
  onToggleAll: (rows: Person[], allSelected: boolean) => void;
}) {
  const allSel =
    rows.length > 0 && rows.every((p) => selectedIds.has(p.party_id));
  return (
    <>
      <button
        type="button"
        className={styles.check}
        aria-pressed={allSel}
        aria-label={allSel ? "Deselect all" : "Select all"}
        onClick={() => onToggleAll(rows, allSel)}
      >
        {allSel ? <Icon svg={I.check} /> : null}
      </button>
      <span style={{ width: "34px" }} />
      <span className={`${styles.col} ${styles.name}`}>Name</span>
      <span className={`${styles.col} ${styles.list}`}>List</span>
      <span className={`${styles.col} ${styles.last}`}>Last spoke</span>
      <span className={`${styles.col} ${styles.status}`}>Status</span>
      <span className={`${styles.col} ${styles.end}`} />
    </>
  );
}

export function WindowFoot({
  peopleWindow,
  onShowMore,
}: {
  peopleWindow: number;
  onShowMore: () => Promise<void>;
}) {
  return (
    <>
      <span>
        Showing your first {peopleWindow} people — the rest are a search away.
      </span>
      <button
        type="button"
        onClick={async (e) => {
          e.currentTarget.disabled = true;
          await onShowMore();
        }}
      >
        Show more
      </button>
    </>
  );
}
