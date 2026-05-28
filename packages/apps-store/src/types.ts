// Public types + error class for the apps-store package.
//
// Split out so `apps-store.ts` stays focused on the class
// implementation. Consumers should still import from the package
// root (`@centraid/apps-store`) — this file is an internal split,
// not an alternate entry point.

export interface AppsStoreOptions {
  /**
   * Per-gateway root containing `apps.git/` + `worktrees/`. The host
   * is responsible for picking the path and ensuring its parent
   * exists — `init()` will mkdir `root` itself.
   */
  root: string;
}

export interface SessionHandle {
  /** The session id, exactly as passed to `openSession`. */
  id: string;
  /** Branch name in the bare repo — `sessions/<id>`. */
  branch: string;
  /** Absolute path to the session worktree. */
  worktreePath: string;
}

export interface PublishInput {
  /** Session whose branch holds the agent's edits. */
  sessionId: string;
  /** App being published. Only files under `apps/<appId>/` are staged. */
  appId: string;
  /** Commit message body (the subject gets `<appId>:` prepended). */
  message: string;
}

export interface PublishResult {
  /** The newly-minted tag, e.g. `todo/v3`. */
  versionTag: string;
  /** Sha the tag and `main` now point at. */
  sha: string;
  /** Absolute path to the freshly-materialized main worktree. */
  materializedMainDir: string;
}

export interface RollbackInput {
  appId: string;
  /** Existing tag to roll back to — e.g. `todo/v1`. */
  versionTag: string;
}

export interface RollbackResult {
  /** Sha of the new forward commit on main. NOT tagged. */
  sha: string;
  materializedMainDir: string;
}

export interface VersionEntry {
  /** Tag name, e.g. `todo/v2`. */
  tag: string;
  /** Numeric version — the `<n>` from `<appId>/v<n>`. */
  version: number;
  /** Sha the tag points at. */
  sha: string;
  /** ISO timestamp from the tagged commit's committer date. */
  uploadedAt: string;
}

export type AppsStoreErrorCode =
  | 'not_initialized'
  | 'session_exists'
  | 'session_missing'
  | 'no_changes'
  | 'tag_missing'
  | 'invalid_app_id'
  | 'invalid_session_id';

export class AppsStoreError extends Error {
  constructor(
    public readonly code: AppsStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppsStoreError';
  }
}
