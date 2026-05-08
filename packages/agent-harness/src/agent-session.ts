import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
} from '@earendil-works/pi-coding-agent';
import type { AppSchema } from '@centraid/openclaw-plugin';
import { CENTRAID_APPEND_PROMPT } from './system-prompt.js';
import { fetchAppSchema } from './gateway-client.js';
import type { HarnessConfig } from './types.js';

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
  /**
   * When provided, the harness fetches the app's live `data.sqlite` schema
   * once at session start and injects a `### Live schema` block into the
   * system prompt so the agent can author the next migration against the
   * correct current state. Failures (gateway down, app not yet published)
   * are silently skipped — the agent then treats the DB as empty.
   */
  liveSchema?: { config: HarnessConfig; appId: string };
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

  let liveSchemaBlock: string | undefined;
  if (opts.liveSchema) {
    try {
      const schema = await fetchAppSchema(opts.liveSchema.config, opts.liveSchema.appId);
      if (schema) liveSchemaBlock = renderLiveSchemaBlock(schema);
    } catch {
      // Gateway unreachable / unauthenticated. The agent simply won't see a
      // live-schema block, which is what we want for offline / first-time use.
    }
  }

  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.create(cwd, agentDir),
    appendSystemPromptOverride: (base) =>
      liveSchemaBlock
        ? [...base, CENTRAID_APPEND_PROMPT, liveSchemaBlock]
        : [...base, CENTRAID_APPEND_PROMPT],
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

/**
 * Render a `### Live schema` block for the system prompt. Lists user_version,
 * the next migration id, and every CREATE TABLE/INDEX/VIEW currently in the
 * live database verbatim from sqlite_master.
 */
function renderLiveSchemaBlock(schema: AppSchema): string {
  const next = String(schema.schemaVersion + 1).padStart(4, '0');
  const lines: string[] = [
    '### Live schema',
    '',
    `PRAGMA user_version = ${schema.schemaVersion}`,
    `Next migration must be ${next}_<slug>.sql.`,
    '',
  ];

  if (schema.tables.length === 0 && schema.indexes.length === 0 && schema.views.length === 0) {
    lines.push('(database is empty — write 0001_init.sql to create your first tables)');
    return lines.join('\n');
  }

  if (schema.tables.length > 0) {
    lines.push('-- tables');
    for (const t of schema.tables) {
      lines.push(`${t.sql ?? `-- ${t.name} (no DDL recorded)`};`);
    }
    lines.push('');
  }
  if (schema.indexes.length > 0) {
    lines.push('-- indexes');
    for (const i of schema.indexes) lines.push(`${i.sql};`);
    lines.push('');
  }
  if (schema.views.length > 0) {
    lines.push('-- views');
    for (const v of schema.views) lines.push(`${v.sql};`);
    lines.push('');
  }

  return lines.join('\n');
}
