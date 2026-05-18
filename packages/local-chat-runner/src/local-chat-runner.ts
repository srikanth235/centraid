/*
 * Chat-specific `ChatRunner` for the desktop's embedded local runtime.
 *
 * Thin wrapper over the unified `runAgentTurn` primitive: derives the
 * per-app workspace from `<appsDir>/<appId>`, splices the `centraid`
 * CLI preamble into the system prompt so the agent knows how to
 * read/write `./data.sqlite`, reads the previous adapter session id
 * from the per-window `ChatStore`, and hands back the new one for the
 * route handler to persist.
 *
 * Builder-mode consumers should call `runAgentTurn` directly with their
 * own workspace + preamble + resume-id handling.
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

export interface MakeLocalChatRunnerOptions {
  /** Embedded runtime's appsDir; pinned at construction. */
  appsDir: string;
  /** Loader for the user's persisted runner prefs. Called per turn so
   *  the adapter picks up settings changes without a runtime restart. */
  prefsLoader: () => Promise<RunnerPrefs | undefined>;
  /**
   * Directory containing the built `centraid` CLI binary. Defaults to
   * the `dist/` sibling of the local-chat-runner package itself.
   * Codex's shell can shell out to this bin by bare name when we
   * prepend it to PATH — but we only need PATH prepending for codex,
   * and codex app-server inherits its env from the parent process.
   * Kept for backwards-compat of the public option name.
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

export function makeLocalChatRunner(opts: MakeLocalChatRunnerOptions): ChatRunner {
  const centraidCliDir = opts.centraidCliDir ?? defaultCentraidCliDir();
  return {
    async run(input: ChatRunInput): Promise<ChatRunResult> {
      const prefs = await opts.prefsLoader();
      if (!prefs) {
        input.onEvent({
          type: 'error',
          message:
            'No local chat runner configured. Open Settings → AI providers and pick Codex or Claude Code.',
        });
        throw new Error('no local chat runner configured');
      }

      const cwd = path.join(opts.appsDir, input.appId);
      const store = new ChatStore(cwd);
      const window = await store.getWindow(input.windowId).catch(() => undefined);
      const adapterKind = prefs.kind;
      const resumeId =
        window && window.adapterKind === adapterKind ? window.adapterSessionId : undefined;

      const extraSystemPrompt = spliceExtraSystemPrompt(input.extraSystemPrompt);

      // Codex spawns its shell tool with its own env; prepend the
      // centraid CLI dir so the agent can invoke `centraid` by bare
      // name regardless of where the user installed the package.
      const originalPath = process.env.PATH ?? '';
      const pathInjection = `${centraidCliDir}${path.delimiter}${originalPath}`;
      const restorePath = (): void => {
        process.env.PATH = originalPath;
      };
      process.env.PATH = pathInjection;

      try {
        const result = await runAgentTurn(
          {
            cwd,
            message: input.message,
            extraSystemPrompt,
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
      } finally {
        restorePath();
      }
    },
  };
}
