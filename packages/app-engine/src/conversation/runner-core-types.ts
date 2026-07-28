/** Per-turn context handed to the injected `buildExtraSystemPrompt` /
 *  `onTurnComplete` seams once prefs are loaded and the cwd is resolved. */
import type { Dispatcher } from '../handlers/dispatcher.js';
import type { ModelSubsystem } from '../stores/prefs-store.js';
import type { ProviderEgressConsentController } from './provider-egress-consent.js';
import type { RunnerHealthController } from './runner-health.js';
import type { ConversationTurnInput } from './runner.js';
import type { RunKind } from './schema.js';
import type {
  RunnerKind,
  RunnerPrefs,
  RunTurnFn,
  VaultContentRunner,
  VaultInvokeRunner,
  VaultSqlRunner,
} from './turn.js';

export interface TurnContext {
  input: ConversationTurnInput;
  prefs: RunnerPrefs;
  /** The working dir this turn runs in (data dir, or draft worktree). */
  cwd: string;
}

export interface ConversationRunnerCoreOptions {
  /**
   * Loader for the user's persisted runner prefs. Called per turn so the
   * runner picks up settings changes without a runtime restart — including a
   * change to WHICH runner this register rides, since the loader resolves
   * `runner.<subsystem>` fresh on every call.
   *
   * The `subsystem` argument is this register's identity (`opts.subsystem`),
   * so a host that scopes runner selection per subsystem can answer with the
   * right kind. Optional on both sides: hosts with one global runner ignore
   * it, and a runner built without `subsystem` calls the loader bare — which
   * is exactly the pre-existing behavior.
   */
  prefsLoader: (
    subsystem?: ModelSubsystem,
    runnerKind?: RunnerKind,
  ) => Promise<RunnerPrefs | undefined>;
  /**
   * Which subsystem's prefs this runner rides — passed to `prefsLoader` on
   * every turn. Left unset by registers with no per-subsystem identity
   * (the data-only chat adapter), which then inherit the host default.
   */
  subsystem?: ModelSubsystem;
  /**
   * Resolve the shared app-engine dispatcher. Threaded into the per-turn
   * `ToolContext` so the agent's structured tools dispatch through the same
   * code path as HTTP callers. Hosts typically return `runtime.dispatcher`.
   * Called per turn so a host can cycle-break on first use.
   */
  getDispatcher: () => Dispatcher;
  /**
   * Resolve the working dir for the turn. Data chat returns `input.dataDir`;
   * builder chat opens (or reuses) the app's draft session worktree and
   * returns its app dir.
   */
  resolveCwd: (input: ConversationTurnInput) => Promise<string> | string;
  /**
   * Build the final extra-system-prompt. Defaults to passing
   * `input.extraSystemPrompt` (the route's data/schema preamble) through
   * unchanged. Builder chat folds the authoring grounding in on top.
   */
  buildExtraSystemPrompt?: (ctx: TurnContext) => Promise<string> | string;
  /**
   * Post-turn side effect, run after the turn settles and before the result
   * is returned. Best-effort — a throw is swallowed and never fails the turn
   * (builder chat mints webhook secrets here).
   */
  onTurnComplete?: (ctx: TurnContext) => Promise<void> | void;
  /** Extra PATH entry (the bundled `centraid` CLI dir) for the spawned
   *  agent. Builder chat sets it; data chat leaves it unset. */
  extraPath?: string;
  /**
   * When true, `resolveCwd` returns a draft session worktree (code + its
   * branched `data.sqlite`), so the turn's `ToolContext.overrideCodeDir` is
   * pinned to it: the agent's `centraid_*` tools then hit the draft's
   * handlers and branched data, not live (issue #144). Builder chat sets it;
   * the data-only backend leaves it false (cwd is the live data dir, no
   * draft to override to).
   */
  cwdIsDraftWorktree?: boolean | ((input: ConversationTurnInput, cwd: string) => boolean);
  /**
   * The vault-assistant register (issue: shell-level vault Q&A). When set,
   * each turn's `ToolContext` carries this owner-side `vault_sql` runner and
   * the adapters swap the app-scoped `centraid_*` trio for the one vault
   * tool. Resolved per turn so it always rides the ACTIVE vault.
   */
  vaultSql?: () => VaultSqlRunner;
  /** The write half of the vault register — resolved per turn like `vaultSql`. */
  vaultInvoke?: () => VaultInvokeRunner;
  /** Document-text access (issue #299) — resolved per turn like `vaultSql`. */
  vaultContent?: () => VaultContentRunner;
  /**
   * The model turn driver. agent-runtime injects its codex/claude
   * `runTurn`; tests inject a stub. Required — this spine is
   * backend-agnostic and never imports a concrete backend.
   */
  runTurn: RunTurnFn;
  /**
   * The ledger `RunKind` turns through this runner persist as, surfaced on
   * the built `ConversationRunner` for the route to read. Builder chat sets `'build'`;
   * data chat leaves it unset (the route defaults to `'chat'`) — issue #181.
   */
  runKind?: RunKind;
  /**
   * Ordered turn-boundary failover candidates. The selected runner remains
   * first; hosts commonly resolve this from `runner.ladder.<subsystem>`.
   */
  runnerLadder?: (
    subsystem: ModelSubsystem | undefined,
    primary: RunnerKind,
  ) => Promise<readonly RunnerKind[]> | readonly RunnerKind[];
  /** Persistent workspace-scoped breaker controller. */
  runnerHealth?: RunnerHealthController;
  /** Stable health scope. Defaults to the resolved cwd. */
  runnerHealthContext?: (input: ConversationTurnInput, cwd: string) => string;
  /** Hard conversation × provider egress gate. */
  providerEgressConsent?: ProviderEgressConsentController;
  /** Host alert seam for unattended/manual boundary failover selection. */
  onFailover?: (event: {
    conversationId: string;
    subsystem?: ModelSubsystem;
    from: RunnerKind;
    to: RunnerKind;
  }) => void;
}
