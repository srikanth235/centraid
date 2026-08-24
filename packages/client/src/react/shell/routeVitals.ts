import { healthSentence, opsGenericLine } from "@centraid/design/blocks";

import {
  EMPTY_HEALTH,
  ERROR_HEALTH,
  READING_HEALTH,
} from "../../surface-copy.js";
import type { OpsPage, OpsState } from "./opsBar.js";
import { setRouteHealth } from "./statusChannel.js";
import type { RouteHealthNote } from "./statusChannel.js";

// The app bar's DYNAMIC half for the six operational routes (#765).
//
// `opsBar.ts` holds what a page always says; this holds what it says about the
// data it just read — the count line under the title, and the state that
// decides which verbs the bar offers. It is a plain pub/sub store rather than a
// context, for the same reason `statusChannel.ts` is: the callers are query
// resolutions and `.catch()` handlers inside a route, not components rendering
// above the frame, and the frame renders ABOVE the outlet so a route cannot
// hand it anything by rendering.
//
// The count line is the page's own sentence in ready/full/empty ("3 decisions
// waiting · 2 standing grants"). In loading and error it is NOT: those two read
// the same on all six pages, so this module owns their wording and ignores
// whatever the route passed. A page that could invent its own loading sentence
// would eventually invent six of them.
//
// WHICH states speak for themselves, and which may carry an inline verb, is not
// decided here: that ladder is the headless block layer's
// (`@centraid/design/blocks`), shared with the React Native kit's own health
// line. This module owns the WORDS and the pub/sub; the shared module owns the
// rule.

// The three shared state sentences live in `../../surface-copy.js` (issue
// #805): mobile draws the same six pages and had re-declared each of them per
// screen model, so the WORDS moved to the one module both surfaces can read
// and this one keeps the pub/sub.

/** What a page says while it is still reading. The same on all six. */
export const LOADING_COUNT_LINE = READING_HEALTH;

/** The status line while reading. One sentence, no action to offer. */
export const LOADING_HEALTH = READING_HEALTH;

/** The error-state count line: the last moment this page is known to have been
 *  right. A clock, so it is a numeric and reads in the numeric register. */
export function lastReadLine(at: Date | number): string {
  const d = at instanceof Date ? at : new Date(at);
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return `Last read at ${time}`;
}

/** The health sentence a route publishes in ready/full: a label, a detail, and
 *  at most ONE inline verb. The verb is the exception, not the rule — three of
 *  the six pages have nothing to offer and say so by omitting it. */
export interface RouteHealth {
  label: string;
  detail: string;
  action?: { label: string; run: () => void };
}

/** What a route hands the frame when its query resolves. */
export interface RouteVitalsInput {
  state: OpsState;
  /** The count line, for ready/full/empty. Ignored in loading and error, which
   *  take this module's generic lines instead. */
  count?: string;
  /** When the page last read successfully. Renders the error count line; with
   *  no value the error state simply carries no count. */
  lastReadAt?: Date | number;
}

/** What the frame reads back. `count` is always resolved — never a route's
 *  guess at what loading or error should say. */
export interface RouteVitals {
  state: OpsState;
  count: string;
}

/** The handlers behind the bar's two verbs. A route publishes the ones only it
 *  can perform (a filter reset, an export of the window it is showing); the
 *  rest are plain navigations `App.tsx` resolves itself. */
export interface RouteVerbs {
  onCommit?: () => void;
  onSecondary?: () => void;
}

type VitalsMap = Readonly<Partial<Record<OpsPage, RouteVitals>>>;
type VerbsMap = Readonly<Partial<Record<OpsPage, RouteVerbs>>>;

// Replaced wholesale rather than mutated: `useSyncExternalStore` compares the
// snapshot by identity, so a mutated map would never re-render the bar.
let vitals: VitalsMap = {};
let verbs: VerbsMap = {};
const subscribers = new Set<() => void>();

function emit(): void {
  // A snapshot, not the live set: a subscriber that unsubscribes as it reacts
  // would otherwise mutate the set mid-iteration.
  for (const fn of Array.from(subscribers)) fn();
}

function resolveCount(input: RouteVitalsInput): string {
  // `empty` is the one generic state whose COUNT is still the page's own: it
  // has a number to report ("0 waiting"), where loading and error do not.
  const generic = opsGenericLine(input.state, {
    empty: input.count ?? "",
    error: input.lastReadAt === undefined ? "" : lastReadLine(input.lastReadAt),
    loading: LOADING_COUNT_LINE,
  });
  return generic ?? input.count ?? "";
}

export function subscribeVitals(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Every page's vitals, by identity — the `useSyncExternalStore` snapshot. */
export function readAllVitals(): VitalsMap {
  return vitals;
}

/** One page's vitals, or `undefined` before its first publish. The bar falls
 *  back to the static def then: title and both verbs, no count line. */
export function readVitals(page: OpsPage): RouteVitals | undefined {
  return vitals[page];
}

/** Every page's published verb handlers — the second snapshot the bar reads. */
export function readAllVerbs(): VerbsMap {
  return verbs;
}

/** Publish the count line + state for a page. Idempotent: republishing the
 *  same values does not wake the bar. */
export function publishVitals(page: OpsPage, input: RouteVitalsInput): void {
  const next: RouteVitals = { count: resolveCount(input), state: input.state };
  const prev = vitals[page];
  if (prev && prev.count === next.count && prev.state === next.state) return;
  vitals = { ...vitals, [page]: next };
  emit();
}

/**
 * Publish the handlers behind the bar's verbs.
 *
 * A verb the route does not claim falls through to `App.tsx`'s own resolution,
 * and a verb neither claims is not rendered — a control that would do nothing
 * is worse than a bar with one control on it.
 */
export function publishRouteVerbs(page: OpsPage, next: RouteVerbs): void {
  verbs = { ...verbs, [page]: next };
  emit();
}

/** Drop a page's vitals and verbs — the route's unmount. */
export function clearVitals(page: OpsPage): void {
  if (vitals[page] === undefined && verbs[page] === undefined) return;
  vitals = Object.fromEntries(
    Object.entries(vitals).filter(([key]) => key !== page)
  );
  verbs = Object.fromEntries(
    Object.entries(verbs).filter(([key]) => key !== page)
  );
  emit();
}

/** The health note for a state, given what the route knows. Loading, empty and
 *  error are generic and carry NO inline action: there is nothing to act on
 *  while reading, nothing to attend to when empty, and offering a verb on a
 *  page that could not load is offering to act on nothing. */
function healthFor(
  state: OpsState,
  health: RouteHealth | undefined,
  tone: RouteHealthNote["tone"]
): RouteHealthNote | null {
  const generic = opsGenericLine(state, {
    empty: EMPTY_HEALTH,
    error: ERROR_HEALTH,
    loading: LOADING_HEALTH,
  });
  if (generic !== undefined) return { text: generic };
  if (!health) return null;
  return {
    text: healthSentence(health.label, health.detail),
    ...(health.action ? { action: health.action } : {}),
    ...(tone ? { tone } : {}),
  };
}

/**
 * Publish the count line and the status line from ONE call.
 *
 * Both come from the same query resolution, so they are published from the same
 * place: a route that fed them separately could leave the bar saying "3
 * decisions waiting" over a status line still reading "Reading from the
 * gateway". They cannot disagree about state if they are set together.
 */
export function publishRouteSignals(
  page: OpsPage,
  input: RouteVitalsInput & {
    /** Ready/full only. Ignored in the other three states, which are generic. */
    health?: RouteHealth;
    /** Colours the inline action's rule. `seam` is Devices' pending tone. */
    tone?: RouteHealthNote["tone"];
  }
): void {
  publishVitals(page, input);
  setRouteHealth(healthFor(input.state, input.health, input.tone));
}

/** Drop a page's signals — the route's unmount, both channels at once. */
export function clearRouteSignals(page: OpsPage): void {
  clearVitals(page);
  setRouteHealth(null);
}

/** Test seam: drop every page's vitals, verbs, and subscribers. */
export function resetVitals(): void {
  vitals = {};
  verbs = {};
  subscribers.clear();
}
