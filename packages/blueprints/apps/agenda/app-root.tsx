// Agenda — deliberately EMPTY pending a ground-up redesign.
//
// The interface was removed wholesale rather than migrated: the next one is
// drawn from scratch, so a half-kept chrome would only be something to unpick.
// Everything BELOW the surface is untouched and still the contract this app is
// judged against — `app.json`'s grants and knobs, the `actions/` and
// `queries/` handler modules, `pending-projection.ts`, and `seed.js`. A
// rebuilt `Root` reads and writes through exactly those doors again.
//
// `Root` paints one empty element and nothing else. It still takes the
// shell's `rootRef` so the route's `data-app-*` knobs land on a real node,
// and it contributes nothing to the frame — an app bar or status line written
// for an empty pane would be chrome around nothing.

import type { ReactElement } from "react";

import type { InlineAppProps } from "../inline-types.ts";

/** The vault entities this app's queries read — the shell's change-subscription
 *  filter, unchanged by the UI's removal. */
export const CHANGE_TABLES = [
  "core.event",
  "schedule.event_ext",
  "schedule.attendee",
  "schedule.recurrence_exception",
  "schedule.calendar",
  "core.party",
  "core.attachment",
  "core.content_item",
  "core.vault",
  // The day-context projection's own entities (#834 R-daycontext): open tasks
  // coming due, and the starred-flag vocabulary that answers a birthday's
  // relationship tier. Without them a completed task or a newly starred
  // person would leave the grid's decorations stale until the next nav.
  "schedule.task",
  "core.tag",
  "core.concept",
  "core.concept_scheme",
];

export function Root({ rootRef }: InlineAppProps): ReactElement {
  return <div ref={rootRef} />;
}
