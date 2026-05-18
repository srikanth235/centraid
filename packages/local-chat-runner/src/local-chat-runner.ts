/*
 * Top-level `ChatRunner` for the desktop's embedded local runtime.
 *
 * Picks an adapter (Codex / Claude Code) based on the user's persisted
 * `chat.runner.kind` pref, then drives one turn. Adapter-assigned session
 * ids are persisted to the per-window `ChatStore` so subsequent turns
 * resume the same CLI session.
 *
 * The local-runtime host wires this up in `Runtime({ chatRunner: ... })`.
 * The route handler in `runtime-core` calls `run()` per inbound POST.
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
   * Optional override for the MCP-server script path. Defaults to the
   * built `centraid-mcp-server.js` colocated with this module.
   */
  mcpServerScript?: string;
  /** Optional override for the node binary used to spawn the MCP server. */
  nodeBin?: string;
}

export function defaultMcpServerScript(): string {
  // `import.meta.url` resolves to .../dist/local-chat-runner.js at runtime.
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), 'centraid-mcp-server.js');
}

export function makeLocalChatRunner(opts: MakeLocalChatRunnerOptions): ChatRunner {
  const script = opts.mcpServerScript ?? defaultMcpServerScript();
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
        mcpServerScript: script,
        ...(opts.nodeBin ? { nodeBin: opts.nodeBin } : {}),
        prefs,
      };

      // Look up any prior adapter session id so we can pass `--resume` /
      // `--session`. Mid-window kind switch drops the stale id — claude
      // session ids aren't portable to codex and vice versa.
      const appDir = path.join(opts.appsDir, input.appId);
      const store = new ChatStore(appDir);
      const window = await store.getWindow(input.windowId).catch(() => undefined);
      const adapterKind = prefs.kind;
      const resumeId =
        window && window.adapterKind === adapterKind ? window.adapterSessionId : undefined;

      if (prefs.kind === 'codex') {
        const result = await runCodexTurn({ ctx, input }, resumeId);
        return {
          adapterKind,
          ...(result.threadId ? { adapterSessionId: result.threadId } : {}),
        };
      }
      const result = await runClaudeTurn({ ctx, input }, resumeId);
      return {
        adapterKind,
        ...(result.sessionId ? { adapterSessionId: result.sessionId } : {}),
      };
    },
  };
}
