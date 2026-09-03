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
