// The shell's one feedback channel (#707, invariant 5). TOASTS ARE BANNED:
// everything lands on ONE persistent line that updates in place. Imperative
// pub/sub, not a context: the callers are `.catch()` handlers and IPC
// callbacks. Three shapes of note and no others — a sentence, plus an action,
// plus DETERMINATE progress (never a spinner) — beside one standing slot
// (`setRouteHealth`) that holds rather than decays.

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

/** A SECOND slot, not a longer-lived note: health holds while a note decays,
 *  and health through `postStatus` would let a confirmation erase it. `tone`
 *  colours the inline action's rule only — never a fill. */
export interface RouteHealthNote extends StatusNote {
  tone?: "net" | "seam";
}

let note: StatusNote | null = null;
let routeHealth: RouteHealthNote | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const subscribers = new Set<() => void>();

const NOTE_TTL_MS = 6000;

function emit(): void {
  // A snapshot: unsubscribing mid-react would mutate the set.
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

/** No TTL: a condition does not decay. Verbatim per-state sentences belong to
 *  the routes that publish them, not here. */
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

/** A second call supersedes the first: the line updates IN PLACE, never stacks.
 *  Progress or an action stands until replaced; a sentence decays. */
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
