/*
 * ONE reducer for the edge lifecycle (issue #750 abstraction 5).
 *
 * Before this, four routes each wrote their own UPDATE over `share_edges`:
 * four hand-rolled state machines over one column meant "what may follow
 * what" had no answer — only four implementations that happened to agree.
 *
 * This module is that answer, as PURE functions: `(state, signal) → {state,
 * effects}`. It knows nothing about SQLite, routes, vaults or the network.
 * `share-edge-store.ts` is the only thing that applies its result durably,
 * and `share-effect-executor.ts` is the only thing that runs the effects it
 * emits.
 *
 * ONE LOCALITY REMAINS (#825, ruling G-copy). Copy-as-share retired with the
 * grant plane: `POST /centraid/_gateway/edges` refuses a cross-owner pair, so
 * every edge this reducer can still see is a same-owner placement between two
 * vaults open in this process. The peer delivery arm, the cross-owner closure
 * gate and the four peer answer signals (`give-served`, `give-asked`,
 * `give-denied`, `give-parked`) left with the transport that produced them —
 * a `delivery` discriminator over a single transport would state a choice
 * nothing makes. Sharing WITH ANOTHER PERSON is a standing grant, and the
 * grant plane's own fulfillment engine carries it.
 */

import type { EdgeKind, EdgeStatus } from "./share-edge-row.js";

/** The mutable half of an edge — the columns a transition may move. */
export interface EdgeState {
  status: EdgeStatus;
  targetState: "queued" | "executed";
  sourceState: "not-needed" | "queued" | "executed";
  targetItemIds: string[] | null;
  reason: string | null;
}

/** The immutable half — what the edge IS, which no transition changes. */
export interface EdgeFacts {
  edgeId: string;
  kind: EdgeKind;
}

/**
 * Everything that can happen to an edge. `begin` is the only COMMAND (the
 * owner, or a retry tick, asking the edge to make progress); the rest are
 * EVENTS reporting what a transport observed. Both go through one door
 * because "what may follow what" must be answered once.
 */
export type EdgeSignal =
  | { type: "begin" }
  | { type: "target-projected"; targetItemIds: readonly string[] }
  | { type: "source-released" }
  /**
   * "Nothing left to do" — the RESUME door. A pass that finds both halves
   * already executed (a crash after the last write, a retried effect) still
   * has to end the edge; without this the row would sit `in-flight` forever
   * on the one path where no work remained to report.
   */
  | { type: "settled" }
  /** This gateway could not act at all (a local vault call threw). */
  | { type: "give-failed"; reason: string }
  | { type: "revoked"; reason: string };

/**
 * A durable obligation the outbox owns until it is discharged. ONE kind since
 * #825: the three peer-plane obligations (`await-answer`, `deliver-refusal`,
 * `pull-blob`) existed only to carry a copy to another person's vault, and
 * left with copy-as-share. `deliver-give` survives as the same-owner
 * placement's own retry anchor.
 */
export interface ShareEffect {
  kind: "deliver-give";
  edgeId: string;
}

export interface EdgeOutcome {
  state: EdgeState;
  effects: ShareEffect[];
  /** False when the signal was a legal no-op (replay, or a terminal edge). */
  changed: boolean;
}

/**
 * Terminal statuses. A terminal edge absorbs every later signal — that is
 * what makes replay after a crash, a late-arriving denial, and a duplicated
 * background tick all safe by construction rather than by four `if`s.
 */
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

/**
 * The one legal-transition table of the sharing plane. Pure and total: every
 * (state, signal) pair has an answer, and an illegal pair is a no-op rather
 * than a throw — a background tick must never crash a gateway because a peer
 * answered late.
 */
export function reduceEdge(
  facts: EdgeFacts,
  state: EdgeState,
  signal: EdgeSignal
): EdgeOutcome {
  if (signal.type === "revoked") {
    // Revocation is the one signal a terminal edge still hears: withdrawing
    // authority must work on an edge that already completed.
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
      // The audience projection ALWAYS commits before a move deletes its
      // source; `targetState` is the marker a replay resumes from, so a
      // repeat of this signal must not undo the source step that followed it.
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
      // "Parked", not "failed": this gateway could not act THIS time. The
      // effect row outlives the attempt, so the next tick tries again — a
      // status of `failed` would claim a finality nothing here established.
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

/** An edge is done when both halves are: a move needs its source released. */
function settled(
  facts: EdgeFacts,
  targetState: EdgeState["targetState"],
  sourceState: EdgeState["sourceState"]
): boolean {
  if (targetState !== "executed") return false;
  return facts.kind === "move" ? sourceState === "executed" : true;
}

/** The deterministic id an effect replays under — the outbox's primary key. */
export function effectIdFor(effect: ShareEffect): string {
  return `give:${effect.edgeId}`;
}
