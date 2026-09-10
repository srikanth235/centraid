// THE ONE READ FAILURE (#1015, S14). A screen whose read did not land has
// exactly two things to say, and neither is the exception: the app is not
// connected, or the app could not be loaded. `useSeatPages` catches whatever
// the engine threw and hands it on as `error` — `caughtError.message`, or
// `String(caughtError)` when it is not even an Error — and Notes and Agenda
// both put that string straight into the room's body, where a member read
// engine vocabulary, a SQL fragment, or nothing at all.
//
// The raw string is not lost: `useSeatPages` logs it at the catch, which is
// where a debug session starts (docs/logs.md). What the member gets is a
// sentence with the app's own noun in it, and ONE retry word for the whole
// product.

import type { RoomAction, RoomError } from "./room-contracts";

/** The product's one retry word. Never "Retry", never "Reload". */
export const TRY_AGAIN = "Try again";

export interface ReadFailureInput {
  /**
   * The app's ONE error noun, as the member names the app: "Notes",
   * "Agenda". S14 allows an app one, so both sentences below carry the same
   * word and a member never learns two names for one place.
   */
  noun: string;
  /** No gateway to read from at all — a different fact from a failed read. */
  unreachable: boolean;
  /**
   * Why it is unreachable, already worded by the replica layer. It is the
   * only string here that may reach the member, and it is never an exception.
   */
  unavailableReason?: string;
  /** That the read threw. The string itself is deliberately not used. */
  failed: boolean;
  onRetry: () => void;
  /** The one way forward when retrying is not it (an unpaired phone). */
  secondary?: RoomAction;
}

/**
 * `undefined` when nothing went wrong — the caller passes the result straight
 * to a room, and a room with no `error` shows its loading or its body.
 */
export function readFailure(input: ReadFailureInput): RoomError | undefined {
  const { noun, unreachable, unavailableReason, failed, onRetry } = input;
  if (!unreachable && !failed) return undefined;
  return {
    body: unreachable
      ? (unavailableReason ?? "Pair or reconnect a vault host.")
      : `Nothing was wrong with what you asked for — the read did not finish. ${TRY_AGAIN}, or come back in a moment.`,
    retry: { label: TRY_AGAIN, onPress: onRetry },
    title: unreachable
      ? `${noun} is not connected`
      : `${noun} could not be loaded`,
    ...(input.secondary ? { secondary: input.secondary } : {}),
  };
}
