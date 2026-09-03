export class ReplicaFts5UnavailableError extends Error {
  constructor() {
    super(
      'op-sqlite was built without FTS5. Add `"op-sqlite": { "fts5": true }` to ' +
        "apps/mobile/package.json and rebuild the native app (expo prebuild + run)."
    );
    this.name = "ReplicaFts5UnavailableError";
  }
}
