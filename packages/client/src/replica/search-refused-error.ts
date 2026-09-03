export class ReplicaSearchRefusedError extends Error {
  readonly code = "REPLICA_SEARCH_REFUSED";

  constructor(readonly reason: string) {
    super(`Search refused in this scope: ${reason}`);
    this.name = "ReplicaSearchRefusedError";
  }
}
