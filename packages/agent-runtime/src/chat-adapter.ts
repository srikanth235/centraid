/*
 * Chat adapter — the per-app data chat layer on top of the engine.
 *
 * This is the data-only `ChatRunner`: the turn runs with cwd =
 * `input.dataDir` (the resolved `appDataDir(entry)` — `<appsDir>/<id>` for
 * uploaded apps, the external folder for path-registered ones), the three
 * first-class `centraid_sql_*` tools declared inline against the per-app
 * `data.sqlite`, and the route's app-context preamble passed through
 * verbatim (it already describes those tools + the `_sql` built-in). No
 * draft worktree, no authoring grounding, no post-turn side effects —
 * those are the builder chat's job (`makeUnifiedChatRunner`).
 *
 * It is a thin config over `makeChatRunnerCore` (issue #147, Concern 1):
 * the shared per-turn spine lives there; this file only supplies the
 * data-chat seams (cwd = data dir, default prompt pass-through).
 *
 * Note: this is one of two in-process `ChatRunner` implementations. The
 * other (`makeUnifiedChatRunner`, gateway) is also a config over the same
 * core; a third lives in `@centraid/openclaw-plugin` and drives an
 * in-process openclaw agent.
 */

import type { ChatRunner, Dispatcher } from '@centraid/app-engine';
import { makeChatRunnerCore } from './chat-runner-core.js';
import type { RunnerPrefs } from './types.js';

export interface MakeChatRunnerOptions {
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
  return makeChatRunnerCore({
    prefsLoader: opts.prefsLoader,
    getDispatcher: opts.getDispatcher,
    ...(opts.codexHomeBaseDir ? { codexHomeBaseDir: opts.codexHomeBaseDir } : {}),
    // Data chat runs in the app's data dir; the route preamble is passed
    // through unchanged (no authoring grounding) and there's no post-turn
    // side effect, so those seams are left at their defaults.
    resolveCwd: (input) => input.dataDir,
  });
}
