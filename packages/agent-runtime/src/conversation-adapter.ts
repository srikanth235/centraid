/*
 * Chat adapter — the per-app data chat layer on top of the engine.
 *
 * This is the data-only `ConversationRunner`: the turn runs with cwd =
 * `input.dataDir` (the resolved `appDataDir(entry)` — `<appsDir>/<id>` for
 * uploaded apps, the external folder for path-registered ones), the three
 * first-class `centraid_sql_*` tools declared inline against the per-app
 * `data.sqlite`, and the route's app-context preamble passed through
 * verbatim (it already describes those tools + the `_sql` built-in). No
 * draft worktree, no authoring grounding, no post-turn side effects —
 * those are the builder chat's job (`makeUnifiedConversationRunner`).
 *
 * It is a thin config over `makeConversationRunnerCore` (issue #147, Concern 1):
 * the shared per-turn spine lives there; this file only supplies the
 * data-chat seams (cwd = data dir, default prompt pass-through).
 *
 * Note: this is one of two in-process `ConversationRunner` implementations. The
 * other (`makeUnifiedConversationRunner`, gateway) is also a config over the same
 * core; a third lives in `@centraid/openclaw-plugin` and drives an
 * in-process openclaw agent.
 */

import type { ConversationRunner, Dispatcher } from '@centraid/app-engine';
import { makeConversationRunnerCore } from '@centraid/conversation-engine';
import { runAgentTurn } from './runtime.js';
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
    runTurn: runAgentTurn,
    // Data chat runs in the app's data dir; the route preamble is passed
    // through unchanged (no authoring grounding) and there's no post-turn
    // side effect, so those seams are left at their defaults.
    resolveCwd: (input) => input.dataDir,
  });
}
