/*
 * The public contract of the generic ACP backend (issue #479): what a caller
 * hands `runAcpTurn` and what a harness kind declares about itself.
 *
 * Two flavours of harness land here:
 *   - CLIs that speak ACP natively (Gemini CLI, Qwen Code, a custom `acp`
 *     binary): spawned directly with their ACP flag.
 *   - CLIs that don't (Claude Code, Codex): spawned through their official
 *     first-party ACP *adapter*, declared as `AcpAdapterSpec` and resolved
 *     from node_modules by `./adapter-bin.ts`. From the backend's point of
 *     view the adapter IS the harness endpoint; per-kind differences collapse into
 *     launch env + an initial session mode.
 *
 * Every type here is re-exported from `./backend.ts`, which stays the single
 * import site for consumers (`../../registry.ts`, `../../index.ts`).
 */

import type {
  HarnessUsageSnapshot,
  HarnessKind,
  ToolContext,
  TurnAttachment,
  TurnStreamEvent,
} from "@centraid/server/engine";

export interface AcpTurnInput {
  /** Stable ledger identity used only to scope the warm-process cache. */
  conversationId?: string;
  cwd: string;
  message: string;
  /**
   * Mapped to ACP prompt content blocks, gated on the capabilities the harness
   * advertised in `initialize`. Anything it can't take is named in a notice.
   */
  attachments?: TurnAttachment[];
  /**
   * The turn's vault executors. When present (and the harness supports HTTP MCP)
   * they are served from a per-turn loopback MCP endpoint named in
   * `mcpServers`, which is how `vault_sql` / `vault_invoke` / `vault_content`
   * reach EVERY harness kind through one mechanism.
   */
  toolContext?: ToolContext;
  /**
   * Prepended as a leading text block on EVERY turn (fresh, loaded, or
   * resumed). ACP has no separate system-prompt channel; re-sending keeps
   * Centraid vault/skills policy in force even when harness session history
   * is restored without our instructions. Callers keep this short.
   */
  extraSystemPrompt: string;
  model?: string;
  /** Category-keyed ACP pins. `model` is applied before `thought_level`. */
  configPins?: Readonly<Record<string, string>>;
  /** Host decision for ACP permission requests; automation chat always denies. */
  permissionPolicy?: "auto-allow" | "deny";
  /** Session id from a prior turn; triggers resume/load when supported. */
  prevSessionId?: string;
  /** Persisted cumulative counters paired with `prevSessionId`. */
  prevUsageSnapshot?: HarnessUsageSnapshot;
  /** Canonical ledger handoff, consumed only when a fresh session is used. */
  hydrationContext?: string;
  /** Historical files accompanying the retained handoff turns. */
  hydrationAttachments?: TurnAttachment[];
  /** Full-ledger handoff used when an otherwise healthy binding cannot resume. */
  recoveryHydrationContext?: string;
  /** Historical files accompanying full-ledger recovery. */
  recoveryHydrationAttachments?: TurnAttachment[];
  /** A harness change already proved that this turn must hydrate. */
  forceHydration?: boolean;
  /**
   * Extra absolute workspace roots for harnesses that advertise
   * `sessionCapabilities.additionalDirectories`. Omitted when empty.
   */
  additionalDirectories?: string[];
  /** Path-delimited dirs prepended to the child's PATH (centraid CLI etc.). */
  extraPath?: string;
  abortSignal: AbortSignal;
  onEvent: (event: TurnStreamEvent) => void;
}

/**
 * How to launch a CLI that does NOT speak ACP natively, via its official
 * first-party adapter. When present, the adapter — not `defaultBin` — is the
 * process we spawn; `defaultBin` stays the USER-FACING CLI so preflight keeps
 * probing and version-hinting the thing the user actually installs.
 */
export interface AcpAdapterSpec {
  /** npm package providing the adapter. Its `bin` entry is resolved from node_modules. */
  readonly packageName: string;
  /**
   * Env var through which `HarnessPrefs.binPath` reaches the UNDERLYING CLI.
   * With an adapter in the middle, `binPath` means "the harness CLI"
   * (`CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH`), never the adapter itself.
   */
  readonly binPathEnvVar?: string;
  /**
   * ACP session mode to select once the session exists (e.g.
   * `bypassPermissions`) — the headless policy for kinds that express it as
   * a mode instead of a launch env var.
   */
  readonly sessionModeId?: string;
  /**
   * True when the adapter refuses `sessionModeId` for a root process unless
   * `IS_SANDBOX` is set. The claude adapter gates bypass on
   * `ALLOW_BYPASS = !IS_ROOT || !!process.env.IS_SANDBOX`; we handle that
   * explicitly (see `./launch.ts`) instead of silently getting a downgraded
   * mode.
   */
  readonly bypassNeedsSandboxWhenRoot?: boolean;
}

export interface AcpTurnConfig {
  /** The harness kind this invocation represents — echoed as `harnessKind`. */
  kind: HarnessKind;
  /**
   * Human label for this kind, used only in operator-facing messages.
   * Defaults to `kind` when absent.
   */
  label?: string;
  /**
   * The registry's install/setup hint. Surfaced verbatim when the harness
   * answers `AUTH_REQUIRED`, so the "how do I sign in" string lives with the
   * kind's other metadata instead of being branched on inside this client —
   * which is exactly the per-kind branching #479 removed.
   */
  installHint?: string;
  /**
   * The user-facing CLI's default binary. Spawned directly for natively
   * ACP-speaking CLIs; with an `adapter` set it is preflight metadata only.
   * Undefined for the custom `acp` kind.
   */
  defaultBin?: string;
  /** Args that put the CLI into ACP mode (e.g. `['--acp']`). Empty with an adapter. */
  acpArgs: string[];
  /** Override the harness CLI's location; defaults to `defaultBin` on PATH. */
  binPath?: string;
  /** Extra args passed verbatim after the ACP flag. */
  extraArgs?: string[];
  /**
   * Static env applied to whatever process we spawn — the ACP-speaking CLI for
   * native kinds, the adapter for adapter-backed ones. ONE field for both
   * flavours: a headless preset (codex's `INITIAL_AGENT_MODE`) and a
   * self-update suppressor (auggie's `AUGMENT_DISABLE_AUTO_UPDATE`) are the
   * same kind of fact — "this kind needs these vars at launch" — and splitting
   * them by flavour is exactly the per-kind branching #479 removed. Applied
   * AFTER `harnessSpawnEnv`, so a kind can override an inherited var but never
   * the sanitized PATH.
   */
  env?: Readonly<Record<string, string>>;
  /** Launch through a first-party ACP adapter instead of spawning the CLI directly. */
  adapter?: AcpAdapterSpec;
  /**
   * Map a capability tier (`smart`/`balanced`/`fast`) to this runtime's
   * native model alias before matching it against the harness's offered model
   * options. Identity when the kind has no tier vocabulary.
   */
  resolveModel?: (model: string) => string;
  /**
   * Bound initialize and session setup requests. Primarily injectable for
   * deterministic tests; production callers use the conservative default.
   */
  stageTimeoutMs?: number;
  /**
   * Kill a prompt that produces no ACP activity for this long. Any session
   * update or permission request resets the watchdog.
   */
  promptIdleTimeoutMs?: number;
}

export interface AcpTurnResult {
  sessionId?: string;
  /** Current cumulative counters to persist beside `sessionId`. */
  usageSnapshot?: HarnessUsageSnapshot;
  /** A fresh session consumed the canonical ledger handoff. */
  hydrated?: boolean;
  /** Whether the normal delta or full resume-recovery plan was consumed. */
  hydrationKind?: "handoff" | "recovery";
}
