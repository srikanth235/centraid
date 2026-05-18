/*
 * Chat-specific `ChatRunner` for the desktop's embedded local runtime.
 *
 * Thin wrapper over the mode-agnostic CLI primitives (`runCodexTurn` /
 * `runClaudeTurn`): picks an adapter from the user's persisted
 * `chat.runner.kind` pref, derives the per-app workspace from
 * `<appsDir>/<appId>`, splices the `centraid` CLI preamble into the
 * system prompt so the agent knows how to read/write `./data.sqlite`,
 * reads the previous adapter session id from the per-window `ChatStore`,
 * and returns the new one for the route handler to persist.
 *
 * Builder-mode consumers should call `runCodexTurn` / `runClaudeTurn`
 * directly with their own workspace + preamble + resume-id handling.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ChatStore,
  type ChatRunInput,
  type ChatRunResult,
  type ChatRunner,
} from '@centraid/runtime-core';
import { runCodexTurn } from './codex-adapter.js';
import { runClaudeTurn } from './claude-adapter.js';
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
   * Codex's PATH is prepended with this dir per turn so it can invoke
   * `centraid` by bare name.
   */
  centraidCliDir?: string;
}

/**
 * Default location of the built `centraid` CLI — sibling of this
 * module, i.e. `<package>/dist/`. The published `bin.centraid` entry
 * in package.json points at `./dist/centraid-cli.js`, and we expose
 * just the directory so spawn-PATH stays simple.
 */
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

      if (prefs.kind === 'codex') {
        const result = await runCodexTurn(
          {
            cwd,
            message: input.message,
            extraSystemPrompt,
            ...(input.model ? { model: input.model } : {}),
            ...(resumeId ? { prevThreadId: resumeId } : {}),
            abortSignal: input.abortSignal,
            onEvent: input.onEvent,
          },
          {
            hostBinDir: centraidCliDir,
            ...(prefs.binPath ? { binPath: prefs.binPath } : {}),
            ...(prefs.extraArgs?.length ? { extraArgs: prefs.extraArgs } : {}),
          },
        );
        return {
          adapterKind,
          ...(result.threadId ? { adapterSessionId: result.threadId } : {}),
        };
      }

      const result = await runClaudeTurn(
        {
          cwd,
          message: input.message,
          extraSystemPrompt,
          ...(input.model ? { model: input.model } : {}),
          ...(resumeId ? { prevSessionId: resumeId } : {}),
          abortSignal: input.abortSignal,
          onEvent: input.onEvent,
        },
        {
          hostBinDir: centraidCliDir,
          ...(prefs.binPath ? { binPath: prefs.binPath } : {}),
          ...(prefs.extraArgs?.length ? { extraArgs: prefs.extraArgs } : {}),
        },
      );
      return {
        adapterKind,
        ...(result.sessionId ? { adapterSessionId: result.sessionId } : {}),
      };
    },
  };
}
