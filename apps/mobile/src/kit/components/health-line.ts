// The standing status sentence for one operational route (#765, spec §11
// `opsVals`), in this surface's shape.
//
// The RULES are shared and live in `@centraid/design/blocks`: which of the five
// states speak for themselves, which may carry an inline verb, and how a label
// joins its detail. What is here is the copy bundle this app's screens pass
// around — every word of it the caller's — and the one call that applies the
// rules to it.

import {
  healthSentence,
  opsGenericLine,
  opsStateCarriesAction,
} from "@centraid/design/blocks";
import type { OpsState } from "@centraid/design/blocks";

export type { OpsState } from "@centraid/design/blocks";

export interface HealthCopy {
  /** The short standing fact ("1 automation is failing"). */
  label: string;
  /** The sentence that qualifies it. */
  detail: string;
  /** The one inline verb, shown only when there is something to attend to. */
  action?: string;
  /** Generic per-state sentences; the caller owns every word. */
  emptyText: string;
  loadingText: string;
  errorText: string;
}

export interface HealthLineCopy {
  text: string;
  action?: string;
}

/** What the line says, and whether its verb is published. */
export function healthLineFor(
  state: OpsState,
  copy: HealthCopy
): HealthLineCopy {
  const generic = opsGenericLine(state, {
    empty: copy.emptyText,
    error: copy.errorText,
    loading: copy.loadingText,
  });
  if (generic !== undefined) return { text: generic };
  const text = healthSentence(copy.label, copy.detail);
  return opsStateCarriesAction(state) && copy.action
    ? { action: copy.action, text }
    : { text };
}
