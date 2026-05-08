/**
 * Public types for @centraid/agent-harness.
 */

export interface HarnessConfig {
  /** Where new app projects are scaffolded by default. */
  projectsDir: string;
  /** OpenClaw gateway base URL — e.g. http://127.0.0.1:7575 */
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
  /** Whether build artifacts are present (any *.js files in queries/actions/crons). */
  built: boolean;
  /** Last-modified timestamp of the project dir. */
  modifiedAt: string;
  /**
   * Human-readable name read from `app.json` at the project root, falling back
   * to the project id when missing or unreadable.
   */
  name?: string;
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

export class HarnessError extends Error {
  constructor(
    public readonly code:
      | "no_project"
      | "build_failed"
      | "upload_failed"
      | "auth_required"
      | "gateway_unreachable"
      | "invalid_id"
      | "already_exists"
      | "config_invalid",
    message: string,
  ) {
    super(message);
    this.name = "HarnessError";
  }
}
