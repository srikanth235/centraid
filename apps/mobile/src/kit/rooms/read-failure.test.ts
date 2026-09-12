// S14 (#1015): the member never reads the exception. `useSeatPages` hands on
// `caughtError.message` (or `String(caughtError)`), and Notes and Agenda used
// to put that string into the room's body verbatim.

import { describe, expect, it } from "vitest";

import { readFailure, TRY_AGAIN } from "./read-failure";

const noop = (): void => undefined;

describe(readFailure, () => {
  it("says nothing when the read landed", () => {
    expect(
      readFailure({
        failed: false,
        noun: "Notes",
        onRetry: noop,
        unreachable: false,
      })
    ).toBeUndefined();
  });

  it("names the app in both sentences, and only the app", () => {
    const unread = readFailure({
      failed: true,
      noun: "Notes",
      onRetry: noop,
      unreachable: false,
    });
    const unpaired = readFailure({
      failed: false,
      noun: "Notes",
      onRetry: noop,
      unreachable: true,
    });
    expect(unread?.title).toBe("Notes could not be loaded");
    expect(unpaired?.title).toBe("Notes is not connected");
  });

  // The one retry word for the whole product.
  it("offers the one retry word", () => {
    expect(TRY_AGAIN).toBe("Try again");
    expect(
      readFailure({
        failed: true,
        noun: "Agenda",
        onRetry: noop,
        unreachable: false,
      })?.retry.label
    ).toBe(TRY_AGAIN);
  });

  // SABOTAGE: there is nowhere to put an exception string. The input carries
  // a BOOLEAN, not the message, so a caller cannot leak one by mistake.
  it("SABOTAGE: takes no channel for the raw failure at all", () => {
    const failure = readFailure({
      failed: true,
      noun: "Notes",
      onRetry: noop,
      unreachable: false,
    });
    const said = `${failure?.title} ${failure?.body} ${failure?.detail ?? ""}`;
    for (const engineWord of ["SQLITE", "select", "undefined", "Error", "500"])
      expect(said).not.toContain(engineWord);
  });

  // The unreachable reason IS worded by the replica layer, so it passes
  // through — but the fallback still speaks in the member's words.
  it("passes the replica layer's worded reason, and words its own fallback", () => {
    expect(
      readFailure({
        failed: false,
        noun: "Agenda",
        onRetry: noop,
        unavailableReason: "This phone is not paired with a vault host yet.",
        unreachable: true,
      })?.body
    ).toBe("This phone is not paired with a vault host yet.");
    expect(
      readFailure({
        failed: false,
        noun: "Agenda",
        onRetry: noop,
        unreachable: true,
      })?.body
    ).toBe("Pair or reconnect a vault host.");
  });
});
