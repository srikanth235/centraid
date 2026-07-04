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
   * Per-runner chat-model selection for the app-view agentic chat, keyed by
   * runner kind (`'codex'` | `'claude-code'` | …). The model is scoped to its
   * runner so switching agents never leaves a foreign id selected; a missing
   * key means that runner uses its gateway default. Patch one runner at a time
   * via `saveSettings({ chatModelByRunner: { [kind]: id } })` (`''` clears that
   * runner; omitting the field preserves the whole map).
   */
  chatModelByRunner?: Record<string, string>;
  /**
   * ISO timestamp the user finished first-run onboarding. Absent on a
   * fresh install — the renderer gates on this to show the welcome /
   * profile-setup view before mounting home.
   */
  onboardingCompletedAt?: string;
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
  /** Defined for remote gateways only. */
  url?: string;
  createdAt: string;
}

/**
 * Which coding-agent CLIs are runnable on the GATEWAY host. Probed
 * gateway-side (`<bin> --version`) and read over `GET /centraid/_agents/status`
 * (see `renderer/gateway-client-conversation.ts`). Centraid is agnostic to how each
 * agent authenticates — this reflects CLI presence only. A remote gateway
 * reports its own host's CLIs, not the desktop's.
 */
export interface CentraidAgentsStatus {
  /** The `codex` CLI is runnable on the gateway host. */
  codexAvailable: boolean;
  /** The `claude` CLI is runnable on the gateway host. */
  claudeAvailable: boolean;
  /** `codex --version` output when available. */
  codexVersion?: string;
  /** `claude --version` output when available. */
  claudeVersion?: string;
  /** Models codex can serve, from the gateway catalog (issue #188). */
  codexModels?: CentraidRunnerModel[];
  /** Load state of `codexModels` — loading vs ready vs empty. */
  codexModelsStatus?: CentraidSurfaceStatus;
  /** Models Claude Code can serve, from the gateway catalog. */
  claudeModels?: CentraidRunnerModel[];
  /** Load state of `claudeModels`. */
  claudeModelsStatus?: CentraidSurfaceStatus;
  /** Tools codex exposes (builtins + MCP), from the gateway catalog. */
  codexTools?: CentraidHostTool[];
  /** Load state of `codexTools`. */
  codexToolsStatus?: CentraidSurfaceStatus;
  /** Tools Claude Code exposes (builtins + MCP), from the gateway catalog. */
  claudeTools?: CentraidHostTool[];
  /** Load state of `claudeTools`. */
  claudeToolsStatus?: CentraidSurfaceStatus;
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
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

/** Coarse-grained persisted shape per message in a chat session. */
export type CentraidConversationHistoryMessage =
  | { kind: 'user'; text: string }
  | { kind: 'ai'; text: string; error?: boolean }
  | {
      kind: 'tool';
      id: string;
      tool: string;
      sql?: string;
      args?: unknown;
      state: 'ok' | 'error';
      result?: unknown;
      errorText?: string;
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
 * Live `data.sqlite` schema for the Cloud → Database panel. Mirrors
 * `AppSchema` from `@centraid/openclaw-plugin` — kept independent so the
 * renderer typings don't pull the gateway plugin as a build-time dep.
 */
export interface CentraidAppSchemaColumn {
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
  dflt_value: string | null;
}
export interface CentraidAppSchemaTable {
  name: string;
  sql: string | null;
  columns: CentraidAppSchemaColumn[];
}
export interface CentraidAppSchemaIndex {
  name: string;
  tbl_name: string;
  sql: string;
}
export interface CentraidAppSchemaView {
  name: string;
  sql: string;
}
export interface CentraidAppSchema {
  schemaVersion: number;
  tables: CentraidAppSchemaTable[];
  indexes: CentraidAppSchemaIndex[];
  views: CentraidAppSchemaView[];
}

/**
 * One page of rows from a table or view in the app's `data.sqlite`. SQLite
 * native values pass through verbatim — numbers, strings, `null`, and
 * `Buffer` (serialised by `JSON.stringify` as `{ type: 'Buffer', data: [] }`).
 */
export interface CentraidAppTableRows {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  totalCount: number;
  limit: number;
  offset: number;
}

/**
 * Result of running one SQL statement via the Cloud → SQL editor.
 * Discriminated on `kind`: SELECT/PRAGMA/EXPLAIN/WITH/VALUES → `'rows'`;
 * INSERT/UPDATE/DELETE/DDL → `'exec'`.
 */
export type CentraidRunQueryResult =
  | {
      kind: 'rows';
      columns: string[];
      rows: Array<Record<string, unknown>>;
      durationMs: number;
    }
  | {
      kind: 'exec';
      rowsAffected: number;
      lastInsertRowid: number | null;
      durationMs: number;
    };

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
  // appSchema / appTableRows / appQuery / appLogs / deregisterApp /
  // listVersions / activateVersion moved there too (pure git-store reads
  // + the editing-session publish, no main-side state).

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
   * Add a remote gateway. UUID id is minted server-side; the token is
   * stored in keychain and is NOT echoed back. The plaintext crosses
   * the bridge exactly once on this call.
   */
  addGateway(input: {
    label: string;
    url: string;
    token: string;
    displayName?: string;
    avatarColor?: string;
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
  getGatewayAuth(): Promise<{ baseUrl: string; token?: string }>;
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
    }) => void,
  ): () => void;

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

/** KPI tiles for the Insights screen. */
export interface CentraidInsightsKpis {
  /** input + output + cache tokens summed over the window. */
  totalTokens: number;
  totalCostUsd: number;
  /** Window run-rate projected to a 30-day month. */
  forecastCostUsd: number;
  generations: number;
  retries: number;
  appsTouched: number;
  /** Placeholder monthly token allowance — no billing model exists yet. */
  quotaTokens: number;
}

/** One day of the consumption chart. `date` is `YYYY-MM-DD` (UTC). */
export interface CentraidInsightsDailyPoint {
  date: string;
  tokens: number;
  costUsd: number;
  runs: number;
}

/** One row of the "by automation" breakdown. Chat / build runs collapse
 *  into synthetic buckets keyed by `kind`. */
export interface CentraidInsightsAutomationRow {
  key: string;
  label: string;
  kind: 'automation' | 'chat' | 'build' | string;
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
  ok: boolean;
  startedAt: number;
  tokens: number;
  costUsd: number;
}

/** Full payload for the Insights screen. */
export interface CentraidInsightsSummary {
  windowDays: number;
  generatedAt: number;
  kpis: CentraidInsightsKpis;
  daily: CentraidInsightsDailyPoint[];
  byAutomation: CentraidInsightsAutomationRow[];
  byModel: CentraidInsightsModelRow[];
  recent: CentraidInsightsActivityRow[];
}

/** A single run record from the unified `runs` ledger. */
export interface CentraidAutomationRunRecord {
  runId: string;
  kind: 'automation' | 'chat' | 'build';
  /** Set for `kind: 'automation'` — the automation app id. */
  automationId?: string;
  triggerKind: 'scheduled' | 'manual' | 'replay' | 'on_failure' | 'interactive';
  /** Source that fired the run (`cron` / `webhook` / `manual`). */
  triggerOrigin?: 'cron' | 'webhook' | 'manual';
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
  >;
  requires: { mcps?: readonly string[]; tools?: readonly string[]; model?: string };
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

/** One model a runtime can serve (OpenClaw enumerates these). */
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

/**
 * One host tool a runner exposes — a native builtin (`Read`) or an MCP tool
 * (`github.list_pull_requests`). Enumerated gateway-side and surfaced in
 * Settings → Agents so the user can see what the builder can reach.
 */
export interface CentraidHostTool {
  /** Callable name as the agent sees it. */
  name: string;
  /** `native` builtin or `mcp`-backed — the panel groups by this. */
  source: 'native' | 'mcp';
  /** MCP server id, when `source === 'mcp'`. */
  server?: string;
  /** One-line description, when the runtime reports one. */
  description?: string;
  /** The tool's JSON args schema, when it takes caller-supplied arguments. */
  inputSchema?: unknown;
}

/** Preflight snapshot returned by `getRunnerStatus`. */
export interface CentraidRunnerStatus {
  kind: 'openclaw' | 'codex' | 'claude-code' | 'none';
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

declare global {
  interface Window {
    CentraidApi: CentraidApi;
  }

  // Renderer scripts are IIFE-style (no imports) and reference these types
  // by bare name. The interfaces below mirror the module exports above so
  // the call sites stay tidy without `Awaited<ReturnType<…>>` boilerplate.
  interface CentraidAppSchemaColumn {
    name: string;
    type: string;
    notnull: boolean;
    pk: boolean;
    dflt_value: string | null;
  }
  interface CentraidAppSchemaTable {
    name: string;
    sql: string | null;
    columns: CentraidAppSchemaColumn[];
  }
  interface CentraidAppSchemaIndex {
    name: string;
    tbl_name: string;
    sql: string;
  }
  interface CentraidAppSchemaView {
    name: string;
    sql: string;
  }
  interface CentraidAppSchema {
    schemaVersion: number;
    tables: CentraidAppSchemaTable[];
    indexes: CentraidAppSchemaIndex[];
    views: CentraidAppSchemaView[];
  }
  interface CentraidVersionRecord {
    versionId: string;
    sha256: string;
    declaredVersion?: string;
    uploadedAt: string;
    bytes: number;
    files: number;
    current?: boolean;
  }
  interface CentraidAppTableRows {
    columns: string[];
    rows: Array<Record<string, unknown>>;
    totalCount: number;
    limit: number;
    offset: number;
  }
  type CentraidRunQueryResult =
    | {
        kind: 'rows';
        columns: string[];
        rows: Array<Record<string, unknown>>;
        durationMs: number;
      }
    | {
        kind: 'exec';
        rowsAffected: number;
        lastInsertRowid: number | null;
        durationMs: number;
      };
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
    createdAt: number;
    updatedAt: number;
    messageCount: number;
  }
  type CentraidConversationHistoryMessage =
    | { kind: 'user'; text: string }
    | { kind: 'ai'; text: string; error?: boolean }
    | {
        kind: 'tool';
        id: string;
        tool: string;
        sql?: string;
        args?: unknown;
        state: 'ok' | 'error';
        result?: unknown;
        errorText?: string;
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
    >;
    requires: { mcps?: readonly string[]; tools?: readonly string[]; model?: string };
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
    triggerKind: 'scheduled' | 'manual' | 'replay' | 'on_failure' | 'interactive';
    triggerOrigin?: 'cron' | 'webhook' | 'manual';
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
  // Mirror of the module-level Insights types so the Insights screen can
  // reference them by bare name without imports (issue #90).
  interface CentraidInsightsKpis {
    totalTokens: number;
    totalCostUsd: number;
    forecastCostUsd: number;
    generations: number;
    retries: number;
    appsTouched: number;
    quotaTokens: number;
  }
  interface CentraidInsightsDailyPoint {
    date: string;
    tokens: number;
    costUsd: number;
    runs: number;
  }
  interface CentraidInsightsAutomationRow {
    key: string;
    label: string;
    kind: string;
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
    ok: boolean;
    startedAt: number;
    tokens: number;
    costUsd: number;
  }
  interface CentraidInsightsSummary {
    windowDays: number;
    generatedAt: number;
    kpis: CentraidInsightsKpis;
    daily: CentraidInsightsDailyPoint[];
    byAutomation: CentraidInsightsAutomationRow[];
    byModel: CentraidInsightsModelRow[];
    recent: CentraidInsightsActivityRow[];
  }
}
