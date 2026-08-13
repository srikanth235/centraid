/*
 * ONE reducer for the edge lifecycle (issue #750 abstraction 5).
 *
 * Before this, every route that touched an edge wrote its own UPDATE:
 * `edges-routes.ts` parked on an exception, `edges-reconcile.ts` walked
 * queued → in-flight → completed, `edges-reconcile-remote.ts` mapped six peer
 * outcomes to statuses of its own, and `peer-edge-give-route.ts` denied from
 * yet another place. Four hand-rolled state machines over one column meant
 * "what may follow what" had no answer — only four implementations that
 * happened to agree.
 *
 * This module is that answer, as PURE functions: `(state, signal) → {state,
 * effects}`. It knows nothing about SQLite, routes, vaults or the network.
 * `share-edge-store.ts` is the only thing that applies its result durably,
 * and `share-effect-executor.ts` is the only thing that runs the effects it
 * emits.
 *
 * Locality does not fork the domain (D3). A give to a vault on this machine
 * and a give across the world produce the SAME `deliver-give` effect from the
 * SAME transition; `delivery` rides along only so the executor can pick a
 * transport (`edges-reconcile.ts`'s direct vault calls, or
 * `edges-reconcile-remote.ts`'s peer dial). If a transition ever needed to
 * ask which one it was, that would be the bug this shape exists to prevent.
 */

import type { EdgeKind, EdgeStatus } from "./share-edge-row.js";

export type EdgeDelivery = "local" | "peer";

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
  delivery: EdgeDelivery;
  /**
   * Threat 8: a co-hosted CROSS-owner give must gate the origin's
   * `media.location` policy inside the closure read. Same-owner gives do not.
   * Decided once, where the crossing is judged, and carried on the effect so
   * a retry after a crash re-decides nothing.
   */
  crossOwner: boolean;
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
  /**
   * The audience came BACK for the closure after its owner accepted a D9
   * 'ask' (`peer/edge/closure/:id`). Handing it over twice is this gateway's
   * definition of "given" — it has no way to observe the far side's
   * projection, so unlike `target-projected` there are no audience item ids
   * to record, and no receipt claims any.
   */
  | { type: "give-served" }
  /** The audience is not accepting automatically — its owner must answer. */
  | { type: "give-asked" }
  /** The audience (or its owner) refused. Terminal, and never says why. */
  | { type: "give-denied"; reason: string }
  /** Not delivered, not refused — try again later. */
  | { type: "give-parked"; reason: string }
  /** This gateway could not act at all (a local vault call threw). */
  | { type: "give-failed"; reason: string }
  | { type: "revoked"; reason: string };

/** A durable obligation the outbox owns until it is discharged. */
export type ShareEffect =
  | {
      kind: "deliver-give";
      edgeId: string;
      delivery: EdgeDelivery;
      crossOwner: boolean;
    }
  | {
      kind: "await-answer";
      edgeId: string;
      linkId: string;
      peerVaultId: string;
      localVaultId: string;
      itemType: string;
      itemCount: number;
    }
  | {
      kind: "deliver-refusal";
      edgeId: string;
      linkId: string;
      peerVaultId: string;
      localVaultId: string;
    }
  | {
      kind: "pull-blob";
      edgeId: string;
      linkId: string;
      localVaultId: string;
      sha256: string;
      size: number;
      tmpPath: string;
    };

export type ShareEffectKind = ShareEffect["kind"];

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
        effects: [
          {
            kind: "deliver-give",
            edgeId: facts.edgeId,
            delivery: facts.delivery,
            crossOwner: facts.crossOwner,
          },
        ],
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
    case "give-served":
      return {
        state: {
          ...state,
          targetState: "executed",
          status: "completed",
          reason: null,
        },
        effects: [],
        changed: true,
      };
    case "settled":
      if (!settled(facts, state.targetState, state.sourceState))
        return unchanged(state);
      if (state.status === "completed") return unchanged(state);
      return {
        state: { ...state, status: "completed", reason: null },
        effects: [],
        changed: true,
      };
    case "give-asked":
      return park(state, "awaiting recipient decision");
    case "give-parked":
      return park(state, signal.reason);
    case "give-denied":
      return {
        state: { ...state, status: "denied", reason: signal.reason },
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
  switch (effect.kind) {
    case "deliver-give":
      return `give:${effect.edgeId}`;
    case "await-answer":
      return `ask:${effect.edgeId}`;
    case "deliver-refusal":
      return `refuse:${effect.edgeId}`;
    case "pull-blob":
      return `pull:${effect.edgeId}:${effect.sha256}`;
  }
}
