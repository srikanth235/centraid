// What one row of the agenda IS. A type, not a projection: `AgendaHome`
// builds these and `AgendaDayRow` draws them, and neither should have to
// import the other to say what they are passing.

import type { DueRow, RibbonFact } from "./day-context";
import type { NativeAgendaEvent } from "./useAgenda";

export interface AgendaDay {
  key: string;
  date: Date;
  events: NativeAgendaEvent[];
  /** The day's costless facts. Empty is the common case, and it draws
   *  nothing at all rather than an empty container. */
  ribbon: RibbonFact[];
  due: DueRow[];
}
