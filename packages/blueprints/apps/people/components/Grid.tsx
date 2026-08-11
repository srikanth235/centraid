// Grid view card (#grid root's mapped children).
import { avatarColor, metaLine, statusOf } from "../format.ts";
import { I } from "../icons.ts";
import type { Person } from "../types.ts";
import { Icon, KitAvatar } from "./Shared.tsx";

import styles from "./Grid.module.css";

export function GridCard({
  p,
  selectedIds,
  pending,
  onOpenDetails,
  onToggleSelect,
  onToggleStar,
}: {
  p: Person;
  selectedIds: Set<string>;
  /** An add/edit/trash write for this row is unsettled (issue #738). */
  pending?: boolean;
  onOpenDetails: (id: string) => void;
  onToggleSelect: (id: string) => void;
  onToggleStar: (p: Person) => void;
}) {
  const color = avatarColor(p);
  const st = statusOf(p);
  const selected = selectedIds.has(p.party_id);
  return (
    <div
      className={pending ? `${styles.card} kit-pending` : styles.card}
      data-selected={String(selected)}
    >
      {/* The whole card opens the profile. One stretched button carries that
          (issue #573) instead of click handlers on the static top/body blocks —
          the card's own select/star buttons sit above it. */}
      <button
        type="button"
        className="kit-stretch-btn"
        aria-label={`Open ${p.name}`}
        onClick={() => onOpenDetails(p.party_id)}
      />
      <div
        className={styles.cardTop}
        style={{ background: `color-mix(in oklab, ${color} 12%, transparent)` }}
      >
        <KitAvatar name={p.name} size="58px" color={color} />
      </div>
      <button
        type="button"
        className={styles.cardSelect}
        aria-pressed={selected}
        aria-label={`Select ${p.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect(p.party_id);
        }}
      >
        {selected ? <Icon svg={I.check} /> : null}
      </button>
      <button
        type="button"
        className={
          p.starred ? `${styles.cardStar} ${styles.on}` : styles.cardStar
        }
        aria-label="Favorite"
        onClick={(e) => {
          e.stopPropagation();
          onToggleStar(p);
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill={p.starred ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m12 3 2.6 5.6 6 .7-4.5 4.2 1.2 6-5.3-3-5.3 3 1.2-6L3.4 9.3l6-.7z" />
        </svg>
      </button>
      <div className={styles.cardBody}>
        <div className={styles.cardTitle}>{p.name}</div>
        <div className={styles.cardRole}>{p.role || ""}</div>
        <div className={styles.cardMeta}>
          <span className="kit-dotmini" style={{ background: st.color }} />
          {metaLine(p)}
        </div>
        {pending ? <span className="kit-pending-chip">pending</span> : null}
      </div>
    </div>
  );
}
