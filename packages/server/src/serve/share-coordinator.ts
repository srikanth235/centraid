// The only legal-transition table for edges (#750): pure, storage-free. Never
// add a route-local UPDATE over `share_edges`. Same-owner placements only (#825).

import type { EdgeKind, EdgeStatus } from "./share-edge-row.js";

export interface EdgeState {
  status: EdgeStatus;
  targetState: "queued" | "executed";
  sourceState: "not-needed" | "queued" | "executed";
  targetItemIds: string[] | null;
  reason: string | null;
}

export interface EdgeFacts {
  edgeId: string;
  kind: EdgeKind;
}

export type EdgeSignal =
  | { type: "begin" }
  | { type: "target-projected"; targetItemIds: readonly string[] }
  | { type: "source-released" }
  | { type: "settled" }
  | { type: "give-failed"; reason: string }
  | { type: "revoked"; reason: string };

export interface ShareEffect {
  kind: "deliver-give";
  edgeId: string;
}

export interface EdgeOutcome {
  state: EdgeState;
  effects: ShareEffect[];
  changed: boolean;
}

const TERMINAL: ReadonlySet<EdgeStatus> = new Set<EdgeStatus>([
  "completed",
  "denied",
  "revoked",
  "failed",
]);

export function isTerminalEdgeStatus(status: EdgeStatus): boolean {
  return TERMINAL.has(status);
}

function unchanged(state: EdgeState): EdgeOutcome {
  return { state, effects: [], changed: false };
}

/** Total: an illegal (state, signal) pair is a no-op, never a throw. */
export function reduceEdge(
  facts: EdgeFacts,
  state: EdgeState,
  signal: EdgeSignal
): EdgeOutcome {
  if (signal.type === "revoked") {
    // The one signal a terminal edge hears: revoking a completed edge works.
    if (state.status === "revoked") return unchanged(state);
    return {
      state: { ...state, status: "revoked", reason: signal.reason },
      effects: [],
      changed: true,
    };
  }
  if (isTerminalEdgeStatus(state.status)) return unchanged(state);

  switch (signal.type) {
    case "begin":
      return {
        state: { ...state, status: "in-flight", reason: null },
        effects: [{ kind: "deliver-give", edgeId: facts.edgeId }],
        changed: true,
      };
    case "target-projected": {
      // Projection commits before a move deletes its source; a repeat must not
      // undo the source step.
      if (state.targetState === "executed") return unchanged(state);
      const next: EdgeState = {
        ...state,
        targetState: "executed",
        targetItemIds: [...signal.targetItemIds],
        reason: null,
        status: settled(facts, "executed", state.sourceState)
          ? "completed"
          : "in-flight",
      };
      return { state: next, effects: [], changed: true };
    }
    case "source-released": {
      if (state.sourceState !== "queued") return unchanged(state);
      const next: EdgeState = {
        ...state,
        sourceState: "executed",
        status: settled(facts, state.targetState, "executed")
          ? "completed"
          : "in-flight",
      };
      return { state: next, effects: [], changed: true };
    }
    case "settled":
      if (!settled(facts, state.targetState, state.sourceState))
        return unchanged(state);
      if (state.status === "completed") return unchanged(state);
      return {
        state: { ...state, status: "completed", reason: null },
        effects: [],
        changed: true,
      };
    case "give-failed":
      // Parked, not failed: the effect row outlives the attempt and retries.
      return park(state, signal.reason);
  }
}

function park(state: EdgeState, reason: string): EdgeOutcome {
  if (state.status === "parked" && state.reason === reason)
    return unchanged(state);
  return {
    state: { ...state, status: "parked", reason },
    effects: [],
    changed: true,
  };
}

function settled(
  facts: EdgeFacts,
  targetState: EdgeState["targetState"],
  sourceState: EdgeState["sourceState"]
): boolean {
  if (targetState !== "executed") return false;
  return facts.kind === "move" ? sourceState === "executed" : true;
}

export function effectIdFor(effect: ShareEffect): string {
  return `give:${effect.edgeId}`;
}
