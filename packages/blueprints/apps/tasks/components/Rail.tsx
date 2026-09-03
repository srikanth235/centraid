import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import type { ShelfId } from "../shelves.ts";
import {
  ALL,
  ANYTIME,
  INBOX,
  LOGBOOK,
  REENTRY,
  UPCOMING,
  projectShelf,
} from "../shelves.ts";
import type { Project } from "../types.ts";
import { GROUPS, RAIL_HEADS, shelfCopy } from "../view-copy.ts";

import styles from "./Board.module.css";

const VIEWS: readonly ShelfId[] = [null, UPCOMING, ANYTIME, ALL, INBOX];

export interface RailProps {
  current: ShelfId;
  counts: Readonly<Record<string, number>>;
  projects: readonly Project[];
  projectHue: (project: Project) => string | null;
  onSelect: (shelf: ShelfId) => void;
}

function Row({
  label,
  count,
  current,
  hue,
  onSelect,
}: {
  label: string;
  count?: number;
  current: boolean;
  hue?: string | null;
  onSelect: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className={styles.railRow}
      data-current={current ? "true" : undefined}
      {...(current ? { "aria-current": "page" as const } : {})}
      onClick={onSelect}
    >
      {hue ? (
        <span
          aria-hidden="true"
          className={styles.dot}
          style={{ background: `var(--c-${hue}-text)` }}
        />
      ) : null}
      <span className={styles.railLabel}>{displayText(label)}</span>
      {typeof count === "number" ? (
        <span className={styles.num}>{count}</span>
      ) : null}
    </button>
  );
}

export function Rail(props: RailProps): ReactNode {
  const areas = new Map<string, Project[]>();
  for (const project of props.projects) {
    const key = project.area ?? "";
    if (!areas.has(key)) areas.set(key, []);
    areas.get(key)?.push(project);
  }

  return (
    <>
      <div className={styles.railHead}>{RAIL_HEADS.views}</div>
      {VIEWS.map((shelf) => (
        <Row
          key={String(shelf)}
          label={shelfCopy(shelf).title}
          count={props.counts[String(shelf)] ?? 0}
          current={props.current === shelf}
          onSelect={() => props.onSelect(shelf)}
        />
      ))}

      <div className={styles.railHead}>{RAIL_HEADS.projects}</div>
      {[...areas.entries()]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([area, list]) => (
          <div key={area || "unfiled"}>
            {area ? (
              <div className={styles.railArea}>{displayText(area)}</div>
            ) : null}
            {list.map((project) => (
              <Row
                key={project.project_id}
                label={project.name}
                count={props.counts[projectShelf(project.project_id)] ?? 0}
                hue={props.projectHue(project)}
                current={props.current === projectShelf(project.project_id)}
                onSelect={() =>
                  props.onSelect(projectShelf(project.project_id))
                }
              />
            ))}
          </div>
        ))}

      <div className={styles.railFoot}>
        <Row
          label={shelfCopy(LOGBOOK).title}
          current={props.current === LOGBOOK}
          onSelect={() => props.onSelect(LOGBOOK)}
        />
        <Row
          label={GROUPS.catchUp}
          current={props.current === REENTRY}
          onSelect={() => props.onSelect(REENTRY)}
        />
      </div>
    </>
  );
}
