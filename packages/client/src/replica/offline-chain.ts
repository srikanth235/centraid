// THE OFFLINE CHAIN, ON THE SEAT (#996, rulings R23–R25).
//
// In airplane mode a member creates a task, renames it twice, gives it a due
// date and completes it. Five intents, four of which name a row the first one
// has not made yet. When the network returns they must execute IN ORDER, once
// each, against the row the create actually produced — and the screen must
// show one completed task with the final values the whole time, including
// after the app is killed and relaunched.
//
// WHAT LIVES HERE, AND WHAT DELIBERATELY DOES NOT. The gateway owns the
// verdict: `replicaDependencyVerdict` decides when an intent may run,
// `resolvePredecessorReferences` decides which row a placeholder means, and
// the durable outcome carries `commit_seq`. This module is the seat's half —
// deriving the edges, carrying them on the wire, holding the dependents,
// rebuilding the projection after a restart, and clearing an overlay at
// exactly the right moment. Every one of those is a decision only the seat can
// make, because only the seat knows what it queued and how far it has applied.
//
// THREE THINGS THIS MODULE REFUSES TO DO:
//
//   - INVENT AN EDGE FROM A VALUE. An edge exists when an intent's input names
//     a row id another QUEUED intent's projection minted — read out of the
//     outbox, never inferred from a value's shape (R20). An app declares
//     nothing and guesses nothing.
//   - SUBSTITUTE A PREDECESSOR'S VERSION BEFORE SENDING. Three outboxes each
//     rebasing locally is three rebases the gateway cannot tell from an
//     observed version, and the whole point of the base set is that the
//     gateway can. The seat sends what it OBSERVED, or nothing, and names the
//     predecessor.
//   - CLEAR AN OVERLAY ON THE ANSWER. `executed` means the gateway committed,
//     not that this seat has the rows. The overlay clears when the applied
//     cursor reaches the outcome's `commit_seq` — in the transaction that
//     advances it, where the outbox shares the file.

import { stablePendingRowId } from "@centraid/blueprints/apps/_shared/pending-overlay";

import { namedRowIds, PENDING_SUPERSEDES_FIELD } from "./intent-revision.js";
import type {
  OptimisticMutation,
  ReplicaBaseVersion,
  ReplicaIntent,
  ReplicaValue,
} from "./types.js";

/** States whose intent is still on its way to an answer. */
const UNSETTLED = new Set([
  "queued",
  "sending",
  "parked",
  "awaiting-change",
  "conflict",
  "conflict-base-missing",
  "failed",
]);

/** States whose intent will never execute. A dependent on one is abandoned. */
const NEVER = new Set(["denied", "expired"]);

/** Every row id an intent's own projection minted, mapped to that intent. */
export interface MintedRow {
  readonly intentId: string;
  readonly entity: string;
  /**
   * True when the id was SYNTHESISED by the projection rather than supplied by
   * the app — which is exactly when the gateway will mint its own and the row
   * id on the wire has to become a reference instead of a value.
   */
  readonly synthetic: boolean;
}

/**
 * Index the rows the outbox's unsettled intents have created.
 *
 * ONLY UPSERTS COUNT. A delete names a row that already exists canonically, so
 * a later intent naming it is not depending on this one to MAKE it; treating
 * it as an edge would serialise two unrelated writes behind each other.
 */
export function mintedRowIndex(
  intents: readonly ReplicaIntent[],
  /**
   * Intents this write SUPERSEDES, plus its own id. A revision replaces its
   * predecessor and inherits its row; it does not WAIT on it, and an edge here
   * would make an intent depend on the one it just retired — a chain that can
   * never drain. `IntentQueue.enqueue` passes the supersession markers the
   * replacement already carries.
   */
  exclude: ReadonlySet<string> = new Set()
): Map<string, MintedRow> {
  const minted = new Map<string, MintedRow>();
  for (const intent of intents) {
    if (!UNSETTLED.has(intent.state)) continue;
    if (exclude.has(intent.intentId)) continue;
    const named = new Set(namedRowIds(intent.input));
    for (const mutation of intent.optimistic) {
      if (mutation.op !== "upsert") continue;
      if (minted.has(mutation.rowId)) continue;
      minted.set(mutation.rowId, {
        intentId: intent.intentId,
        entity: mutation.entity,
        // Two ways to be sure the id is the projection's invention: it matches
        // `stablePendingRowId` for this intent, or the intent's own input
        // never named it. Either is decisive; neither guesses from the shape
        // of the string.
        synthetic:
          !named.has(mutation.rowId) ||
          isStablePendingId(intent.intentId, mutation.rowId),
      });
    }
  }
  return minted;
}

function isStablePendingId(intentId: string, rowId: string): boolean {
  // The suffixes the bundled projections use. A miss here is not a wrong
  // answer — `!named.has(...)` already decides the common case — it only
  // costs the id its second, independent confirmation.
  for (const suffix of ["row", "task", "project", "section", "event", "note"])
    if (stablePendingRowId(intentId, suffix) === rowId) return true;
  return false;
}

/**
 * The intents this write may not run before (R23).
 *
 * Derived from the ids the input NAMES against the ids the outbox has MINTED —
 * the two facts the seat already has. Order is the outbox's, so a chain of
 * five arrives with its edges in the order they were made.
 */
export function chainDependencies(
  input: ReplicaValue,
  minted: Map<string, MintedRow>
): string[] {
  const edges: string[] = [];
  for (const rowId of namedRowIds(input)) {
    const source = minted.get(rowId);
    if (!source || edges.includes(source.intentId)) continue;
    edges.push(source.intentId);
  }
  return edges;
}

/**
 * Intent ids a REPLACEMENT retires, read off the supersession markers its own
 * projection already carries (`intent-revision.ts`).
 *
 * A revision inherits the predecessor's row on purpose — that is what makes a
 * re-edited pending write one row on the screen instead of two. What it must
 * not inherit is a dependency ON the row's maker, which would be an edge to an
 * intent this one has just retired.
 */
export function supersededByInput(input: {
  optimistic?: readonly OptimisticMutation[];
}): string[] {
  const ids = new Set<string>();
  for (const mutation of input.optimistic ?? []) {
    if (mutation.op !== "upsert") continue;
    const marker = (mutation.values as Record<string, unknown>)[
      PENDING_SUPERSEDES_FIELD
    ];
    if (typeof marker === "string") ids.add(marker);
  }
  return [...ids];
}

/** The `{"$intent": id, "table": …}` form the gateway resolves. */
export interface PredecessorReference {
  readonly $intent: string;
  readonly table?: string;
}

/**
 * Rewrite row ids a predecessor will mint into references to that predecessor.
 *
 * ONLY THE SYNTHETIC ONES. When an app supplies the id itself, the create
 * writes that id and every later intent may name it directly — substituting
 * there would replace a correct value with an indirection. When the projection
 * INVENTED the id for display, the gateway has never seen it and never will,
 * so the wire has to carry the reference.
 */
export function substitutePredecessorReferences(
  input: ReplicaValue,
  minted: Map<string, MintedRow>
): ReplicaValue {
  if (!input || typeof input !== "object") return input;
  if (Array.isArray(input))
    return input.map((item) =>
      substitutePredecessorReferences(item, minted)
    ) as ReplicaValue;
  const out: Record<string, ReplicaValue> = {};
  for (const [key, value] of Object.entries(input)) {
    const source = typeof value === "string" ? minted.get(value) : undefined;
    out[key] =
      source && source.synthetic
        ? ({
            $intent: source.intentId,
            table: source.entity,
          } as unknown as ReplicaValue)
        : substitutePredecessorReferences(value, minted);
  }
  return out;
}

/**
 * The base set, minus the rows a predecessor has not produced yet (R23).
 *
 * A row the create has not made has no version to observe, and inventing one
 * — 0, or the projection's optimistic guess — is how a chain conflicts with
 * itself on its own first run. The reference to it is the dependency edge and
 * the `$intent` placeholder; the gateway resolves both from the durable
 * outcome and then compares by plain equality.
 */
export function chainBaseVersions(
  observed: readonly ReplicaBaseVersion[],
  minted: Map<string, MintedRow>
): ReplicaBaseVersion[] {
  return observed.filter((base) => !minted.has(base.rowId));
}

/** A dependent that is not going anywhere yet, and why. */
export interface ChainHold {
  readonly intentId: string;
  /** The predecessor intent id. */
  readonly on: string;
  readonly kind: "waiting" | "abandoned";
  /** The predecessor's own reason, when it has one. */
  readonly reason?: string;
}

/**
 * Which queued intents are held, and by what.
 *
 * Computed on the SEAT as well as on the gateway, because the badge has to be
 * right while the device is offline — where the gateway's verdict does not
 * exist yet and will not for hours.
 */
export function chainHolds(intents: readonly ReplicaIntent[]): ChainHold[] {
  const byId = new Map(intents.map((intent) => [intent.intentId, intent]));
  const holds: ChainHold[] = [];
  for (const intent of intents) {
    if (!UNSETTLED.has(intent.state)) continue;
    for (const predecessor of intent.dependsOn ?? []) {
      const source = byId.get(predecessor);
      if (!source || source.state === "executed") continue;
      const kind = NEVER.has(source.state) ? "abandoned" : "waiting";
      holds.push({
        intentId: intent.intentId,
        on: predecessor,
        kind,
        ...(source.reason === undefined ? {} : { reason: source.reason }),
      });
      break;
    }
  }
  return holds;
}

/**
 * What a held dependent says on the screen.
 *
 * "Waiting on an earlier change" is deliberately not "failed": it releases on
 * its own when the predecessor lands, and a member who is told a thing failed
 * goes and does it again. An abandoned dependent gets the predecessor's own
 * reason, because "an earlier change was refused" without saying WHICH is a
 * queue that has quietly stopped.
 */
export function chainBadgeCopy(hold: ChainHold): string {
  if (hold.kind === "waiting") return "Waiting on an earlier change";
  return hold.reason
    ? `An earlier change did not go through — ${hold.reason}`
    : "An earlier change did not go through";
}

/**
 * The overlay a restart has to rebuild (R23).
 *
 * A projection held only in component state is a projection that vanishes when
 * the app is killed, which is exactly when the member most needs to see that
 * their work is still there. The outbox is durable, so the overlay is derived
 * from it — in outbox order, so a rename applied after a create still wins.
 *
 * A HELD DEPENDENT STILL SHOWS. Its work is real, it has not failed, and
 * hiding it would make the screen disagree with the badge beside it.
 */
export function reconstructPendingProjection(
  intents: readonly ReplicaIntent[]
): OptimisticMutation[] {
  return [...intents]
    .filter((intent) => UNSETTLED.has(intent.state))
    .sort((left, right) => left.createdOrder - right.createdOrder)
    .flatMap((intent) => intent.optimistic);
}

/**
 * Backoff for a transport failure, in ms.
 *
 * Exponential from one second, capped at five minutes, and DETERMINISTIC:
 * intents drain one at a time in outbox order, so there is no thundering herd
 * to spread and jitter would only make the wait unexplainable to the member.
 */
export function chainRetryDelayMs(attempts: number): number {
  const step = Math.max(0, Math.min(attempts, 9));
  return Math.min(5 * 60_000, 1_000 * 2 ** step);
}

export function chainNextRetryAt(
  intent: Pick<ReplicaIntent, "attempts">,
  now: Date = new Date()
): string {
  return new Date(
    now.getTime() + chainRetryDelayMs(intent.attempts)
  ).toISOString();
}

/**
 * The intents whose overlay this applied cursor has earned the right to clear
 * (R24).
 *
 * `executed` alone is not enough: the gateway has committed, and this seat may
 * not have the rows yet. Clearing there is the flicker — the pending row goes
 * and the canonical one has not arrived. Clearing at `commit_seq` is the whole
 * fix, and it makes acknowledgement-before-delta and delta-before-
 * acknowledgement the same sequence.
 */
export function overlaysClearedAt(
  cursorCommitSeq: number,
  intents: readonly ReplicaIntent[]
): string[] {
  return intents
    .filter(
      (intent) =>
        intent.commitSeq !== undefined && intent.commitSeq <= cursorCommitSeq
    )
    .map((intent) => intent.intentId);
}

/**
 * ABSENCE RECONCILES TOO (R24).
 *
 * A rejected offline creation must leave NO pending row, and an accepted
 * deletion must leave no stale one. Both are the same question asked about
 * nothing — there is no canonical row to compare against — so neither can be
 * answered by "does the replica hold this row yet". The answer is the
 * OUTCOME's, and it is final the moment it arrives.
 */
export function absenceReconciled(
  intent: Pick<ReplicaIntent, "state" | "commitSeq">,
  cursorCommitSeq: number
): boolean {
  // A refusal produced no commit, so there is nothing to wait for: the
  // overlay goes at once, or a task the gateway refused sits on the screen
  // forever looking pending.
  if (intent.state === "denied" || intent.state === "expired") return true;
  if (intent.commitSeq === undefined) return false;
  return intent.commitSeq <= cursorCommitSeq;
}

/**
 * The re-bootstrap cutover, in order (R23, R25).
 *
 * Stated as data rather than left implicit in a function body because the
 * ORDER is the contract, and the one thing every future edit must not do is
 * reorder it. Steps 1 and 2 are the reason: a seat that swaps the file first
 * and rescues the outbox second has a window in which a crash destroys work
 * that exists nowhere else.
 */
export const SEAT_REBOOTSTRAP_CUTOVER = [
  "quiesce: stop claiming intents; an intent already sending keeps its answer",
  "carry-over: read the outbox, the held blobs and the pins out of the old file",
  "install: replace the file and reopen it",
  "restore: write the carry-over back, created_order verbatim",
  "reproject: rebuild the overlay from the restored outbox",
  "resume: drain from the outbox and tail from the new cursor",
] as const;

/**
 * May an intent be ADMITTED while a re-bootstrap is being prepared?
 *
 * Yes — and it has to be. Refusing would make "saved" untrue for the member
 * during a repair they did not ask for and cannot see. What it may NOT do is
 * be SENT: the seat's cursor is about to move discontinuously, so an answer
 * arriving mid-swap would be reconciled against a file that no longer exists.
 * Admitted and held is the only correct pair.
 */
export function admissionDuringRebootstrap(): {
  readonly admit: true;
  readonly send: false;
  readonly reason: string;
} {
  return {
    admit: true,
    send: false,
    reason: "the seat is replacing its copy; this is saved and will send after",
  };
}

/** The gateway's 409 for an outcome that aged out of the window (R24). */
export interface ExpiredOutcomeAnswer {
  readonly error: "replica_intent_outcome_expired";
  readonly recovery: "resubmit-as-new-intent";
  readonly reason?: string;
}

export interface ChainRecovery {
  readonly action: "recover";
  /** Mint a NEW intent id against a freshly observed base. */
  readonly mintNewIntent: true;
  readonly copy: string;
  readonly reason: string | undefined;
}

/**
 * What the member is offered when the gateway says "I no longer know".
 *
 * NEVER A SILENT RETRY. The retained outcome is what made a retry idempotent;
 * once it is gone, re-sending the same id could duplicate a payment or a
 * completion. So the seat surfaces a decision — the same one a conflict asks
 * for, for the same reason — rather than choosing on the member's behalf.
 */
export function chainRecoveryFromExpiredOutcome(
  answer: ExpiredOutcomeAnswer
): ChainRecovery {
  return {
    action: "recover",
    mintNewIntent: true,
    copy: "This waited too long to be sure it ran. Check, then send it again.",
    reason: answer.reason,
  };
}
