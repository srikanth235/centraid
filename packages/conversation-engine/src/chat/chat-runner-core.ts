/*
 * Chat-runner core — the one place the per-turn chat loop lives.
 *
 * This is the chat counterpart to the automation fire spine, and it lives in
 * the same backend-agnostic engine package: both are "runners over the run
 * ledger" that differ only in driver and fan-out (a chat run is one
 * model-driven turn; an automation fire is a script-driven fan-out of many).
 *
 * `makeChatRunnerCore` is backend-agnostic. The actual model turn is injected
 * as a `RunTurnFn` (`runTurn`) — agent-runtime passes its codex/claude
 * `runAgentTurn`; tests pass a stub. Every `ChatRunner` the gateway's `/_chat`
 * route can inject does the same thing around that turn: load prefs, resolve a
 * cwd, build the system prompt, thread the `centraid_*` dispatcher into a
 * `ToolContext`, resume when the prior turn used the same runner kind, drive
 * the turn, and (optionally) run a post-turn side effect. That spine used to
 * be copied into both `makeChatRunner` (data-only chat) and the gateway's
 * `makeUnifiedChatRunner` (code+data builder chat); they now differ only by
 * the four injected seams below (issue #147, Concern 1):
 *
 *   - `resolveCwd`            — data chat returns `input.dataDir`; builder
 *                              chat opens the app's draft worktree.
 *   - `buildExtraSystemPrompt` — defaults to passing the route's preamble
 *                              through unchanged; builder chat folds in the
 *                              authoring grounding (owned by `@centraid/skills`).
 *   - `onTurnComplete`        — builder chat mints webhook secrets here.
 *   - `extraPath`             — builder chat puts the bundled `centraid` CLI
 *                              on the agent's PATH; data chat doesn't.
 *
 * The interface (`ChatRunner`, `ChatRunInput`, `ChatRunResult`) and the
 * turn contract (`RunTurnFn`, `AgentTurnInput`, `ToolContext`) both live in
 * app-engine; this is the host-agnostic spine that wires them together.
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentTurnInput,
  ChatRunInput,
  ChatRunResult,
  ChatRunner,
  Dispatcher,
  RunnerPrefs,
  RunTurnFn,
  ToolContext,
} from '@centraid/app-engine';

export type { RunTurnFn };

/** Per-turn context handed to the injected `buildExtraSystemPrompt` /
 *  `onTurnComplete` seams once prefs are loaded and the cwd is resolved. */
export interface ChatTurnContext {
  input: ChatRunInput;
  prefs: RunnerPrefs;
  /** The working dir this turn runs in (data dir, or draft worktree). */
  cwd: string;
}

export interface ChatRunnerCoreOptions {
  /** Loader for the user's persisted runner prefs. Called per turn so the
   *  runner picks up settings changes without a runtime restart. */
  prefsLoader: () => Promise<RunnerPrefs | undefined>;
  /**
   * Resolve the shared app-engine dispatcher. Threaded into the per-turn
   * `ToolContext` so the agent's structured tools dispatch through the same
   * code path as HTTP callers. Hosts typically return `runtime.dispatcher`.
   * Called per turn so a host can cycle-break on first use.
   */
  getDispatcher: () => Dispatcher;
  /**
   * Resolve the working dir for the turn. Data chat returns `input.dataDir`;
   * builder chat opens (or reuses) the app's draft session worktree and
   * returns its app dir.
   */
  resolveCwd: (input: ChatRunInput) => Promise<string> | string;
  /**
   * Build the final extra-system-prompt. Defaults to passing
   * `input.extraSystemPrompt` (the route's data/schema preamble) through
   * unchanged. Builder chat folds the authoring grounding in on top.
   */
  buildExtraSystemPrompt?: (ctx: ChatTurnContext) => Promise<string> | string;
  /**
   * Post-turn side effect, run after the turn settles and before the result
   * is returned. Best-effort — a throw is swallowed and never fails the turn
   * (builder chat mints webhook secrets here).
   */
  onTurnComplete?: (ctx: ChatTurnContext) => Promise<void> | void;
  /** Extra PATH entry (the bundled `centraid` CLI dir) for the spawned
   *  agent. Builder chat sets it; data chat leaves it unset. */
  extraPath?: string;
  /**
   * When true, `resolveCwd` returns a draft session worktree (code + its
   * branched `data.sqlite`), so the turn's `ToolContext.overrideCodeDir` is
   * pinned to it: the agent's `centraid_*` tools then hit the draft's
   * handlers and branched data, not live (issue #144). Builder chat sets it;
   * the data-only backend leaves it false (cwd is the live data dir, no
   * draft to override to).
   */
  cwdIsDraftWorktree?: boolean;
  /**
   * The model turn driver. agent-runtime injects its codex/claude
   * `runAgentTurn`; tests inject a stub. Required — this package is
   * backend-agnostic and never imports a concrete backend.
   */
  runTurn: RunTurnFn;
}

/**
 * Build a `ChatRunner` from the shared spine plus the injected seams. Both
 * the data-only `makeChatRunner` and the gateway's `makeUnifiedChatRunner`
 * are thin configs over this.
 */
export function makeChatRunnerCore(opts: ChatRunnerCoreOptions): ChatRunner {
  const runTurn = opts.runTurn;

  return {
    async run(input: ChatRunInput): Promise<ChatRunResult> {
      const prefs = await opts.prefsLoader();
      if (!prefs) {
        input.onEvent({
          type: 'error',
          message:
            'No coding agent configured. Open Settings → Agents and pick Codex or Claude Code.',
        });
        throw new Error('no coding agent configured');
      }

      const cwd = await opts.resolveCwd(input);
      const turnCtx: ChatTurnContext = { input, prefs, cwd };

      const extraSystemPrompt = opts.buildExtraSystemPrompt
        ? await opts.buildExtraSystemPrompt(turnCtx)
        : input.extraSystemPrompt;

      // Resume only when the previous turn used the same runner kind — a
      // mid-session runner switch starts a fresh conversation.
      const resumeId =
        input.prevAdapterKind === prefs.kind ? input.prevAdapterSessionId : undefined;

      const toolContext: ToolContext = {
        appId: input.appId,
        dispatcher: opts.getDispatcher(),
        agentTurnId: randomUUID(),
        ...(opts.cwdIsDraftWorktree ? { overrideCodeDir: cwd } : {}),
      };

      const turnInput: AgentTurnInput = {
        cwd,
        message: input.message,
        extraSystemPrompt,
        toolContext,
        abortSignal: input.abortSignal,
        onEvent: input.onEvent,
        ...(opts.extraPath ? { extraPath: opts.extraPath } : {}),
        ...(input.model ? { model: input.model } : {}),
        ...(resumeId ? { prevSessionId: resumeId } : {}),
      };

      const result = await runTurn(turnInput, { prefs });

      if (opts.onTurnComplete) {
        try {
          await opts.onTurnComplete(turnCtx);
        } catch {
          /* post-turn hook is best-effort — never fails the turn */
        }
      }

      return {
        adapterKind: result.adapterKind,
        ...(result.sessionId ? { adapterSessionId: result.sessionId } : {}),
      };
    },
  };
}
