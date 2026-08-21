// The day-context layers, drawn: the rail's three switches, the day ribbon,
// and the collapsed due-task shelf.
//
// NONE OF THIS IS A CALENDAR AND NONE OF IT IS AN EVENT. A layer has no hue
// dot — the dot is the calendars' content marker, and giving one to a layer
// would say "this is a fourth calendar you can write to", which is exactly
// what a layer is not. The ribbon and the shelf are drawn in the annotation
// register on a dotted rule so they read as decoration on the day rather than
// as another row competing with a meeting.
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

/**
 * The rail's third section. Three switches and one sentence: a member may
 * reasonably read three toggles under Calendars as three more calendars, so
 * the section says once what they are.
 */
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

/**
 * A day's costless facts, on one line. Several collapse into a count rather
 * than spelling three names into a month cell that has room for one.
 */
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
  /** Hand this task to Tasks. Absent where the host offers no way to leave
   *  this app — and then no row is drawn as a control, because an affordance
   *  that cannot act is the thing this product refuses. */
  onOpenTask?: (taskId: string) => void;
}

/**
 * The due-task shelf: `3 due`, collapsed, toggleable per day.
 *
 * NEVER GRID CHIPS. A due date has no time cost, so it does not get grid
 * shape; it sits above the day's first hour as one collapsed line, and the
 * member opens it when they want the names. Tap-through leaves for Tasks —
 * Agenda shows the fact and never edits it.
 */
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
