// The shell's one feedback channel (#707, invariant 5).
//
// A toast is a message that appears somewhere else, covers something, and then
// leaves before it can be re-read; the Binding Layer bans it outright.
// Everything the shell has to say lands on ONE persistent line at the bottom of
// the frame, which updates in place.
//
// The module is imperative on purpose — the callers are `.catch()` handlers
// and IPC callbacks, not components — and it is a plain pub/sub store rather
// than a React context so a helper called from a promise chain does not need a
// hook. `StatusLine.tsx` is the only subscriber that renders.
//
// Three shapes of note, and no others:
//   - a sentence         — "Renamed · Groceries"
//   - a sentence + an action  — the undo grace window
//   - a sentence + determinate progress — a long LOCAL operation, which a
//     local-first product always knows the size of, which is exactly why a
//     spinner would be a lie here.
//
// Plus ONE standing slot beside them — `setRouteHealth` — for the condition of
// the route you are on, which holds rather than decays. See below.

export interface StatusAction {
  label: string;
  run: () => void;
}

/** Determinate progress. Both numbers are real counts, never a fraction: the
 *  line says "412 of 1,904", because a bare percentage hides how much work is
 *  actually left. */
export interface StatusProgress {
  done: number;
  total: number;
  /** What is being counted, e.g. "photos". Rendered after the counts. */
  unit?: string;
}

export interface StatusNote {
  text: string;
  action?: StatusAction;
  progress?: StatusProgress;
}

/**
 * The STANDING note for the route you are on (#765).
 *
 * It is the same shape as a transient note plus a tone, and it is a second slot
 * rather than a longer-lived note because the two have different lifetimes: a
 * note is something that just happened and decays, while route health is a
 * condition that holds for as long as you are on the page. Putting health
 * through `postStatus` would mean every confirmation on the page erased the one
 * standing sentence, and the next confirmation would have nothing to fall back
 * to.
 *
 * `tone` colours the inline action's rule and nothing else — `net` is "leaves
 * the device", `seam` is pending/expiring/invited. Never a fill.
 */
export interface RouteHealthNote extends StatusNote {
  tone?: "net" | "seam";
}

let note: StatusNote | null = null;
let routeHealth: RouteHealthNote | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const subscribers = new Set<() => void>();

/** How long a plain confirmation stands before the line falls back to the
 *  ambient sentence. Long enough to read twice; the line never covers
 *  anything, so there is no cost to it lingering. */
const NOTE_TTL_MS = 6000;

function emit(): void {
  // A snapshot, not the live set: a subscriber that unsubscribes as it reacts
  // would otherwise mutate the set mid-iteration.
  const listeners = Array.from(subscribers);
  for (const fn of listeners) fn();
}

function clearTimer(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

export function subscribeStatus(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function readStatus(): StatusNote | null {
  return note;
}

export function readRouteHealth(): RouteHealthNote | null {
  return routeHealth;
}

/**
 * Set (or clear, with `null`) the standing line for the current route.
 *
 * No TTL: a condition does not decay, it is replaced by the next route's or
 * cleared when this one unmounts. The channel stays generic on purpose — the
 * verbatim per-state sentences belong to the routes that publish them
 * (`routeVitals.ts` owns the three that are the same on every ops page).
 */
export function setRouteHealth(next: RouteHealthNote | null): void {
  if (routeHealth === null && next === null) return;
  routeHealth = next;
  emit();
}

/** Drop back to the ambient sentence. */
export function clearStatus(): void {
  clearTimer();
  if (note === null) return;
  note = null;
  emit();
}

/**
 * Say something on the status line.
 *
 * Replaces `showToast`. A second call supersedes the first — the line updates
 * IN PLACE rather than stacking, which is the whole point of having one.
 * A note carrying progress or an action stands until it is replaced or
 * cleared; a bare sentence decays back to the ambient line.
 */
export function postStatus(
  text: string,
  extra?: { action?: StatusAction; progress?: StatusProgress }
): void {
  clearTimer();
  note = {
    text,
    ...(extra?.action ? { action: extra.action } : {}),
    ...(extra?.progress ? { progress: extra.progress } : {}),
  };
  emit();
  if (!extra?.action && !extra?.progress) {
    timer = setTimeout(clearStatus, NOTE_TTL_MS);
  }
}

export interface UndoStatusOpts {
  /** Grace window before the action commits (default 6000ms). */
  durationMs?: number;
  /** Label on the action control (default "Undo"). */
  actionLabel?: string;
  /** Fired when the window lapses without an undo — commit the real action. */
  onExpire?: () => void;
}

/** The active undo's settler — a new one commits the previous (expire), so a
 *  rapid second delete never strands the first in limbo. */
let activeFinish: ((undone: boolean) => void) | null = null;

/**
 * A deferred-destructive grace window, on the status line.
 *
 * The caller does the destructive work optimistically; this owns the window
 * and calls `onUndo` if the member reverts, or `onExpire` when it lapses.
 */
export function showUndoStatus(
  message: string,
  onUndo: () => void,
  opts: UndoStatusOpts = {}
): void {
  activeFinish?.(false);

  let settled = false;
  const finish = (undone: boolean): void => {
    if (settled) return;
    settled = true;
    activeFinish = null;
    clearStatus();
    if (undone) onUndo();
    else opts.onExpire?.();
  };
  activeFinish = finish;

  postStatus(message, {
    action: { label: opts.actionLabel ?? "Undo", run: () => finish(true) },
  });
  clearTimer();
  timer = setTimeout(() => finish(false), opts.durationMs ?? 6000);
}

/** Test seam: drop every subscriber and any pending window. */
export function resetStatus(): void {
  activeFinish = null;
  clearTimer();
  note = null;
  routeHealth = null;
  subscribers.clear();
}
