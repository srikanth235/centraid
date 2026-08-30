/**
 * THE ONE FEEDBACK CHANNEL (#707, invariant 5): toasts are banned, and
 * everything lands on ONE line that updates in place. Imperative, not a
 * context — the callers are not components. Each seat re-exports this module,
 * so each bundle keeps its own channel state.
 */

export interface StatusAction {
  label: string;
  run: () => void;
}

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

/** A SECOND slot: health holds while a note decays; never via `postStatus`. */
export interface RouteHealthNote extends StatusNote {
  tone?: "net" | "seam";
}

let note: StatusNote | null = null;
let routeHealth: RouteHealthNote | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const subscribers = new Set<() => void>();

const NOTE_TTL_MS = 6000;

function emit(): void {
  // Snapshot: unsubscribing mid-notify would mutate the set.
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

export function setRouteHealth(next: RouteHealthNote | null): void {
  if (routeHealth === null && next === null) return;
  routeHealth = next;
  emit();
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
  routeHealth = null;
  subscribers.clear();
}
