/**
 * Public types for @centraid/builder-harness.
 */

export interface HarnessConfig {
  /** Where new app projects are scaffolded by default. */
  projectsDir: string;
  /** OpenClaw gateway base URL — e.g. http://127.0.0.1:18789 */
  gatewayUrl: string;
  /**
   * Bearer token sent as `Authorization: Bearer <token>` to the gateway.
   * Empty string disables the header (works only against loopback gateways
   * configured with `auth.mode: "none"`).
   */
  gatewayToken?: string;
}

export interface ProjectInfo {
  id: string;
  /** Absolute path on disk. */
  dir: string;
  /** Whether build artifacts are present (any *.js files in queries/actions). */
  built: boolean;
  /** Last-modified timestamp of the project dir. */
  modifiedAt: string;
  /**
   * Human-readable name read from `app.json` at the project root, falling back
   * to the project id when missing or unreadable.
   */
  name?: string;
  /**
   * Optional one-line description read from `app.json#description`. Templates
   * seed this when cloned (carried from the template manifest); the user can
   * edit it inline in the builder topbar.
   */
  description?: string;
  /**
   * Whether `index.html` exists at the project root — i.e. the project is
   * preview-ready as a static site.
   */
  hasIndex?: boolean;
}

export interface PublishResult {
  id: string;
  versionId: string;
  declaredVersion?: string;
  sha256: string;
  files: number;
  bytes: number;
  activated: boolean;
  /**
   * Migration ids the gateway applied during this publish. Empty when the
   * tarball had no `migrations/` dir or all migrations were already at or
   * below `PRAGMA user_version`.
   */
  migrationsApplied: number[];
}

export interface PublishOptions {
  /** Skip running `bun run build` / `tsc` before tarballing. */
  skipBuild?: boolean;
  /**
   * Override which build command runs in the project dir before tarballing.
   * Default: `bun run build` if `package.json#scripts.build` exists, else `tsc`.
   */
  buildCommand?: { bin: string; args: string[] };
}

export type HarnessErrorCode =
  | 'no_project'
  | 'build_failed'
  | 'upload_failed'
  | 'auth_required'
  | 'gateway_unreachable'
  | 'gateway_error'
  | 'not_found'
  | 'conflict'
  | 'invalid_id'
  | 'already_exists'
  | 'config_invalid';

export class HarnessError extends Error {
  constructor(
    public readonly code: HarnessErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HarnessError';
  }
}
