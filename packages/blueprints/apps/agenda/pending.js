const PENDING = new Set(['queued', 'in-flight', 'parked']);
const TERMINAL = new Set(['executed', 'denied', 'failed']);

function records(state) {
  if (!(state.pendingByIntent instanceof Map)) state.pendingByIntent = new Map();
  return state.pendingByIntent;
}

function refreshPresentation(state) {
  state.pendingIds.clear();
  state.pendingCancelIds.clear();
  for (const pending of records(state).values()) {
    state.pendingIds.add(pending.eventId);
    if (pending.kind === 'cancel') state.pendingCancelIds.add(pending.eventId);
  }
}

/** Track one queued/parked write without letting an unrelated change clear it. */
export function trackPendingOutcome(state, eventId, kind, outcome) {
  if (!eventId || !PENDING.has(outcome?.status)) return false;
  const key = outcome.intentId ?? outcome.invocationId ?? `${kind}:${eventId}`;
  records(state).set(key, { eventId, kind });
  refreshPresentation(state);
  return true;
}

/** Settle only the exact intent named by a terminal overlay invalidation. */
export function settlePendingChange(state, detail) {
  if (
    detail?.source !== 'overlay' ||
    !TERMINAL.has(detail?.intentState) ||
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
export function reconcilePendingChange(state, detail, managed) {
  if (managed) return settlePendingChange(state, detail);
  const changed = records(state).size > 0;
  clearPendingState(state);
  return changed;
}

export function clearPendingState(state) {
  records(state).clear();
  refreshPresentation(state);
}
