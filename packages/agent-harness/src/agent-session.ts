import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
} from '@earendil-works/pi-coding-agent';
import { CENTRAID_APPEND_PROMPT } from './system-prompt.js';

export type CentraidSessionMode = 'fresh' | 'continue' | 'in-memory';

export interface CreateCentraidAgentSessionOptions extends Pick<
  CreateAgentSessionOptions,
  'model' | 'thinkingLevel' | 'tools' | 'customTools'
> {
  /** Project directory the agent operates in (its cwd). */
  projectDir: string;
  /**
   * Session persistence mode:
   *   - "continue"  (default for re-opens): resume the most recent persisted
   *     session for this project so chat history survives builder reloads.
   *     Falls back to a fresh persisted session if none exists yet.
   *   - "fresh":    start a new persisted session (used by first-build flows
   *     so the initial-prompt run isn't appended to a stale transcript).
   *   - "in-memory": no on-disk persistence (testing / ephemeral flows).
   *
   * Persisted sessions live under `~/.pi/agent/sessions/<encoded-cwd>/` —
   * pi's default location, scoped per project directory.
   */
  sessionMode?: CentraidSessionMode;
}

/**
 * Create a pi coding-agent session pre-configured for centraid app authoring:
 *
 * - cwd = the project directory; built-in `read`/`write`/`edit`/`bash` operate in there.
 * - System prompt has the centraid app-format guide appended (see system-prompt.ts).
 * - Default tools (read/write/edit/bash) — sufficient for v1; pass `tools` to narrow.
 * - Session is disk-persisted by default; mode controls whether to resume.
 *
 * Returns the underlying pi `AgentSession`. Subscribe to it for streaming text,
 * call `session.prompt(text)` to drive a turn.
 */
export async function createCentraidAgentSession(
  opts: CreateCentraidAgentSessionOptions,
): Promise<AgentSession> {
  const cwd = opts.projectDir;
  const agentDir = getAgentDir();
  const mode: CentraidSessionMode = opts.sessionMode ?? 'continue';

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    appendSystemPromptOverride: (base) => [...base, CENTRAID_APPEND_PROMPT],
  });
  await loader.reload();

  const sessionManager =
    mode === 'in-memory'
      ? SessionManager.inMemory(cwd)
      : mode === 'continue'
        ? SessionManager.continueRecent(cwd)
        : SessionManager.create(cwd);

  const { session } = await createAgentSession({
    cwd,
    resourceLoader: loader,
    sessionManager,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.thinkingLevel ? { thinkingLevel: opts.thinkingLevel } : {}),
    ...(opts.tools ? { tools: opts.tools } : {}),
    ...(opts.customTools ? { customTools: opts.customTools } : {}),
  });

  return session;
}
