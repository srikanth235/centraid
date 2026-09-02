export interface WorktreeStoreOptions {
  root: string;
}

export interface SessionHandle {
  id: string;
  branch: string;
  worktreePath: string;
}

export interface PublishInput {
  sessionId: string;
  appId: string;
  message: string;
  /** Runs post-rebase, pre-ff-merge (#144, #286) so it sees the tree about to go live; throwing aborts the publish — `main` never advances. */
  beforeMerge?: (worktreeAppDir: string) => Promise<void>;
}

export interface PublishResult {
  versionTag: string;
  sha: string;
  materializedMainDir: string;
}

export interface RollbackInput {
  appId: string;
  versionTag: string;
  // NO pre-merge hook, by design (#160 / #144): rollback is CODE-ONLY, leaves the ext band at its forward shape; a re-publish heals the drift.
}

export interface RollbackResult {
  sha: string;
  materializedMainDir: string;
}

export interface VersionEntry {
  tag: string;
  version: number;
  sha: string;
  uploadedAt: string;
  active: boolean;
}

export type WorktreeStoreErrorCode =
  | "not_initialized"
  | "session_exists"
  | "session_missing"
  | "no_changes"
  | "tag_missing"
  | "invalid_app_id"
  | "invalid_session_id";

export class WorktreeStoreError extends Error {
  constructor(
    public readonly code: WorktreeStoreErrorCode,
    message: string
  ) {
    super(message);
    this.name = "WorktreeStoreError";
  }
}
