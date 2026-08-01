// How much of a transcript is mounted at once (issue #659).
//
// A long conversation is thousands of message rows, and an answer row is not a
// cheap one: it injects HTML and re-hydrates ref chips and copy buttons on
// mount. Painting all of them to show the last screenful is the cost this
// removes.
//
// The window is the TAIL — reading starts at the newest message — and the rest
// is one keyboard-reachable click away, never dropped. That distinction is the
// whole point: a transcript you cannot scroll back through is not a transcript,
// and "we quietly stopped showing you your own history" is a worse defect than
// a slow load.

/** Messages mounted before the reader asks for more. Roughly two screenfuls. */
export const TRANSCRIPT_WINDOW = 60;

export interface TranscriptWindow<T> {
  /** The tail that is actually mounted. */
  rendered: readonly T[];
  /** How many older messages exist above `rendered`. Zero ⇒ all of it. */
  hiddenCount: number;
}

/**
 * Take the newest `windowSize` messages.
 *
 * Two identity guarantees, both load-bearing for the memoized transcript:
 * every rendered element is the SAME object the caller passed (so the row
 * projection's per-message cache still hits), and when nothing is hidden the
 * caller's own array comes back unchanged (so a windowing pass never looks
 * like new content to a dependency array).
 */
export function windowTranscript<T>(
  messages: readonly T[],
  windowSize: number
): TranscriptWindow<T> {
  const hiddenCount = Math.max(0, messages.length - Math.max(0, windowSize));
  if (hiddenCount === 0) return { rendered: messages, hiddenCount: 0 };
  return { rendered: messages.slice(hiddenCount), hiddenCount };
}

/**
 * Where to put `scrollTop` after content was prepended, so what the reader was
 * looking at stays exactly where it was.
 *
 * A browser keeps `scrollTop` numerically fixed when content grows above the
 * viewport, which shifts everything visible DOWN by the height of what was
 * added — the classic backfill jump. Anchoring on distance from the BOTTOM is
 * exact here because a prepend moves nothing below the viewport.
 *
 * Split out and named because this arithmetic is the part that can be wrong,
 * and jsdom reports every layout box as zero — so the formula is testable
 * where the rendered behaviour is not.
 */
export function anchoredScrollTop(
  before: { scrollHeight: number; scrollTop: number },
  after: { scrollHeight: number }
): number {
  const distanceFromBottom = before.scrollHeight - before.scrollTop;
  return Math.max(0, after.scrollHeight - distanceFromBottom);
}
