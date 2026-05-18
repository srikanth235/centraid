/*
 * Top-level `ChatRunner` for the desktop's embedded local runtime.
 *
 * Picks an adapter (Codex / Claude Code) based on the user's persisted
 * `chat.runner.kind` pref, then drives one turn. Adapter-assigned
 * session ids are persisted to the per-window `ChatStore` so subsequent
 * turns resume the same CLI session.
 *
 * Codex talks to a small `centraid` CLI bin (shipped by this package)
 * directly via shell — no MCP server, no network, no token plumbing.
 * The CLI operates on `./data.sqlite` and codex is spawned with cwd
 * pinned to `<appsDir>/<appId>`.
 *
 * Claude Code keeps its existing stdio-MCP wiring — this iteration's
 * empirical verification + simplification work targets codex.
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
import type { AdapterCtx, RunnerPrefs } from './types.js';

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
  // `import.meta.url` resolves to .../dist/local-chat-runner.js at runtime.
  return path.dirname(fileURLToPath(import.meta.url));
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
      const ctx: AdapterCtx = {
        appsDir: opts.appsDir,
        prefs,
      };

      const appDir = path.join(opts.appsDir, input.appId);
      const store = new ChatStore(appDir);
      const window = await store.getWindow(input.windowId).catch(() => undefined);
      const adapterKind = prefs.kind;
      const resumeId =
        window && window.adapterKind === adapterKind ? window.adapterSessionId : undefined;

      if (prefs.kind === 'codex') {
        const result = await runCodexTurn({ ctx, input }, resumeId, {
          appsDir: opts.appsDir,
          centraidCliDir,
        });
        return {
          adapterKind,
          ...(result.threadId ? { adapterSessionId: result.threadId } : {}),
        };
      }
      const result = await runClaudeTurn({ ctx, input }, resumeId, {
        appsDir: opts.appsDir,
        centraidCliDir,
      });
      return {
        adapterKind,
        ...(result.sessionId ? { adapterSessionId: result.sessionId } : {}),
      };
    },
  };
}
