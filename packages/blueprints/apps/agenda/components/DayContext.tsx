// Day-context layers — none of this is a calendar or an event; a layer gets
// no hue dot.
import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import type {
  DueTask,
  LayerId,
  LayerState,
  RibbonFact,
} from "../day-context.ts";
import { ribbonLabel, shelfLabel } from "../day-context.ts";
import {
  LAYERS,
  LAYERS_READ_ONLY,
  SHELF_HIDE,
  SHELF_OPEN_IN_TASKS,
} from "../view-copy.ts";
import { Num } from "./Shared.tsx";

import styles from "./DayContext.module.css";

export interface LayerTogglesProps {
  layers: LayerState;
  onToggle: (id: LayerId) => void;
}

/** Three toggles could read as three calendars; one sentence says what they are. */
export function LayerToggles(props: LayerTogglesProps): ReactNode {
  return (
    <>
      <ul className={styles.layers}>
        {LAYERS.map((layer) => (
          <li key={layer.id}>
            <label className={styles.layerRow}>
              <input
                type="checkbox"
                checked={props.layers[layer.id as LayerId]}
                onChange={() => props.onToggle(layer.id as LayerId)}
              />
              <span className={styles.layerName}>{layer.name}</span>
              <span className={styles.layerFrom}>{layer.from}</span>
            </label>
          </li>
        ))}
      </ul>
      <p className={styles.layerNote}>{LAYERS_READ_ONLY}</p>
    </>
  );
}

export interface DayRibbonProps {
  facts: readonly RibbonFact[];
}

/** A day's costless facts on one line; several collapse into a count. */
export function DayRibbon(props: DayRibbonProps): ReactNode {
  if (props.facts.length === 0) return null;
  const label = ribbonLabel(props.facts);
  return (
    <span
      className={styles.ribbon}
      data-collapsed={String(props.facts.length > 1)}
      title={props.facts.map((fact) => fact.text).join(" · ")}
    >
      {props.facts.length > 1 ? (
        <Num>{label}</Num>
      ) : (
        <span className={styles.ribbonText}>{displayText(label)}</span>
      )}
    </span>
  );
}

export interface DayShelfProps {
  dayKey: string;
  count: number;
  tasks: readonly DueTask[];
  open: boolean;
  onToggle: (dayKey: string) => void;
  /** Hand this task to Tasks; absent where the host offers no way out. */
  onOpenTask?: (taskId: string) => void;
}

/** Due-task shelf: `3 due`, collapsed, toggleable. NEVER GRID CHIPS (no time
 *  cost → no grid shape); tap-through leaves for Tasks. */
export function DayShelf(props: DayShelfProps): ReactNode {
  if (props.count === 0) return null;
  return (
    <div className={styles.shelf}>
      <button
        type="button"
        className={styles.shelfToggle}
        aria-expanded={props.open}
        onClick={() => props.onToggle(props.dayKey)}
      >
        {props.open ? SHELF_HIDE : <Num>{shelfLabel(props.count)}</Num>}
      </button>
      {props.open && props.tasks.length > 0 ? (
        <ul className={styles.shelfRows}>
          {props.tasks.map((task) =>
            props.onOpenTask ? (
              <li key={task.task_id}>
                <button
                  type="button"
                  className={styles.shelfRow}
                  title={SHELF_OPEN_IN_TASKS}
                  onClick={() => props.onOpenTask?.(task.task_id)}
                >
                  {displayText(task.title)}
                </button>
              </li>
            ) : (
              <li key={task.task_id} className={styles.shelfRow}>
                {displayText(task.title)}
              </li>
            )
          )}
        </ul>
      ) : null}
    </div>
  );
}
