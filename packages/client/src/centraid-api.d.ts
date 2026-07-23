// governance: allow-repo-hygiene file-size-limit ipc-types-bridge pending split into per-feature type modules
/**
 * Renderer-side typings for the IPC bridge exposed by `preload.ts` under
 * `window.CentraidApi`. The shapes here mirror the public types of
 * `@centraid/agent-harness` — kept independent so the renderer doesn't pull
 * the harness as a build-time dependency.
 */

export interface CentraidAppInfo {
  id: string;
  dir: string;
  built: boolean;
  modifiedAt: string;
  /** Name from the app's `app.json`, falling back to the id if missing. */
  name?: string;
  /** One-line description from `app.json#description`, if present. */
  description?: string;
  /**
   * App classification from `app.json#kind`: `'automation'` marks a UI-less
   * automation app (shown on the Automations surface, hidden from My apps);
   * `'app'` / undefined a normal UI app. Replaces the legacy `auto.`
   * id-prefix convention as the automation signal.
   */
  kind?: 'app' | 'automation';
  /** Whether the app root has an `index.html` (preview-ready). */
  hasIndex?: boolean;
}

export interface CentraidPublishResult {
  id: string;
  versionId: string;
  declaredVersion?: string;
  sha256: string;
  files: number;
  bytes: number;
  activated: boolean;
  /** Migration ids the gateway applied during this publish. */
  migrationsApplied: number[];
}

export interface CentraidSettings {
  /**
   * Active gateway id — `'local'` (always present) or a UUID for a
   * remote gateway. Switching this is the multi-gateway "log in to
   * another workspace" action (issue #109). Use `setActiveGateway`
   * on the API rather than patching this through `saveSettings`.
   */
  activeGatewayId: string;
  /** Kind of the active gateway. */
  activeGatewayKind: 'local' | 'remote';
  /** User-facing label for the active gateway (shown in the switcher). */
  activeGatewayLabel: string;
  /**
   * Friendly display name for the active profile (issue #113). Always
   * populated — falls back to `activeGatewayLabel` when the profile hasn't
   * set an explicit `displayName`.
   */
  activeProfileDisplayName: string;
  /**
   * Avatar color for the active profile as `#RRGGBB` (issue #113). Always
   * populated — defaults to a deterministic palette pick keyed by the
   * gateway id.
   */
  activeProfileAvatarColor: string;
  /**
   * Effective base URL for the active gateway. Local = the in-process
   * runtime's URL; remote = the active gateway's `profile.url`. Read-only.
   */
  gatewayUrl: string;
  /** Effective bearer token; companion to `gatewayUrl`. Read-only. */
  gatewayToken?: string;
  /**
   * The vault this client addresses on the active gateway (issue #289),
   * or absent to let the gateway pick. Client-owned, keyed by gateway;
   * flip it with `setActiveVault`, not `saveSettings`. Read-only here.
   */
  activeVaultId?: string;
  /**
   * ISO timestamp the user finished first-run onboarding. Absent on a
   * fresh install — the renderer gates on this to show the welcome /
   * profile-setup view before mounting home.
   */
  onboardingCompletedAt?: string;
  /**
   * Gateway down-alert threshold in seconds — the monitor notifies once
   * the active gateway has been continuously unreachable this long.
   * Absent → the 2-minute default. Clamped main-side to [15, 3600].
   */
  gatewayAlertSeconds?: number;
  /** Master switch for the gateway down alert. Absent → enabled. */
  gatewayAlertsEnabled?: boolean;
  /**
   * Changelog version the "What's new" modal last auto-opened for. The shell
   * auto-opens once whenever the running build's version differs from this,
   * then writes the new version back via `saveSettings`. Absent → never seen.
   */
  changelogSeenVersion?: string;
  /**
   * Launch Centraid automatically at OS login (issue #351) — the cheap 80%
   * fix for "always-on" given the desktop-hosted gateway dies when the app
   * quits and there's deliberately no OS scheduler. Applied to the OS
   * immediately on save via `app.setLoginItemSettings`; no-op on Linux.
   * Absent → disabled (opt-in).
   */
  launchAtLogin?: boolean;
  /**
   * H5 — OS service install for the detached gateway. Absent = not asked yet
   * (onboarding will offer). Explicit false = declined; true = opted in.
   */
  offerGatewayService?: boolean;
  /**
   * DEV FLAG (issue #434, Phase 3) — reveal the in-app builder and every
   * surface that reaches it: the Home composer, "Build new", the ⌘K "Build a
   * new app…" row, draft apps + their menus, "Edit with Centraid", and the
   * `builder` / `automation-builder` routes. The builder is hidden from the
   * first release — apps are installed from Discover, not authored here — but
   * the machinery stays fully wired (the builder is also the headless
   * automations compiler), so this only gates UI reachability. There is no
   * settings-screen toggle for v1: hand-edit the settings JSON (set
   * `"builderEnabled": true`) and relaunch. Absent → disabled.
   */
  builderEnabled?: boolean;
}

/** A single published release shown in the "What's new" modal. */
export interface CentraidChangelogRelease {
  /** Release tag (e.g. `v0.2.0`) — stable identity + the version chip. */
  version: string;
  /** Human title (GitHub release `name`), falling back to the tag. */
  title: string;
  /** Raw release notes (GitHub-flavored markdown), rendered md-lite client-side. */
  notes: string;
  /** ISO 8601 publish timestamp, or `null` if GitHub omitted it. */
  publishedAt: string | null;
  /** Canonical GitHub URL for the release. */
  url: string;
  /** Pre-release flag — the modal tags these as not-yet-stable. */
  prerelease: boolean;
}

/** The changelog read: running build version + the release list. */
export interface CentraidChangelogResult {
  /** Version of the running build — the auto-open version gate reads this. */
  currentVersion: string;
  /** Published releases, newest-first. Empty when none (or on a cold error). */
  releases: CentraidChangelogRelease[];
  /** Present only when the fetch failed AND nothing was cached to serve. */
  error?: string;
}

/** One heartbeat probe in the runtime sample strip. */
export interface CentraidGatewaySample {
  at: number;
  ok: boolean;
  latencyMs?: number;
}

/** One continuous stretch of failed heartbeats. Open-ended while ongoing. */
export interface CentraidGatewayOutage {
  startedAt: number;
  endedAt?: number;
  /** Set when the OS down-alert fired for this outage. */
  alertedAt?: number;
  recoveredNoticeAt?: number;
}

/**
 * One durable alert-history entry (issue #351 wave 4) — persisted under
 * Electron userData (`gateway-monitor.ts` / `gateway-outage-log.ts`), so
 * unlike `CentraidGatewayOutage` above (in-memory, per-launch) this
 * history survives a restart. `previousSession` marks an entry that
 * predates this launch (loaded from disk at boot) vs. one recorded during
 * the current run.
 */
export interface CentraidGatewayAlertHistoryEntry {
  at: number;
  kind: 'down' | 'degraded' | 'component-error' | 'version-skew' | 'recovered';
  /** Component name / error message / version string — kind-dependent. */
  detail?: string;
  /** Downtime length for `recovered`; time-at-error for `component-error`. */
  durationMs?: number;
  previousSession: boolean;
}

/**
 * Snapshot of the main-process gateway runtime watch (gateway-monitor.ts):
 * heartbeat status, per-launch sample strip + outage log, the gateway's own
 * reported uptime, and the effective alert config. Pushed on every poll via
 * `onGatewayRuntime`; `getGatewayRuntime` covers first paint.
 */
export interface CentraidGatewayRuntime {
  gatewayId: string;
  gatewayLabel: string;
  gatewayKind: 'local' | 'remote';
  /** When tracking began (app launch or gateway switch), epoch ms. */
  trackingSince: number;
  status: 'unknown' | 'up' | 'down';
  /** When the current status began. */
  statusSince?: number;
  lastCheckAt?: number;
  latencyMs?: number;
  /** Server-reported process start (gateway clock). */
  gatewayStartedAt?: number;
  /** Server-reported uptime — clock-skew-safe companion. */
  gatewayUptimeMs?: number;
  version?: string;
  schemaEpoch?: number;
  lastError?: string;
  checksTotal: number;
  checksFailed: number;
  samples: CentraidGatewaySample[];
  outages: CentraidGatewayOutage[];
  alert: { enabled: boolean; thresholdSeconds: number };
  pollIntervalMs: number;
  /**
   * Durable alert-history log (issue #351 wave 4) — the persisted
   * counterpart of `outages`, spanning restarts. Newest-last, capped at
   * ~500 entries (`gateway-outage-log-core.ts`'s `OUTAGE_LOG_CAP`).
   */
  alertHistory: CentraidGatewayAlertHistoryEntry[];
  /**
   * Reconciled health signal (issue #351): folds `/centraid/_gateway/health`'s
   * component statuses plus a sustained-high-latency check into one badge —
   * a "listening but hung" gateway reads as `'degraded'`, not `'up'`. Absent
   * until the first probe reaches `/health` (or for a gateway old enough to
   * only answer `/info`); persists at its last value while unreachable, same
   * posture as `version`.
   */
  healthStatus?: 'ok' | 'degraded' | 'error';
  /** Non-'ok' components from the most recent `/health` snapshot. */
  componentIssues?: { component: string; status: string; message?: string }[];
  /** True when recent probe latency has sustained above the degraded-latency threshold (~2s). */
  latencyDegraded?: boolean;
  /**
   * Protocol-handshake verdict (issue #351 wave 2 / #512) — REMOTE only.
   * `skewed: true` means the protocol support window failed — product version
   * strings may differ without setting skewed.
   */
  versionSkew?: {
    skewed: boolean;
    gatewayVersion: string;
    gatewaySchemaEpoch: number;
    gatewayProtocolVersion?: number;
    clientVersion: string;
    clientSchemaEpoch: number;
    clientProtocolVersion?: number;
  };
}

/** Lightweight profile describing one gateway (issue #109, metadata #113). */
export interface CentraidGatewayProfile {
  id: string;
  kind: 'local' | 'remote';
  label: string;
  /**
   * Friendly name for the profile. Read-time defaulted to `label` when not
   * explicitly set, so the field is always populated on receive.
   */
  displayName: string;
  /**
   * Avatar color as `#RRGGBB`. Read-time defaulted to a deterministic
   * palette pick keyed by `id` when not explicitly set, so the field is
   * always populated on receive.
   */
  avatarColor: string;
  /**
   * Transport tier (issue #289): `local` (in-process), `iroh` (EndpointId
   * over the QUIC tunnel), or `direct` (URL + token). Absent on pre-#289
   * profiles — derived from kind + url.
   */
  transport?: 'local' | 'iroh' | 'direct';
  /** Defined for `direct` remote gateways only. */
  url?: string;
  /** The gateway's iroh EndpointId (`iroh` transport) — shown for `devices add`. */
  endpointId?: string;
  /** Explicit pairing consent for durable replica, outbox, and media caches. */
  rememberDevice?: boolean;
  /**
   * SSH admin channel (issue #382) — present once this gateway has been
   * reached over SSH (the ConnectFlow "Over SSH" method, or a prior
   * ssh-routed vault create). Independent of `transport`. Its presence is
   * the "can create a vault here" signal for a remote gateway: the
   * switcher/ConnectFlow derive that capability as `kind === 'local' ||
   * Boolean(ssh)` — a plain `direct`/`iroh` profile with no `ssh` block
   * still refuses vault create/delete (server-side admin act only).
   */
  ssh?: { destination: string; dataDir?: string; remoteCli?: string };
  createdAt: string;
}

/**
 * Result of redeeming a gateway pairing ticket (issue #376). On success, the
 * paired gateway AND the vault it enrolled into are both now active — the
 * renderer should treat this the same as a `setActiveGateway` +
 * `setActiveVault` response and drop gateway/vault-scoped state.
 */
export type CentraidRedeemGatewayPairingResult =
  | { ok: true; gatewayId: string; vaultId: string; vaultName: string }
  | {
      ok: false;
      /** Stable error code — safe to switch on for copy. */
      error: 'invalid_ticket' | 'ticket_expired' | 'invalid_input' | 'unreachable' | 'bad_response';
      /** Human-readable detail, safe to show as-is if there's no copy for `error`. */
      message: string;
    };

/**
 * One vault of a (not-necessarily-active) gateway, from `listGatewayVaults`
 * (issue #376). Mirrors `renderer/gateway-client-vault.ts`'s `VaultListEntry`
 * — same shape, fetched for a gateway the client isn't addressing yet.
 */
export interface CentraidGatewayVaultEntry {
  vaultId: string;
  name: string;
  ownerPartyId?: string;
  color?: string;
  icon?: string;
  blurb?: string;
}

/** Result of `listGatewayVaults` — a preview read, never mutates active state. */
export type CentraidListGatewayVaultsResult =
  | { ok: true; vaults: CentraidGatewayVaultEntry[] }
  | { ok: false; error: 'unreachable' | 'auth_failed' | 'bad_response' };

/**
 * Input to `testGatewayConnection` (issue #382) — the ConnectFlow wizard's
 * "handshake ladder", one shape per connect method. `ssh` and `gateway`
 * never carry a bearer token (ssh auth rides the user's key; `gateway`
 * resolves the already-known profile's own credential).
 */
export type CentraidTestConnectionInput =
  | { kind: 'url'; url: string; token?: string }
  | { kind: 'ticket'; ticket: string }
  | { kind: 'ssh'; destination: string; dataDir?: string }
  | { kind: 'gateway'; gatewayId: string };

/** One step of the connectivity-test "handshake ladder". */
export interface CentraidConnectivityStage {
  id: 'reach' | 'identify' | 'auth' | 'vaults' | 'ssh' | 'cli' | 'daemon' | 'decode';
  label: string;
  status: 'pass' | 'fail' | 'skip';
  /** Human-actionable detail — always present on `fail`, sometimes on `pass`. */
  detail?: string;
}

/**
 * Result of `testGatewayConnection` — never rejects; every failure is a
 * failed stage with a human-actionable `detail`, plus a stable top-level
 * `error` code for the first failure. Stage set (and which of
 * `gateway`/`vaults`/`ticket` gets populated) depends on the input `kind`:
 * `url`/`gateway` run reach→identify→auth→vaults; `ticket` runs decode
 * only; `ssh` runs ssh→cli→daemon→vaults.
 */
export interface CentraidConnectivityReport {
  ok: boolean;
  stages: CentraidConnectivityStage[];
  gateway?: {
    version: string;
    schemaEpoch: number;
    protocolVersion?: number;
    minSupportedProtocol?: number;
    instanceId: string;
    compatible: boolean;
  };
  vaults?: Array<{ vaultId: string; name: string; color?: string; icon?: string }>;
  ticket?: { vaultName: string; expiresAt: string; gatewayEndpointId: string };
  /** Stable code for the FIRST failing stage — absent when `ok`. */
  error?: string;
}

/** Result of `sshConnectGateway` — the ConnectFlow "Over SSH" commit step. */
export type CentraidSshConnectResult =
  | { ok: true; gatewayId: string; vaultId: string; vaultName: string }
  | { ok: false; error: string; message: string };

/**
 * Which coding-agent CLIs are runnable on the GATEWAY host. Probed
 * gateway-side (`<bin> --version`) and read over `GET /centraid/_agents/status`
 * (see `renderer/gateway-client-conversation.ts`). Centraid is agnostic to how each
 * agent authenticates — this reflects CLI presence only. A remote gateway
 * reports its own host's CLIs, not the desktop's.
 */
export interface CentraidAgentStatusEntry {
  /**
   * The runner kind (`codex`, `claude-code`, `gemini`, `qwen`, `acp`). An OPEN
   * string, deliberately: a newer gateway may register kinds this build has
   * never heard of, and they must still parse and render (docs/protocol.md
   * C1a). Compare against `AGENT_RUNNER_KINDS` only to decide whether extra
   * client-side polish (an accent colour) applies — never to filter the list.
   */
  kind: string;
  /** Human label for pickers and cards, supplied by the gateway. */
  label: string;
  /** The CLI is runnable on the gateway host. */
  available: boolean;
  /** `<bin> --version` output when available. */
  version?: string;
  /** Minimum CLI version whose protocol the gateway verified, e.g. `"0.128.0"`. */
  minVersion: string;
  /** Install/setup hint — present only when the CLI is NOT available. */
  hint?: string;
  /** Models this runner can serve, from the gateway catalog (issue #188). */
  models: CentraidRunnerModel[];
  /** Load state of `models` — loading vs ready vs empty. */
  modelsStatus: CentraidSurfaceStatus;
  /** The model this runner defaults to, when its catalog names one. */
  defaultModel?: string;
  /**
   * Live ACP capability strip (vault HTTP MCP, session resume/load, model
   * pin, auth). Present after Settings Refresh probes the agent; absent
   * until then so a cold status poll stays cheap.
   */
  capabilities?: {
    reachable: boolean;
    loadSession: boolean;
    resume: boolean;
    close: boolean;
    additionalDirectories: boolean;
    mcpHttp: boolean;
    mcpSse: boolean;
    modelConfigurable: boolean;
    authRequired: boolean;
    promptImage: boolean;
    reason?: string;
  };
}

export interface CentraidAgentsStatus {
  /** One entry per runner kind the gateway registers. */
  agents: CentraidAgentStatusEntry[];
}

// The renderer-side chat event union is the gateway's native `TurnStreamEvent`
// (see `renderer/gateway-client-conversation.ts`) now that the chat panel streams the
// turn directly — no IPC-translated `CentraidTurnEvent` / model-list shape.

/**
 * One persisted chat session — the session id is also the chat window id.
 * Sessions list RPCs return these sorted by `updatedAt` desc.
 */
export interface CentraidConversationSummary {
  id: string;
  /** App the chat was opened from; `null` for chats started from the shell. */
  originAppId: string | null;
  title: string;
  /** Runner kind that owns `adapterSessionId`. */
  adapterKind: string | null;
  /** Opaque per-runner resume handle. */
  adapterSessionId: string | null;
  /** Number of completed turns. */
  turnCount: number;
  /** Pinned threads sort first in the sidebar (issue #420). */
  pinned: boolean;
  /** Archived threads hide behind a collapsed group and drop out of search. */
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** A conversation search hit: the summary plus a highlighted match snippet. */
export interface CentraidConversationSearchResult extends CentraidConversationSummary {
  /** `snippet()` output — matched terms wrapped in `⟦`/`⟧`, elisions `…`. */
  snippet: string;
}

/** One file attached to a persisted user turn (issue #190 history mirror). */
export interface CentraidConversationHistoryAttachment {
  hash: string;
  mime: string;
  filename?: string;
  sizeBytes: number;
  url?: string;
}

/** Per-turn token/cost usage on a terminal `ai` answer (issue #420, Wave 2). */
export interface CentraidConversationTurnUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  model?: string;
}

/** One prior attempt of a regenerated answer — a sibling in the "<2/2>" pager. */
export interface CentraidConversationHistoryRetryAttempt {
  turnId: string;
  text: string;
  error?: boolean;
  feedback: 'up' | 'down' | null;
  usage?: CentraidConversationTurnUsage;
}

/**
 * Coarse-grained persisted shape per message in a chat session. `fromArchive`
 * marks a message rehydrated from a custody-gated-pruned segment (issue #438
 * wave 3) — read-only cold history the surface renders with a "from the archive"
 * affordance and no feedback/regenerate controls.
 */
export type CentraidConversationHistoryMessage =
  | {
      kind: 'user';
      text: string;
      attachments?: CentraidConversationHistoryAttachment[];
      fromArchive?: boolean;
    }
  | {
      kind: 'ai';
      text: string;
      error?: boolean;
      /** The turn this answer belongs to — the target for feedback/regenerate
       *  (issue #420). Only the terminal answer row of a turn carries it. */
      turnId?: string;
      /** Reader 👍/👎 on this answer, if set. */
      feedback?: 'up' | 'down' | null;
      /** Retry pager: present when the turn has been regenerated; carries every
       *  attempt oldest→newest, with `index`/`count` for the active (latest). */
      retry?: {
        index: number;
        count: number;
        attempts: CentraidConversationHistoryRetryAttempt[];
      };
      /** Token/cost usage for this answer's turn (issue #420, Wave 2). */
      usage?: CentraidConversationTurnUsage;
      /** Rehydrated from a pruned archive segment (issue #438) — read-only. */
      fromArchive?: boolean;
    }
  | {
      kind: 'tool';
      id: string;
      tool: string;
      sql?: string;
      args?: unknown;
      state: 'ok' | 'error';
      result?: unknown;
      errorText?: string;
      fromArchive?: boolean;
    };

export interface CentraidVersionRecord {
  versionId: string;
  sha256: string;
  declaredVersion?: string;
  uploadedAt: string;
  bytes: number;
  files: number;
  current?: boolean;
}

export interface CentraidAppFile {
  path: string;
  content: string;
  size: number;
  language: 'ts' | 'js' | 'html' | 'css' | 'json' | 'md' | 'other';
}

/**
 * App-owned `settings.json` map (`GET`/`PUT /centraid/_apps/:id/settings`,
 * issue #286 phase 2 — the per-app data.sqlite's `__centraid_settings`
 * table became this file). Knob keys are the manifest's camelCase `app*`
 * names (e.g. `appFont`) sent verbatim; the runtime kebab-cases them into
 * `data-app-*` / `--app-*` when baking the served HTML. Runtime-owned
 * keys (`__` prefix) never cross this surface.
 */
export type CentraidAppSettings = Record<string, unknown>;

export type CentraidLogLevel = 'info' | 'warn' | 'error';

/** A single line written by `log.info/warn/error` (or a handler failure). */
export interface CentraidLogEntry {
  ts: number;
  level: CentraidLogLevel;
  msg: string;
  source: 'query' | 'action';
  handler: string;
}

/**
 * A bundled template, as surfaced by the desktop's templates IPC. Mirrors
 * `TemplateMeta` from `@centraid/blueprints` — duplicated here so the
 * renderer typings stay independent of the templates package at build time.
 */
export interface CentraidTemplateMeta {
  id: string;
  name: string;
  desc: string;
  colorKey: string;
  iconKey: string;
  version: string;
  /**
   * 'app' (default — full UI app like Hydrate / Todos) or 'automation'
   * (an app folder marked `app.json#kind: 'automation'`, no UI, surfaced on
   * the Automations gallery). Defaults to 'app' when absent.
   */
  kind?: 'app' | 'automation';
  // ----- automation-only display fields ('automation' kind) -----
  /** Emoji on the gallery card (e.g. '🌤'). */
  emoji?: string;
  /** Gallery section header (e.g. 'Daily rhythm'). */
  category?: string;
  /** Trigger-style glyph picker on the card. */
  triggerKind?: 'cron' | 'webhook';
  /** Human-readable trigger label (e.g. 'Weekdays · 6:00 PM'). */
  triggerLabel?: string;
  /** Integration chip labels (e.g. ['Gmail', 'Slack']). */
  integrations?: readonly string[];
}

/**
 * Minted webhook credential returned by `cloneTemplate` when the cloned
 * automation template ships a `{kind:'webhook',pending:true}` trigger. The
 * plaintext `secret` crosses the IPC boundary exactly once (the manifest
 * persists only the SHA-256 hash) — the renderer shows it to the user.
 */
export interface CentraidMintedWebhook {
  automationId: string;
  ownerApp: string;
  webhookId: string;
  secret: string;
  url: string;
}

/**
 * Result of cloning a template — lays down the app on disk as a draft.
 * Publishing to the gateway is a separate explicit step (see `publish`).
 */
export interface CentraidCloneTemplateResult {
  app: CentraidAppInfo;
  template: CentraidTemplateMeta & { kind: 'app' | 'automation' };
  /** Empty array for app templates and automation templates with no webhook triggers. */
  webhooks: CentraidMintedWebhook[];
}

// The in-process builder agent's persisted-message + event types
// (CentraidContentBlock / CentraidAgentMessage / CentraidAgentEvent) retired
// with the unified chat (issue #141, Phase 3): the builder + the app-view
// data chat now stream the gateway's native `TurnStreamEvent` directly (see
// `renderer/gateway-client-conversation.ts`).

/** A phone paired over the iroh tunnel (issue #263). */
export interface CentraidPhoneDevice {
  deviceId: string;
  name: string;
  platform: string;
  /** Base32 iroh EndpointId — the device's transport identity. */
  endpointId: string;
  addedAt: string;
}

export interface CentraidPhoneLinkStatus {
  running: boolean;
  endpointId?: string;
  error?: string;
  devices: CentraidPhoneDevice[];
}

export interface CentraidPhonePairingInfo {
  payload: string;
  qrDataUrl: string;
  expiresAt: number;
}

interface CentraidApi {
  /** Host capabilities used where browser security differs from Electron. */
  getHostCapabilities?(): Promise<{
    platform: 'desktop' | 'web';
    appSessions: boolean;
    compute?: {
      previews: boolean;
      poster: boolean;
      pdfText: boolean;
      ocr: boolean;
      embedding: boolean;
      transcript: boolean;
      edgeSeal: boolean;
      backgroundTransfer: boolean;
    };
  }>;
  /** Desktop-only device-local file ASR; present only on a host with an adapter seam. */
  transcribeMedia?(input: {
    bytes: ArrayBuffer;
    mediaType: string;
    filename?: string;
  }): Promise<string>;
  getSettings(): Promise<CentraidSettings>;
  saveSettings(patch: Partial<CentraidSettings>): Promise<CentraidSettings>;

  // App list/create/files/write/delete/update-meta + publish moved to the
  // renderer's direct HTTP client (renderer/gateway-client.ts) under the
  // thin-client pivot. The preview iframe points at the gateway draft URL
  // (Phase 4: renderer-side `draftPreviewUrl`), so only the local-only
  // reveal-in-Finder stays on IPC.
  openAppFolder(input: { id: string }): Promise<{ ok: true }>;

  // The in-process AGENT_* builder retired with the unified chat (issue
  // #141, Phase 3): the builder streams `/centraid/<id>/_turn` SSE directly
  // (renderer/gateway-client-conversation.ts), so there are no startAgent /
  // promptAgent / stopAgent / onAgentEvent IPC methods.

  // publish moved to the renderer's direct HTTP client. appLiveUrl /
  // appLogs / deregisterApp / listVersions / activateVersion moved there
  // too (pure git-store reads + the editing-session publish, no main-side
  // state). The appSchema / appTableRows / appQuery trio died with the
  // per-app data.sqlite (issue #286 phase 2); per-app knob values now
  // ride appSettings / appSettingWrite over the app's settings.json.

  /**
   * Snapshot of the auto-publish queue (issue #108). Every workspace
   * mutation triggers a debounced upload to the local gateway; this
   * read surfaces the in-flight flag, the last error string (if any),
   * and the timestamp of the last successful publish.
   */
  getPublishStatus(input: { id: string }): Promise<{
    inFlight: boolean;
    lastError?: string;
    lastPublishedAt?: number;
  }>;
  /**
   * Subscribe to per-app publish events. Fired once per auto-publish
   * resolution (success or failure). Returns the unsubscribe.
   */
  onPublishEvent(
    cb: (msg: { id: string; ok: boolean; error?: string; publishedAt?: number }) => void,
  ): () => void;

  // ----- Gateways (issue #109) -----
  /** List every gateway profile (local + remote). Sorted local-first. */
  listGateways(): Promise<CentraidGatewayProfile[]>;
  /**
   * Register a `direct`-tier remote gateway from a URL + per-device token
   * (the PWA web-host path, issue #505 phase 7). The token is the per-device
   * token minted by the pairing ceremony — NOT a shared admin token (retired).
   * The Electron desktop no longer exposes this bridge: it adds gateways only
   * through the pairing ceremony (`redeemGatewayPairing`), which registers the
   * profile in-process.
   */
  addGateway(input: {
    label: string;
    /**
     * `direct` transport — an https/http URL + per-device token. Plain http://
     * to a public host is refused (issue #289): the bearer would travel in
     * cleartext. Omit when adding an `iroh` gateway.
     */
    url?: string;
    /**
     * `iroh` transport — the gateway's EndpointTicket (EndpointId + relay
     * hint), redeemed from a pairing ticket. Omit for a `direct` gateway.
     */
    endpointTicket?: string;
    endpointId?: string;
    token: string;
    displayName?: string;
    avatarColor?: string;
    rememberDevice?: boolean;
  }): Promise<CentraidGatewayProfile>;
  /**
   * Remove a gateway (connection). Refuses to remove the primordial
   * `'local'` gateway; remote connections can be removed. Returns the
   * new active gateway id (falls back to the primordial `'local'` if
   * the removed gateway was active). (#280 removed additional local
   * workspaces — a second space is a second VAULT.)
   */
  removeGateway(input: { id: string }): Promise<{ activeGatewayId: string }>;
  /** Rename a gateway's user-facing label. Id and paths never change. */
  renameGateway(input: { id: string; label: string }): Promise<CentraidGatewayProfile>;
  /**
   * Patch profile metadata (`displayName` and/or `avatarColor`). Pass empty
   * string for `displayName` to reset to label-derived default; pass the
   * field as `undefined` (omit) to leave it untouched. `avatarColor` must
   * be a `#RRGGBB` string when provided.
   */
  updateProfileMetadata(input: {
    id: string;
    displayName?: string;
    avatarColor?: string;
  }): Promise<CentraidGatewayProfile>;
  /**
   * Rotate a remote gateway's keychain-stored bearer token. The
   * plaintext crosses the bridge exactly once on this call (mirroring
   * `addGateway`) and never returns. Pass an empty string to clear.
   * No-op for the primordial local gateway (its token is minted per
   * launch by the in-process runtime). When the rotated profile is
   * the active one the main process drops its HTTP-client auth caches
   * before resolving so subsequent IPCs see the new token.
   */
  updateGatewayToken(input: { id: string; token: string }): Promise<{ ok: true }>;
  /**
   * Switch the active gateway. The renderer should treat the response
   * as the new authoritative settings and drop gateway-scoped state
   * (app list, agent session, iframe).
   */
  setActiveGateway(input: { id: string }): Promise<CentraidSettings>;
  /**
   * Active gateway's HTTP base URL + bearer token for the renderer's
   * direct data-plane client (`renderer/gateway-client.ts`). The token
   * lives in keychain-backed settings on main; this is the only path it
   * crosses to the renderer. Re-fetched on every gateway switch.
   */
  getGatewayAuth(): Promise<{
    baseUrl: string;
    /** Stable gateway/profile identity, independent of its current transport URL. */
    gatewayId?: string;
    token?: string;
    vaultId?: string;
    /** Web-only browser control session. */
    webControl?: boolean;
    /** Web-only Iroh/WASM data plane. */
    iroh?: boolean;
    /** Explicit pairing consent for durable replica, outbox, and cache state. */
    rememberDevice?: boolean;
  }>;
  /**
   * Redeem a pairing ticket minted by `centraid-gateway pair --vault <name>`
   * (issue #376). Default `mode: 'auto'` picks the `http` transport when
   * `url` is set, else `iroh`. On success the paired gateway AND the vault
   * it enrolled into are both active — treat the result like a combined
   * `setActiveGateway` + `setActiveVault` and drop gateway/vault-scoped
   * state; the same `onGatewayChanged` / `onVaultChanged` broadcasts fire.
   * Never rejects — failures come back as `{ok:false, error, message}`.
   */
  redeemGatewayPairing(input: {
    /** The pasted/scanned one-line pairing token. */
    ticket: string;
    /** Optional profile label; falls back to the gateway/vault's own name. */
    label?: string;
    mode?: 'auto' | 'iroh' | 'http';
    /** Required for (and only meaningful with) the `http` transport. */
    url?: string;
    /** Explicit consent for a durable replica, outbox, and preview cache. */
    rememberDevice?: boolean;
  }): Promise<CentraidRedeemGatewayPairingResult>;
  /**
   * Read a gateway's vault list WITHOUT switching to it (issue #376) — the
   * flat (gateway, vault) switcher's preview. `~3s` timeout; a resolvable
   * but unauthenticated/unreachable gateway comes back `ok:false`, never a
   * rejection.
   */
  listGatewayVaults(input: { gatewayId: string }): Promise<CentraidListGatewayVaultsResult>;
  /**
   * ConnectFlow "handshake ladder" (issue #382): stage-by-stage
   * connectivity check for a method the user just supplied coordinates
   * for, OR an already-known gateway (`kind:'gateway'`). Never rejects.
   */
  testGatewayConnection(input: CentraidTestConnectionInput): Promise<CentraidConnectivityReport>;
  /**
   * ConnectFlow "Over SSH" commit step (issue #382): (optionally) create a
   * vault on the remote box, mint a pairing ticket over ssh, and redeem it
   * locally — same atomic "enroll + activate" `redeemGatewayPairing`
   * always runs, so treat success like a combined `setActiveGateway` +
   * `setActiveVault` and drop gateway/vault-scoped state; the same
   * `onGatewayChanged`/`onVaultChanged` broadcasts fire. Never rejects.
   */
  sshConnectGateway(input: {
    destination: string;
    dataDir?: string;
    label?: string;
    rememberDevice?: boolean;
    vault: { kind: 'existing'; vaultId: string } | { kind: 'create'; name: string };
  }): Promise<CentraidSshConnectResult>;
  /**
   * Latest gateway-runtime snapshot from the main-process heartbeat
   * monitor. Resolves immediately from the last poll (≤5s old); the first
   * call after launch may run a probe.
   */
  getGatewayRuntime(): Promise<CentraidGatewayRuntime>;
  /**
   * Subscribe to per-poll runtime snapshots (every ~5s, plus immediately
   * after settings writes and gateway switches). Returns the unsubscribe.
   */
  onGatewayRuntime(cb: (snapshot: CentraidGatewayRuntime) => void): () => void;
  /**
   * Restart the local embedded gateway (issue #351): graceful stop (WAL
   * checkpoint + close) then relaunch. Refused for remote gateways —
   * `ok: false` with an explanatory error.
   */
  restartGateway(): Promise<{ ok: boolean; error?: string }>;
  /**
   * Fetch `/centraid/_gateway/diagnostics` from the active gateway and save
   * it through a native save dialog (issue #351). `canceled` when the user
   * dismissed the dialog.
   */
  exportGatewayDiagnostics(): Promise<
    { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
  >;
  /** Export the live backup keyring + target map through a native 0600 file save. */
  exportGatewayRecoveryKit(): Promise<
    { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
  >;
  /**
   * Switch the vault this client addresses on the active gateway (issue
   * #289). A pure client-side pointer flip — no server call, no re-root:
   * subsequent requests carry a different `x-centraid-vault` header. Pass
   * `undefined` to clear (let the gateway pick). The renderer keeps its
   * per-(gateway,vault) state and re-renders on `onVaultChanged`.
   */
  setActiveVault(input: { vaultId?: string }): Promise<CentraidSettings>;
  /**
   * Create a vault on the active gateway (issue #289). Admin act: works for
   * the desktop's own LOCAL gateway (the desktop is its landlord); rejects
   * for a remote gateway (its vault lifecycle is the server CLI over SSH).
   * The new vault does NOT become active implicitly — call `setActiveVault`.
   */
  createVault(input: { name?: string }): Promise<{ vaultId: string }>;
  /**
   * Delete a vault on the active LOCAL gateway (issue #289). Rejects for a
   * remote gateway. Clears the client's active-vault pointer first if it
   * names the vault being deleted.
   */
  deleteVault(input: { vaultId: string }): Promise<{ deleted: true }>;
  /**
   * Notify-only (issue #382 follow-up): call after a metadata-only
   * `updateVault()` HTTP call succeeds (rename/retheme) so every window's
   * `onVaultMetadataChanged` listeners re-read immediately — metadata edits
   * ride a direct HTTP call, not IPC, so unlike create/switch/delete they
   * never otherwise broadcast anything. Deliberately separate from
   * `onVaultChanged`/`VAULT_CHANGED`: that channel means "the ADDRESSED
   * vault changed" and drives a navigate-Home + full re-scope, which is
   * wrong for a same-vault rename.
   */
  notifyVaultMetadataChanged(): Promise<void>;
  // ----- Phone link (issue #263) -----
  /** Tunnel status + the paired-device allowlist. */
  getPhoneLinkStatus(): Promise<CentraidPhoneLinkStatus>;
  /** Mint a fresh one-time pairing code; returns the QR as a data URL. */
  beginPhonePairing(): Promise<CentraidPhonePairingInfo>;
  cancelPhonePairing(): Promise<{ ok: true }>;
  /** Revoke a paired phone — drops its live connections at the transport. */
  revokePhoneDevice(input: { deviceId: string }): Promise<{ removed: boolean }>;
  /** Subscribe to pairing completions. Returns the unsubscribe. */
  onPhonePaired(cb: (msg: { device: CentraidPhoneDevice }) => void): () => void;

  // ----- Relaunch to update -----
  /**
   * Snapshot of the dist watcher: whether a newer build than the running
   * one is on disk, and the version a relaunch would load. Optional so
   * test harnesses can mock a partial bridge.
   */
  getUpdateStatus?(): Promise<{
    available: boolean;
    version: string;
    /** Packaged: true only after download finished (#501). */
    readyToInstall?: boolean;
  }>;
  /** Manual "check for updates" (I6 — always admits when a feed candidate exists). */
  checkForUpdates?(): Promise<{
    available: boolean;
    version: string;
    readyToInstall?: boolean;
  }>;
  /** Restart the app so it loads the new build (app.relaunch + exit). */
  relaunchToUpdate?(): Promise<{ ok: true }>;
  /** Subscribe to "a new build landed on disk". Returns the unsubscribe. */
  onUpdateAvailable?(
    cb: (msg: { available: boolean; version: string; readyToInstall?: boolean }) => void,
  ): () => void;
  /**
   * H5 — opt-in OS service install for the detached local gateway
   * (`centraid-gateway service install`). Never silent; onboarding offers it.
   */
  installGatewayService?(): Promise<{ ok: true } | { ok: false; error: string }>;

  // ----- "What's new" changelog -----
  /**
   * Fetch the project's GitHub release notes (main-side, cached) plus the
   * running build version. Optional so test harnesses can mock a partial
   * bridge (the modal shows an error/empty state when it's absent).
   */
  getChangelog?(): Promise<CentraidChangelogResult>;

  /**
   * Subscribe to active-gateway changes (any cause — add/remove/rename
   * of the active one, or explicit switch). Returns the unsubscribe.
   */
  onGatewayChanged(
    cb: (msg: {
      activeGatewayId: string;
      activeGatewayKind: 'local' | 'remote';
      activeGatewayLabel: string;
      activeProfileDisplayName: string;
      activeProfileAvatarColor: string;
      /** Stable identity used by replica storage (web may differ from activeGatewayId). */
      gatewayId?: string;
      /** Present when an inactive or active profile was removed. */
      removedGatewayId?: string;
      /** Present when durable replica consent was explicitly withdrawn. */
      purgeReplicaGatewayId?: string;
    }) => void,
  ): () => void;

  /**
   * Subscribe to vault-address changes on the active gateway (issue #289).
   * Fires on `setActiveVault`; the renderer re-reads its gateway auth (new
   * vault header) and re-renders the vault's world WITHOUT the wholesale
   * wipe a gateway switch triggers. Returns the unsubscribe.
   */
  onVaultChanged(
    cb: (msg: { activeGatewayId: string; gatewayId?: string; activeVaultId?: string }) => void,
  ): () => void;

  /**
   * Subscribe to vault METADATA changes (name/color/icon/blurb) on the
   * active vault (issue #382 follow-up). Fires from
   * `notifyVaultMetadataChanged()`, not from any addressing change — the
   * addressed (gateway, vault) is unchanged, so unlike `onVaultChanged`
   * this must NOT trigger a navigate-Home/full re-scope. Returns the
   * unsubscribe.
   */
  onVaultMetadataChanged(cb: () => void): () => void;

  // listTemplates + cloneTemplate moved to the renderer's direct HTTP client
  // (renderer/gateway-client.ts) under the thin-client pivot — the gateway
  // owns the catalog (`GET /centraid/_templates`) + clone orchestration
  // (`POST /centraid/_apps/_clone`).

  // App chat (turn streaming + history) moved to the renderer's direct HTTP
  // client (`renderer/gateway-client-conversation.ts`) under the unified-chat pivot
  // (issue #141, Phase 3): the panel streams `/centraid/<appId>/_turn` SSE
  // itself and reads/writes history over `/_centraid-conversations` — no IPC.

  // Coding-agent detection moved to the gateway (`GET /centraid/_agents/status`,
  // read via `renderer/gateway-client-conversation.ts`): the gateway is colocated with
  // the runner, so it probes its own host. No IPC, no desktop-side probing.

  // getUserId / getUserPrefs / saveUserPrefs moved to the renderer's direct
  // HTTP client (renderer/gateway-client.ts) under the thin-client pivot —
  // pure `/_centraid-user` reads/writes. The main-side preflight-cache drop
  // that rode `saveUserPrefs` is no longer needed (the cache keys on the
  // runner prefs that matter, and the runner-status read force-invalidates).

  // Automations (issue #98). Every automation lives inside an app
  // folder under `appsDir`; these read/write that app tree and the
  // unified run ledger. An `automationId` argument is the automation's
  // `<appId>/<id>` handle (the `ref` field of `CentraidAutomationRow`).
  //
  // The full automation surface — create/enable/delete mutators AND the
  // read/run/analytics surface (listAutomations / readAutomation /
  // runAutomationNow / listAutomationRuns / readAutomationRun /
  // listAutomationRunNodes / pinAutomationRun / getInsightsSummary) — moved
  // to the renderer's direct HTTP client (renderer/gateway-client.ts) under
  // the thin-client pivot: the gateway owns scaffold + webhook mint + stage +
  // publish (`POST /centraid/_automations`, `…/set-enabled`, `DELETE …`).
}

/** KPI tiles for the Insights screen (issue #514). */
export interface CentraidInsightsKpis {
  totalTokens: number;
  /** Known spend floor when unpriced/unreported runs exist. */
  totalCostUsd: number;
  agentReportedCostUsd: number;
  estimatedCostUsd: number;
  forecastCostUsd: number;
  generations: number;
  retries: number;
  failedRuns: number;
  failedCostUsd: number;
  appsTouched: number;
  unpricedRuns: number;
  unreportedRuns: number;
}

/** One day of the consumption chart. `date` is `YYYY-MM-DD` (UTC). */
export interface CentraidInsightsDailyPoint {
  date: string;
  tokens: number;
  costUsd: number;
  runs: number;
}

/** One row of the "by source" breakdown. Chat / build collapse to kind keys. */
export interface CentraidInsightsSourceRow {
  key: string;
  label: string;
  kind: 'automation' | 'chat' | 'build' | string;
  runs: number;
  tokens: number;
  costUsd: number;
  automationName?: string;
}

/** @deprecated Prefer CentraidInsightsSourceRow (#514). */
export type CentraidInsightsAutomationRow = CentraidInsightsSourceRow;

export interface CentraidInsightsRunnerRow {
  provider: string;
  runs: number;
  tokens: number;
  costUsd: number;
}

/** One row of the "by model" breakdown. */
export interface CentraidInsightsModelRow {
  model: string;
  runs: number;
  tokens: number;
  costUsd: number;
}

/** One entry of the recent-activity feed. */
export interface CentraidInsightsActivityRow {
  runId: string;
  kind: 'automation' | 'chat' | 'build' | string;
  label: string;
  automationRef?: string;
  automationName?: string;
  ok: boolean;
  startedAt: number;
  tokens: number;
  costUsd: number;
  provider?: string;
  model?: string;
}

export interface CentraidInsightsPeakDay {
  date: string;
  tokens: number;
  costUsd: number;
  topSources: Array<{
    key: string;
    label: string;
    kind: string;
    tokens: number;
    costUsd: number;
  }>;
}

export interface CentraidInsightsAttention {
  kind: 'top_source';
  key: string;
  label: string;
  kindLabel: string;
  share: number;
  costUsd: number;
}

/** Full payload for the Insights screen. */
export interface CentraidInsightsSummary {
  windowDays: number;
  generatedAt: number;
  kpis: CentraidInsightsKpis;
  daily: CentraidInsightsDailyPoint[];
  bySource: CentraidInsightsSourceRow[];
  byRunner: CentraidInsightsRunnerRow[];
  byModel: CentraidInsightsModelRow[];
  recent: CentraidInsightsActivityRow[];
  peakDay?: CentraidInsightsPeakDay;
  attention?: CentraidInsightsAttention;
}

/** A single run record from the unified `runs` ledger. */
export interface CentraidAutomationRunRecord {
  runId: string;
  kind: 'automation' | 'chat' | 'build';
  /** Set for `kind: 'automation'` — the automation app id. */
  automationId?: string;
  /** The automation's last-known display name, recorded on the run itself —
   *  survives the automation being deleted (falls back to `automationId`). */
  automationName?: string;
  triggerKind: 'scheduled' | 'manual' | 'replay' | 'on_failure' | 'compile' | 'interactive';
  /** Source that fired the run (`cron` / `webhook` / `data` / `condition` / `manual`). */
  triggerOrigin?: 'cron' | 'webhook' | 'data' | 'condition' | 'manual';
  parentRunId?: string;
  inputJson?: string;
  startedAt: number;
  endedAt?: number;
  ok: boolean;
  error?: string;
  summary?: string;
  outputJson?: string;
  /** True when the run is pinned as a replay fixture. */
  pinned: boolean;
  /** Denormalized token / cost rollup, written at finish. */
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCacheReadTokens?: number;
  totalCacheWriteTokens?: number;
  totalCostUsd?: number;
  stepCount?: number;
  toolCount?: number;
}

/** A single node (step / tool / agent / invoke) inside a run. */
export interface CentraidAutomationRunNode {
  nodeId: string;
  runId: string;
  ordinal: number;
  batchId?: number;
  kind: 'step' | 'tool' | 'agent' | 'invoke';
  /** Tool / invoke target. Absent for `kind: 'step'`. */
  name?: string;
  argsJson?: string;
  outputJson?: string;
  ok: boolean;
  error?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** `step` / `agent` — the model + provider that served the call. */
  model?: string;
  provider?: string;
  /** Frozen at write time; NULL = no price known. */
  costUsd?: number;
  /** For `kind: 'invoke'` — the run id of the child run it spawned. */
  childRunId?: string;
}

/** The `automation.json` app manifest. Mirrors app-engine. */
export interface CentraidAutomationManifest {
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  prompt: string;
  triggers: Array<
    | { kind: 'cron'; expr: string }
    | { kind: 'webhook'; id?: string; secretHash?: string; pending?: true }
    | { kind: 'data'; entities: readonly string[]; every?: string }
    | { kind: 'condition'; entity: string; where?: unknown; every?: string }
  >;
  requires: { mcps?: readonly string[]; model?: string };
  /** App ids this automation is associated with. */
  apps?: readonly string[];
  costEstimate?: { model: string; tokensPerFire: number };
  onFailure?: string;
  history: { keep: { count: number } | { days: number } | 'all' | 'errors' };
  generated: { by: string; at: string };
}

/** Row shape returned by `listAutomations`. Mirrors `AutomationRow` from app-engine. */
export interface CentraidAutomationRow {
  /** Automation id — the directory slug, unique within its owning app. */
  id: string;
  /** Absolute path to the automation app directory. */
  dir: string;
  name: string;
  triggers: Array<
    | { kind: 'cron'; expr: string }
    | { kind: 'webhook'; id?: string; secretHash?: string; pending?: true }
    | { kind: 'data'; entities: readonly string[]; every?: string }
    | { kind: 'condition'; entity: string; where?: unknown; every?: string }
  >;
  enabled: boolean;
  /** Id of the app folder this automation belongs to. */
  ownerApp: string;
  /** Globally-unique handle — `<ownerApp>/<id>`. Pass this as `automationId`. */
  ref: string;
  manifest: CentraidAutomationManifest;
}

/**
 * Result of `runAutomationNow`. The fire runs in the background; the
 * `runId` lets the caller open the run viewer and poll for progress.
 */
export interface CentraidAutomationRunResult {
  runId: string;
}

/**
 * A webhook the builder minted while provisioning a pending trigger
 * the agent authored. The `secret` is the plaintext shared secret —
 * surfaced to the user once and never persisted (`automation.json`
 * keeps only its SHA-256 hash).
 */
export interface CentraidMintedWebhook {
  /** Id of the automation that owns the webhook trigger. */
  automationId: string;
  /** Id of the app folder that owns the automation. */
  ownerApp: string;
  /** Minted route slug — the path segment under `/_centraid-hook/`. */
  webhookId: string;
  /** Full gateway URL callers POST to. */
  url: string;
  /** Plaintext shared secret — shown once, never stored. */
  secret: string;
}

/** One model a runtime can serve. */
export interface CentraidRunnerModel {
  id: string;
  name?: string;
  default?: boolean;
  /** Capability tier for grouping concrete models in the picker. */
  tier?: 'smart' | 'balanced' | 'fast';
}

/**
 * Load state of a catalog surface (models / tools): `loading` while the gateway
 * enumerates, `ready` once cached, `empty` when nothing was found / the CLI is
 * unavailable. The picker shows a loading placeholder and polls while `loading`.
 */
export type CentraidSurfaceStatus = 'loading' | 'ready' | 'empty';

// The per-agent host-tool listing (`CentraidHostTool`) retired with the
// Settings → Agents tools drawer — Connections is where the user reasons about
// what an agent can reach. Host tools are still enumerated gateway-side; they
// just feed the builder's grounding block now, never a client surface.

/** Preflight snapshot returned by `getRunnerStatus`. */
export interface CentraidRunnerStatus {
  /**
   * The configured runner kind, or `'none'` when none is. Open string for the
   * same reason as `CentraidAgentStatusEntry.kind` — a newer gateway can name
   * a kind this build doesn't know, and the status must still parse.
   */
  kind: string;
  ok: boolean;
  version?: string;
  minVersion?: string;
  versionAtLeast?: boolean;
  reason?: string;
  hint?: string;
  /** Models the active runner can serve, from the gateway catalog. */
  models?: CentraidRunnerModel[];
  /** Load state of `models` — lets the composer picker show loading vs empty. */
  modelsStatus?: CentraidSurfaceStatus;
}

/** One subsystem's health in `GET /centraid/_gateway/health`. */
export interface CentraidHealthComponent {
  component: string;
  status: 'ok' | 'degraded' | 'error';
  detail?: string;
  lastOkAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  errorCount: number;
}

/** One structured warn/error event from the gateway's recent-events tail. */
export interface CentraidHealthEvent {
  at: string;
  component: string;
  level: 'warn' | 'error';
  message: string;
}

/** Coarse numeric signals on `GET /centraid/_gateway/health` (issue #521). */
export interface CentraidHealthMetrics {
  rssBytes: number;
  outboxPending: number;
  sseClients?: number;
  eventLoopLagP50Ms?: number;
  eventLoopLagP99Ms?: number;
  eventLoopLagMaxMs?: number;
  eventLoopLagPeakP99Ms?: number;
  eventLoopLagSamples?: number;
  storageFsyncMs?: number;
  hardwareProfileClass?: string;
  resourceMode?: string;
  uptimeMs: number;
}

/** Aggregate payload of `GET /centraid/_gateway/health`. */
export interface CentraidGatewayHealth {
  status: 'ok' | 'degraded' | 'error';
  startedAt: string;
  uptimeMs: number;
  components: CentraidHealthComponent[];
  recentEvents: CentraidHealthEvent[];
  metrics?: CentraidHealthMetrics;
}

declare global {
  interface Window {
    CentraidApi: CentraidApi;
  }

  // Renderer scripts are IIFE-style (no imports) and reference these types
  // by bare name. The interfaces below mirror the module exports above so
  // the call sites stay tidy without `Awaited<ReturnType<…>>` boilerplate.
  interface CentraidVersionRecord {
    versionId: string;
    sha256: string;
    declaredVersion?: string;
    uploadedAt: string;
    bytes: number;
    files: number;
    current?: boolean;
  }
  type CentraidAppSettings = Record<string, unknown>;
  type CentraidLogLevel = 'info' | 'warn' | 'error';
  interface CentraidLogEntry {
    ts: number;
    level: CentraidLogLevel;
    msg: string;
    source: 'query' | 'action';
    handler: string;
  }
  interface CentraidConversationSummary {
    id: string;
    originAppId: string | null;
    title: string;
    adapterKind: string | null;
    adapterSessionId: string | null;
    turnCount: number;
    pinned: boolean;
    archived: boolean;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
  }
  interface CentraidConversationSearchResult extends CentraidConversationSummary {
    snippet: string;
  }
  interface CentraidConversationHistoryAttachment {
    hash: string;
    mime: string;
    filename?: string;
    sizeBytes: number;
    url?: string;
  }
  interface CentraidConversationTurnUsage {
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    model?: string;
  }
  interface CentraidConversationHistoryRetryAttempt {
    turnId: string;
    text: string;
    error?: boolean;
    feedback: 'up' | 'down' | null;
    usage?: CentraidConversationTurnUsage;
  }
  type CentraidConversationHistoryMessage =
    | {
        kind: 'user';
        text: string;
        attachments?: CentraidConversationHistoryAttachment[];
        fromArchive?: boolean;
      }
    | {
        kind: 'ai';
        text: string;
        error?: boolean;
        turnId?: string;
        feedback?: 'up' | 'down' | null;
        retry?: {
          index: number;
          count: number;
          attempts: CentraidConversationHistoryRetryAttempt[];
        };
        usage?: CentraidConversationTurnUsage;
        fromArchive?: boolean;
      }
    | {
        kind: 'tool';
        id: string;
        tool: string;
        sql?: string;
        args?: unknown;
        state: 'ok' | 'error';
        result?: unknown;
        errorText?: string;
        fromArchive?: boolean;
      };
  // Mirror of the module-level automation types so screens can
  // reference them by bare name without imports (issue #91).
  interface CentraidAutomationManifest {
    name: string;
    version: string;
    description?: string;
    enabled: boolean;
    prompt: string;
    triggers: Array<
      | { kind: 'cron'; expr: string }
      | { kind: 'webhook'; id?: string; secretHash?: string; pending?: true }
      | { kind: 'data'; entities: readonly string[]; every?: string }
      | { kind: 'condition'; entity: string; where?: unknown; every?: string }
    >;
    requires: { mcps?: readonly string[]; model?: string };
    apps?: readonly string[];
    costEstimate?: { model: string; tokensPerFire: number };
    onFailure?: string;
    history: { keep: { count: number } | { days: number } | 'all' | 'errors' };
    generated: { by: string; at: string };
  }
  interface CentraidAutomationRow {
    id: string;
    dir: string;
    name: string;
    triggers: Array<
      | { kind: 'cron'; expr: string }
      | { kind: 'webhook'; id?: string; secretHash?: string; pending?: true }
      | { kind: 'data'; entities: readonly string[]; every?: string }
      | { kind: 'condition'; entity: string; where?: unknown; every?: string }
    >;
    enabled: boolean;
    ownerApp: string;
    ref: string;
    manifest: CentraidAutomationManifest;
  }
  interface CentraidAutomationRunResult {
    runId: string;
  }
  interface CentraidMintedWebhook {
    automationId: string;
    ownerApp: string;
    webhookId: string;
    url: string;
    secret: string;
  }
  interface CentraidAutomationRunRecord {
    runId: string;
    kind: 'automation' | 'chat' | 'build';
    automationId?: string;
    automationName?: string;
    triggerKind: 'scheduled' | 'manual' | 'replay' | 'on_failure' | 'compile' | 'interactive';
    triggerOrigin?: 'cron' | 'webhook' | 'data' | 'condition' | 'manual';
    parentRunId?: string;
    inputJson?: string;
    startedAt: number;
    endedAt?: number;
    ok: boolean;
    error?: string;
    summary?: string;
    outputJson?: string;
    pinned: boolean;
    totalInputTokens?: number;
    totalOutputTokens?: number;
    totalCacheReadTokens?: number;
    totalCacheWriteTokens?: number;
    totalCostUsd?: number;
    stepCount?: number;
    toolCount?: number;
  }
  interface CentraidAutomationRunNode {
    nodeId: string;
    runId: string;
    ordinal: number;
    batchId?: number;
    kind: 'step' | 'tool' | 'agent' | 'invoke';
    name?: string;
    argsJson?: string;
    outputJson?: string;
    ok: boolean;
    error?: string;
    startedAt: number;
    endedAt?: number;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    model?: string;
    provider?: string;
    costUsd?: number;
    childRunId?: string;
  }
  // Mirror of the module-level Insights types (issue #514).
  interface CentraidInsightsKpis {
    totalTokens: number;
    totalCostUsd: number;
    agentReportedCostUsd: number;
    estimatedCostUsd: number;
    forecastCostUsd: number;
    generations: number;
    retries: number;
    failedRuns: number;
    failedCostUsd: number;
    appsTouched: number;
    unpricedRuns: number;
    unreportedRuns: number;
  }
  interface CentraidInsightsDailyPoint {
    date: string;
    tokens: number;
    costUsd: number;
    runs: number;
  }
  interface CentraidInsightsSourceRow {
    key: string;
    label: string;
    kind: string;
    runs: number;
    tokens: number;
    costUsd: number;
    automationName?: string;
  }
  type CentraidInsightsAutomationRow = CentraidInsightsSourceRow;
  interface CentraidInsightsRunnerRow {
    provider: string;
    runs: number;
    tokens: number;
    costUsd: number;
  }
  interface CentraidInsightsModelRow {
    model: string;
    runs: number;
    tokens: number;
    costUsd: number;
  }
  interface CentraidInsightsActivityRow {
    runId: string;
    kind: string;
    label: string;
    automationRef?: string;
    automationName?: string;
    ok: boolean;
    startedAt: number;
    tokens: number;
    costUsd: number;
    provider?: string;
    model?: string;
  }
  interface CentraidInsightsPeakDay {
    date: string;
    tokens: number;
    costUsd: number;
    topSources: Array<{
      key: string;
      label: string;
      kind: string;
      tokens: number;
      costUsd: number;
    }>;
  }
  interface CentraidInsightsAttention {
    kind: 'top_source';
    key: string;
    label: string;
    kindLabel: string;
    share: number;
    costUsd: number;
  }
  interface CentraidInsightsSummary {
    windowDays: number;
    generatedAt: number;
    kpis: CentraidInsightsKpis;
    daily: CentraidInsightsDailyPoint[];
    bySource: CentraidInsightsSourceRow[];
    byRunner: CentraidInsightsRunnerRow[];
    byModel: CentraidInsightsModelRow[];
    recent: CentraidInsightsActivityRow[];
    peakDay?: CentraidInsightsPeakDay;
    attention?: CentraidInsightsAttention;
  }
  interface CentraidHealthComponent {
    component: string;
    status: 'ok' | 'degraded' | 'error';
    detail?: string;
    lastOkAt?: string;
    lastErrorAt?: string;
    lastError?: string;
    errorCount: number;
  }
  interface CentraidHealthEvent {
    at: string;
    component: string;
    level: 'warn' | 'error';
    message: string;
  }
  interface CentraidGatewayHealth {
    status: 'ok' | 'degraded' | 'error';
    startedAt: string;
    uptimeMs: number;
    components: CentraidHealthComponent[];
    recentEvents: CentraidHealthEvent[];
  }
}
