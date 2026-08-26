/*
 * Per-turn chat loop. Hosts differ by four seams (#147): `resolveCwd`,
 * `buildExtraSystemPrompt`, `onTurnComplete`, `extraPath`.
 */

import { randomUUID } from "node:crypto";

import type {
  ConversationRunnerCoreOptions,
  TurnContext,
} from "./runner-core-types.js";
import type {
  HarnessFailureClass,
  ConversationRunner,
  ConversationTurnInput,
  ConversationTurnResult,
  TurnStreamEvent,
} from "./runner.js";
import { TurnPlane } from "./turn-plane.js";
import type {
  HarnessKind,
  HarnessPrefs,
  ToolContext,
  TurnInput,
  TurnResult,
} from "./turn.js";

export type {
  ConversationRunnerCoreOptions,
  TurnContext,
} from "./runner-core-types.js";

export function makeConversationRunnerCore(
  opts: ConversationRunnerCoreOptions
): ConversationRunner {
  if (!opts.providerEgressConsent) {
    throw new Error("conversation runner requires provider-egress consent");
  }
  const turnPlane = new TurnPlane(opts.runTurn);

  return {
    ...(opts.runKind ? { runKind: opts.runKind } : {}),
    resolveHarnessKind: async (): Promise<HarnessKind | undefined> =>
      (await opts.prefsLoader(opts.subsystem))?.kind,
    async run(input: ConversationTurnInput): Promise<ConversationTurnResult> {
      const loadedPrefs = input.harnessKind
        ? await opts.prefsLoader(opts.subsystem, input.harnessKind)
        : await opts.prefsLoader(opts.subsystem);
      if (!loadedPrefs) {
        input.onEvent({
          type: "error",
          message:
            "No harness configured. Open Settings → Agents and pick Codex or Claude Code.",
        });
        throw new Error("no harness configured");
      }
      // A host that predates the harnessKind loader argument may still return
      // another harness's launch settings. Keep the requested kind; discard the
      // mismatched binary/args.
      const primaryPrefs: HarnessPrefs =
        input.harnessKind && loadedPrefs.kind !== input.harnessKind
          ? { kind: input.harnessKind }
          : loadedPrefs;

      const cwd = await opts.resolveCwd(input);
      const toolContext: ToolContext = {
        appId: input.appId,
        dispatcher: opts.getDispatcher(),
        turnId: randomUUID(),
        ...(typeof opts.cwdIsDraftWorktree === "function"
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
      const configuredLadder = opts.harnessLadder
        ? await opts.harnessLadder(opts.subsystem, primaryPrefs.kind)
        : [primaryPrefs.kind];
      const ladder: HarnessKind[] = [];
      for (const kind of [primaryPrefs.kind, ...configuredLadder]) {
        if (!ladder.includes(kind)) ladder.push(kind);
      }
      const healthContext = opts.harnessHealthContext?.(input, cwd) ?? cwd;
      let lastError: Extract<TurnStreamEvent, { type: "error" }> | undefined;
      let lastResult: TurnResult | undefined;
      let completedCtx: TurnContext | undefined;
      let consumedHydrationTokens: number | undefined;
      const activeHarnessKind =
        input.activeHarnessKind ?? input.prevHarnessKind;
      // Consulted kinds + last refusal class: an all-rungs-unavailable turn
      // must name them, not blame "every configured harness" as 'unknown'.
      const consulted: HarnessKind[] = [];
      let lastBreakerClass: HarnessFailureClass | undefined;
      const consented: readonly HarnessKind[] =
        input.providerConsent === undefined
          ? []
          : typeof input.providerConsent === "string"
            ? [input.providerConsent]
            : input.providerConsent;

      // Ladder rungs are turn boundaries, not parallel retries.
      const attemptRung = async (
        rung: number
      ): Promise<ConversationTurnResult | undefined> => {
        const kind = ladder[rung];
        if (kind === undefined) return;
        consulted.push(kind);
        const consentSource = rung === 0 ? "direct" : "ladder";
        if (
          !opts.providerEgressConsent.has(
            input.conversationId,
            kind,
            opts.subsystem
          )
        ) {
          if (
            consentSource === "ladder" ||
            activeHarnessKind === undefined ||
            activeHarnessKind === kind ||
            consented.includes(kind)
          ) {
            // Initial use is implicit in choosing the surface. A ladder rung
            // is authorized by Settings membership (D13). Only an attended
            // cross-provider switch needs the one-time gate.
            opts.providerEgressConsent.grant(
              input.conversationId,
              kind,
              consentSource,
              opts.subsystem
            );
          }
        }
        if (
          !opts.providerEgressConsent.has(
            input.conversationId,
            kind,
            opts.subsystem
          )
        ) {
          input.onEvent({
            type: "consent.required",
            consentKind: "provider-egress",
            provider: kind,
            reason: consentSource,
            message:
              consentSource === "ladder"
                ? `${kind} is the next failover provider. Allow this conversation to be sent to it?`
                : `Allow this conversation to be sent to ${kind}?`,
          });
          return { harnessKind: primaryPrefs.kind };
        }
        const breaker = opts.harnessHealth?.canAttempt(healthContext, kind);
        if (breaker && !breaker.allowed) {
          if (breaker.failureClass) lastBreakerClass = breaker.failureClass;
          input.onEvent({
            type: "notice",
            level: "warn",
            code: "harness_breaker_open",
            message:
              `${kind} is temporarily paused for this workspace after a ` +
              `${breaker.failureClass ?? "harness"} failure; trying the next configured harness.`,
          });
          return attemptRung(rung + 1);
        }
        if (rung > 0) {
          input.onEvent({
            type: "notice",
            level: "warn",
            code: "harness_failover",
            message:
              `${ladder[0]} is unavailable at the turn boundary. Using ${kind}; ` +
              "provider-specific model and effort pins were cleared.",
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
        const prefs: HarnessPrefs = loaded.kind === kind ? loaded : { kind };
        const turnCtx: TurnContext = { input, prefs, cwd };
        const extraSystemPrompt = opts.buildExtraSystemPrompt
          ? await opts.buildExtraSystemPrompt(turnCtx)
          : input.extraSystemPrompt;

        // Resume and hydration are PER RUNG — a failover has its own binding
        // and watermark. Ask the driver for THIS kind's plan.
        const plan = input.resumeForKind?.(kind);
        // Resume only against the harness that minted the opaque session id.
        const resumeId = plan
          ? plan.sessionId
          : input.prevHarnessKind === prefs.kind
            ? input.prevHarnessSessionId
            : undefined;
        const resumeUsage = plan
          ? plan.sessionId
            ? plan.usageSnapshot
            : undefined
          : resumeId
            ? input.prevHarnessUsageSnapshot
            : undefined;
        const hydrationContext = plan
          ? plan.hydrationContext
          : input.hydrationContext;
        const hydrationAttachments = plan
          ? plan.hydrationAttachments
          : input.hydrationAttachments;
        const recoveryHydrationContext = plan
          ? plan.recoveryHydrationContext
          : input.recoveryHydrationContext;
        const recoveryHydrationAttachments = plan
          ? plan.recoveryHydrationAttachments
          : input.recoveryHydrationAttachments;
        // A supplied hydration plan is an explicit instruction, not a
        // harness-kind mismatch heuristic (A → B → A still carries a delta).
        const forceHydration = hydrationContext !== undefined;

        // Failover rungs get only their own persisted defaults — do not carry
        // a Codex model or thought level into Claude.
        const configPins: Record<string, string> = {
          ...prefs.configPins,
          ...(rung === 0 ? input.configPins : {}),
          ...(rung === 0 && input.model ? { model: input.model } : {}),
          ...(rung === 0 && input.thinking
            ? { thought_level: input.thinking }
            : {}),
        };
        let failure: Extract<TurnStreamEvent, { type: "error" }> | undefined;
        const onEvent = (event: TurnStreamEvent): void => {
          if (event.type === "error") {
            failure = event;
            return;
          }
          input.onEvent(event);
        };
        const turnInput: TurnInput = {
          conversationId: input.conversationId,
          cwd,
          message: input.message,
          ...(input.attachments?.length
            ? { attachments: input.attachments }
            : {}),
          extraSystemPrompt,
          toolContext,
          abortSignal: input.abortSignal,
          onEvent,
          ...(opts.extraPath ? { extraPath: opts.extraPath } : {}),
          ...(rung === 0 && input.model ? { model: input.model } : {}),
          ...(Object.keys(configPins).length > 0 ? { configPins } : {}),
          ...(input.permissionPolicy
            ? { permissionPolicy: input.permissionPolicy }
            : {}),
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
          ...(recoveryHydrationAttachments?.length
            ? { recoveryHydrationAttachments }
            : {}),
        };

        try {
          lastResult = await turnPlane.runTurn(turnInput, prefs, {
            surface: "interactive",
            egress: "attended",
            egressConsent: () =>
              opts.providerEgressConsent.has(
                input.conversationId,
                kind,
                opts.subsystem
              ),
            failover: "turn-boundary",
            permissionPolicy: input.permissionPolicy ?? "auto-allow",
            artifacts: "capture",
          });
        } catch (error) {
          failure = {
            type: "error",
            message: error instanceof Error ? error.message : String(error),
            failureClass: "unknown",
          };
        }

        if (!failure) {
          opts.harnessHealth?.reportOk(healthContext, kind);
          completedCtx = turnCtx;
          // Bill the hydration THIS rung was handed, not the route's original plan.
          if (lastResult?.hydrated) {
            consumedHydrationTokens =
              lastResult.hydrationKind === "recovery"
                ? recoveryHydrationContext?.estimatedTokens
                : hydrationContext?.estimatedTokens;
          }
          return;
        }

        const failureClass: HarnessFailureClass =
          failure.failureClass ?? "unknown";
        opts.harnessHealth?.reportFailure(
          healthContext,
          kind,
          failureClass,
          failure.message
        );
        lastError = failure;
        // Never silently replay a failed turn through another stateful session.
        // The breaker affects the next turn boundary, before any prompt is sent.
        input.onEvent(failure);
      };
      const consentResult = await attemptRung(0);
      if (consentResult) return consentResult;

      if (!completedCtx && !lastResult) {
        // Name the harnesses consulted and carry the breaker's failure class.
        // "Every configured harness" + 'unknown' hides a one-rung auth/quota.
        const unavailable: Extract<TurnStreamEvent, { type: "error" }> =
          lastError ?? {
            type: "error",
            message:
              `${consulted.join(", ")} ${consulted.length === 1 ? "is" : "are"} temporarily ` +
              "paused for this workspace after a recent failure.",
            failureClass: lastBreakerClass ?? "unknown",
          };
        if (!lastError) input.onEvent(unavailable);
        return { harnessKind: primaryPrefs.kind };
      }

      if (completedCtx && opts.onTurnComplete) {
        try {
          await opts.onTurnComplete(completedCtx);
        } catch {
          /* post-turn hook is best-effort — never fails the turn */
        }
      }

      const result: TurnResult = lastResult ?? {
        harnessKind: completedCtx?.prefs.kind ?? primaryPrefs.kind,
      };
      return {
        harnessKind: result.harnessKind,
        ...(result.sessionId ? { harnessSessionId: result.sessionId } : {}),
        ...(result.usageSnapshot
          ? { harnessUsageSnapshot: result.usageSnapshot }
          : {}),
        ...(result.hydrated ? { hydrated: true } : {}),
        // So the driver can retire a binding whose resume handle was abandoned.
        ...(result.hydrationKind
          ? { hydrationKind: result.hydrationKind }
          : {}),
        ...(consumedHydrationTokens === undefined
          ? {}
          : { hydrationTokens: consumedHydrationTokens }),
      };
    },
  };
}
