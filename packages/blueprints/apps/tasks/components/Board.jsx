// The scrolling board column: the capture bar, a "pending approval" strip
// for parked adds (no task_id exists yet, so these are rendered as ghost
// rows rather than real Row components), the bucketed/logbook sections, the
// empty state and the bounded-window "Show more" footer.
import { Capture } from './Capture.jsx';
import { Row } from './Row.jsx';
import { I } from '../icons.js';
import { Icon } from './Shared.jsx';
import { fmtDay } from '../format.js';

function PendingAddRow({ item }) {
  return (
    <div className="tk-row kit-pending">
      <span className="tk-circle" data-cancelled="false" aria-hidden="true" />
      <div className="tk-row-main">
        <div className="tk-row-title-line">
          <span className="tk-row-title">{item.title}</span>
          <span className="kit-pending-chip">pending</span>
        </div>
      </div>
      {item.due_at ? <span className="tk-due">{fmtDay(item.due_at)}</span> : null}
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
}) {
  return (
    <div className="tk-column">
      {showCapture ? <Capture {...captureProps} /> : null}

      {pendingAdds.length > 0 && view !== 'logbook' ? (
        <div className="tk-section">
          <div className="tk-section-head">
            <span className="tk-eyebrow">Pending approval</span>
            <span className="tk-eyebrow-count">{pendingAdds.length}</span>
            <span className="tk-hairline" />
          </div>
          <div className="tk-rows">
            {pendingAdds.map((item) => (
              <PendingAddRow key={item.key} item={item} />
            ))}
          </div>
        </div>
      ) : null}

      {sections.map((sec) => (
        <div className="tk-section" key={sec.key}>
          <div className="tk-section-head">
            <span className={`tk-eyebrow tone-${sec.tone}`}>{sec.label}</span>
            <span className="tk-eyebrow-count">{sec.count}</span>
            <span className="tk-hairline" />
          </div>
          <div className="tk-rows">
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
