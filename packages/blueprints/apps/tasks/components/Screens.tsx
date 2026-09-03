import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import { VaultAccessButton } from "../../_shared/VaultAccessButton.tsx";
import type { Project, ReentryBucket, Section, Task } from "../types.ts";
import {
  DENIED,
  GROUPS,
  NOTIFY_COPY,
  REENTRY_FOOT_A,
  REENTRY_FOOT_B,
  REENTRY_LEAD_A,
  REENTRY_LEAD_B,
  SEARCH_COPY,
  reentryHead,
  windowEndLogbook,
} from "../view-copy.ts";
import { Board } from "./Board.tsx";
import type { RowContext } from "./Board.tsx";

import styles from "./Board.module.css";

export function ProjectsRoute({
  projects,
  counts,
  projectHue,
  onOpen,
  onNewProject,
}: {
  projects: readonly Project[];
  counts: Readonly<Record<string, number>>;
  projectHue: (project: Project) => string | null;
  onOpen: (projectId: string) => void;
  onNewProject: () => void;
}): ReactNode {
  const areas = new Map<string, Project[]>();
  for (const project of projects) {
    const key = project.area ?? "";
    if (!areas.has(key)) areas.set(key, []);
    areas.get(key)?.push(project);
  }
  return (
    <div className={styles.board}>
      {[...areas.entries()]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([area, list]) => (
          <section key={area || "unfiled"} className={styles.group}>
            <div className={styles.groupHead}>
              <span className={styles.groupLabel}>
                {area ? displayText(area) : GROUPS.inbox}
              </span>
            </div>
            {list.map((project) => (
              <button
                key={project.project_id}
                type="button"
                className={styles.railRow}
                onClick={() => onOpen(project.project_id)}
              >
                <span
                  aria-hidden="true"
                  className={styles.dot}
                  style={{
                    background: `var(--c-${projectHue(project) ?? "ochre"}-text)`,
                  }}
                />
                <span className={styles.railLabel}>
                  {displayText(project.name)}
                </span>
                <span className={styles.num}>
                  {counts[project.project_id] ?? 0}
                </span>
              </button>
            ))}
          </section>
        ))}
      <div className={styles.windowEnd}>
        <button type="button" className="kit-btn" onClick={onNewProject}>
          {GROUPS.addTask}
        </button>
      </div>
    </div>
  );
}

export function ProjectRoute({
  sections,
  rows,
  ctx,
  narrow,
  onAddSection,
  onAddTask,
}: {
  sections: readonly Section[];
  rows: readonly Task[];
  ctx: RowContext;
  narrow: boolean;
  onAddSection: () => void;
  onAddTask: (sectionId: string | null) => void;
}): ReactNode {
  const bySection = new Map<string, Task[]>();
  for (const task of rows) {
    const key = task.section_id ?? "";
    if (!bySection.has(key)) bySection.set(key, []);
    bySection.get(key)?.push(task);
  }
  const groups = [
    { key: "", label: GROUPS.inbox },
    ...sections.map((section) => ({
      key: section.section_id,
      label: section.name,
    })),
  ]
    .filter((entry) => (bySection.get(entry.key) ?? []).length > 0)
    .map((entry) => ({
      key: entry.key || "unfiled",
      label: displayText(entry.label),
      rows: bySection.get(entry.key) ?? [],
    }));

  return (
    <>
      <Board groups={groups} ctx={ctx} narrow={narrow} />
      <div className={styles.windowEnd}>
        <button
          type="button"
          className="kit-plain-btn"
          onClick={() => onAddTask(null)}
        >
          {GROUPS.addTask}
        </button>
        <button type="button" className="kit-btn" onClick={onAddSection}>
          {GROUPS.addTask}
        </button>
      </div>
    </>
  );
}

export function ReentryRoute({
  days,
  due,
  buckets,
  ctx,
  narrow,
  onBulk,
}: {
  days: number;
  due: number;
  buckets: readonly ReentryBucket[];
  ctx: RowContext;
  narrow: boolean;
  onBulk: (bucket: ReentryBucket) => void;
}): ReactNode {
  return (
    <div className={styles.reentry}>
      <h2 className={`${styles.reentryHead} ${styles.num}`}>
        {reentryHead(days, due)}
      </h2>
      <p className={styles.reentryLead}>{REENTRY_LEAD_A}</p>
      <p className={styles.reentryLead}>{REENTRY_LEAD_B}</p>
      {buckets.map((bucket) => (
        <Board
          key={bucket.key}
          groups={[
            {
              key: bucket.key,
              label: bucket.label,
              rows: bucket.rows,
            },
          ]}
          ctx={ctx}
          narrow={narrow}
          overdueVerbs={[{ label: bucket.verb, run: () => onBulk(bucket) }]}
        />
      ))}
      <p className={styles.reentryFoot}>{REENTRY_FOOT_A}</p>
      <p className={styles.reentryFoot}>{REENTRY_FOOT_B}</p>
    </div>
  );
}

export function LogbookRoute({
  groups,
  ctx,
  narrow,
  total,
}: {
  groups: readonly { key: string; label: string; rows: Task[] }[];
  ctx: RowContext;
  narrow: boolean;
  total: string;
}): ReactNode {
  const shown = groups.reduce((sum, group) => sum + group.rows.length, 0);
  return (
    <>
      <Board groups={groups} ctx={ctx} narrow={narrow} log />
      <div className={styles.windowEnd}>
        <span className={styles.num}>{windowEndLogbook(shown, total)}</span>
      </div>
    </>
  );
}

export function SearchRoute({
  status,
  scope,
  rows,
  ctx,
  narrow,
  inputRef,
  onInput,
  onScope,
}: {
  status: "resting" | "searching" | "ready" | "unreachable";
  scope: "everywhere" | "project";
  rows: readonly Task[];
  ctx: RowContext;
  narrow: boolean;
  inputRef: (el: HTMLInputElement | null) => void;
  onInput: () => void;
  onScope: (scope: "everywhere" | "project") => void;
}): ReactNode {
  return (
    <div className={styles.board}>
      <input
        ref={inputRef}
        id="searchInput"
        className={`kit-input ${styles.captureField}`}
        placeholder={SEARCH_COPY.placeholder}
        aria-label={SEARCH_COPY.placeholder}
        onInput={onInput}
      />
      <div className={styles.chipRow}>
        {(["everywhere", "project"] as const).map((option) => (
          <button
            key={option}
            type="button"
            className="kit-chip"
            aria-pressed={scope === option}
            onClick={() => onScope(option)}
          >
            {option === "everywhere"
              ? SEARCH_COPY.everywhere
              : SEARCH_COPY.thisProject}
          </button>
        ))}
      </div>
      {status === "ready" || status === "searching" ? (
        <Board
          groups={
            rows.length > 0
              ? [
                  {
                    key: "hits",
                    label: SEARCH_COPY.everywhere,
                    rows: [...rows],
                  },
                ]
              : []
          }
          ctx={ctx}
          narrow={narrow}
        />
      ) : null}
    </div>
  );
}

export function NotifyRoute({
  title,
  when,
  supported,
  note,
}: {
  title: string;
  when: string;
  supported: boolean;
  note: ReactNode;
}): ReactNode {
  return (
    <div className={styles.notify}>
      <div className={styles.notifyCard}>
        <span className={styles.notifyApp}>Tasks</span>
        <span className={styles.num}>{when}</span>
        <span className={styles.cardHead}>{displayText(title)}</span>
        <div className={styles.notifyActs}>
          <button type="button" className="kit-btn">
            {NOTIFY_COPY.complete}
          </button>
          <button type="button" className="kit-btn">
            {NOTIFY_COPY.snooze}
          </button>
          <button type="button" className="kit-btn">
            {NOTIFY_COPY.open}
          </button>
        </div>
      </div>
      <div className={styles.chipRow}>
        {NOTIFY_COPY.snoozes.map((option) => (
          <span key={option} className="kit-chip">
            {option}
          </span>
        ))}
      </div>
      <p className={styles.fieldNote}>{NOTIFY_COPY.rule}</p>
      {supported ? null : <p className={styles.fieldNote}>{note}</p>}
    </div>
  );
}

export function ConsentGate({
  receipt,
  scope,
  when,
  onWhatWeHold,
}: {
  receipt: string;
  scope: string;
  when: string;
  onWhatWeHold: () => void;
}): ReactNode {
  return (
    <div className={styles.gate}>
      <h2 className={styles.gateTitle}>{DENIED.title}</h2>
      <p className={styles.gateBody}>{DENIED.bodyA}</p>
      <p className={styles.gateBody}>{DENIED.bodyB}</p>
      <dl className={styles.gateFacts}>
        <dt>{DENIED.receipt}</dt>
        <dd className={styles.num}>{displayText(receipt)}</dd>
        <dt>{DENIED.scope}</dt>
        <dd>{displayText(scope)}</dd>
        <dt>{DENIED.when}</dt>
        <dd className={styles.num}>{displayText(when)}</dd>
      </dl>
      <div className={styles.editorFoot}>
        <VaultAccessButton />
        <button type="button" className="kit-btn" onClick={onWhatWeHold}>
          {DENIED.holds}
        </button>
      </div>
    </div>
  );
}
