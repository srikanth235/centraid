/** Builder chat: the data-chat spine plus three seams — DRAFT-worktree cwd, a unified authoring prompt, post-turn webhook minting. Ext changes are DECLARED in the draft manifest and mirrored to the vault's draft band, so preview data stays scratch until Publish (#141, #147, #286). */

import { promises as fs } from "node:fs";
import path from "node:path";

import { defaultCentraidCliDir, runTurn } from "@centraid/server/acp";
import {
  provisionAppPendingWebhooks,
  WEBHOOK_ROUTE_PREFIX,
} from "@centraid/server/automation";
import { makeConversationRunnerCore } from "@centraid/server/engine";
import type {
  ConversationTurnInput,
  ConversationRunner,
  TurnStreamEvent,
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

import { ensureDraftBand } from "../lifecycle/ext-band.js";
import type { ExtBandOps } from "../lifecycle/ext-band.js";
import { ensureSession } from "../lifecycle/lifecycle-shared.js";
import { buildAuthoringExtraPrompt } from "../skills/index.js";
import type { WorktreeStore } from "../worktree-store/index.js";

export { type RunTurnFn } from "@centraid/server/engine";

export interface UnifiedConversationRunnerOptions {
  store: WorktreeStore;
  prefsLoader: (
    subsystem?: ModelSubsystem,
    harnessKind?: HarnessKind
  ) => Promise<HarnessPrefs | undefined>;
  subsystem?: ModelSubsystem;
  getDispatcher: () => Dispatcher;
  /** A thunk: the ephemeral port is only known after the server starts. */
  publicBaseUrl: () => string;
  ext?: ExtBandOps;
  vaultSql?: () => VaultSqlRunner;
  /** Rides the `_assistant` agent — high-risk commands park as usual. */
  vaultInvoke?: () => VaultInvokeRunner;
  vaultContent?: () => VaultContentRunner;
  sessionIdFor?: (appId: string) => string;
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

function defaultSessionIdFor(appId: string): string {
  return `chat-${appId}`;
}

async function readAppKind(appDir: string): Promise<"app" | "automation"> {
  try {
    const raw = await fs.readFile(path.join(appDir, "app.json"), "utf8");
    const parsed = JSON.parse(raw) as { kind?: unknown };
    return parsed.kind === "automation" ? "automation" : "app";
  } catch {
    return "app";
  }
}

/**
 * The harness can't generate crypto-random credentials, so an authored webhook
 * stages `pending: true` and mints here. Best-effort — never fails the turn.
 */
async function mintPendingWebhooks(
  cwd: string,
  publicBaseUrl: () => string,
  onEvent: (event: TurnStreamEvent) => void
): Promise<void> {
  const minted = await provisionAppPendingWebhooks(cwd);
  if (minted.length === 0) return;
  const base = publicBaseUrl();
  onEvent({
    type: "webhooks",
    minted: minted.map((w) => ({
      automationId: w.automationId,
      ownerApp: w.ownerApp,
      webhookId: w.webhookId,
      url: `${base}${WEBHOOK_ROUTE_PREFIX}/${w.webhookId}`,
      secret: w.secret,
    })),
  });
}

export function makeUnifiedConversationRunner(
  opts: UnifiedConversationRunnerOptions
): ConversationRunner {
  const sessionIdFor = opts.sessionIdFor ?? defaultSessionIdFor;
  const extraPath = defaultCentraidCliDir();

  return makeConversationRunnerCore({
    prefsLoader: opts.prefsLoader,
    ...(opts.subsystem ? { subsystem: opts.subsystem } : {}),
    getDispatcher: opts.getDispatcher,
    ...(extraPath ? { extraPath } : {}),

    runKind: "build",
    runTurn: opts.runTurn ?? runTurn,
    ...(opts.harnessLadder ? { harnessLadder: opts.harnessLadder } : {}),
    ...(opts.harnessHealth ? { harnessHealth: opts.harnessHealth } : {}),
    ...(opts.harnessHealthContext
      ? { harnessHealthContext: opts.harnessHealthContext }
      : {}),
    providerEgressConsent: opts.providerEgressConsent,
    ...(opts.onFailover ? { onFailover: opts.onFailover } : {}),

    cwdIsDraftWorktree: (input) =>
      input.workspaceKind === undefined || input.workspaceKind === "draft",

    ...(opts.vaultSql ? { vaultSql: opts.vaultSql } : {}),
    ...(opts.vaultInvoke ? { vaultInvoke: opts.vaultInvoke } : {}),
    ...(opts.vaultContent ? { vaultContent: opts.vaultContent } : {}),

    resolveCwd: async (input) => {
      if (input.workspaceDirectory) return input.workspaceDirectory;
      const sessionId = input.draftSessionId ?? sessionIdFor(input.appId);
      await ensureSession(opts.store, sessionId);
      const worktreeAppDir = await opts.store.snapshotSessionAppDir(
        sessionId,
        input.appId
      );
      if (opts.ext)
        await ensureDraftBand(opts.ext, input.appId, worktreeAppDir);
      return worktreeAppDir;
    },

    buildExtraSystemPrompt: async ({ input, cwd }) =>
      buildAuthoringExtraPrompt({
        baseExtra: input.extraSystemPrompt,
        appKind: await readAppKind(cwd),
      }),

    onTurnComplete: ({ input, cwd }) =>
      mintPendingWebhooks(cwd, opts.publicBaseUrl, input.onEvent),
  });
}
