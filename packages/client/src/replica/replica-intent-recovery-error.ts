import type { ChainRecovery } from "./offline-chain.js";

/**
 * The gateway answered 409 about THIS INTENT, not about this seat's copy
 * (#996, R24).
 *
 * A 409 on the replica plane has always meant "re-bootstrap": the seat's
 * cursor is unusable and the file has to be replaced. Two of them do not.
 * `replica_intent_outcome_expired` and `replica_intent_payload_mismatch` are
 * facts about one queued write — its durable answer aged out, or its id was
 * reused with different bytes — and the seat's copy is fine. Treating them as
 * re-bootstrap would throw away a whole vault to answer a question about one
 * task, and it would lose the outbox's own decision in the process.
 *
 * So they get their own error, carrying the recovery the member is offered.
 */
export class ReplicaIntentRecoveryError extends Error {
  readonly code = "replica_intent_recovery";
  constructor(
    readonly intentId: string,
    readonly serverError: string,
    readonly recovery: ChainRecovery
  ) {
    super(`intent ${intentId}: ${recovery.copy}`);
    this.name = "ReplicaIntentRecoveryError";
  }
}
