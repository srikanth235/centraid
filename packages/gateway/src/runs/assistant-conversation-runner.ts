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
  type ModelSubsystem,
  type RunnerPrefs,
  type RunTurnFn,
  type VaultInvokeRunner,
  type VaultContentRunner,
  type VaultSqlRunner,
} from '@centraid/app-engine';
import type { VaultRegistry } from '../serve/vault-registry.js';

export interface AssistantConversationRunnerOptions {
  /** Per-turn runner prefs (kind + provider) — same loader app chat uses.
   *  Receives `subsystem` so a host that pins a runner per subsystem answers
   *  with THIS register's kind (assistant and ask are separate pins). */
  prefsLoader: (subsystem?: ModelSubsystem) => Promise<RunnerPrefs | undefined>;
  /** Which subsystem's runner/model prefs these turns ride. The gateway
   *  builds this factory twice — `'assistant'` for the shell register and
   *  `'ask'` for the per-app copilot; unset → the host's default agent. */
  subsystem?: ModelSubsystem;
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
  return path.join(vaults.currentWorkspace().runnerSessionDir, 'assistant-cwd');
}

/**
 * The vault-register tool runners, shared by every register that carries
 * them (assistant, ask, and — issue #286 phase 2 — the builder): reads are
 * the owner's `vault_sql`; writes ride the enrolled `_assistant` agent,
 * so confirm-gated (Tier 3/4, issue #306) commands park for the owner
 * instead of executing.
 */
export function makeVaultToolRunners(vaults: VaultRegistry): {
  vaultSql: () => VaultSqlRunner;
  vaultInvoke: () => VaultInvokeRunner;
  vaultContent: () => VaultContentRunner;
} {
  return {
    vaultSql: () => (sql: string) => {
      const result = vaults.current().sqlAsOwner(sql);
      // The receipt id stays gateway-side; the model gets rows + caps only.
      const { receiptId: _receiptId, ...rows } = result;
      return rows;
    },
    vaultInvoke: () => (call) =>
      vaults.current().invokeAsAssistant({
        command: call.command,
        input: call.input,
        purpose: 'dpv:ServiceProvision',
      }),
    // Document-text reads (issue #299): "walk me through this contract"
    // resolves the text variant, receipted; the receipt id stays here.
    vaultContent: () => async (call) => {
      const result = (await vaults.current().contentAsOwner(call)) as Record<string, unknown>;
      const { receiptId: _receiptId, ...rest } = result;
      return rest;
    },
  };
}

export function makeAssistantConversationRunner(
  opts: AssistantConversationRunnerOptions,
): ConversationRunner {
  const { vaultSql, vaultInvoke, vaultContent } = makeVaultToolRunners(opts.vaults);

  return makeConversationRunnerCore({
    prefsLoader: opts.prefsLoader,
    ...(opts.subsystem ? { subsystem: opts.subsystem } : {}),
    getDispatcher: opts.getDispatcher,
    runTurn: opts.runTurn ?? runTurn,
    vaultSql,
    vaultInvoke,
    vaultContent,
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
