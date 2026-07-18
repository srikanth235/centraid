// Parked-write tracking: which events have an outstanding queued/parked/
// in-flight reschedule, RSVP or cancel, keyed by the exact intent so an
// unrelated change never clears the wrong chip. `AppState` is the same bag
// app.tsx mutates in place; the outcome shape is typed locally (the ambient
// `VaultOutcome` in types/centraid.d.ts, out of scope here, carries no
// `intentId`, which the replica overlay path does).
import type { AppState } from './types.ts';

/** The subset of a write outcome pending.ts keys and settles on. */
interface PendingOutcome {
  status?: string;
  intentId?: string;
  invocationId?: string;
}

const PENDING = new Set(['queued', 'in-flight', 'parked']);
const TERMINAL = new Set(['executed', 'denied', 'failed']);

function records(state: AppState): Map<string, { eventId: string; kind: string }> {
  if (!(state.pendingByIntent instanceof Map)) state.pendingByIntent = new Map();
  return state.pendingByIntent;
}

function refreshPresentation(state: AppState): void {
  state.pendingIds.clear();
  state.pendingCancelIds.clear();
  for (const pending of records(state).values()) {
    state.pendingIds.add(pending.eventId);
    if (pending.kind === 'cancel') state.pendingCancelIds.add(pending.eventId);
  }
}

/** Track one queued/parked write without letting an unrelated change clear it. */
export function trackPendingOutcome(
  state: AppState,
  eventId: string | null | undefined,
  kind: string,
  outcome: PendingOutcome | undefined,
): boolean {
  if (!eventId || !outcome?.status || !PENDING.has(outcome.status)) return false;
  const key = outcome.intentId ?? outcome.invocationId ?? `${kind}:${eventId}`;
  records(state).set(key, { eventId, kind });
  refreshPresentation(state);
  return true;
}

/** Settle only the exact intent named by a terminal overlay invalidation. */
export function settlePendingChange(state: AppState, detail: CentraidChangeDetail): boolean {
  if (
    detail?.source !== 'overlay' ||
    typeof detail?.intentState !== 'string' ||
    !TERMINAL.has(detail.intentState) ||
    typeof detail?.intentId !== 'string'
  ) {
    return false;
  }
  const changed = records(state).delete(detail.intentId);
  if (changed) refreshPresentation(state);
  return changed;
}

/**
 * Managed replicas settle by exact intent metadata. Legacy `_changes`
 * doorbells have no intent id; the caller has already table-filtered them,
 * so retain the former bounded behavior of clearing this session's chips.
 */
export function reconcilePendingChange(
  state: AppState,
  detail: CentraidChangeDetail,
  managed: boolean,
): boolean {
  if (managed) return settlePendingChange(state, detail);
  const changed = records(state).size > 0;
  clearPendingState(state);
  return changed;
}

export function clearPendingState(state: AppState): void {
  records(state).clear();
  refreshPresentation(state);
}
