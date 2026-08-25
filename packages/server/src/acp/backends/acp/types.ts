// The public contract of the generic ACP backend (#479). Two flavours land
// here: CLIs that speak ACP natively (spawned with their ACP flag) and CLIs
// that do not (spawned through their first-party adapter, `AcpAdapterSpec`).
// From the backend's view the adapter IS the endpoint, so per-kind differences
// collapse into launch env plus an initial session mode. Every type here is
// re-exported from `./backend.ts`, the single import site for consumers.

import type {
  HarnessUsageSnapshot,
  HarnessKind,
  ToolContext,
  TurnAttachment,
  TurnStreamEvent,
} from "@centraid/server/engine";

export interface AcpTurnInput {
  conversationId?: string;
  cwd: string;
  message: string;
  /** Gated on the capabilities the harness advertised in `initialize`; anything
   *  it cannot take is named in a notice. */
  attachments?: TurnAttachment[];
  /** Served from a per-turn loopback MCP endpoint, which is how the vault tools
   *  reach EVERY harness kind through one mechanism. */
  toolContext?: ToolContext;
  /** Prepended on EVERY turn: ACP has no system-prompt channel, so re-sending is
   *  what keeps vault/skills policy in force across a restored session. Keep it
   *  short. */
  extraSystemPrompt: string;
  model?: string;
  /** `model` is applied before `thought_level`. */
  configPins?: Readonly<Record<string, string>>;
  /** Automation chat always denies. */
  permissionPolicy?: "auto-allow" | "deny";
  prevSessionId?: string;
  prevUsageSnapshot?: HarnessUsageSnapshot;
  /** Consumed only when a fresh session is used. */
  hydrationContext?: string;
  hydrationAttachments?: TurnAttachment[];
  /** Used when an otherwise healthy binding cannot resume. */
  recoveryHydrationContext?: string;
  recoveryHydrationAttachments?: TurnAttachment[];
  forceHydration?: boolean;
  /** Only for harnesses advertising `sessionCapabilities.additionalDirectories`.
   *  Omitted when empty. */
  additionalDirectories?: string[];
  extraPath?: string;
  abortSignal: AbortSignal;
  onEvent: (event: TurnStreamEvent) => void;
}

/** When present, the adapter — not `defaultBin` — is the process spawned;
 *  `defaultBin` stays the USER-FACING CLI, so preflight keeps probing what the
 *  user actually installs. */
export interface AcpAdapterSpec {
  readonly packageName: string;
  /** With an adapter in the middle, `binPath` means the HARNESS CLI, never the
   *  adapter itself. */
  readonly binPathEnvVar?: string;
  /** The headless policy for kinds that express it as a mode instead of a
   *  launch env var. */
  readonly sessionModeId?: string;
  /** True when the adapter refuses `sessionModeId` for a root process without
   *  `IS_SANDBOX`. Handled explicitly in `./launch.ts` rather than silently
   *  accepting a downgraded mode. */
  readonly bypassNeedsSandboxWhenRoot?: boolean;
}

export interface AcpTurnConfig {
  kind: HarnessKind;
  label?: string;
  /** Surfaced verbatim on `AUTH_REQUIRED`, so the sign-in string lives with the
   *  kind's metadata rather than as a branch in this client (#479). */
  installHint?: string;
  /** Spawned directly for native ACP CLIs; with an `adapter` set it is preflight
   *  metadata only. */
  defaultBin?: string;
  acpArgs: string[];
  binPath?: string;
  extraArgs?: string[];
  /** ONE field for both flavours — "this kind needs these vars at launch" —
   *  because splitting them by flavour is the per-kind branching #479 removed.
   *  Applied AFTER `harnessSpawnEnv`, so a kind can override an inherited var
   *  but never the sanitized PATH. */
  env?: Readonly<Record<string, string>>;
  adapter?: AcpAdapterSpec;
  /** Maps a capability tier to this runtime's native alias before matching the
   *  harness's offered options. Identity when the kind has no tier vocabulary. */
  resolveModel?: (model: string) => string;
  stageTimeoutMs?: number;
  /** Any session update or permission request resets the watchdog. */
  promptIdleTimeoutMs?: number;
}

export interface AcpTurnResult {
  sessionId?: string;
  usageSnapshot?: HarnessUsageSnapshot;
  hydrated?: boolean;
  hydrationKind?: "handoff" | "recovery";
}
