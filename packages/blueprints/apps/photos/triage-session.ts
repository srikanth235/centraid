// THE TRIAGE SESSION (issue #712 D3) — the state machine every "work through
// a queue of proposals, one at a time" surface in this app was writing for
// itself, extracted once so the third one does not write a fourth version.
//
// Two flows already had it, in two different dialects:
//
//   * FACE REVIEW (components/FaceReview.tsx + the native twin) — DURABLE
//     answers. Each answer is a vault write; the queue is re-read afterwards
//     and the answered proposal is gone from it.
//   * DUPLICATE REVIEW (duplicates.tsx + components/DuplicateReview.tsx) —
//     EPHEMERAL decisions. Nothing persists a "reviewed this cluster" state
//     by design (there is no proposal table; the only write is trashing the
//     redundant copies), so the queue is a SNAPSHOT the cursor walks.
//
// This module deliberately does NOT unify those two. It unifies what they
// genuinely share and nothing else:
//
//   1. an ordered queue and a cursor into it, with exactly one item current;
//   2. a FROZEN denominator, so the numerator counts UP as the member works
//      ("1 of 54") instead of the total sliding around under them as the
//      backlog changes mid-session — the single trickiest bit of both flows,
//      and the one both had reimplemented with a `sessionStartTotal` ref;
//   3. SKIP vs ANSWER as different acts — skip moves the cursor and records
//      nothing (so "it stays in the queue" is literally true), an answer
//      records an outcome and moves on;
//   4. per-outcome counts, so a surface can say what the session did.
//
// Everything is a pure function over an immutable value: no React, no DOM, no
// timers. That is what lets the native twin import it verbatim
// (`@centraid/blueprints/apps/photos/triage-session`) rather than keeping a
// parallel copy that drifts — the same arrangement `enrichment-consent.ts`
// already has with its own screen.
//
// The third consumer (Docs OCR corrections) joins here by naming its own
// outcome vocabulary; nothing in this file knows what a face or a cluster is.

/** One session over one queue. Treat as immutable — every verb returns a new
 *  value rather than mutating this one, so a React state setter can take the
 *  result directly and a DOM-imperative caller can reassign one variable. */
export interface TriageSession<Item> {
  /** The items still to answer, in the order the surface walks them. */
  readonly queue: readonly Item[];
  /** Which one is current. `queue.length` means the session is finished. */
  readonly cursor: number;
  /** The denominator, frozen when the session opened (see 2 above). */
  readonly total: number;
  /** How many answers of each outcome this session recorded. */
  readonly counts: Readonly<Record<string, number>>;
}

/** What a surface prints. Derived, never stored, so it cannot go stale. */
export interface TriageProgress {
  /** 1-based position for `N of M` — never past `total`, never below 1. */
  readonly position: number;
  readonly total: number;
  /** Answers recorded so far, across every outcome. */
  readonly answered: number;
  /** Items left in the queue behind the current one. */
  readonly remaining: number;
  /** True when there is nothing current — the zero-remaining state. */
  readonly done: boolean;
}

/**
 * Open a session over a queue.
 *
 * `total` exists for the durable flow, whose queue page is BOUNDED (the face
 * queue reads one page at a time) while the real backlog it is working
 * through is larger: the surface passes the true backlog size so the
 * denominator is the member's actual queue, not the page in hand.
 */
export function openTriage<Item>(
  queue: readonly Item[],
  options?: { total?: number; at?: number }
): TriageSession<Item> {
  return {
    queue,
    cursor: clampCursor(options?.at ?? 0, queue.length),
    total: options?.total ?? queue.length,
    counts: {},
  };
}

/** The one item on screen, or `undefined` when the session is finished. */
export function triageCurrent<Item>(
  session: TriageSession<Item>
): Item | undefined {
  return session.queue[session.cursor];
}

/**
 * Move past the current item WITHOUT recording anything.
 *
 * Wraps, because a skipped item genuinely stays in the queue — the member
 * meets it again after the ones behind it, which is what "decide later" means
 * on both surfaces. A one-item queue therefore stays on that item rather than
 * pretending the session is over.
 */
export function triageSkip<Item>(
  session: TriageSession<Item>
): TriageSession<Item> {
  if (session.queue.length === 0) return session;
  return { ...session, cursor: (session.cursor + 1) % session.queue.length };
}

/**
 * Record an answer for the current item and move on.
 *
 * The cursor advances rather than wraps: an answered item is finished with,
 * so running off the end is the correct, reachable end of the session —
 * `triageCurrent` then returns `undefined` and the surface shows its
 * zero-remaining state. A durable flow follows this with `triageRefill` once
 * the write has landed and the queue has been re-read.
 */
export function triageAnswer<Item>(
  session: TriageSession<Item>,
  outcome: string
): TriageSession<Item> {
  return {
    ...session,
    cursor: session.cursor + 1,
    counts: {
      ...session.counts,
      [outcome]: (session.counts[outcome] ?? 0) + 1,
    },
  };
}

/**
 * Replace the queue, keeping the session's own memory (the frozen total and
 * the outcome counts).
 *
 * This is the durable flow's re-read: the answered proposal is gone from the
 * vault's queue, so the fresh page is shorter and every index in it has
 * shifted. The cursor therefore goes back to the head unless the caller names
 * a position — there is no "same item" to hold, and a stale index would land
 * the member on a proposal they never navigated to.
 */
export function triageRefill<Item>(
  session: TriageSession<Item>,
  queue: readonly Item[],
  options?: { at?: number }
): TriageSession<Item> {
  return {
    ...session,
    queue,
    cursor: clampCursor(options?.at ?? 0, queue.length),
  };
}

/** What the surface prints — see `TriageProgress`. */
export function triageProgress<Item>(
  session: TriageSession<Item>
): TriageProgress {
  const answered = Object.values(session.counts).reduce((sum, n) => sum + n, 0);
  const done = triageCurrent(session) === undefined;
  const total = Math.max(session.total, 1);
  return {
    position: Math.min(answered + 1, total),
    total,
    answered,
    remaining: Math.max(session.queue.length - session.cursor - 1, 0),
    done,
  };
}

/** A cursor inside the queue, or `length` (finished) for an empty one. A
 *  caller's requested position is a hint — an out-of-range one starts at the
 *  head rather than leaving the session pointing at nothing. */
function clampCursor(at: number, length: number): number {
  if (length === 0) return 0;
  return Number.isInteger(at) && at >= 0 && at < length ? at : 0;
}
