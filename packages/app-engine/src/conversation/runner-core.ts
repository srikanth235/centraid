/*
 * Chat-runner core — the one place the per-turn chat loop lives.
 *
 * It sits next to the `ConversationRunner` interface and the agent-turn
 * contract it wires together, both of which live here in app-engine. The
 * actual model turn is injected as a `RunTurnFn` (`runTurn`) — agent-runtime
 * passes its codex/claude `runTurn`; tests pass a stub. Every
 * `ConversationRunner` the gateway's `/_turn` route can inject does the same
 * thing around that turn: load prefs, resolve a cwd, build the system prompt,
 * thread the `centraid_*` dispatcher into a `ToolContext`, resume when the
 * prior turn used the same runner kind, drive the turn, and (optionally) run a
 * post-turn side effect. That spine used to be copied into both
 * `makeConversationRunner` (agent-runtime, data-only chat) and the gateway's
 * `makeUnifiedConversationRunner` (code+data builder chat); they now differ
 * only by the four injected seams below (issue #147, Concern 1):
 *
 *   - `resolveCwd`            — data chat returns `input.dataDir`; builder
 *                              chat opens the app's draft worktree.
 *   - `buildExtraSystemPrompt` — defaults to passing the route's preamble
 *                              through unchanged; builder chat folds in the
 *                              authoring grounding (owned by the gateway's `src/skills/`).
 *   - `onTurnComplete`        — builder chat mints webhook secrets here.
 *   - `extraPath`             — builder chat puts the bundled `centraid` CLI
 *                              on the agent's PATH; data chat doesn't.
 *
 * Backend-agnostic by construction: the model turn (`runTurn`) is injected, so
 * this spine never imports a concrete agent backend.
 */

import { randomUUID } from 'node:crypto';
import type { Dispatcher } from '../handlers/dispatcher.js';
import type { ModelSubsystem } from '../stores/prefs-store.js';
import type { RunKind } from './schema.js';
import type {
  AgentFailureClass,
  ConversationRunner,
  ConversationTurnInput,
  ConversationTurnResult,
  TurnStreamEvent,
} from './runner.js';
import type { RunnerHealthController } from './runner-health.js';
import type { ProviderEgressConsentController } from './provider-egress-consent.js';
import type {
  RunnerKind,
  RunnerPrefs,
  RunTurnFn,
  ToolContext,
  TurnInput,
  TurnResult,
  VaultInvokeRunner,
  VaultContentRunner,
  VaultSqlRunner,
} from './turn.js';

/** Per-turn context handed to the injected `buildExtraSystemPrompt` /
 *  `onTurnComplete` seams once prefs are loaded and the cwd is resolved. */
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

/**
 * Build a `ConversationRunner` from the shared spine plus the injected seams. Both
 * the data-only `makeConversationRunner` and the gateway's `makeUnifiedConversationRunner`
 * are thin configs over this.
 */
export function makeConversationRunnerCore(
  opts: ConversationRunnerCoreOptions,
): ConversationRunner {
  const runTurn = opts.runTurn;

  return {
    ...(opts.runKind ? { runKind: opts.runKind } : {}),
    resolveRunnerKind: async (): Promise<RunnerKind | undefined> =>
      (await opts.prefsLoader(opts.subsystem))?.kind,
    async run(input: ConversationTurnInput): Promise<ConversationTurnResult> {
      const loadedPrefs = input.runnerKind
        ? await opts.prefsLoader(opts.subsystem, input.runnerKind)
        : await opts.prefsLoader(opts.subsystem);
      if (!loadedPrefs) {
        input.onEvent({
          type: 'error',
          message:
            'No coding agent configured. Open Settings → Agents and pick Codex or Claude Code.',
        });
        throw new Error('no coding agent configured');
      }
      // A host that predates the runnerKind loader argument may still return
      // another runner's launch settings. Keep the requested kind but discard
      // that mismatched binary/args; registry defaults are safer than launching
      // runner A through runner B's executable.
      const primaryPrefs: RunnerPrefs =
        input.runnerKind && loadedPrefs.kind !== input.runnerKind
          ? { kind: input.runnerKind }
          : loadedPrefs;

      const cwd = await opts.resolveCwd(input);
      const toolContext: ToolContext = {
        appId: input.appId,
        dispatcher: opts.getDispatcher(),
        turnId: randomUUID(),
        ...(typeof opts.cwdIsDraftWorktree === 'function'
          ? opts.cwdIsDraftWorktree(input, cwd)
            ? { overrideCodeDir: cwd }
            : {}
          : opts.cwdIsDraftWorktree
            ? { overrideCodeDir: cwd }
            : {}),
        ...(opts.vaultSql ? { vaultSql: opts.vaultSql() } : {}),
        ...(opts.vaultInvoke ? { vaultInvoke: opts.vaultInvoke() } : {}),
        ...(opts.vaultContent ? { vaultContent: opts.vaultContent() } : {}),
      };
      const configuredLadder = opts.runnerLadder
        ? await opts.runnerLadder(opts.subsystem, primaryPrefs.kind)
        : [primaryPrefs.kind];
      const ladder: RunnerKind[] = [];
      for (const kind of [primaryPrefs.kind, ...configuredLadder]) {
        if (!ladder.includes(kind)) ladder.push(kind);
      }
      const healthContext = opts.runnerHealthContext?.(input, cwd) ?? cwd;
      let lastError: Extract<TurnStreamEvent, { type: 'error' }> | undefined;
      let lastResult: TurnResult | undefined;
      let completedCtx: TurnContext | undefined;
      let consumedHydrationTokens: number | undefined;
      const activeAdapterKind = input.activeAdapterKind ?? input.prevAdapterKind;
      // Kinds this turn actually consulted, and why the last one was refused —
      // so an all-rungs-unavailable turn can name them instead of blaming
      // "every configured agent" with an anonymous 'unknown' failure class.
      const consulted: RunnerKind[] = [];
      let lastBreakerClass: AgentFailureClass | undefined;
      const consented: readonly RunnerKind[] =
        input.providerConsent === undefined
          ? []
          : typeof input.providerConsent === 'string'
            ? [input.providerConsent]
            : input.providerConsent;

      for (let rung = 0; rung < ladder.length; rung += 1) {
        const kind = ladder[rung]!;
        consulted.push(kind);
        const consentSource = rung === 0 ? 'direct' : 'ladder';
        if (
          opts.providerEgressConsent &&
          !opts.providerEgressConsent.has(input.conversationId, kind, opts.subsystem)
        ) {
          if (
            consentSource === 'ladder' ||
            activeAdapterKind === undefined ||
            activeAdapterKind === kind ||
            consented.includes(kind)
          ) {
            // Initial use is implicit in choosing the surface. A ladder rung
            // is authorized by its explicit Settings membership (D13).
            // Only an attended cross-provider switch needs the one-time gate.
            opts.providerEgressConsent.grant(
              input.conversationId,
              kind,
              consentSource,
              opts.subsystem,
            );
          }
        }
        if (
          opts.providerEgressConsent &&
          !opts.providerEgressConsent.has(input.conversationId, kind, opts.subsystem)
        ) {
          input.onEvent({
            type: 'consent.required',
            consentKind: 'provider-egress',
            provider: kind,
            reason: consentSource,
            message:
              consentSource === 'ladder'
                ? `${kind} is the next failover provider. Allow this conversation to be sent to it?`
                : `Allow this conversation to be sent to ${kind}?`,
          });
          return { adapterKind: primaryPrefs.kind };
        }
        const breaker = opts.runnerHealth?.canAttempt(healthContext, kind);
        if (breaker && !breaker.allowed) {
          if (breaker.failureClass) lastBreakerClass = breaker.failureClass;
          input.onEvent({
            type: 'notice',
            level: 'warn',
            code: 'runner_breaker_open',
            message:
              `${kind} is temporarily paused for this workspace after a ` +
              `${breaker.failureClass ?? 'runner'} failure; trying the next configured agent.`,
          });
          continue;
        }
        if (rung > 0) {
          input.onEvent({
            type: 'notice',
            level: 'warn',
            code: 'runner_failover',
            message:
              `${ladder[0]} is unavailable at the turn boundary. Using ${kind}; ` +
              'provider-specific model and effort pins were cleared.',
          });
          opts.onFailover?.({
            conversationId: input.conversationId,
            ...(opts.subsystem ? { subsystem: opts.subsystem } : {}),
            from: ladder[0]!,
            to: kind,
          });
        }

        const loaded =
          kind === primaryPrefs.kind
            ? primaryPrefs
            : ((await opts.prefsLoader(opts.subsystem, kind)) ?? { kind });
        const prefs: RunnerPrefs = loaded.kind === kind ? loaded : { kind };
        const turnCtx: TurnContext = { input, prefs, cwd };
        const extraSystemPrompt = opts.buildExtraSystemPrompt
          ? await opts.buildExtraSystemPrompt(turnCtx)
          : input.extraSystemPrompt;

        // Resume and hydration are PER RUNG. This rung may be a failover the
        // route never planned for: it has its own (possibly cold) binding and
        // its own watermark, so the primary target's plan is both the wrong
        // session id and the wrong delta. Ask the driver for THIS kind's plan;
        // hosts without a conversation store keep the precomputed fields.
        const plan = input.resumeForKind?.(kind);
        // Resume only against the backend that minted the opaque session id.
        const resumeId = plan
          ? plan.sessionId
          : input.prevAdapterKind === prefs.kind
            ? input.prevAdapterSessionId
            : undefined;
        const resumeUsage = plan
          ? plan.sessionId
            ? plan.usageSnapshot
            : undefined
          : resumeId
            ? input.prevAdapterUsageSnapshot
            : undefined;
        const hydrationContext = plan ? plan.hydrationContext : input.hydrationContext;
        const hydrationAttachments = plan ? plan.hydrationAttachments : input.hydrationAttachments;
        const recoveryHydrationContext = plan
          ? plan.recoveryHydrationContext
          : input.recoveryHydrationContext;
        const recoveryHydrationAttachments = plan
          ? plan.recoveryHydrationAttachments
          : input.recoveryHydrationAttachments;
        // The ledger may carry a delta even when this runner resumes its own
        // ACP session (A → B → A). A supplied hydration plan is therefore an
        // explicit instruction, not merely a runner-kind mismatch heuristic.
        const forceHydration = hydrationContext !== undefined;

        // Explicit model/config pins belong to the selected provider. A
        // failover rung gets only its own persisted defaults; carrying a Codex
        // model or thought level into Claude is both meaningless and unsafe.
        const configPins: Record<string, string> = {
          ...prefs.configPins,
          ...(rung === 0 ? input.configPins : {}),
          ...(rung === 0 && input.model ? { model: input.model } : {}),
          ...(rung === 0 && input.thinking ? { thought_level: input.thinking } : {}),
        };
        let failure: Extract<TurnStreamEvent, { type: 'error' }> | undefined;
        const onEvent = (event: TurnStreamEvent): void => {
          if (event.type === 'error') {
            failure = event;
            return;
          }
          input.onEvent(event);
        };
        const turnInput: TurnInput = {
          conversationId: input.conversationId,
          cwd,
          message: input.message,
          ...(input.attachments?.length ? { attachments: input.attachments } : {}),
          extraSystemPrompt,
          toolContext,
          abortSignal: input.abortSignal,
          onEvent,
          ...(opts.extraPath ? { extraPath: opts.extraPath } : {}),
          ...(rung === 0 && input.model ? { model: input.model } : {}),
          ...(Object.keys(configPins).length > 0 ? { configPins } : {}),
          ...(input.permissionPolicy ? { permissionPolicy: input.permissionPolicy } : {}),
          ...(input.additionalDirectories?.length
            ? { additionalDirectories: input.additionalDirectories }
            : {}),
          ...(resumeId ? { prevSessionId: resumeId } : {}),
          ...(resumeUsage ? { prevUsageSnapshot: resumeUsage } : {}),
          ...(hydrationContext
            ? {
                hydrationContext: hydrationContext.prompt,
                ...(forceHydration ? { forceHydration: true } : {}),
              }
            : {}),
          ...(hydrationAttachments?.length ? { hydrationAttachments } : {}),
          ...(recoveryHydrationContext
            ? { recoveryHydrationContext: recoveryHydrationContext.prompt }
            : {}),
          ...(recoveryHydrationAttachments?.length ? { recoveryHydrationAttachments } : {}),
        };

        try {
          lastResult = await runTurn(turnInput, { prefs });
        } catch (error) {
          failure = {
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
            failureClass: 'unknown',
          };
        }

        if (!failure) {
          opts.runnerHealth?.reportOk(healthContext, kind);
          completedCtx = turnCtx;
          // Bill the hydration THIS rung was handed, not the route's original
          // plan — a failover rung carries a different prompt and cost.
          if (lastResult?.hydrated) {
            consumedHydrationTokens =
              lastResult.hydrationKind === 'recovery'
                ? recoveryHydrationContext?.estimatedTokens
                : hydrationContext?.estimatedTokens;
          }
          break;
        }

        const failureClass: AgentFailureClass = failure.failureClass ?? 'unknown';
        opts.runnerHealth?.reportFailure(healthContext, kind, failureClass, failure.message);
        lastError = failure;
        // A failed turn is never silently replayed through another stateful
        // session. The breaker affects the next turn boundary, where the next
        // ladder rung is selected before any prompt is sent.
        input.onEvent(failure);
        break;
      }

      if (!completedCtx && !lastResult) {
        // Name the agents actually consulted and carry the breaker's own
        // failure class. "Every configured agent" reads as a fleet-wide
        // outage when the ladder was one rung, and 'unknown' hides the
        // auth/quota reason the breaker already knows.
        const unavailable: Extract<TurnStreamEvent, { type: 'error' }> = lastError ?? {
          type: 'error',
          message:
            `${consulted.join(', ')} ${consulted.length === 1 ? 'is' : 'are'} temporarily ` +
            'paused for this workspace after a recent failure.',
          failureClass: lastBreakerClass ?? 'unknown',
        };
        if (!lastError) input.onEvent(unavailable);
        return { adapterKind: primaryPrefs.kind };
      }

      if (completedCtx && opts.onTurnComplete) {
        try {
          await opts.onTurnComplete(completedCtx);
        } catch {
          /* post-turn hook is best-effort — never fails the turn */
        }
      }

      const result = lastResult ?? { adapterKind: completedCtx?.prefs.kind ?? primaryPrefs.kind };
      return {
        adapterKind: result.adapterKind,
        ...(result.sessionId ? { adapterSessionId: result.sessionId } : {}),
        ...(result.usageSnapshot ? { adapterUsageSnapshot: result.usageSnapshot } : {}),
        ...(result.hydrated ? { hydrated: true } : {}),
        // Surfaced so the driver can retire a binding whose resume handle the
        // adapter had to abandon (`'recovery'`).
        ...(result.hydrationKind ? { hydrationKind: result.hydrationKind } : {}),
        ...(consumedHydrationTokens !== undefined
          ? { hydrationTokens: consumedHydrationTokens }
          : {}),
      };
    },
  };
}
