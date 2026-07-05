// Public types + error class for the worktree-store module.
//
// Split out so `worktree-store.ts` stays focused on the class
// implementation. Consumers should still import from the module
// barrel (`./index.js`) — this file is an internal split, not an
// alternate entry point.

export interface WorktreeStoreOptions {
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
  /**
   * Optional pre-merge hook, run inside the publish mutex AFTER the
   * session is rebased onto current `main` and BEFORE the ff-merge (#144,
   * reshaped by #286 phase 2). Receives the post-rebase worktree app dir
   * (`<worktree>/apps/<appId>/`, carrying the final merged `app.json`).
   * Throwing aborts the publish: `main` never advances, no tag is minted.
   *
   * The store stays data-agnostic — the gateway injects the vault-side
   * ext-band DDL apply here. Running it post-rebase ensures the declared
   * specs are the exact tree about to go live, not the session's stale
   * pre-rebase tree.
   */
  beforeMerge?: (worktreeAppDir: string) => Promise<void>;
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
  // By design there is NO pre-merge hook here (the asymmetry with
  // `PublishInput.beforeMerge` is deliberate — issue #160 / #144): rollback
  // is CODE-ONLY. It swaps the live `apps/<appId>/` tree back to an older
  // tag but does NOT touch the app's ext band in the vault. Ext DDL is
  // applied additively on publish; the band stays at its current (forward)
  // shape, ahead of the rolled-back code.
  // A subsequent re-publish re-applies the forward migration and heals any
  // drift. See `rollbackCritical`.
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
  /**
   * `true` iff this tag's `apps/<appId>/` subtree matches the one
   * currently on `main`. After a forward publish, the newest tag is
   * active. After a rollback (forward-only overlay), the older tag
   * whose tree was re-laid on `main` becomes active again — the newer
   * tag stays in the list (reachable, replayable) but `active: false`.
   */
  active: boolean;
}

export type WorktreeStoreErrorCode =
  | 'not_initialized'
  | 'session_exists'
  | 'session_missing'
  | 'no_changes'
  | 'tag_missing'
  | 'invalid_app_id'
  | 'invalid_session_id';

export class WorktreeStoreError extends Error {
  constructor(
    public readonly code: WorktreeStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorktreeStoreError';
  }
}
