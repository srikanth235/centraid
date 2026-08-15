/**
 * Types shared by the app clone path here and the automation scaffolder in
 * `@centraid/automation`. `AppScaffoldError` carries a machine-readable `code`
 * the gateway maps to an HTTP status.
 */

/** A single file in a scaffold/clone file map. `path` is app-relative, posix. */
export interface ScaffoldFile {
  path: string;
  content: string;
}

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
   * seed this when cloned (carried from the template manifest).
   */
  description?: string;
  /**
   * App classification read from `app.json#kind`: `'automation'` marks a
   * UI-less automation app (Automations page), `'app'` / undefined a normal
   * UI app. Replaces the legacy `auto.` id-prefix convention.
   */
  kind?: "app" | "automation";
}

export type AppScaffoldErrorCode =
  | "no_app"
  | "not_found"
  | "conflict"
  | "invalid_id"
  | "invalid_manifest"
  | "already_exists";

/**
 * Error thrown by the app scaffolders / clone / lifecycle helpers. The gateway
 * lifecycle routes catch this and map `code` → HTTP status.
 */
export class AppScaffoldError extends Error {
  constructor(
    public readonly code: AppScaffoldErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AppScaffoldError";
  }
}
