/* Injection surface for the harness-agnostic conversation spine. */
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
  /** Data dir, or draft worktree. */
  cwd: string;
}

export interface ConversationRunnerCoreOptions {
  /** Call per turn: settings changes, including which harness, apply live. */
  prefsLoader: (
    subsystem?: ModelSubsystem,
    harnessKind?: HarnessKind
  ) => Promise<HarnessPrefs | undefined>;
  /** Unset means no per-subsystem identity: inherit the host default. */
  subsystem?: ModelSubsystem;
  /** Called per turn so a host can cycle-break on first use. */
  getDispatcher: () => Dispatcher;
  resolveCwd: (input: ConversationTurnInput) => Promise<string> | string;
  /** Defaults to passing `input.extraSystemPrompt` through unchanged. */
  buildExtraSystemPrompt?: (ctx: TurnContext) => Promise<string> | string;
  /** Best-effort: a throw is swallowed and never fails the turn. */
  onTurnComplete?: (ctx: TurnContext) => Promise<void> | void;
  extraPath?: string;
  /** True pins `ToolContext.overrideCodeDir` to the draft, not live (#144). */
  cwdIsDraftWorktree?:
    | boolean
    | ((input: ConversationTurnInput, cwd: string) => boolean);
  /**
   * Set swaps the app-scoped `centraid_*` trio for the vault tools. Resolve
   * all three per turn so they ride the ACTIVE vault.
   */
  vaultSql?: () => VaultSqlRunner;
  vaultInvoke?: () => VaultInvokeRunner;
  vaultContent?: () => VaultContentRunner;
  /** Injected: this spine never imports a concrete harness runtime. */
  runTurn: RunTurnFn;
  /** Unset lets the route default to `'chat'` (#181). */
  runKind?: RunKind;
  /** Ordered failover candidates; the selected harness must remain first. */
  harnessLadder?: (
    subsystem: ModelSubsystem | undefined,
    primary: HarnessKind
  ) => Promise<readonly HarnessKind[]> | readonly HarnessKind[];
  harnessHealth?: HarnessHealthController;
  /** Stable health scope. Defaults to the resolved cwd. */
  harnessHealthContext?: (input: ConversationTurnInput, cwd: string) => string;
  providerEgressConsent: ProviderEgressConsentController;
  onFailover?: (event: {
    conversationId: string;
    subsystem?: ModelSubsystem;
    from: HarnessKind;
    to: HarnessKind;
  }) => void;
}
