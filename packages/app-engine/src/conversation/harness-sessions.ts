/*
 * HarnessSessions — one actor per `(conversationRef, harnessKind)` (#743
 * Part 2, item 2).
 *
 * The schema has always said a binding is keyed by conversation AND harness
 * (`conversation_harness_sessions` UNIQUE `(conversation_id, harness_kind,
 * acp_session_id)`); the code never honoured it. Four call sites each grew
 * their own copy of "look up this harness's binding, fold the ledger past its
 * watermark, hand the plan to the turn, settle whatever came back" — the chat
 * driver, the headless compile, interactive steering, and the automation fire.
 * They drifted, and the fire's copy carried the `latestAdapter` bug: one
 * unkeyed slot, so a fire touching two harnesses handed harness B the opaque
 * session id harness A minted.
 *
 * This module is that logic, once, keyed properly. It owns, per harness kind:
 *
 *   - the binding row (which opaque ACP session id is resumable),
 *   - the resume decision — *resume only against the backend that minted the
 *     opaque session id*, the invariant `TurnResumePlan` already encoded,
 *   - the hydration watermark (how much ledger that binding has already seen,
 *     and therefore what this turn must re-fold),
 *   - the warm-process association: within one turn, a harness driven twice
 *     resumes what it just minted and is never re-hydrated.
 *
 * Settlement is per binding: `bindings` is every binding the turn touched, in
 * touch order, and the store settles each one. That is what deletes the
 * one-observed-harness-per-turn limit.
 *
 * Reads and the one write it performs (retiring an abandoned binding) cross
 * the `HarnessSessionsLedger` port, so the app-scoped history facade and the
 * journal-direct `ConversationStore` both drive the same owner.
 */

import { compileHydrationPlan } from "./hydration.js";
import type { HydrationMessage } from "./hydration.js";
import type { TurnPosture } from "./posture.js";
import type { AdapterUsageSnapshot, TurnAttachment } from "./turn.js";

/** A bounded ledger fold handed to a turn, with what it is expected to cost. */
export interface HydrationContext {
  prompt: string;
  includedTurns: number;
  omittedTurns: number;
  /** Estimated prompt tokens injected solely to restore ledger context. */
  estimatedTokens: number;
}

/** One harness kind's resume handle plus the hydration it would need. */
export interface TurnResumePlan {
  /** That harness's own resumable opaque session id, when it has a binding. */
  sessionId?: string;
  /** Durable binding row that supplied `sessionId`. */
  bindingId?: string;
  /** Cumulative counters stored with `sessionId`. */
  usageSnapshot?: AdapterUsageSnapshot;
  /** Ledger delta past THIS binding's watermark (the full ledger when cold). */
  hydrationContext?: HydrationContext;
  hydrationAttachments?: TurnAttachment[];
  /** Full-ledger plan used only if `sessionId` turns out to be expired. */
  recoveryHydrationContext?: HydrationContext;
  recoveryHydrationAttachments?: TurnAttachment[];
}

/** The durable binding row, as the planner needs to read it. */
export interface HarnessBindingRow {
  bindingId: string;
  /** Non-optional: a row with no opaque session id is not a resume handle. */
  sessionId: string;
  usageSnapshot?: AdapterUsageSnapshot;
  /** Ledger `seq` this binding has already been shown. -1 = nothing yet. */
  hydratedThroughSeq: number;
}

/** What a completed dispatch reports back about the harness it drove. */
export interface ObservedHarnessTurn {
  /**
   * The harness that produced `sessionId`. The turn driver may land on a
   * different kind than the caller planned for (a failover rung, a host-side
   * ladder inside the accounted seam), and the session id belongs to whoever
   * minted it — never to whoever was asked.
   */
  harnessKind?: string;
  sessionId?: string;
  usageSnapshot?: AdapterUsageSnapshot;
  hydrated?: boolean;
  hydrationKind?: "handoff" | "recovery";
}

/** One binding touched this turn, in the shape the store settles. */
export interface TouchedHarnessBinding {
  kind: string;
  sessionId?: string;
  usageSnapshot?: AdapterUsageSnapshot;
  hydrated?: boolean;
  /**
   * Whether this dispatch delivered its prompt and got an answer back. Only a
   * delivered binding may advance its hydration watermark — a rung that
   * errored never showed the model the turn it would be marked as having seen.
   * A failed binding still settles its cumulative usage, so its next resume
   * does not double-book what the failed attempt already burned.
   */
  ok: boolean;
}

/** Ledger access HarnessSessions needs, scoped to ONE conversation. */
export interface HarnessSessionsLedger {
  /** This harness's own resumable binding, or undefined when it is cold. */
  binding: (harnessKind: string) => HarnessBindingRow | undefined;
  /** Completed ledger rows strictly after `afterSeq` (-1 = the whole ledger). */
  hydrationMessages: (afterSeq: number) => readonly HydrationMessage[];
  /** Retire a binding whose resume handle the harness abandoned (D9). */
  retire: (bindingId: string) => void;
  /**
   * Resolve a hydration attachment's CAS hash to an on-disk path. Absent on
   * hosts that cannot serve historical files — the fold then carries the
   * text references only, which is what the ledger already prints.
   */
  attachmentPath?: (hash: string) => string;
}

interface CompiledFold {
  context: HydrationContext;
  attachments: TurnAttachment[];
}

export class HarnessSessions {
  private readonly ledger: HarnessSessionsLedger;
  private readonly hydration: TurnPosture["hydration"];
  /** One plan per harness kind — a turn asks at most once per kind. */
  private readonly plans = new Map<string, TurnResumePlan>();
  /** Insertion-ordered; the LAST entry is the conversation's active harness. */
  private readonly touched = new Map<string, TouchedHarnessBinding>();
  private billedHydrationTokens = 0;

  constructor(
    ledger: HarnessSessionsLedger,
    hydration: TurnPosture["hydration"]
  ) {
    this.ledger = ledger;
    this.hydration = hydration;
  }

  /**
   * The resume handle + ledger fold for one harness kind. Memoized: the same
   * kind asked twice in one turn gets the same answer, and once that kind has
   * actually run (see `observe`) the answer becomes "resume what you just
   * minted, hydration already delivered".
   */
  plan(harnessKind: string): TurnResumePlan {
    const cached = this.plans.get(harnessKind);
    if (cached) return cached;
    const binding = this.ledger.binding(harnessKind);
    // Without a resumable session id this kind starts cold, so its delta is the
    // whole ledger — and its recovery plan would be that same fold.
    const watermark = binding ? binding.hydratedThroughSeq : -1;
    const handoff = this.compile(watermark);
    const recovery = binding
      ? watermark === -1
        ? handoff
        : this.compile(-1)
      : undefined;
    const plan: TurnResumePlan = {
      ...(binding
        ? { sessionId: binding.sessionId, bindingId: binding.bindingId }
        : {}),
      ...(binding?.usageSnapshot
        ? { usageSnapshot: binding.usageSnapshot }
        : {}),
      ...(handoff ? { hydrationContext: handoff.context } : {}),
      ...(handoff && handoff.attachments.length > 0
        ? { hydrationAttachments: handoff.attachments }
        : {}),
      ...(recovery ? { recoveryHydrationContext: recovery.context } : {}),
      ...(recovery && recovery.attachments.length > 0
        ? { recoveryHydrationAttachments: recovery.attachments }
        : {}),
    };
    this.plans.set(harnessKind, plan);
    return plan;
  }

  /** Record a dispatch, planned for `plannedKind`, that delivered its prompt. */
  observe(plannedKind: string, observed: ObservedHarnessTurn): void {
    const plan = this.plans.get(plannedKind);
    // Bill the fold this dispatch was actually handed, not the one the route
    // first imagined — a failover rung carries a different prompt and cost.
    if (observed.hydrated) {
      this.billedHydrationTokens +=
        (observed.hydrationKind === "recovery"
          ? plan?.recoveryHydrationContext?.estimatedTokens
          : plan?.hydrationContext?.estimatedTokens) ?? 0;
    }
    const kind = this.record(plannedKind, observed, true);
    // Warm-process association: this harness now holds the context live, so a
    // second dispatch to it in the same turn resumes what it just minted and
    // re-folds nothing. Keyed on the MINTING kind, never the requested one.
    this.plans.set(kind, {
      ...(observed.sessionId ? { sessionId: observed.sessionId } : {}),
      ...(observed.usageSnapshot
        ? { usageSnapshot: observed.usageSnapshot }
        : {}),
    });
  }

  /**
   * Record a dispatch that errored. The binding still settles its cumulative
   * usage — the failed attempt burned real tokens against that session — but
   * never its watermark, and it never becomes the resume handle for a later
   * dispatch in the same turn.
   */
  observeFailure(plannedKind: string, observed: ObservedHarnessTurn): void {
    this.record(plannedKind, observed, false);
  }

  /** Every binding this turn touched, oldest touch first. */
  get bindings(): TouchedHarnessBinding[] {
    return [...this.touched.values()];
  }

  /** Ledger-restoration tokens this turn actually paid for, across bindings. */
  get hydrationTokens(): number {
    return this.billedHydrationTokens;
  }

  private record(
    plannedKind: string,
    observed: ObservedHarnessTurn,
    ok: boolean
  ): string {
    const plan = this.plans.get(plannedKind);
    const kind = observed.harnessKind ?? plannedKind;
    // `hydrationKind: 'recovery'` means the resume handle we offered was
    // rejected and the harness self-healed onto a fresh session. Left active,
    // that dead handle is re-offered every turn, paying a failed resume plus a
    // full-ledger fold each time. Only the planned kind's own binding can be
    // the one that was rejected.
    if (
      observed.hydrationKind === "recovery" &&
      kind === plannedKind &&
      plan?.bindingId &&
      plan.sessionId !== observed.sessionId
    ) {
      this.ledger.retire(plan.bindingId);
    }
    // Re-touching moves the binding to the end: settlement order decides which
    // harness the conversation row records as active.
    this.touched.delete(kind);
    this.touched.set(kind, {
      kind,
      ...(observed.sessionId ? { sessionId: observed.sessionId } : {}),
      ...(observed.usageSnapshot
        ? { usageSnapshot: observed.usageSnapshot }
        : {}),
      ...(observed.hydrated ? { hydrated: true } : {}),
      ok,
    });
    return kind;
  }

  private compile(afterSeq: number): CompiledFold | undefined {
    const messages = this.ledger.hydrationMessages(afterSeq);
    if (messages.length === 0) return undefined;
    const compiled = compileHydrationPlan(messages, {
      ...this.hydration,
      includeAttachmentReferences: true,
    });
    // A fold that funds no turn at all is no fold.
    if (compiled.includedTurns === 0) return undefined;
    const resolve = this.ledger.attachmentPath;
    return {
      context: {
        prompt: compiled.prompt,
        includedTurns: compiled.includedTurns,
        omittedTurns: compiled.omittedTurns,
        estimatedTokens: compiled.estimatedTokens,
      },
      attachments: resolve
        ? compiled.attachments.map((attachment) => ({
            path: resolve(attachment.hash),
            mime: attachment.mime,
            ...(attachment.filename ? { filename: attachment.filename } : {}),
          }))
        : [],
    };
  }
}
