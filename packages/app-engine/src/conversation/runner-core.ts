/*
 * Chat-runner core — the one place the per-turn chat loop lives.
 *
 * It sits next to the `ConversationRunner` interface and the agent-turn
 * contract it wires together, both of which live here in app-engine. The
 * actual model turn is injected as a `RunTurnFn` (`runTurn`) — agent-runtime
 * passes its codex/claude `runTurn`; tests pass a stub. Every
 * `ConversationRunner` the gateway's `/_turn` route can inject does the same
 * thing around that turn: load prefs, resolve a cwd, build the system prompt,
 * thread the `centraid_*` dispatcher into a `ToolContext`, resume when the
 * prior turn used the same runner kind, drive the turn, and (optionally) run a
 * post-turn side effect. That spine used to be copied into both
 * `makeConversationRunner` (agent-runtime, data-only chat) and the gateway's
 * `makeUnifiedConversationRunner` (code+data builder chat); they now differ
 * only by the four injected seams below (issue #147, Concern 1):
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
 * Backend-agnostic by construction: the model turn (`runTurn`) is injected, so
 * this spine never imports a concrete agent backend.
 */

import { randomUUID } from 'node:crypto';
import type { Dispatcher } from '../handlers/dispatcher.js';
import type { RunKind } from './schema.js';
import type {
  ConversationRunner,
  ConversationTurnInput,
  ConversationTurnResult,
} from './runner.js';
import type { RunnerPrefs, RunTurnFn, ToolContext, TurnInput } from './turn.js';

/** Per-turn context handed to the injected `buildExtraSystemPrompt` /
 *  `onTurnComplete` seams once prefs are loaded and the cwd is resolved. */
export interface TurnContext {
  input: ConversationTurnInput;
  prefs: RunnerPrefs;
  /** The working dir this turn runs in (data dir, or draft worktree). */
  cwd: string;
}

export interface ConversationRunnerCoreOptions {
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
  resolveCwd: (input: ConversationTurnInput) => Promise<string> | string;
  /**
   * Build the final extra-system-prompt. Defaults to passing
   * `input.extraSystemPrompt` (the route's data/schema preamble) through
   * unchanged. Builder chat folds the authoring grounding in on top.
   */
  buildExtraSystemPrompt?: (ctx: TurnContext) => Promise<string> | string;
  /**
   * Post-turn side effect, run after the turn settles and before the result
   * is returned. Best-effort — a throw is swallowed and never fails the turn
   * (builder chat mints webhook secrets here).
   */
  onTurnComplete?: (ctx: TurnContext) => Promise<void> | void;
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
   * `runTurn`; tests inject a stub. Required — this spine is
   * backend-agnostic and never imports a concrete backend.
   */
  runTurn: RunTurnFn;
  /**
   * The ledger `RunKind` turns through this runner persist as, surfaced on
   * the built `ConversationRunner` for the route to read. Builder chat sets `'build'`;
   * data chat leaves it unset (the route defaults to `'chat'`) — issue #181.
   */
  runKind?: RunKind;
}

/**
 * Build a `ConversationRunner` from the shared spine plus the injected seams. Both
 * the data-only `makeConversationRunner` and the gateway's `makeUnifiedConversationRunner`
 * are thin configs over this.
 */
export function makeConversationRunnerCore(
  opts: ConversationRunnerCoreOptions,
): ConversationRunner {
  const runTurn = opts.runTurn;

  return {
    ...(opts.runKind ? { runKind: opts.runKind } : {}),
    async run(input: ConversationTurnInput): Promise<ConversationTurnResult> {
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
      const turnCtx: TurnContext = { input, prefs, cwd };

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
        turnId: randomUUID(),
        ...(opts.cwdIsDraftWorktree ? { overrideCodeDir: cwd } : {}),
      };

      const turnInput: TurnInput = {
        cwd,
        message: input.message,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
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
