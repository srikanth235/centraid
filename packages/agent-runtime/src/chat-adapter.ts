/*
 * Chat adapter — the per-app data chat layer on top of the engine.
 *
 * `runAgentTurn` is mode-agnostic. This file is the chat-side adapter
 * that wraps it into a `ChatRunner` the gateway's `/_chat` route can
 * inject: per-app cwd from `input.dataDir` (the resolved `appDataDir(entry)`
 * — `<appsDir>/<id>` for uploaded apps, the external folder for
 * path-registered ones), the three first-class `centraid_sql_*` tools
 * declared inline against the per-app `data.sqlite`, and the per-window
 * `ChatStore` lookup for the previous adapter session id (round-tripped
 * to resume the conversation).
 *
 * Builder-mode consumers call `runAgentTurn` directly — they own their
 * own cwd / preamble / resume-id plumbing and don't need this adapter.
 *
 * Note: this is one of two `ChatRunner` implementations. The other lives
 * in `@centraid/openclaw-plugin` and drives an in-process openclaw agent.
 * The desktop's embedded runtime injects this one; openclaw injects its.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  ChatStore,
  type ChatRunInput,
  type ChatRunResult,
  type ChatRunner,
} from '@centraid/runtime-core';
import { runAgentTurn, type ToolContext } from './runtime.js';
import type { RunnerPrefs } from './types.js';

export interface MakeChatRunnerOptions {
  /** Loader for the user's persisted runner prefs. Called per turn so
   *  the adapter picks up settings changes without a runtime restart. */
  prefsLoader: () => Promise<RunnerPrefs | undefined>;
  /**
   * Resolve the host's change-emitter for an app. Required for the
   * agent's `centraid_sql_write` tool to fire the runtime's change bus —
   * without it, agent writes succeed but iframe re-renders won't trigger
   * for the running app. The local-runtime sets this after `Runtime` is
   * constructed (so it can close over `runtime.agentEmitForApp`).
   */
  getChangeEmitter?: (
    appId: string,
  ) => (payload: { tables: string[]; toolCallId?: string; agentTurnId?: string }) => void;
}

const CHAT_PROMPT_PREAMBLE = `## Centraid SQL tools

You have three in-process tools for reading and writing this app's SQLite
database. They are typed and scoped to this app — you do not pass an appId.

  centraid_sql_describe()                   — schema JSON: tables, columns, indexes, views
  centraid_sql_read({ sql })                — rows JSON: { columns, rows, totalRows, truncated, durationMs }
  centraid_sql_write({ sql })               — { rowsAffected, lastInsertRowid, durationMs }

\`sql_read\` accepts a single SELECT or EXPLAIN. \`sql_write\` accepts one
INSERT/UPDATE/DELETE/REPLACE. DDL (CREATE/ALTER/DROP), PRAGMA, ATTACH, and
VACUUM are refused. Read responses are capped at 200 rows — pass LIMIT
explicitly when you want fewer.

Prefer one focused query over many small ones. Call \`centraid_sql_describe\`
first if you don't know the schema yet. After a \`centraid_sql_write\` the
runtime fires a precise change event that the running app's UI subscribes
to, so you do not need to ask the user to reload — the iframe will update
on its own.`;

function spliceExtraSystemPrompt(extra: string): string {
  return extra ? `${CHAT_PROMPT_PREAMBLE}\n\n${extra}` : CHAT_PROMPT_PREAMBLE;
}

export function makeChatRunner(opts: MakeChatRunnerOptions): ChatRunner {
  return {
    async run(input: ChatRunInput): Promise<ChatRunResult> {
      const prefs = await opts.prefsLoader();
      if (!prefs) {
        input.onEvent({
          type: 'error',
          message:
            'No coding agent configured. Open Settings → AI providers and pick Codex or Claude Code.',
        });
        throw new Error('no coding agent configured');
      }

      const cwd = input.dataDir;
      const store = new ChatStore(cwd);
      const window = await store.getWindow(input.windowId).catch(() => undefined);
      const adapterKind = prefs.kind;
      const resumeId =
        window && window.adapterKind === adapterKind ? window.adapterSessionId : undefined;

      const extraSystemPrompt = spliceExtraSystemPrompt(input.extraSystemPrompt);

      const agentTurnId = randomUUID();
      const emit = opts.getChangeEmitter?.(input.appId);
      const toolContext: ToolContext | undefined = emit
        ? {
            dataFile: path.join(cwd, 'data.sqlite'),
            agentTurnId,
            emitChange: (payload) =>
              emit({
                tables: payload.tables,
                agentTurnId,
                ...(payload.toolCallId ? { toolCallId: payload.toolCallId } : {}),
              }),
          }
        : undefined;

      const result = await runAgentTurn(
        {
          cwd,
          message: input.message,
          extraSystemPrompt,
          ...(input.model ? { model: input.model } : {}),
          ...(resumeId ? { prevSessionId: resumeId } : {}),
          ...(toolContext ? { toolContext } : {}),
          abortSignal: input.abortSignal,
          onEvent: input.onEvent,
        },
        { prefs },
      );
      return {
        adapterKind: result.adapterKind,
        ...(result.sessionId ? { adapterSessionId: result.sessionId } : {}),
      };
    },
  };
}
