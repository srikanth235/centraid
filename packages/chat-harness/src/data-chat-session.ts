import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
} from '@earendil-works/pi-coding-agent';
import type { HarnessConfig } from '@centraid/builder-harness';
import { promises as fs } from 'node:fs';
import { createCentraidSqlTools } from './sql-tools.js';
import { buildDataChatPrompt } from './system-prompt.js';

export type DataChatSessionMode = 'fresh' | 'continue' | 'in-memory';

export interface CreateDataChatSessionOptions extends Pick<
  CreateAgentSessionOptions,
  'model' | 'thinkingLevel'
> {
  /**
   * Resolved harness config — already targets either the embedded local
   * runtime or the remote OpenClaw gateway, with auth token resolved. The
   * SQL tools use this for every `/centraid/_apps/{appId}/...` call.
   */
  config: HarnessConfig;
  /**
   * App id the chat is scoped to. Encoded into the system prompt and frozen
   * into every SQL tool's closure — the model cannot target a different app.
   */
  appId: string;
  /**
   * Human-readable app name. Appears in the system prompt so the model can
   * refer to the app by name in user-facing replies.
   */
  appName: string;
  /**
   * Sandbox directory pi-coding-agent treats as its cwd. The data chat does
   * NOT touch files inside it — `noTools: 'all'` disables every built-in
   * file/bash tool — but pi requires a real directory for session metadata.
   * Callers should pass a per-app subdir under `userData` and the factory
   * mkdirs it.
   */
  sandboxDir: string;
  /**
   * Session persistence mode for pi-coding-agent's own session memory:
   *   - "in-memory" (default): no on-disk persistence. The chat-harness
   *     consumer keeps its own user-visible chat history elsewhere.
   *   - "continue": resume the most recent persisted pi session for this
   *     sandboxDir (file-backed under `~/.pi/agent/sessions/...`).
   *   - "fresh": start a new persisted pi session.
   */
  sessionMode?: DataChatSessionMode;
  /** Override the per-SELECT row cap surfaced to the model. */
  selectRowCap?: number;
}

/**
 * Create a pi-coding-agent session pre-configured for the in-app data chat:
 *
 * - cwd = `sandboxDir` (just so pi has somewhere to write session files).
 *   No app-authoring tools are enabled, so the model never touches it.
 * - All built-in tools (read/write/edit/bash/grep/find/ls) are disabled.
 * - Three custom tools are registered: centraid_sql_describe,
 *   centraid_sql_read, centraid_sql_write — all closure-scoped to `appId`.
 * - System prompt = `buildDataChatPrompt({ appName, appId })`, appended onto
 *   pi's bare default (which is now nearly empty given `noTools: 'all'`).
 *
 * Returns the raw pi `AgentSession`. Subscribe to it for streaming events;
 * call `session.prompt(text)` to drive a turn; `session.abort()` to cancel.
 */
export async function createCentraidDataChatSession(
  opts: CreateDataChatSessionOptions,
): Promise<AgentSession> {
  const cwd = opts.sandboxDir;
  await fs.mkdir(cwd, { recursive: true });

  const agentDir = getAgentDir();
  const mode: DataChatSessionMode = opts.sessionMode ?? 'in-memory';

  const promptBlock = buildDataChatPrompt({ appName: opts.appName, appId: opts.appId });

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    // The builder harness uses this hook to append app-authoring guidance;
    // here we replace `base` entirely so the model never sees coding-agent
    // boilerplate that doesn't apply to read-only data Q&A.
    appendSystemPromptOverride: () => [promptBlock],
  });
  await loader.reload();

  const sessionManager =
    mode === 'in-memory'
      ? SessionManager.inMemory(cwd)
      : mode === 'continue'
        ? SessionManager.continueRecent(cwd)
        : SessionManager.create(cwd);

  const customTools = createCentraidSqlTools({
    config: opts.config,
    appId: opts.appId,
    selectRowCap: opts.selectRowCap,
  });

  const { session } = await createAgentSession({
    cwd,
    resourceLoader: loader,
    sessionManager,
    // Turn OFF every built-in tool. The chat agent has exactly one job —
    // talk to this app's SQLite via the three custom tools — and exposing
    // bash/edit/read here would be both pointless and a footgun.
    noTools: 'all',
    customTools,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
  });

  return session;
}
