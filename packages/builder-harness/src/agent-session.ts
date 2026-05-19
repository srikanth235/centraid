/*
 * Builder agent session — facade over `runAgentTurn` (the unified
 * codex-app-server + Claude-SDK runtime in `@centraid/agent-runtime`)
 * that shapes events for the renderer's `handleAgentEvent`.
 *
 * The renderer consumes a coarser event union (`agent_start` /
 * `turn_start` / `message_update` / `tool_execution_*` / etc.) than the
 * fine-grained `ChatStreamEvent` the runtime emits, so this module owns
 * the translation. Keeping it isolated lets the runtime evolve without
 * the renderer relearning an event schema.
 *
 * Resume strategy: the runtime returns an opaque `sessionId` (codex
 * thread id / Claude session id). We persist it under
 * `<projectDir>/.centraid-builder-state.json` so reopening the same
 * project resumes the prior CLI session. If the user switches CLI
 * between turns we discard the stale id (each backend's session id
 * is meaningful only to that backend).
 *
 * Messages on resume: we return an empty array. The CLI / SDK owns
 * the model-visible transcript via its own session-resume mechanism,
 * so the *agent* keeps context; the renderer just shows a fresh chat
 * pane on reload. A dedicated transcript-on-disk store can be added
 * later if it proves needed.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { runAgentTurn, defaultCentraidCliDir, type RunnerPrefs } from '@centraid/agent-runtime';
import type { ChatStreamEvent, AppSchema } from '@centraid/runtime-core';
import { CENTRAID_APPEND_PROMPT } from './system-prompt.js';
import { buildUiGroundingBlocks } from './ui-grounding.js';
import { fetchAppSchema } from './gateway-client.js';
import type { HarnessConfig } from './types.js';

export type CentraidSessionMode = 'fresh' | 'continue' | 'in-memory';

export interface CreateCentraidAgentSessionOptions {
  /** Project directory the agent operates in (its cwd). */
  projectDir: string;
  /** Which CLI / SDK to drive the session. Required. */
  runnerPrefs: RunnerPrefs;
  /**
   * Session persistence mode:
   *   - "continue" (default): resume the adapter session id stored at
   *     `<projectDir>/.centraid-builder-state.json` if the prior kind
   *     matches the current pref. Falls back to a fresh turn otherwise.
   *   - "fresh": start a new adapter session (used by first-build flows).
   *   - "in-memory": no on-disk state read or written.
   */
  sessionMode?: CentraidSessionMode;
  /**
   * When provided, the harness fetches the app's live `data.sqlite`
   * schema once at session start and injects a `### Live schema` block
   * into the system prompt so the agent can author the next migration
   * against the correct current state. Failures (gateway down, app
   * not yet published) are silently skipped.
   */
  liveSchema?: { config: HarnessConfig; appId: string };
  model?: string;
  /**
   * Directory to prepend to PATH for any subprocess the agent spawns.
   * Defaults to `defaultCentraidCliDir()` so the agent can invoke the
   * `centraid` CLI (used by the `centraid preview snapshot` flow) by
   * bare name. Pass an empty string to opt out.
   */
  centraidCliDir?: string;
  /**
   * Parent dir under which scoped `CODEX_HOME`s are materialized when
   * `runnerPrefs.provider` is set. Forwarded to `runAgentTurn`. Ignored
   * when no provider is configured or the runner is `claude-code`.
   */
  codexHomeBaseDir?: string;
}

/** Event shape the renderer's `handleAgentEvent` consumes. */
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
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      result: unknown;
      isError: boolean;
    };

export interface AgentSession {
  subscribe(cb: (event: CentraidAgentEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): void;
  readonly messages: unknown[];
}

interface BuilderStateFile {
  kind: RunnerPrefs['kind'];
  sessionId: string;
  updatedAt: string;
}

const STATE_FILENAME = '.centraid-builder-state.json';

export async function createCentraidAgentSession(
  opts: CreateCentraidAgentSessionOptions,
): Promise<AgentSession> {
  const cwd = opts.projectDir;
  const mode: CentraidSessionMode = opts.sessionMode ?? 'continue';
  await fs.mkdir(cwd, { recursive: true });

  const extraSystemPrompt = await buildExtraSystemPrompt(opts);
  // Empty string = explicit opt-out; undefined = default (CLI dist dir).
  const extraPath = opts.centraidCliDir ?? defaultCentraidCliDir();

  let resumeId: string | undefined;
  if (mode === 'continue') {
    const prior = await readBuilderState(cwd);
    if (prior && prior.kind === opts.runnerPrefs.kind) {
      resumeId = prior.sessionId;
    }
  }

  const subscribers = new Set<(event: CentraidAgentEvent) => void>();
  let abortController: AbortController | undefined;
  let agentStarted = false;

  const emit = (event: CentraidAgentEvent): void => {
    for (const cb of subscribers) {
      try {
        cb(event);
      } catch {
        // listener errors must not interrupt the stream
      }
    }
  };

  return {
    subscribe(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },

    get messages(): unknown[] {
      return [];
    },

    abort() {
      abortController?.abort();
    },

    async prompt(text: string): Promise<void> {
      if (!agentStarted) {
        agentStarted = true;
        emit({ type: 'agent_start' });
      }
      emit({ type: 'turn_start' });
      emit({ type: 'message_start', message: null });

      abortController = new AbortController();
      const translator = makeStreamTranslator(emit);
      const onEvent = (event: ChatStreamEvent): void => translator(event);

      try {
        const result = await runAgentTurn(
          {
            cwd,
            message: text,
            extraSystemPrompt,
            ...(extraPath ? { extraPath } : {}),
            ...(opts.model ? { model: opts.model } : {}),
            ...(resumeId ? { prevSessionId: resumeId } : {}),
            abortSignal: abortController.signal,
            onEvent,
          },
          {
            prefs: opts.runnerPrefs,
            ...(opts.codexHomeBaseDir ? { codexHomeBaseDir: opts.codexHomeBaseDir } : {}),
          },
        );
        if (result.sessionId) {
          resumeId = result.sessionId;
          if (mode !== 'in-memory') {
            await writeBuilderState(cwd, {
              kind: result.adapterKind,
              sessionId: result.sessionId,
              updatedAt: new Date().toISOString(),
            });
          }
        }
      } finally {
        translator.flush();
        emit({ type: 'message_end', message: null });
        emit({ type: 'turn_end', message: null, toolResults: [] });
        abortController = undefined;
      }
    },
  };
}

/**
 * Translate the runtime's `ChatStreamEvent` union into the renderer's
 * `CentraidAgentEvent`s. `assistant.delta` / `reasoning.delta` →
 * `message_update`; `tool.start` / `tool.result` → `tool_execution_*`;
 * `phase` / `final` drop (the wrapping `message_end` / `turn_end`
 * carry the same signal); `error` synthesizes a tool failure.
 */
function makeStreamTranslator(emit: (event: CentraidAgentEvent) => void): {
  (event: ChatStreamEvent): void;
  flush: () => void;
} {
  let textOpen = false;
  let thinkingOpen = false;

  const closeText = (): void => {
    if (textOpen) {
      emit({
        type: 'message_update',
        message: null,
        assistantMessageEvent: { type: 'text_end' },
      });
      textOpen = false;
    }
  };
  const closeThinking = (): void => {
    if (thinkingOpen) {
      emit({
        type: 'message_update',
        message: null,
        assistantMessageEvent: { type: 'thinking_end' },
      });
      thinkingOpen = false;
    }
  };

  const fn = (event: ChatStreamEvent): void => {
    switch (event.type) {
      case 'assistant.start':
      case 'phase':
      case 'final':
        return;
      case 'assistant.delta':
        closeThinking();
        textOpen = true;
        emit({
          type: 'message_update',
          message: null,
          assistantMessageEvent: { type: 'text_delta', delta: event.delta },
        });
        return;
      case 'reasoning.delta':
        closeText();
        thinkingOpen = true;
        emit({
          type: 'message_update',
          message: null,
          assistantMessageEvent: { type: 'thinking_delta', delta: event.delta },
        });
        return;
      case 'tool.start':
        closeText();
        closeThinking();
        emit({
          type: 'tool_execution_start',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args ?? {},
        });
        return;
      case 'tool.result':
        emit({
          type: 'tool_execution_end',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result ?? null,
          isError: !event.ok,
        });
        return;
      case 'error':
        closeText();
        closeThinking();
        emit({
          type: 'tool_execution_end',
          toolCallId: `error-${Date.now()}`,
          toolName: 'error',
          result: event.message,
          isError: true,
        });
        return;
      case 'aborted':
        closeText();
        closeThinking();
    }
  };

  fn.flush = (): void => {
    closeText();
    closeThinking();
  };
  return fn;
}

async function buildExtraSystemPrompt(opts: CreateCentraidAgentSessionOptions): Promise<string> {
  const blocks: string[] = [CENTRAID_APPEND_PROMPT, ...buildUiGroundingBlocks()];

  if (opts.liveSchema) {
    try {
      const schema = await fetchAppSchema(opts.liveSchema.config, opts.liveSchema.appId);
      if (schema) blocks.push(renderLiveSchemaBlock(schema));
    } catch {
      // gateway unreachable / app not yet published — agent treats the DB as empty
    }
  }

  return blocks.join('\n\n');
}

async function readBuilderState(projectDir: string): Promise<BuilderStateFile | undefined> {
  try {
    const raw = await fs.readFile(path.join(projectDir, STATE_FILENAME), 'utf8');
    const parsed = JSON.parse(raw) as Partial<BuilderStateFile>;
    if (
      (parsed.kind === 'codex' || parsed.kind === 'claude-code') &&
      typeof parsed.sessionId === 'string'
    ) {
      return {
        kind: parsed.kind,
        sessionId: parsed.sessionId,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

async function writeBuilderState(projectDir: string, state: BuilderStateFile): Promise<void> {
  const file = path.join(projectDir, STATE_FILENAME);
  await fs.writeFile(file, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

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
