/*
 * Chat adapter — the per-app data chat layer on top of the engine.
 *
 * `runAgentTurn` is mode-agnostic. This file is the chat-side adapter
 * that wraps it into a `ChatRunner` the gateway's `/_chat` route can
 * inject: per-app cwd from `<appsDir>/<appId>`, the `centraid` CLI
 * preamble spliced into the system prompt so the agent can read/write
 * `./data.sqlite`, and the per-window `ChatStore` lookup for the
 * previous adapter session id (round-tripped to resume the conversation).
 *
 * Builder-mode consumers call `runAgentTurn` directly — they own their
 * own cwd / preamble / resume-id plumbing and don't need this adapter.
 *
 * Note: this is one of two `ChatRunner` implementations. The other lives
 * in `@centraid/openclaw-plugin` and drives an in-process openclaw agent.
 * The desktop's embedded runtime injects this one; openclaw injects its.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChatStore,
  type ChatRunInput,
  type ChatRunResult,
  type ChatRunner,
} from '@centraid/runtime-core';
import { runAgentTurn } from './runtime.js';
import type { RunnerPrefs } from './types.js';

export interface MakeChatRunnerOptions {
  /** Embedded runtime's appsDir; pinned at construction. */
  appsDir: string;
  /** Loader for the user's persisted runner prefs. Called per turn so
   *  the adapter picks up settings changes without a runtime restart. */
  prefsLoader: () => Promise<RunnerPrefs | undefined>;
  /**
   * Directory containing the built `centraid` CLI binary. Defaults to
   * the `dist/` sibling of the agent-runtime package itself. Forwarded
   * to `runAgentTurn` as `extraPath` so codex's shell tool / claude's
   * Bash tool can invoke `centraid` by bare name without mutating the
   * host's `process.env`.
   */
  centraidCliDir?: string;
}

export function defaultCentraidCliDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

const CHAT_PROMPT_PREAMBLE = `## centraid CLI

You have a "centraid" CLI available for reading and writing this app's data:

  centraid sql describe                      — JSON: tables, columns, indexes, views
  centraid sql read  "SELECT ..."            — JSON: { columns, rows, totalRows, truncated }
  centraid sql write "INSERT/UPDATE/DELETE/REPLACE ..."  — JSON: { rowsAffected, lastInsertRowid }

The CLI operates on ./data.sqlite in the current working directory, which is
already scoped to this app. You do NOT need to pass an appId. DDL
(CREATE/ALTER/DROP) and PRAGMA are refused.

Prefer one focused SELECT over many small ones (use LIMIT). Call
\`centraid sql describe\` first if you don't know the schema yet.`;

function spliceExtraSystemPrompt(extra: string): string {
  return extra ? `${CHAT_PROMPT_PREAMBLE}\n\n${extra}` : CHAT_PROMPT_PREAMBLE;
}

export function makeChatRunner(opts: MakeChatRunnerOptions): ChatRunner {
  const centraidCliDir = opts.centraidCliDir ?? defaultCentraidCliDir();
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

      const cwd = path.join(opts.appsDir, input.appId);
      const store = new ChatStore(cwd);
      const window = await store.getWindow(input.windowId).catch(() => undefined);
      const adapterKind = prefs.kind;
      const resumeId =
        window && window.adapterKind === adapterKind ? window.adapterSessionId : undefined;

      const extraSystemPrompt = spliceExtraSystemPrompt(input.extraSystemPrompt);

      const result = await runAgentTurn(
        {
          cwd,
          message: input.message,
          extraSystemPrompt,
          extraPath: centraidCliDir,
          ...(input.model ? { model: input.model } : {}),
          ...(resumeId ? { prevSessionId: resumeId } : {}),
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
