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

export type CentraidAuthSource = 'codex' | 'claude-code' | 'pi';

export interface CentraidProviderStatus {
  source: CentraidAuthSource;
  expires?: number;
  accountId?: string;
  subscriptionType?: string;
}

export interface CentraidAuthStatus {
  codexAvailable: boolean;
  claudeAvailable: boolean;
  providers: Partial<Record<'openai-codex' | 'anthropic', CentraidProviderStatus>>;
}

export interface CentraidAuthImportResult {
  importedCodex: boolean;
  importedClaude: boolean;
  preferred?: 'openai-codex' | 'anthropic';
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
 * One row from the persisted chat-history index for an app. Sessions list
 * RPCs return these sorted by `updatedAt` desc.
 */
export interface CentraidChatSessionMeta {
  id: string;
  appId: string;
  title: string;
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
  source: 'query' | 'action' | 'cron';
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
 * Subset of pi-ai's content-block types that the renderer hydrates into the
 * chat pane on session resume. Other block types (e.g. images) pass through
 * as opaque objects and are ignored.
 */
export type CentraidContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: string; [k: string]: unknown };

/**
 * Subset of pi's `AgentMessage` union covering the roles the renderer
 * actually displays. Bash-execution / custom / summary message types are
 * passed through as `{ role: string }` and skipped during hydration.
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
 * Pi `AgentEvent` shape (subset we care about). The full union is wider; we
 * type only the fields the renderer reads. See `@earendil-works/pi-agent-core`.
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

  /** Snapshot of pi's auth.json + the on-machine source files. */
  authStatus(): Promise<CentraidAuthStatus>;
  /** Re-import Codex / Claude Code creds, overwriting pi's existing entries. */
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
    source: 'query' | 'action' | 'cron';
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
    appId: string;
    title: string;
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
}
