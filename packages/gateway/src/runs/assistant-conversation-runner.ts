/*
 * The vault assistant's conversation runner — the owner-register config
 * over `makeConversationRunnerCore` (the same spine app chat and builder
 * chat ride). What differs from the app registers:
 *
 *   - tools: `ToolContext.vaultSql` is set, so both backends swap the
 *     app-scoped `centraid_*` trio for the ONE `vault_sql` tool, executed
 *     host-side with the ACTIVE vault's owner-device credential;
 *   - cwd: an empty per-vault scratch dir (`runner-sessions/assistant-cwd`)
 *     — the assistant has no app worktree and its native file tools have
 *     nothing meaningful to touch;
 *   - prompt: the route assembles the full assistant preamble (register +
 *     answer format + live vault map); the runner passes it through.
 *
 * Provider-agnostic like every runner here: prefs pick codex/claude per
 * turn, and the injected `runTurn` drives whichever is configured.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';
import { runTurn } from '@centraid/agent-runtime';
import {
  makeConversationRunnerCore,
  type ConversationRunner,
  type ConversationTurnInput,
  type Dispatcher,
  type RunnerPrefs,
  type RunTurnFn,
  type VaultInvokeRunner,
  type VaultSqlRunner,
} from '@centraid/app-engine';
import type { VaultRegistry } from '../serve/vault-registry.js';

export interface AssistantConversationRunnerOptions {
  /** Per-turn runner prefs (kind + provider) — same loader app chat uses. */
  prefsLoader: () => Promise<RunnerPrefs | undefined>;
  /** The shared dispatcher — required by ToolContext; unused on this register. */
  getDispatcher: () => Dispatcher;
  /** The vault registry; every turn resolves the ACTIVE vault through it. */
  vaults: VaultRegistry;
  /**
   * Build the turn's preamble. The shell assistant route assembles its own
   * and passes it through (the default); the per-app ask register injects
   * one that composes the assistant prompt + the app lens per turn.
   */
  buildPrompt?: (input: ConversationTurnInput) => Promise<string> | string;
  /** Turn driver — defaults to `runTurn`; injected in tests. */
  runTurn?: RunTurnFn;
}

/** The active vault's scratch cwd for assistant turns. */
export function assistantCwd(vaults: VaultRegistry): string {
  return path.join(vaults.activeWorkspace().runnerSessionDir, 'assistant-cwd');
}

export function makeAssistantConversationRunner(
  opts: AssistantConversationRunnerOptions,
): ConversationRunner {
  const vaultSql: () => VaultSqlRunner = () => (sql: string) => {
    const result = opts.vaults.active().sqlAsOwner(sql);
    // The receipt id stays gateway-side; the model gets rows + caps only.
    const { receiptId: _receiptId, ...rows } = result;
    return rows;
  };
  // Writes ride the enrolled `_assistant` agent (medium risk ceiling), so
  // high-risk commands park for the owner instead of executing.
  const vaultInvoke: () => VaultInvokeRunner = () => (call) =>
    opts.vaults.active().invokeAsAssistant({
      command: call.command,
      input: call.input,
      purpose: 'dpv:ServiceProvision',
    });

  return makeConversationRunnerCore({
    prefsLoader: opts.prefsLoader,
    getDispatcher: opts.getDispatcher,
    runTurn: opts.runTurn ?? runTurn,
    vaultSql,
    vaultInvoke,
    ...(opts.buildPrompt
      ? { buildExtraSystemPrompt: ({ input }) => opts.buildPrompt!(input) }
      : {}),
    resolveCwd: async () => {
      const cwd = assistantCwd(opts.vaults);
      await fs.mkdir(cwd, { recursive: true }).catch(() => undefined);
      return cwd;
    },
  });
}
