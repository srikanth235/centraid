// Sidebar region: the focus-view nav (with live counts) and the footer
// (today progress meter + the trust line). Chrome owns the shared nav/footer
// containers; this component supplies only their app-specific contents.
import { useState } from "react";

import { I } from "../icons.ts";
import type {
  Project,
  SidebarCountsShape,
  TodayProgress,
  View,
} from "../types.ts";
import { Icon } from "./Shared.tsx";

import shared from "./shared.module.css";
import styles from "./Sidebar.module.css";

const VIEWS: Array<{ key: View; label: string; icon: string }> = [
  { key: "inbox", label: "Inbox", icon: I.inbox },
  { key: "today", label: "Today", icon: I.today },
  { key: "upcoming", label: "Upcoming", icon: I.upcoming },
  { key: "anytime", label: "Anytime", icon: I.anytime },
  { key: "all", label: "All open", icon: I.inbox },
  { key: "logbook", label: "Logbook", icon: I.logbook },
];

export function SidebarNav({
  view,
  counts,
  projects,
  projectCounts,
  onSelectView,
  onCreateProject,
  onCreateSection,
}: {
  view: View;
  counts: SidebarCountsShape;
  projects: Project[];
  projectCounts: Map<string, number>;
  onSelectView: (view: View) => void;
  onCreateProject: (name: string) => Promise<boolean>;
  onCreateSection: (projectId: string, name: string) => Promise<boolean>;
}) {
  const [newProject, setNewProject] = useState("");
  const [newSection, setNewSection] = useState("");
  const activeProjectId = view.startsWith("project:")
    ? view.slice("project:".length)
    : null;
  return (
    <>
      {VIEWS.map((v) => (
        <button
          key={v.key}
          type="button"
          className={styles.navItem}
          aria-current={view === v.key}
          onClick={() => onSelectView(v.key)}
        >
          <Icon svg={v.icon} />
          <span>{v.label}</span>
          <span className={styles.navCount}>
            {counts[v.key as keyof SidebarCountsShape] ?? 0}
          </span>
        </button>
      ))}
      <div className={styles.projectLabel}>Projects & areas</div>
      {projects.map((project) => {
        const key = `project:${project.project_id}` as const;
        return (
          <button
            key={project.project_id}
            type="button"
            className={styles.navItem}
            aria-current={view === key}
            onClick={() => onSelectView(key)}
          >
            <span
              className={styles.projectDot}
              style={{ background: project.color ?? "var(--accent)" }}
            />
            <span>
              {project.name}
              {project.area ? ` · ${project.area}` : ""}
            </span>
            <span className={styles.navCount}>
              {projectCounts.get(project.project_id) ?? 0}
            </span>
          </button>
        );
      })}
      <form
        className={styles.projectForm}
        onSubmit={(event) => {
          event.preventDefault();
          void onCreateProject(newProject).then((saved) => {
            if (saved) setNewProject("");
          });
        }}
      >
        <input
          value={newProject}
          aria-label="New project or area"
          placeholder="New project…"
          onChange={(event) => setNewProject(event.currentTarget.value)}
        />
        <button type="submit" disabled={!newProject.trim()}>
          +
        </button>
      </form>
      {activeProjectId ? (
        <form
          className={styles.projectForm}
          onSubmit={(event) => {
            event.preventDefault();
            void onCreateSection(activeProjectId, newSection).then((saved) => {
              if (saved) setNewSection("");
            });
          }}
        >
          <input
            value={newSection}
            aria-label="New section"
            placeholder="New section…"
            onChange={(event) => setNewSection(event.currentTarget.value)}
          />
          <button type="submit" disabled={!newSection.trim()}>
            +
          </button>
        </form>
      ) : null}
    </>
  );
}

export function SidebarFoot({ progress }: { progress: TodayProgress }) {
  return (
    <>
      <div className={styles.progress}>
        <div className={styles.progressTop}>
          <span className={shared.eyebrowLabel}>Today</span>
          <span className={styles.progressPct}>{progress.pct}%</span>
        </div>
        <div className={styles.progressTrack}>
          <div
            className={styles.progressBar}
            style={{ width: `${progress.pct}%` }}
          />
        </div>
        <div className={styles.progressLabel}>{progress.label}</div>
      </div>
      <div className={styles.consentLine}>
        <Icon svg={I.shield} />
        <span>Every change is a receipted vault command</span>
      </div>
    </>
  );
}
