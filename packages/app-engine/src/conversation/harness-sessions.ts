/** Per-conversation, per-harness resume and hydration actor. */

import type { HydrationMessage } from "./hydration.js";
import { compileHydrationPlan } from "./hydration.js";
import type { TurnResumePlan } from "./runner.js";
import {
  TURN_HYDRATION_MIN_TURNS,
  TURN_HYDRATION_TOKEN_BUDGET,
} from "./turn-plane.js";
import type { HarnessKind, HarnessUsageSnapshot } from "./turn.js";

export interface HarnessSessionBinding {
  readonly bindingId?: string;
  readonly sessionId: string;
  readonly usageSnapshot?: HarnessUsageSnapshot;
  readonly hydratedThroughSeq?: number;
}

export interface HarnessSessionSource {
  binding: (kind: HarnessKind) => HarnessSessionBinding | undefined;
  messages: (afterSeq: number) => readonly HydrationMessage[];
  attachmentPath?: (hash: string) => string;
}

export interface HarnessSessionObservation {
  readonly kind: HarnessKind;
  readonly sessionId?: string;
  readonly usageSnapshot?: HarnessUsageSnapshot;
  readonly hydrated?: boolean;
}

export class HarnessSessions {
  private readonly plans = new Map<HarnessKind, TurnResumePlan>();
  private readonly observations = new Map<
    HarnessKind,
    HarnessSessionObservation
  >();
  private lastObservedKind?: HarnessKind;
  private hydrationTokens = 0;

  constructor(private readonly source: HarnessSessionSource) {}

  plan(kind: HarnessKind): TurnResumePlan {
    const cached = this.plans.get(kind);
    if (cached) return cached;
    const binding = this.source.binding(kind);
    const compile = (afterSeq: number) => {
      const messages = this.source.messages(afterSeq);
      if (messages.length === 0) return undefined;
      const plan = compileHydrationPlan(messages, {
        tokenBudget: TURN_HYDRATION_TOKEN_BUDGET,
        minTurns: TURN_HYDRATION_MIN_TURNS,
        includeAttachmentReferences: true,
      });
      return plan.includedTurns === 0 ? undefined : plan;
    };
    const watermark = binding?.sessionId
      ? (binding.hydratedThroughSeq ?? -1)
      : -1;
    const handoff = compile(watermark);
    const recovery = binding?.sessionId
      ? watermark === -1
        ? handoff
        : compile(-1)
      : undefined;
    const plan: TurnResumePlan = {
      ...(binding?.sessionId ? { sessionId: binding.sessionId } : {}),
      ...(binding?.bindingId ? { bindingId: binding.bindingId } : {}),
      ...(binding?.usageSnapshot
        ? { usageSnapshot: binding.usageSnapshot }
        : {}),
      ...(handoff
        ? {
            hydrationContext: {
              prompt: handoff.prompt,
              includedTurns: handoff.includedTurns,
              omittedTurns: handoff.omittedTurns,
              estimatedTokens: handoff.estimatedTokens,
            },
            ...(this.source.attachmentPath
              ? {
                  hydrationAttachments: handoff.attachments.map(
                    (attachment) => ({
                      path: this.source.attachmentPath!(attachment.hash),
                      mime: attachment.mime,
                      ...(attachment.filename
                        ? { filename: attachment.filename }
                        : {}),
                    })
                  ),
                }
              : {}),
          }
        : {}),
      ...(recovery
        ? {
            recoveryHydrationContext: {
              prompt: recovery.prompt,
              includedTurns: recovery.includedTurns,
              omittedTurns: recovery.omittedTurns,
              estimatedTokens: recovery.estimatedTokens,
            },
            ...(this.source.attachmentPath
              ? {
                  recoveryHydrationAttachments: recovery.attachments.map(
                    (attachment) => ({
                      path: this.source.attachmentPath!(attachment.hash),
                      mime: attachment.mime,
                      ...(attachment.filename
                        ? { filename: attachment.filename }
                        : {}),
                    })
                  ),
                }
              : {}),
          }
        : {}),
    };
    this.plans.set(kind, plan);
    return plan;
  }

  observe(
    observation: HarnessSessionObservation,
    hydrationKind?: "handoff" | "recovery"
  ): void {
    const usedPlan = this.plan(observation.kind);
    this.observations.set(observation.kind, observation);
    this.lastObservedKind = observation.kind;
    if (observation.hydrated) {
      this.hydrationTokens +=
        hydrationKind === "recovery"
          ? (usedPlan.recoveryHydrationContext?.estimatedTokens ?? 0)
          : (usedPlan.hydrationContext?.estimatedTokens ?? 0);
    }
    // A subsequent delegate call to this harness in the same turn must resume
    // the session just observed, not the binding snapshot loaded at turn start.
    // Hydration is intentionally absent: the first call either resumed the
    // existing actor or delivered the bounded handoff/recovery context.
    this.plans.set(observation.kind, {
      ...(observation.sessionId ? { sessionId: observation.sessionId } : {}),
      ...(observation.usageSnapshot
        ? { usageSnapshot: observation.usageSnapshot }
        : {}),
    });
  }

  allObservations(): readonly HarnessSessionObservation[] {
    return [...this.observations.values()];
  }

  lastObservation(): HarnessSessionObservation | undefined {
    return this.lastObservedKind
      ? this.observations.get(this.lastObservedKind)
      : undefined;
  }

  consumedHydrationTokens(): number {
    return this.hydrationTokens;
  }
}
