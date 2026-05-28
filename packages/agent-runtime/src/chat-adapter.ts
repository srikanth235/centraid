/*
 * Chat adapter — the per-app data chat layer on top of the engine.
 *
 * `runAgentTurn` is mode-agnostic. This file is the chat-side adapter
 * that wraps it into a `ChatRunner` the gateway's `/_chat` route can
 * inject: per-app cwd from `input.dataDir` (the resolved `appDataDir(entry)`
 * — `<appsDir>/<id>` for uploaded apps, the external folder for
 * path-registered ones), the three first-class `centraid_sql_*` tools
 * declared inline against the per-app `data.sqlite`, and the previous
 * adapter session id threaded through `input.prevAdapter*` (round-tripped
 * from the central `chat_sessions` row to resume the conversation).
 *
 * Builder-mode consumers call `runAgentTurn` directly — they own their
 * own cwd / preamble / resume-id plumbing and don't need this adapter.
 *
 * Note: this is one of two `ChatRunner` implementations. The other lives
 * in `@centraid/openclaw-plugin` and drives an in-process openclaw agent.
 * The desktop's embedded runtime injects this one; openclaw injects its.
 */

import { randomUUID } from 'node:crypto';
import type { ChatRunInput, ChatRunResult, ChatRunner, Dispatcher } from '@centraid/runtime-core';
import { runAgentTurn, type ToolContext } from './runtime.js';
import type { RunnerPrefs } from './types.js';

export interface MakeChatRunnerOptions {
  /** Loader for the user's persisted runner prefs. Called per turn so
   *  the adapter picks up settings changes without a runtime restart. */
  prefsLoader: () => Promise<RunnerPrefs | undefined>;
  /**
   * Resolve the shared runtime-core dispatcher. The chat adapter threads
   * this into the per-turn `ToolContext` so the agent's three structured
   * tools dispatch through the same code path as HTTP callers. Hosts
   * typically return `runtime.dispatcher`. Called per turn so a host can
   * cycle-break on first use (see local-runtime).
   */
  getDispatcher: () => Dispatcher;
  /**
   * Parent dir under which scoped `CODEX_HOME`s are materialized when the
   * user has configured a custom OpenAI-compatible provider on a codex
   * runner. Hosts should point this at a stable userData-relative path
   * so codex thread state persists across launches. Ignored when no
   * provider is configured.
   */
  codexHomeBaseDir?: string;
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
      // Resume only when the previous turn used the same runner kind — a
      // mid-session runner switch starts a fresh conversation.
      const resumeId =
        input.prevAdapterKind === prefs.kind ? input.prevAdapterSessionId : undefined;

      // The runtime-core extra-system-prompt already describes the three
      // structured tools + `_sql` built-in; pass it through verbatim.
      const extraSystemPrompt = input.extraSystemPrompt;

      const agentTurnId = randomUUID();
      const toolContext: ToolContext = {
        appId: input.appId,
        dispatcher: opts.getDispatcher(),
        agentTurnId,
      };

      const result = await runAgentTurn(
        {
          cwd,
          message: input.message,
          extraSystemPrompt,
          ...(input.model ? { model: input.model } : {}),
          ...(resumeId ? { prevSessionId: resumeId } : {}),
          toolContext,
          abortSignal: input.abortSignal,
          onEvent: input.onEvent,
        },
        {
          prefs,
          ...(opts.codexHomeBaseDir ? { codexHomeBaseDir: opts.codexHomeBaseDir } : {}),
        },
      );
      return {
        adapterKind: result.adapterKind,
        ...(result.sessionId ? { adapterSessionId: result.sessionId } : {}),
      };
    },
  };
}
