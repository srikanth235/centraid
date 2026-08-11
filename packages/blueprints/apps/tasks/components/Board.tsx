import type { PendingRowState } from "../../_shared/pending-overlay.ts";
import type { ScopeSearchReach } from "../../_shared/search-scaffold.ts";
import { scopeReachFacts } from "../../_shared/search-scaffold.ts";
import { I } from "../icons.ts";
import type { BoardSection, Project, Section, Task, View } from "../types.ts";
// The scrolling board column: the capture bar, the bucketed/logbook
// sections, the empty state and the bounded-window "Show more" footer. A
// pending ADD arrives as a normal row inside `sections` (the replica composes
// it from the durable outbox — issue #738); `pendingByRowId` decorates it
// (and any pending mutation on an existing row) with the chip, same as every
// other row.
import { Attention } from "./Attention.tsx";
import { Capture } from "./Capture.tsx";
import type { CaptureProps } from "./Capture.tsx";
import { Row } from "./Row.tsx";
import { Icon } from "./Shared.tsx";

import styles from "./Board.module.css";

// Section tone → eyebrow modifier (explicit map, never a computed styles key).
const TONE_MOD: Record<string, string | undefined> = {
  danger: styles.toneDanger,
  accent: styles.toneAccent,
};

export function Board({
  view,
  showCapture,
  captureProps,
  sections,
  isEmpty,
  emptyTitle,
  emptySub,
  search,
  snippets,
  pendingByRowId,
  attention,
  onRetryPending,
  onDiscardPending,
  projects,
  projectSections,
  footer,
  reach,
  onShowMore,
  onEmptyAction,
  onOpenDetail,
  onToggle,
  onOrganize,
  onReorder,
}: {
  view: View;
  showCapture: boolean;
  captureProps: CaptureProps;
  sections: BoardSection[];
  isEmpty: boolean;
  emptyTitle: string;
  emptySub: string;
  search: string;
  snippets: Map<string, string> | null;
  pendingByRowId: Map<string, PendingRowState>;
  /** Writes that settled without executing (issue #738). They no longer
   *  overlay any row, so they render as their own panel above the board. */
  attention: PendingRowState[];
  onRetryPending: (intentId: string) => void;
  onDiscardPending: (intentId: string) => void;
  projects: Project[];
  projectSections: Section[];
  footer: { windowSize: number } | null;
  /** Per-scope reach for this board's fan-out (issue #726 D10/D11,
   *  `scope-fanout.ts`'s `readBoard`) — undefined/empty for a single-scope
   *  mount, which has no fan-out to report on. */
  reach?: readonly ScopeSearchReach[];
  onShowMore: () => void;
  onEmptyAction: () => void;
  onOpenDetail: (id: string) => void;
  onToggle: (task: Task) => Promise<boolean>;
  onOrganize: (
    taskId: string,
    projectId: string | null,
    sectionId: string | null,
    sortOrder: number
  ) => Promise<boolean>;
  onReorder: (task: Task, before: Task) => Promise<boolean>;
}) {
  const reachFacts = reach ? scopeReachFacts(reach) : [];
  return (
    <div className={styles.column}>
      {showCapture ? <Capture {...captureProps} /> : null}

      {/* A refused/conflicted/failed write keeps its place until the member
          answers it — never a row that quietly vanished (issue #738). */}
      <Attention
        rows={attention}
        onRetry={onRetryPending}
        onDiscard={onDiscardPending}
      />

      {/* A scope that could not be asked, named BESIDE whatever other
          scopes' tasks are still on screen — never a reason to blank the
          board (issue #726 D10/D11). */}
      {reachFacts.length > 0 ? (
        <div className={styles.partial}>
          <p className={styles.partialTitle}>Not every scope answered</p>
          <dl className={styles.facts}>
            {reachFacts.map((fact) => (
              <div key={fact.label} className={styles.fact}>
                <dt className={styles.factLabel}>{fact.label}</dt>
                <dd className={styles.factValue}>{fact.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}

      {sections.map((sec) => (
        <div className={styles.section} key={sec.key}>
          <div className={styles.sectionHead}>
            <span className={`${styles.eyebrow} ${TONE_MOD[sec.tone] ?? ""}`}>
              {sec.label}
            </span>
            <span className={styles.eyebrowCount}>{sec.count}</span>
            <span className={styles.hairline} />
          </div>
          <div className={styles.rows}>
            {sec.rows.map((task) => (
              <div
                className={styles.organizedRow}
                key={task.task_id}
                draggable={view !== "logbook"}
                onDragStart={(event) =>
                  event.dataTransfer.setData(
                    "application/x-centraid-task",
                    task.task_id
                  )
                }
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  const draggedId = event.dataTransfer.getData(
                    "application/x-centraid-task"
                  );
                  const dragged = sections
                    .flatMap((section) => section.rows)
                    .find((row) => row.task_id === draggedId);
                  if (dragged && dragged.task_id !== task.task_id)
                    void onReorder(dragged, task);
                }}
              >
                <Row
                  task={task}
                  closed={view === "logbook"}
                  pending={pendingByRowId.get(task.task_id)}
                  search={search}
                  snippet={snippets?.get(task.task_id)}
                  onOpen={onOpenDetail}
                  onToggle={onToggle}
                />
                {view === "logbook" ? null : (
                  <select
                    className={styles.organizeSelect}
                    aria-label={`Project for ${task.title}`}
                    value={
                      task.section_id
                        ? `section:${task.section_id}`
                        : task.project_id
                          ? `project:${task.project_id}`
                          : "inbox"
                    }
                    onChange={(event) => {
                      const value = event.currentTarget.value;
                      if (value === "inbox") {
                        void onOrganize(
                          task.task_id,
                          null,
                          null,
                          Number(task.sort_order ?? 0)
                        );
                        return;
                      }
                      if (value.startsWith("section:")) {
                        const sectionId = value.slice("section:".length);
                        const section = projectSections.find(
                          (row) => row.section_id === sectionId
                        );
                        if (section)
                          void onOrganize(
                            task.task_id,
                            section.project_id,
                            section.section_id,
                            Number(task.sort_order ?? 0)
                          );
                        return;
                      }
                      void onOrganize(
                        task.task_id,
                        value.slice("project:".length),
                        null,
                        Number(task.sort_order ?? 0)
                      );
                    }}
                  >
                    <option value="inbox">Inbox</option>
                    {projects.map((project) => (
                      <optgroup
                        key={project.project_id}
                        label={
                          project.area
                            ? `${project.name} · ${project.area}`
                            : project.name
                        }
                      >
                        <option value={`project:${project.project_id}`}>
                          No section
                        </option>
                        {projectSections
                          .filter(
                            (section) =>
                              section.project_id === project.project_id
                          )
                          .map((section) => (
                            <option
                              key={section.section_id}
                              value={`section:${section.section_id}`}
                            >
                              {section.name}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </select>
                )}
              </div>
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
          <button type="button" className="kit-btn" onClick={onEmptyAction}>
            {search.trim() ? "Clear search" : "New task"}
          </button>
        </div>
      ) : null}

      {footer ? (
        <div className="kit-foot">
          <span>
            Showing your newest {footer.windowSize} open tasks — the rest are a
            search away.
          </span>
          <button type="button" className="kit-btn" onClick={onShowMore}>
            Show more
          </button>
        </div>
      ) : null}
    </div>
  );
}
