export class ReplicaSqliteVecUnavailableError extends Error {
  constructor() {
    super(
      'op-sqlite was built without sqlite-vec. Add `"op-sqlite": { "sqliteVec": true }` to ' +
        "apps/mobile/package.json and rebuild the native app (expo prebuild + run)."
    );
    this.name = "ReplicaSqliteVecUnavailableError";
  }
}
