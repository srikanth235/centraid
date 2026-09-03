import type { Dispatcher } from "../handlers/dispatcher.js";
import type { ModelSubsystem } from "../stores/prefs-store.js";
import type { HarnessHealthController } from "./harness-health.js";
import type { ProviderEgressConsentController } from "./provider-egress-consent.js";
import type { ConversationTurnInput } from "./runner.js";
import type { RunKind } from "./schema.js";
import type {
  HarnessKind,
  HarnessPrefs,
  RunTurnFn,
  VaultContentRunner,
  VaultInvokeRunner,
  VaultSqlRunner,
} from "./turn.js";

export interface TurnContext {
  input: ConversationTurnInput;
  prefs: HarnessPrefs;
  cwd: string;
}

export interface ConversationRunnerCoreOptions {
  prefsLoader: (
    subsystem?: ModelSubsystem,
    harnessKind?: HarnessKind
  ) => Promise<HarnessPrefs | undefined>;
  subsystem?: ModelSubsystem;
  getDispatcher: () => Dispatcher;
  resolveCwd: (input: ConversationTurnInput) => Promise<string> | string;
  buildExtraSystemPrompt?: (ctx: TurnContext) => Promise<string> | string;
  onTurnComplete?: (ctx: TurnContext) => Promise<void> | void;
  extraPath?: string;
  cwdIsDraftWorktree?:
    | boolean
    | ((input: ConversationTurnInput, cwd: string) => boolean);
  vaultSql?: () => VaultSqlRunner;
  vaultInvoke?: () => VaultInvokeRunner;
  vaultContent?: () => VaultContentRunner;
  runTurn: RunTurnFn;
  runKind?: RunKind;
  harnessLadder?: (
    subsystem: ModelSubsystem | undefined,
    primary: HarnessKind
  ) => Promise<readonly HarnessKind[]> | readonly HarnessKind[];
  harnessHealth?: HarnessHealthController;
  harnessHealthContext?: (input: ConversationTurnInput, cwd: string) => string;
  providerEgressConsent: ProviderEgressConsentController;
  onFailover?: (event: {
    conversationId: string;
    subsystem?: ModelSubsystem;
    from: HarnessKind;
    to: HarnessKind;
  }) => void;
}
