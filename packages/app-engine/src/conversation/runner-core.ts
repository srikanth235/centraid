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

import type { ConversationRunnerCoreOptions, TurnContext } from './runner-core-types.js';
import type {
  AgentFailureClass,
  ConversationRunner,
  ConversationTurnInput,
  ConversationTurnResult,
  TurnStreamEvent,
} from './runner.js';
import type { RunnerKind, RunnerPrefs, ToolContext, TurnInput, TurnResult } from './turn.js';

export type { ConversationRunnerCoreOptions, TurnContext } from './runner-core-types.js';

/** Build a `ConversationRunner` from injected host seams. */
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

      // Ladder rungs are turn boundaries, not parallel retries: each can
      // authorize egress, resume a distinct session, and emit ledger events.
      const attemptRung = async (rung: number): Promise<ConversationTurnResult | undefined> => {
        const kind = ladder[rung];
        if (kind === undefined) return;
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
          return attemptRung(rung + 1);
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
          return;
        }

        const failureClass: AgentFailureClass = failure.failureClass ?? 'unknown';
        opts.runnerHealth?.reportFailure(healthContext, kind, failureClass, failure.message);
        lastError = failure;
        // A failed turn is never silently replayed through another stateful
        // session. The breaker affects the next turn boundary, where the next
        // ladder rung is selected before any prompt is sent.
        input.onEvent(failure);
      };
      const consentResult = await attemptRung(0);
      if (consentResult) return consentResult;

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

      const result: TurnResult = lastResult ?? {
        adapterKind: completedCtx?.prefs.kind ?? primaryPrefs.kind,
      };
      return {
        adapterKind: result.adapterKind,
        ...(result.sessionId ? { adapterSessionId: result.sessionId } : {}),
        ...(result.usageSnapshot ? { adapterUsageSnapshot: result.usageSnapshot } : {}),
        ...(result.hydrated ? { hydrated: true } : {}),
        // Surfaced so the driver can retire a binding whose resume handle the
        // adapter had to abandon (`'recovery'`).
        ...(result.hydrationKind ? { hydrationKind: result.hydrationKind } : {}),
        ...(consumedHydrationTokens === undefined
          ? {}
          : { hydrationTokens: consumedHydrationTokens }),
      };
    },
  };
}
