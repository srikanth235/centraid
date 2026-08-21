// Tally — deliberately EMPTY pending a ground-up redesign.
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
  "tally.expense",
  "tally.expense_split",
  "tally.expense_receipt",
  "tally.expense_line_item",
  "tally.expense_line_allocation",
  "tally.recurring_expense",
  "schedule.recurrence_exception",
  "core.content_item",
  "tally.settlement",
  "tally.friend",
  "tally.group",
  "social.circle",
  "social.circle_member",
  "core.party",
  "core.vault",
  "tally",
];

export function Root({ rootRef }: InlineAppProps): ReactElement {
  return <div ref={rootRef} />;
}
