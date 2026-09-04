/*
 * Vault-assistant config over `makeConversationRunnerCore`. Tools: host-side
 * `vault_sql` with the active vault's owner credential. cwd: empty per-vault
 * scratch (`harness-sessions/assistant-cwd`). Writes ride `_assistant` so
 * confirm-gated commands park (#306).
 */

import { promises as fs } from "node:fs";
import path from "node:path";

import { runTurn } from "@centraid/server/acp";
import { makeConversationRunnerCore } from "@centraid/server/engine";
import type {
  ConversationRunner,
  ConversationTurnInput,
  Dispatcher,
  ModelSubsystem,
  HarnessKind,
  HarnessPrefs,
  RunTurnFn,
  HarnessHealthController,
  ProviderEgressConsentController,
  VaultInvokeRunner,
  VaultContentRunner,
  VaultSqlRunner,
} from "@centraid/server/engine";

import type { VaultRegistry } from "../serve/vault-registry.js";

export interface AssistantConversationRunnerOptions {
  prefsLoader: (
    subsystem?: ModelSubsystem,
    harnessKind?: HarnessKind
  ) => Promise<HarnessPrefs | undefined>;
  /** Gateway builds this twice: `'assistant'` (shell) and `'ask'` (per-app). */
  subsystem?: ModelSubsystem;
  getDispatcher: () => Dispatcher;
  vaults: VaultRegistry;
  buildPrompt?: (input: ConversationTurnInput) => Promise<string> | string;
  runTurn?: RunTurnFn;
  harnessLadder?: (
    subsystem: ModelSubsystem | undefined,
    primary: HarnessKind
  ) => Promise<readonly HarnessKind[]> | readonly HarnessKind[];
  harnessHealth?: HarnessHealthController;
  harnessHealthContext?: (input: ConversationTurnInput, cwd: string) => string;
  providerEgressConsent: ProviderEgressConsentController;
  onFailover?: Parameters<typeof makeConversationRunnerCore>[0]["onFailover"];
}

export function assistantCwd(vaults: VaultRegistry): string {
  return path.join(
    vaults.currentWorkspace().harnessSessionDir,
    "assistant-cwd"
  );
}

export function makeVaultToolRunners(vaults: VaultRegistry): {
  vaultSql: () => VaultSqlRunner;
  vaultInvoke: () => VaultInvokeRunner;
  vaultContent: () => VaultContentRunner;
} {
  return {
    vaultSql: () => (sql: string) => {
      const result = vaults.current().sqlAsAssistant(sql);
      // Receipt id stays gateway-side; the model gets rows + caps only.
      const { receiptId: _receiptId, ...rows } = result;
      return rows;
    },
    vaultInvoke: () => (call) =>
      vaults.current().invokeAsAssistant({
        command: call.command,
        input: call.input,
        purpose: "dpv:ServiceProvision",
      }),
    vaultContent: () => async (call) => {
      const result = (await vaults.current().contentAsOwner(call)) as Record<
        string,
        unknown
      >;
      const { receiptId: _receiptId, ...rest } = result;
      return rest;
    },
  };
}

export function makeAssistantConversationRunner(
  opts: AssistantConversationRunnerOptions
): ConversationRunner {
  const { vaultSql, vaultInvoke, vaultContent } = makeVaultToolRunners(
    opts.vaults
  );

  return makeConversationRunnerCore({
    prefsLoader: opts.prefsLoader,
    ...(opts.subsystem ? { subsystem: opts.subsystem } : {}),
    getDispatcher: opts.getDispatcher,
    runTurn: opts.runTurn ?? runTurn,
    ...(opts.harnessLadder ? { harnessLadder: opts.harnessLadder } : {}),
    ...(opts.harnessHealth ? { harnessHealth: opts.harnessHealth } : {}),
    ...(opts.harnessHealthContext
      ? { harnessHealthContext: opts.harnessHealthContext }
      : {}),
    providerEgressConsent: opts.providerEgressConsent,
    ...(opts.onFailover ? { onFailover: opts.onFailover } : {}),
    vaultSql,
    vaultInvoke,
    vaultContent,
    ...(opts.buildPrompt
      ? { buildExtraSystemPrompt: ({ input }) => opts.buildPrompt!(input) }
      : {}),
    resolveCwd: async (input) => {
      const cwd = input.workspaceDirectory ?? assistantCwd(opts.vaults);
      await fs.mkdir(cwd, { recursive: true }).catch(() => undefined);
      return cwd;
    },
  });
}
