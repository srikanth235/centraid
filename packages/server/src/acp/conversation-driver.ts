/*
 * Data-chat config over `makeConversationRunnerCore` (#147). cwd =
 * `input.dataDir`; no vault runners, no draft worktree, no post-turn side
 * effects (those belong to `makeUnifiedConversationRunner`).
 */

import { makeConversationRunnerCore } from "@centraid/server/engine";
import type {
  ConversationRunner,
  Dispatcher,
  ModelSubsystem,
  ProviderEgressConsentController,
} from "@centraid/server/engine";

import { runTurn } from "./runtime.js";
import type { HarnessKind, HarnessPrefs } from "./types.js";

export interface MakeConversationRunnerOptions {
  prefsLoader: (
    subsystem?: ModelSubsystem,
    harnessKind?: HarnessKind
  ) => Promise<HarnessPrefs | undefined>;
  subsystem?: ModelSubsystem;
  /** Per turn so a host can cycle-break on first use (local-runtime). */
  getDispatcher: () => Dispatcher;
  providerEgressConsent: ProviderEgressConsentController;
}

export function makeConversationRunner(
  opts: MakeConversationRunnerOptions
): ConversationRunner {
  return makeConversationRunnerCore({
    prefsLoader: opts.prefsLoader,
    ...(opts.subsystem ? { subsystem: opts.subsystem } : {}),
    getDispatcher: opts.getDispatcher,
    providerEgressConsent: opts.providerEgressConsent,
    runTurn,
    resolveCwd: (input) => input.dataDir,
  });
}
