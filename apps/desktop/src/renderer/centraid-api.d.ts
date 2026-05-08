/**
 * Renderer-side typings for the IPC bridge exposed by `preload.ts` under
 * `window.CentraidApi`. The shapes here mirror the public types of
 * `@centraid/agent-harness` — kept independent so the renderer doesn't pull
 * the harness as a build-time dependency.
 */

export interface CentraidProjectInfo {
  id: string;
  dir: string;
  built: boolean;
  modifiedAt: string;
  /** Name from the project's `app.json`, falling back to the id if missing. */
  name?: string;
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
}

export interface CentraidSettings {
  projectsDir: string;
  gatewayUrl: string;
  gatewayToken?: string;
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
  language: "ts" | "js" | "html" | "css" | "json" | "md" | "other";
}

/**
 * Subset of pi-ai's content-block types that the renderer hydrates into the
 * chat pane on session resume. Other block types (e.g. images) pass through
 * as opaque objects and are ignored.
 */
export type CentraidContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: string; [k: string]: unknown };

/**
 * Subset of pi's `AgentMessage` union covering the roles the renderer
 * actually displays. Bash-execution / custom / summary message types are
 * passed through as `{ role: string }` and skipped during hydration.
 */
export type CentraidAgentMessage =
  | { role: "user"; content: string | CentraidContentBlock[]; timestamp?: number }
  | {
      role: "assistant";
      content: CentraidContentBlock[];
      timestamp?: number;
    }
  | {
      role: "toolResult";
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
  | { type: "agent_start" }
  | { type: "agent_end"; messages: unknown[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: unknown; toolResults: unknown[] }
  | { type: "message_start"; message: unknown }
  | {
      type: "message_update";
      message: unknown;
      assistantMessageEvent:
        | { type: "text_delta"; delta: string }
        | { type: "text_end"; content?: string }
        | { type: "thinking_delta"; delta: string }
        | { type: "thinking_end"; content?: string }
        | { type: string; [k: string]: unknown };
    }
  | { type: "message_end"; message: unknown }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: unknown;
    }
  | {
      type: "tool_execution_end";
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
   * URL the builder iframe can load to preview a project's local files
   * before publish. `available` is false when the project has no
   * `index.html` yet — the renderer should show an empty state in that case.
   */
  previewUrl(input: { id: string }): Promise<{ url: string; available: boolean }>;

  startAgent(input: {
    projectId: string;
    sessionMode?: "fresh" | "continue" | "in-memory";
  }): Promise<{ ok: true; messages: CentraidAgentMessage[] }>;
  promptAgent(input: { text: string }): Promise<{ ok: true }>;
  stopAgent(): Promise<{ ok: true }>;
  onAgentEvent(
    cb: (msg: { projectId: string; event: CentraidAgentEvent }) => void,
  ): () => void;

  publish(input: {
    id: string;
    skipBuild?: boolean;
  }): Promise<CentraidPublishResult>;
  listVersions(input: {
    id: string;
  }): Promise<{ activeVersion?: string; versions: CentraidVersionRecord[] }>;
  activateVersion(input: {
    id: string;
    versionId: string;
  }): Promise<{ activeVersion: string }>;
  appLiveUrl(input: { id: string }): Promise<{ url: string }>;
  deregisterApp(input: { id: string }): Promise<{ id: string }>;
}

declare global {
  interface Window {
    CentraidApi: CentraidApi;
  }
}

export {};
