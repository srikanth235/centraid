// governance: allow-repo-hygiene file-size-limit ipc-types-bridge pending split into per-feature type modules
/**
 * Renderer-side typings for the IPC bridge exposed by `preload.ts` under
 * `window.CentraidApi`. The shapes here mirror the public types of
 * `@centraid/builder-harness` — kept independent so the renderer doesn't pull
 * the harness as a build-time dependency.
 */

export interface CentraidProjectInfo {
  id: string;
  dir: string;
  built: boolean;
  modifiedAt: string;
  /** Name from the project's `app.json`, falling back to the id if missing. */
  name?: string;
  /** One-line description from `app.json#description`, if present. */
  description?: string;
  /** Whether the project root has an `index.html` (preview-ready). */
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
  projectsDir: string;
  /**
   * Where centraid runs apps. `local` (default) spawns an in-process
   * runtime inside the Electron main; `remote` points at an externally
   * hosted gateway (e.g., OpenClaw).
   */
  runtimeMode: 'local' | 'remote';
  /**
   * Effective base URL for the runtime — automatically set to the local
   * loopback URL when `runtimeMode === 'local'`, otherwise the configured
   * `remoteGatewayUrl`. The renderer should read this for all runtime HTTP
   * calls; do not write to it.
   */
  gatewayUrl: string;
  /** Effective bearer token; companion to `gatewayUrl`. Read-only. */
  gatewayToken?: string;
  /** User-configured remote gateway URL — only used when `runtimeMode === 'remote'`. */
  remoteGatewayUrl: string;
  /** User-configured remote gateway token — only used when `runtimeMode === 'remote'`. */
  remoteGatewayToken?: string;
  /** Provider/model id (e.g. `openai/gpt-4o`) used by the app-view agentic chat. */
  chatModel?: string;
  /** ISO timestamp of the last Claude Code / Codex credential import. */
  authImportedAt?: string;
}

export interface CentraidAuthStatus {
  /** `~/.codex/auth.json` exists (i.e. `codex login` has run). */
  codexAvailable: boolean;
  /** Claude Code OAuth entry present in macOS keychain. */
  claudeAvailable: boolean;
}

export interface CentraidAuthImportResult {
  importedCodex: boolean;
  importedClaude: boolean;
  status: CentraidAuthStatus;
}

export interface CentraidChatModel {
  id: string;
  name: string;
  provider: string;
}

type ChatEventBase = { appId: string; turnId: number };
export type CentraidChatEvent =
  | (ChatEventBase & { kind: 'thinking' })
  | (ChatEventBase & { kind: 'assistant-delta'; delta: string })
  | (ChatEventBase & { kind: 'tool-call'; toolName: string; toolArgs?: unknown; sql?: string })
  | (ChatEventBase & { kind: 'tool-result'; toolName: string; toolResult?: unknown })
  | (ChatEventBase & { kind: 'tool-error'; toolName?: string; text: string })
  | (ChatEventBase & { kind: 'final'; text: string })
  | (ChatEventBase & { kind: 'error'; text: string })
  | (ChatEventBase & { kind: 'aborted' });

/**
 * One persisted chat session — the session id is also the chat window id.
 * Sessions list RPCs return these sorted by `updatedAt` desc.
 */
export interface CentraidChatSessionMeta {
  id: string;
  /** App the chat was opened from; `null` for chats started from the shell. */
  originAppId: string | null;
  title: string;
  /** Sticky chat mode. */
  mode: 'full' | 'data';
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
export type CentraidChatHistoryMessage =
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

export interface CentraidChatSessionWithMessages extends CentraidChatSessionMeta {
  messages: Array<{ idx: number; payload: CentraidChatHistoryMessage; createdAt: number }>;
}

export interface CentraidVersionRecord {
  versionId: string;
  sha256: string;
  declaredVersion?: string;
  uploadedAt: string;
  bytes: number;
  files: number;
  current?: boolean;
}

export interface CentraidProjectFile {
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
 * `TemplateMeta` from `@centraid/app-templates` — duplicated here so the
 * renderer typings stay independent of the templates package at build time.
 */
export interface CentraidTemplateMeta {
  id: string;
  name: string;
  desc: string;
  colorKey: string;
  iconKey: string;
  version: string;
}

/**
 * Result of cloning a template — lays down the project on disk as a draft.
 * Publishing to the gateway is a separate explicit step (see `publish`).
 */
export interface CentraidCloneTemplateResult {
  project: CentraidProjectInfo;
  template: CentraidTemplateMeta;
}

/**
 * Content-block shapes the renderer hydrates into the chat pane on
 * session resume. Other block types (e.g. images) pass through as
 * opaque objects and are ignored.
 */
export type CentraidContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: string; [k: string]: unknown };

/**
 * Persisted-message shape covering the roles the renderer actually
 * displays. Bash-execution / custom / summary message types are passed
 * through as `{ role: string }` and skipped during hydration.
 */
export type CentraidAgentMessage =
  | { role: 'user'; content: string | CentraidContentBlock[]; timestamp?: number }
  | {
      role: 'assistant';
      content: CentraidContentBlock[];
      timestamp?: number;
    }
  | {
      role: 'toolResult';
      toolCallId: string;
      toolName: string;
      isError: boolean;
      content?: unknown;
      timestamp?: number;
    }
  | { role: string; [k: string]: unknown };

/**
 * `AgentEvent` shape the renderer consumes (subset we care about).
 * Emitted by `@centraid/builder-harness`'s `createCentraidAgentSession`
 * via the main-process IPC channel; matches `CentraidAgentEvent` there.
 */
export type CentraidAgentEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: unknown[] }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: unknown; toolResults: unknown[] }
  | { type: 'message_start'; message: unknown }
  | {
      type: 'message_update';
      message: unknown;
      assistantMessageEvent:
        | { type: 'text_delta'; delta: string }
        | { type: 'text_end'; content?: string }
        | { type: 'thinking_delta'; delta: string }
        | { type: 'thinking_end'; content?: string }
        | { type: string; [k: string]: unknown };
    }
  | { type: 'message_end'; message: unknown }
  | {
      type: 'tool_execution_start';
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: 'tool_execution_update';
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    };

interface CentraidApi {
  getSettings(): Promise<CentraidSettings>;
  saveSettings(patch: Partial<CentraidSettings>): Promise<CentraidSettings>;

  listProjects(): Promise<CentraidProjectInfo[]>;
  createProject(input: {
    id: string;
    name?: string;
    version?: string;
  }): Promise<CentraidProjectInfo>;
  readProjectFiles(input: { id: string }): Promise<CentraidProjectFile[]>;
  /**
   * Overwrite a single text file inside the project folder (§B5 editable
   * code workspace). The main process guards against path traversal and
   * rejects non-text extensions. Returns the written path + byte size.
   */
  writeProjectFile(input: {
    id: string;
    path: string;
    content: string;
  }): Promise<{ path: string; size: number }>;
  openProjectFolder(input: { id: string }): Promise<{ ok: true }>;
  deleteProject(input: { id: string }): Promise<{ ok: true }>;
  /**
   * Patch `<projectDir>/app.json` with new `name` and/or `description`.
   * Either field is optional; provide only what should change. Empty
   * `description` clears the field; empty `name` is rejected (name is
   * mandatory).
   */
  updateProjectMeta(input: {
    id: string;
    name?: string;
    description?: string;
  }): Promise<{ ok: true }>;
  /**
   * URL the builder iframe can load to preview a project's local files
   * before publish. `available` is false when the project has no
   * `index.html` yet — the renderer should show an empty state in that case.
   */
  previewUrl(input: { id: string }): Promise<{ url: string; available: boolean }>;

  startAgent(input: {
    projectId: string;
    sessionMode?: 'fresh' | 'continue' | 'in-memory';
  }): Promise<{ ok: true; messages: CentraidAgentMessage[] }>;
  promptAgent(input: { text: string }): Promise<{ ok: true }>;
  stopAgent(): Promise<{ ok: true }>;
  onAgentEvent(cb: (msg: { projectId: string; event: CentraidAgentEvent }) => void): () => void;

  publish(input: { id: string; skipBuild?: boolean }): Promise<CentraidPublishResult>;
  listVersions(input: {
    id: string;
  }): Promise<{ activeVersion?: string; versions: CentraidVersionRecord[] }>;
  activateVersion(input: { id: string; versionId: string }): Promise<{ activeVersion: string }>;
  appLiveUrl(input: { id: string }): Promise<{ url: string }>;
  /**
   * Live schema for the Cloud → Database panel. `undefined` when the gateway
   * has nothing for this app yet (unregistered, or never published).
   */
  appSchema(input: { id: string }): Promise<CentraidAppSchema | undefined>;
  /**
   * One page of rows from a table or view. The gateway caps `limit` at 200
   * server-side; defaults to 50. Throws if the table doesn't exist.
   */
  appTableRows(input: {
    id: string;
    table: string;
    limit?: number;
    offset?: number;
  }): Promise<CentraidAppTableRows>;
  /**
   * Run a single SQL statement against the app's `data.sqlite`. Multi-
   * statement input is rejected by the gateway.
   */
  appQuery(input: { id: string; sql: string }): Promise<CentraidRunQueryResult>;
  /**
   * Newest-first tail of persistent handler logs. `sinceTs` is the
   * polling-friendly anchor; pass the highest `ts` you've seen.
   */
  appLogs(input: {
    id: string;
    limit?: number;
    sinceTs?: number;
    level?: CentraidLogLevel;
  }): Promise<{ entries: CentraidLogEntry[] }>;
  deregisterApp(input: { id: string }): Promise<{ id: string }>;

  /** List bundled templates from `@centraid/app-templates`. */
  listTemplates(): Promise<CentraidTemplateMeta[]>;
  /**
   * Clone a bundled template into the user's projects dir and publish it
   * to the gateway in one round-trip. `newAppId` is optional — the main
   * process auto-suffixes on collision (e.g. `hydrate` → `hydrate-2`).
   */
  cloneTemplate(input: {
    templateId: string;
    newAppId?: string;
    newName?: string;
  }): Promise<CentraidCloneTemplateResult>;

  /**
   * Start (or reset) the app-scoped agentic chat session for this window.
   * Pass `sessionId` to resume a persisted chat from history; omit it for a
   * fresh conversation (the row is lazy-created on first `chatSend`).
   */
  chatStart(input: {
    appId: string;
    appName: string;
    sessionId?: string | null;
    /** Known title when resuming a persisted session; echoed back by `chatSend`. */
    title?: string;
  }): Promise<{ ok: true; sessionId: string | null }>;
  /**
   * Send one user turn. Progress + result arrive via `onChatEvent` with the
   * matching `turnId`. The renderer assigns `turnId` (monotonic per session).
   *
   * Returns the persisted chat sessionId plus the session's canonical
   * `title` — which the server auto-derives from the first user message.
   * The renderer should treat `title` as authoritative (don't compute one
   * client-side) so the header label and the history list stay in sync.
   */
  chatSend(input: {
    appId: string;
    text: string;
    turnId: number;
    model?: string;
  }): Promise<{ ok: true; sessionId: string; title: string }>;
  /** Cancel the in-flight infer for this app, if any. */
  chatAbort(input: { appId: string }): Promise<{ ok: true }>;
  /** Models surfaced by `openclaw infer model list --json`. Empty on failure. */
  listChatModels(): Promise<CentraidChatModel[]>;
  onChatEvent(cb: (event: CentraidChatEvent) => void): () => void;

  /** List persisted chat sessions for an app, newest first. */
  chatHistoryList(input: { appId: string }): Promise<{ sessions: CentraidChatSessionMeta[] }>;
  /** Load one persisted chat session's metadata + ordered message log. */
  chatHistoryLoad(input: { sessionId: string }): Promise<CentraidChatSessionWithMessages>;
  /** Permanently delete one chat session and its messages. */
  chatHistoryDelete(input: { sessionId: string }): Promise<{ ok: boolean }>;
  /** Rename a chat session (overrides the auto-generated title). */
  chatHistoryRename(input: { sessionId: string; title: string }): Promise<CentraidChatSessionMeta>;

  /** Snapshot of which coding-agent credentials are present on this machine. */
  authStatus(): Promise<CentraidAuthStatus>;
  /** Re-probe the on-disk credential locations and return a fresh snapshot. */
  authResync(): Promise<CentraidAuthImportResult>;

  /**
   * Stable user identity, generated on the gateway side on first read.
   * Persists with the gateway's centraid-user.sqlite — the same UUID survives
   * Electron reinstalls and travels with whichever gateway you point at.
   */
  getUserId(): Promise<string>;
  /**
   * Snapshot of every gateway-side global preference (theme, density, accent,
   * …). Empty object on first launch.
   */
  getUserPrefs(): Promise<Record<string, unknown>>;
  /**
   * Merge `patch` into the gateway-side prefs store. `null`/`undefined` values
   * delete the corresponding key. Returns the full prefs map after the write.
   */
  saveUserPrefs(patch: Record<string, unknown>): Promise<Record<string, unknown>>;

  /**
   * Persist the API key for the custom OpenAI-compatible provider via
   * Electron `safeStorage`. The plaintext key crosses the IPC bridge once
   * (renderer → main) and is encrypted before being written to disk.
   * It never enters `user_prefs` or any renderer-readable surface.
   * Pass an empty string to delete; equivalent to `clearProviderApiKey`.
   */
  setProviderApiKey(input: { apiKey: string }): Promise<{ ok: true }>;
  /** Whether an encrypted API key blob is on disk. The plaintext is never returned. */
  hasProviderApiKey(): Promise<{ present: boolean }>;
  /** Delete the encrypted API key blob from disk. */
  clearProviderApiKey(): Promise<{ ok: true }>;

  /**
   * Fresh preflight of the configured runner: binary version + (if a
   * custom OpenAI-compatible endpoint is set) reachability probe of
   * `<baseUrl>/models` with the persisted API key. Always re-probes —
   * the renderer should call this only on settings-panel open or after
   * an explicit user action.
   */
  getRunnerStatus(): Promise<CentraidRunnerStatus>;

  // Automations (issue #70). The desktop UI reads the per-gateway
  // automations mirror table directly and triggers manual runs via
  // the local headless run path.
  listAutomations(input: { appId: string }): Promise<CentraidAutomationRow[]>;
  /**
   * Fire an automation now. With `replay: true` the run is served from
   * the automation's pinned run (recorded tool/agent outputs) instead of
   * live tools — fast, deterministic builder iteration (issue #80).
   */
  runAutomationNow(input: {
    appId: string;
    name: string;
    replay?: boolean;
  }): Promise<CentraidAutomationRunResult>;
  setAutomationEnabled(input: {
    appId: string;
    name: string;
    enabled: boolean;
  }): Promise<{ ok: true }>;
  deleteAutomation(input: { appId: string; name: string }): Promise<{ ok: true }>;
  // Run audit (issue #80). Reads the per-app `automations.sqlite`
  // file's runs / run_nodes tables. Returns [] if no automation has
  // fired yet (file not created).
  listAutomationRuns(input: {
    appId: string;
    name: string;
    limit?: number;
  }): Promise<CentraidAutomationRunRecord[]>;
  listAutomationRunNodes(input: {
    appId: string;
    runId: string;
  }): Promise<CentraidAutomationRunNode[]>;
  /** Pin / unpin a run as a replay fixture (issue #80 follow-up). */
  pinAutomationRun(input: { appId: string; runId: string; pinned: boolean }): Promise<{ ok: true }>;

  /**
   * Insights (issue #90) — the whole analytics screen's payload in one
   * read over the unified run ledger (chat turns + automation fires +
   * builder runs). `windowDays` defaults to 30.
   */
  getInsightsSummary(input?: { windowDays?: number }): Promise<CentraidInsightsSummary>;
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

/** A single run record from `automations.sqlite#runs`. */
export interface CentraidAutomationRunRecord {
  runId: string;
  automationName: string;
  triggerKind: 'scheduled' | 'manual' | 'replay' | 'on_failure';
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
}

/** A single node (ctx.tool / ctx.agent / ctx.invoke call) inside a run. */
export interface CentraidAutomationRunNode {
  nodeId: string;
  runId: string;
  ordinal: number;
  batchId?: number;
  kind: 'tool' | 'agent' | 'invoke';
  name: string;
  argsJson?: string;
  outputJson?: string;
  ok: boolean;
  error?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** For `kind: 'invoke'` — the run id of the child run it spawned. */
  childRunId?: string;
}

/** Row shape returned by `listAutomations`. Mirrors `AutomationRow` from runtime-core. */
export interface CentraidAutomationRow {
  originAppId: string;
  name: string;
  prompt: string;
  cronExpr: string;
  enabled: boolean;
  manifest: {
    prompt: string;
    trigger: { kind: 'cron'; expr: string };
    action: string;
    requires: { mcps?: readonly string[]; tools?: readonly string[]; model?: string };
    costEstimate?: { model: string; tokensPerFire: number };
    generated: { by: string; at: string };
  };
  createdAt: number;
  updatedAt: number;
}

/** Result of `runAutomationNow`. */
export interface CentraidAutomationRunResult {
  ok: boolean;
  durationMs: number;
  error?: string;
  toolBatches: number;
  agentCalls: number;
}

/** Sub-status for a custom OpenAI-compatible provider on a codex runner. */
export interface CentraidProviderStatus {
  id: string;
  baseUrl: string;
  ok: boolean;
  modelCount?: number;
  reason?: string;
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
  provider?: CentraidProviderStatus;
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
  interface CentraidChatModel {
    id: string;
    name: string;
    provider: string;
  }
  type _ChatEventBaseG = { appId: string; turnId: number };
  type CentraidChatEvent =
    | (_ChatEventBaseG & { kind: 'thinking' })
    | (_ChatEventBaseG & { kind: 'assistant-delta'; delta: string })
    | (_ChatEventBaseG & { kind: 'tool-call'; toolName: string; toolArgs?: unknown; sql?: string })
    | (_ChatEventBaseG & { kind: 'tool-result'; toolName: string; toolResult?: unknown })
    | (_ChatEventBaseG & { kind: 'tool-error'; toolName?: string; text: string })
    | (_ChatEventBaseG & { kind: 'final'; text: string })
    | (_ChatEventBaseG & { kind: 'error'; text: string })
    | (_ChatEventBaseG & { kind: 'aborted' });
  interface CentraidChatSessionMeta {
    id: string;
    originAppId: string | null;
    title: string;
    mode: 'full' | 'data';
    adapterKind: string | null;
    adapterSessionId: string | null;
    turnCount: number;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
  }
  type CentraidChatHistoryMessage =
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
  interface CentraidChatSessionWithMessages extends CentraidChatSessionMeta {
    messages: Array<{ idx: number; payload: CentraidChatHistoryMessage; createdAt: number }>;
  }
  // Mirror of the module-level CentraidAutomationRow/Result so the Cloud
  // → Automations panel can reference them by bare name without imports.
  interface CentraidAutomationRow {
    originAppId: string;
    name: string;
    prompt: string;
    cronExpr: string;
    enabled: boolean;
    manifest: {
      prompt: string;
      trigger: { kind: 'cron'; expr: string };
      action: string;
      requires: { mcps?: readonly string[]; tools?: readonly string[]; model?: string };
      costEstimate?: { model: string; tokensPerFire: number };
      generated: { by: string; at: string };
    };
    createdAt: number;
    updatedAt: number;
  }
  interface CentraidAutomationRunResult {
    ok: boolean;
    durationMs: number;
    error?: string;
    toolBatches: number;
    agentCalls: number;
  }
  interface CentraidAutomationRunRecord {
    runId: string;
    automationName: string;
    triggerKind: 'scheduled' | 'manual' | 'replay' | 'on_failure';
    parentRunId?: string;
    inputJson?: string;
    startedAt: number;
    endedAt?: number;
    ok: boolean;
    error?: string;
    summary?: string;
    outputJson?: string;
    pinned: boolean;
  }
  interface CentraidAutomationRunNode {
    nodeId: string;
    runId: string;
    ordinal: number;
    batchId?: number;
    kind: 'tool' | 'agent' | 'invoke';
    name: string;
    argsJson?: string;
    outputJson?: string;
    ok: boolean;
    error?: string;
    startedAt: number;
    endedAt?: number;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    childRunId?: string;
  }
}
