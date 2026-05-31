/**
 * Types shared by the app scaffolders (moved here when `@centraid/agent-harness`
 * was dissolved — issue #145). `AppScaffoldError` is the renamed `HarnessError`;
 * it carries a machine-readable `code` the gateway maps to an HTTP status.
 */

export interface AppInfo {
  id: string;
  /** Absolute path on disk. */
  dir: string;
  /** Whether build artifacts are present (any *.js files in queries/actions). */
  built: boolean;
  /** Last-modified timestamp of the app dir. */
  modifiedAt: string;
  /**
   * Human-readable name read from `app.json` at the app root, falling back
   * to the app id when missing or unreadable.
   */
  name?: string;
  /**
   * Optional one-line description read from `app.json#description`. Templates
   * seed this when cloned (carried from the template manifest); the user can
   * edit it inline in the builder topbar.
   */
  description?: string;
  /**
   * Whether `index.html` exists at the app root — i.e. the app is
   * preview-ready as a static site.
   */
  hasIndex?: boolean;
  /**
   * App classification read from `app.json#kind`: `'automation'` marks a
   * UI-less automation app (Automations page), `'app'` / undefined a normal
   * UI app. Replaces the legacy `auto.` id-prefix convention.
   */
  kind?: 'app' | 'automation';
}

export type AppScaffoldErrorCode =
  | 'no_app'
  | 'not_found'
  | 'conflict'
  | 'invalid_id'
  | 'invalid_manifest'
  | 'already_exists';

/**
 * Error thrown by the app scaffolders / clone / lifecycle helpers. The gateway
 * lifecycle routes catch this and map `code` → HTTP status.
 */
export class AppScaffoldError extends Error {
  constructor(
    public readonly code: AppScaffoldErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AppScaffoldError';
  }
}
