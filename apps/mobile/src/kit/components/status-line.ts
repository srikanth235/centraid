// The app's one feedback channel (issue 707, invariant 5) — the native
// mirror of `packages/client/src/react/shell/statusChannel.ts`. Same shape,
// same three note kinds, so a caller migrating a `showToast()` call reads the
// same contract regardless of surface.
//
// A toast is a message that appears somewhere else, covers something, and
// then leaves before it can be re-read; the Binding Layer bans it outright.
// Everything this app has to say now lands on ONE persistent line at the
// bottom of the frame, which updates in place.
//
// Imperative on purpose — callers are `.catch()` handlers, replica callbacks
// and upload progress ticks, not components — and a plain pub/sub store
// rather than context so a helper called from a promise chain needs no hook.
// `StatusLine.tsx` is the only subscriber that renders.

export interface StatusAction {
  label: string;
  run: () => void;
}

/** Determinate progress. Both numbers are real counts, never a bare
 *  fraction — a local-first product always knows the size of LOCAL work,
 *  which is exactly why a spinner would be a lie here. Omit this entirely
 *  when the total genuinely isn't known (e.g. an open-ended remote sync);
 *  a fabricated bar is worse than none. */
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

let note: StatusNote | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const subscribers = new Set<() => void>();

/** How long a plain confirmation stands before the line goes quiet again.
 *  Long enough to read twice; the line never covers anything, so there is no
 *  cost to it lingering. */
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

/** Drop back to quiet — the line renders nothing until the next note. */
export function clearStatus(): void {
  clearTimer();
  if (note === null) return;
  note = null;
  emit();
}

/**
 * Say something on the status line.
 *
 * Replaces `showToast`. A second call supersedes the first — the line
 * updates IN PLACE rather than stacking, which is the whole point of having
 * one. A note carrying progress or an action stands until it is replaced or
 * cleared; a bare sentence decays on its own after `NOTE_TTL_MS`.
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
 * Replaces `showToast({ action: … })`'s undo pattern with the same contract:
 * the caller does the destructive work optimistically, this owns the window
 * and calls `onUndo` if the member reverts or `onExpire` when it lapses.
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
  subscribers.clear();
}
