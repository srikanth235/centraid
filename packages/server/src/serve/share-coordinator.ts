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

export function reduceEdge(
  facts: EdgeFacts,
  state: EdgeState,
  signal: EdgeSignal
): EdgeOutcome {
  if (signal.type === "revoked") {
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
