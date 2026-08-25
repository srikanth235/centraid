// What a view may say about itself, given what has been read. Pure and DOM-free
// so the rules stay testable; never re-express one inline in a render function.
// A shelf is never silently swapped for another: each app owns `shelfAfterRead`
// and announces the move.

export interface EmptyStateGate {
  /** False covers "in flight" and "every read failed" — neither knows. */
  loaded: boolean;
  count: number;
  suppressed?: boolean;
}

/** Nothing is empty until a read LANDS. Ask this before any copy table so a
 *  shelf never grows a second way of deciding it is empty. */
export function showsEmptyState(gate: EmptyStateGate): boolean {
  return gate.loaded && !gate.suppressed && gate.count === 0;
}

/**
 * Offline is read, never invented. `InlineFrame` carries no reachability, so
 * judge only observables: `hostStatus` (absent until the host stamps it) and
 * `readFailed` (replica AND gateway failed). Never consult `navigator.onLine`:
 * the desktop gateway is a local child process.
 */
export function libraryReachability(input: {
  hostStatus?: string | null;
  readFailed: boolean;
}): "reachable" | "unreachable" {
  if (input.hostStatus === "down") return "unreachable";
  if (input.hostStatus === "up") return "reachable";
  return input.readFailed ? "unreachable" : "reachable";
}
