/**
 * Journal replay for crash-resumable automation fires (issue #166, Phase 3).
 *
 * An automation handler is deterministic JS whose only outside effects are
 * `ctx.tool` / `ctx.agent` / `ctx.invoke`. Every serviced call is already
 * recorded as a `run_nodes` row (the journal) keyed by ordinal. To resume an
 * interrupted fire we re-run the handler from the top against the prior run's
 * journal: a call whose ordinal has a settled, successful journal entry
 * returns the RECORDED result without re-dispatching — so `ctx.agent` is
 * never re-billed and `ctx.tool` is not re-executed. The first un-journaled
 * (or failed, or still-open at the crash) call is the resume point; it and
 * everything after it run live.
 *
 * Determinism contract: replay is sound only if the handler issues the same
 * ordered sequence of `ctx.*` calls on every run. Ordinals are assigned in
 * call order, so the journal aligns to the re-run iff the handler is
 * deterministic between `ctx.*` calls — no `Date.now()` / `Math.random()` /
 * ambient I/O outside the `ctx.*` surface. Nondeterminism shifts ordinals
 * and desynchronizes the journal; the runner does not police this, the
 * handler owns it (see the builder system prompt's determinism note).
 */

import type { AgentRunNodeKind, AgentRunsStore } from '@centraid/app-engine';

/** A replayable journal entry: a settled, successful node from a prior run. */
export interface JournalEntry {
  readonly ordinal: number;
  readonly kind: AgentRunNodeKind;
  readonly name?: string;
  /** The recorded successful result (`run_nodes.output_json`, parsed). */
  readonly output: unknown;
}

/** Replay surface over one prior run's `run_nodes`. */
export interface RunJournal {
  /**
   * The replayable entry for an ordinal, or undefined when the call must run
   * live (no entry, the node failed, or it was still open at the crash).
   */
  replayable(ordinal: number): JournalEntry | undefined;
  /** Count of replayable entries — 0 means "nothing to resume". */
  readonly size: number;
}

/**
 * Build a journal from a prior run's recorded nodes. Only settled
 * (`ended_at` non-null) successful nodes are replayable — an open node is the
 * crash point and a failed node re-runs live so the handler can retry it.
 */
export function buildRunJournal(store: AgentRunsStore, sourceRunId: string): RunJournal {
  const byOrdinal = new Map<number, JournalEntry>();
  for (const node of store.listNodes(sourceRunId)) {
    if (node.endedAt === undefined) continue; // still open → the crash point
    if (!node.ok) continue; // failed → re-run live
    let output: unknown;
    if (node.outputJson !== undefined) {
      try {
        output = JSON.parse(node.outputJson) as unknown;
      } catch {
        output = node.outputJson;
      }
    }
    byOrdinal.set(node.ordinal, {
      ordinal: node.ordinal,
      kind: node.kind,
      ...(node.name !== undefined ? { name: node.name } : {}),
      output,
    });
  }
  return {
    replayable: (ordinal) => byOrdinal.get(ordinal),
    size: byOrdinal.size,
  };
}

/** An empty journal — every call runs live. Used by a non-resume fire. */
export const EMPTY_JOURNAL: RunJournal = {
  replayable: () => undefined,
  size: 0,
};
