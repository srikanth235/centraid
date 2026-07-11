/*
 * Chat adapter — the plain per-app chat layer on top of the engine.
 *
 * The turn runs with cwd = `input.dataDir` (the resolved
 * `appDataDir(entry)`) and the route's app-context preamble passed through
 * verbatim. It wires no vault runners, so the turn carries no data tools —
 * hosts with a vault mount their own runner configs instead. No draft
 * worktree, no authoring grounding, no post-turn side effects — those are
 * the builder chat's job (`makeUnifiedConversationRunner`).
 *
 * It is a thin config over `makeConversationRunnerCore` (issue #147, Concern 1):
 * the shared per-turn spine lives there; this file only supplies the
 * data-chat seams (cwd = data dir, default prompt pass-through).
 *
 * Note: this is one of two in-process `ConversationRunner` implementations. The
 * other (`makeUnifiedConversationRunner`, gateway) is also a config over the same
 * core.
 */

import {
  makeConversationRunnerCore,
  type ConversationRunner,
  type Dispatcher,
} from '@centraid/app-engine';
import { runTurn } from './runtime.js';
import type { RunnerPrefs } from './types.js';

export interface MakeConversationRunnerOptions {
  /** Loader for the user's persisted runner prefs. Called per turn so
   *  the adapter picks up settings changes without a runtime restart. */
  prefsLoader: () => Promise<RunnerPrefs | undefined>;
  /**
   * Resolve the shared app-engine dispatcher. The chat adapter threads
   * this into the per-turn `ToolContext` so the agent's three structured
   * tools dispatch through the same code path as HTTP callers. Hosts
   * typically return `runtime.dispatcher`. Called per turn so a host can
   * cycle-break on first use (see local-runtime).
   */
  getDispatcher: () => Dispatcher;
}

export function makeConversationRunner(opts: MakeConversationRunnerOptions): ConversationRunner {
  return makeConversationRunnerCore({
    prefsLoader: opts.prefsLoader,
    getDispatcher: opts.getDispatcher,
    // The local codex/claude turn driver.
    runTurn: runTurn,
    // Data chat runs in the app's data dir; the route preamble is passed
    // through unchanged (no authoring grounding) and there's no post-turn
    // side effect, so those seams are left at their defaults.
    resolveCwd: (input) => input.dataDir,
  });
}
