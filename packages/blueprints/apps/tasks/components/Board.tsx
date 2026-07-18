// The scrolling board column: the capture bar, a "pending approval" strip
// for parked adds (no task_id exists yet, so these are rendered as ghost
// rows rather than real Row components), the bucketed/logbook sections, the
// empty state and the bounded-window "Show more" footer.
import { Capture, type CaptureProps } from './Capture.tsx';
import { Row } from './Row.tsx';
import { I } from '../icons.ts';
import { Icon } from './Shared.tsx';
import { fmtDay } from '../format.ts';
import type { BoardSection, PendingAdd, Task, View } from '../types.ts';
import styles from './Board.module.css';
import shared from './shared.module.css';

// Section tone → eyebrow modifier (explicit map, never a computed styles key).
const TONE_MOD: Record<string, string | undefined> = {
  danger: styles.toneDanger,
  accent: styles.toneAccent,
};

function PendingAddRow({ item }: { item: PendingAdd }) {
  return (
    <div className={`${shared.row} kit-pending`}>
      <span className={shared.circle} data-cancelled="false" aria-hidden="true" />
      <div className={shared.rowMain}>
        <div className={shared.rowTitleLine}>
          <span className={shared.rowTitle}>{item.title}</span>
          <span className="kit-pending-chip">pending</span>
        </div>
      </div>
      {item.due_at ? <span className={shared.due}>{fmtDay(item.due_at)}</span> : null}
    </div>
  );
}

export function Board({
  view,
  showCapture,
  captureProps,
  pendingAdds,
  sections,
  isEmpty,
  emptyTitle,
  emptySub,
  search,
  snippets,
  pendingIds,
  footer,
  onShowMore,
  onOpenDetail,
  onToggle,
}: {
  view: View;
  showCapture: boolean;
  captureProps: CaptureProps;
  pendingAdds: PendingAdd[];
  sections: BoardSection[];
  isEmpty: boolean;
  emptyTitle: string;
  emptySub: string;
  search: string;
  snippets: Map<string, string> | null;
  pendingIds: Set<string>;
  footer: { windowSize: number } | null;
  onShowMore: () => void;
  onOpenDetail: (id: string) => void;
  onToggle: (task: Task) => Promise<boolean>;
}) {
  return (
    <div className={styles.column}>
      {showCapture ? <Capture {...captureProps} /> : null}

      {pendingAdds.length > 0 && view !== 'logbook' ? (
        <div className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.eyebrow}>Pending approval</span>
            <span className={styles.eyebrowCount}>{pendingAdds.length}</span>
            <span className={styles.hairline} />
          </div>
          <div className={styles.rows}>
            {pendingAdds.map((item) => (
              <PendingAddRow key={item.key} item={item} />
            ))}
          </div>
        </div>
      ) : null}

      {sections.map((sec) => (
        <div className={styles.section} key={sec.key}>
          <div className={styles.sectionHead}>
            <span className={`${styles.eyebrow} ${TONE_MOD[sec.tone] ?? ''}`}>{sec.label}</span>
            <span className={styles.eyebrowCount}>{sec.count}</span>
            <span className={styles.hairline} />
          </div>
          <div className={styles.rows}>
            {sec.rows.map((task) => (
              <Row
                key={task.task_id}
                task={task}
                closed={view === 'logbook'}
                pending={pendingIds.has(task.task_id)}
                search={search}
                snippet={snippets?.get(task.task_id)}
                onOpen={onOpenDetail}
                onToggle={onToggle}
              />
            ))}
          </div>
        </div>
      ))}

      {isEmpty ? (
        <div className="kit-empty">
          <div className="kit-empty-icon">
            <Icon svg={I.empty} />
          </div>
          <div className="kit-empty-title">{emptyTitle}</div>
          <div className="kit-empty-sub">{emptySub}</div>
        </div>
      ) : null}

      {footer ? (
        <div className="kit-foot">
          <span>
            Showing your newest {footer.windowSize} open tasks — the rest are a search away.
          </span>
          <button type="button" className="kit-btn" onClick={onShowMore}>
            Show more
          </button>
        </div>
      ) : null}
    </div>
  );
}
