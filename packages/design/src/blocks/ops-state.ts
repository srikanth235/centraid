// The five states every operational surface carries, and the two rules that
// decide what each one is allowed to SAY (#765).
//
// The rules are the shared part, not the words. A page owns its own sentence
// in `ready`/`full`; the other three read the same on every page and on both
// renderers, so the decision "does this state speak for itself, and may it
// offer a verb" is made once, here, and the copy is passed in by the caller.
// A surface that decided this for itself would eventually decide it six
// different ways.

/** What an operational surface is doing, at the moment it publishes. */
export type OpsState = "ready" | "full" | "empty" | "loading" | "error";

/** The three generic sentences, in the caller's own words. */
export interface OpsGenericLines {
  empty: string;
  loading: string;
  error: string;
}

/**
 * May this state carry an inline verb?
 *
 * `ready` and `full` only. There is nothing to act on when empty, the target
 * is not known yet while loading, and on error the one way forward lives in
 * the error panel — a second verb beside it is two answers to one question.
 */
export function opsStateCarriesAction(state: OpsState): boolean {
  return state === "ready" || state === "full";
}

/**
 * The generic sentence for a state, or `undefined` when the surface speaks for
 * itself.
 *
 * `undefined` is the signal, not an empty string: an empty generic line and
 * "this state uses the page's own line" are different facts, and a caller that
 * conflated them would print a blank where a count belongs.
 */
export function opsGenericLine(
  state: OpsState,
  lines: OpsGenericLines
): string | undefined {
  if (state === "loading") return lines.loading;
  if (state === "empty") return lines.empty;
  if (state === "error") return lines.error;
  return undefined;
}

/**
 * `label · detail` — the standing fact joined to its qualifier.
 *
 * The separator is the system's own middot, and either half may be missing: a
 * surface that knows only the detail says the detail, not " · detail".
 */
export function healthSentence(label: string, detail: string): string {
  if (!label) return detail;
  if (!detail) return label;
  return `${label} · ${detail}`;
}
