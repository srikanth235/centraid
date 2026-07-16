/**
 * Thrown when the op-sqlite build was compiled without FTS5. The replica store
 * indexes captions/titles into an `fts5` virtual table for offline search, so a
 * build missing the extension can never bootstrap. Fail loud at open with the
 * exact fix rather than crashing opaquely mid-bootstrap.
 */
export class ReplicaFts5UnavailableError extends Error {
  constructor() {
    super(
      'op-sqlite was built without FTS5. Add `"op-sqlite": { "fts5": true }` to ' +
        'apps/mobile/package.json and rebuild the native app (expo prebuild + run).',
    );
    this.name = 'ReplicaFts5UnavailableError';
  }
}
