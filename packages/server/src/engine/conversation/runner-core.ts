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
      const consulted: HarnessKind[] = [];
      let lastBreakerClass: HarnessFailureClass | undefined;
      const consented: readonly HarnessKind[] =
        input.providerConsent === undefined
          ? []
          : typeof input.providerConsent === "string"
            ? [input.providerConsent]
            : input.providerConsent;

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

        const plan = input.resumeForKind?.(kind);
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
        const forceHydration = hydrationContext !== undefined;

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
        input.onEvent(failure);
      };
      const consentResult = await attemptRung(0);
      if (consentResult) return consentResult;

      if (!completedCtx && !lastResult) {
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
          // Intentionally empty.
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
