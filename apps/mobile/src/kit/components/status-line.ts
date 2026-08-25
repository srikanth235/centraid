// One feedback channel (#707, invariant 5); native mirror of
// `packages/client/src/react/shell/statusChannel.ts`. Binding Layer bans
// toasts. Imperative pub/sub — callers are `.catch()` / replica / progress
// ticks, not components. `StatusLine.tsx` is the only renderer.

export interface StatusAction {
  label: string;
  run: () => void;
}

/** Real counts, never a fabricated fraction. Omit when the total is unknown. */
export interface StatusProgress {
  done: number;
  total: number;
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

const NOTE_TTL_MS = 6000;

function emit(): void {
  // Snapshot: a subscriber that unsubscribes as it reacts must not mutate mid-iteration.
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

export function clearStatus(): void {
  clearTimer();
  if (note === null) return;
  note = null;
  emit();
}

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
  durationMs?: number;
  actionLabel?: string;
  onExpire?: () => void;
}

/** A new undo commits the previous (expire) so a second delete never strands the first. */
let activeFinish: ((undone: boolean) => void) | null = null;

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

export function resetStatus(): void {
  activeFinish = null;
  clearTimer();
  note = null;
  subscribers.clear();
}
