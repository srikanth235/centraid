import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  nativeWriteOutput,
  surfaceWriteFailure,
  surfaceWriteOutcome,
  surfaceWriteRefusal,
} from "./write-outcome";

const { post, read } = vi.hoisted(() => ({
  post: vi.fn<(...args: unknown[]) => void>(),
  read: vi.fn<
    () => { text: string; action?: { label: string; run: () => void } } | null
  >(() => null),
}));
vi.mock(import("../components/status-line"), () => ({
  postStatus: post,
  readStatus: read,
}));
vi.mock(import("react-native"), () => ({
  Alert: {
    alert: vi.fn<(...args: unknown[]) => void>(),
    prompt: vi.fn<(...args: unknown[]) => void>(),
  },
}));

describe("native write outcome surface", () => {
  beforeEach(() => {
    post.mockReset();
    read.mockReset();
    read.mockReturnValue(null);
  });

  it("surfaces each non-executed admission outcome", () => {
    const onParked = vi.fn<() => void>();
    expect(
      surfaceWriteOutcome({ intentId: "i-1", status: "parked" }, { onParked })
    ).toBe(false);
    expect(onParked).toHaveBeenCalledOnce();

    expect(surfaceWriteOutcome({ intentId: "i-2", status: "queued" })).toBe(
      true
    );
    expect(post).toHaveBeenLastCalledWith(
      expect.stringContaining("Saved offline")
    );

    expect(surfaceWriteOutcome({ intentId: "i-3", status: "in-flight" })).toBe(
      true
    );
    expect(post).toHaveBeenLastCalledWith(
      expect.stringContaining("final status remains visible")
    );

    expect(
      surfaceWriteOutcome({
        intentId: "i-4",
        status: "failed",
        reason: "nope",
      })
    ).toBe(false);
    // THE VAULT'S WORDS GO TO THE LOG (#1015, S14 — R-A-18): the member gets
    // the surface's noun and the one thing that is true about a refusal.
    expect(post).toHaveBeenLastCalledWith(
      "Change not applied. The vault did not allow this change."
    );

    expect(surfaceWriteOutcome({ intentId: "i-5", status: "executed" })).toBe(
      true
    );
  });

  it("routes a conflict to the row that still holds both versions", () => {
    // THE REGRESSION THIS PINS (#880 W2.3). A conflict fell through to the
    // generic failure line — "Change not applied: …" — which told a member
    // their work was gone while the write was still retained on the phone with
    // both versions and a retry waiting for them.
    expect(
      surfaceWriteOutcome({
        intentId: "i-c",
        status: "conflict",
        reason: "This row changed somewhere else.",
        conflict: {
          entity: "expense",
          rowId: "e-1",
          expectedVersion: 3,
          actualVersion: 5,
        },
      })
    ).toBe(false);
    const line = post.mock.lastCall?.[0] as string;
    expect(line).toContain("This row changed somewhere else.");
    expect(line).toContain("Open Pending changes to retry or discard.");
    expect(line).not.toContain("Change not applied");
    // NO VERSION NUMBERS ON THE PHONE (#1015, S14 — R-A-15). The sidecar still
    // carries them and Pending changes may show them; a status line that says
    // "Expected version 3; found 5" spends the one slot on a number the member
    // cannot act on.
    expect(line).not.toContain("Expected version");
    expect(line).not.toContain("found 5");
  });

  it("lets a seat own the conflict door itself", () => {
    let opened = false;
    expect(
      surfaceWriteOutcome(
        { intentId: "i-c2", status: "conflict" },
        {
          onConflict: () => {
            opened = true;
          },
        }
      )
    ).toBe(false);
    expect(opened).toBe(true);
    expect(post).not.toHaveBeenCalled();
  });

  it("lets callers own parked/queued UX without double alerts", () => {
    const onParked = vi.fn<() => void>();
    const onQueued = vi.fn<() => void>();
    const onInFlight = vi.fn<() => void>();
    expect(
      surfaceWriteOutcome(
        { intentId: "p", status: "parked" },
        { onParked, onQueued, onInFlight }
      )
    ).toBe(false);
    expect(
      surfaceWriteOutcome(
        { intentId: "q", status: "queued" },
        { onParked, onQueued, onInFlight }
      )
    ).toBe(true);
    expect(
      surfaceWriteOutcome(
        { intentId: "f", status: "in-flight" },
        { onParked, onQueued, onInFlight }
      )
    ).toBe(true);
    expect(onParked).toHaveBeenCalledOnce();
    expect(onQueued).toHaveBeenCalledOnce();
    expect(onInFlight).toHaveBeenCalledOnce();
    expect(post).not.toHaveBeenCalled();
  });

  it("surfaces rejected write promises without the exception", () => {
    // "transport down" is what a driver threw, not a sentence a member can act
    // on (#1015, S14 — R-A-15). It goes to the log; the line gets the noun and
    // the product's one retry word.
    const logged = vi.spyOn(console, "warn").mockReturnValue(undefined);
    const thrown = new Error("transport down");
    surfaceWriteFailure(thrown, "Album not renamed");
    expect(post).toHaveBeenCalledWith("Album not renamed. Try again.");
    expect(logged).toHaveBeenCalledWith(
      "[write] failed",
      "Album not renamed",
      thrown
    );
    logged.mockRestore();
  });

  it("gives a refusal its own channel rather than a fake Error", () => {
    // `new Error(reason)` handed to the failure door was how a vault refusal
    // got printed verbatim (`locker-writes.ts` did it three times).
    const logged = vi.spyOn(console, "warn").mockReturnValue(undefined);
    surfaceWriteRefusal("unpaired", "Locker change not written");
    expect(post).toHaveBeenLastCalledWith(
      "Locker change not written. Pair or reconnect a vault host."
    );
    expect(logged).not.toHaveBeenCalled();

    surfaceWriteRefusal(
      "denied",
      "Locker not exported",
      "receipt r-9, scope x"
    );
    expect(post).toHaveBeenLastCalledWith(
      "Locker not exported. The vault did not allow this change."
    );
    expect(logged).toHaveBeenCalledWith(
      "[write] refused",
      "Locker not exported",
      "receipt r-9, scope x"
    );
    logged.mockRestore();
  });

  it("reads command output from successful write results", () => {
    expect(
      nativeWriteOutput({
        intentId: "i",
        status: "executed",
        output: { party_id: "p1" },
      })
    ).toStrictEqual({ party_id: "p1" });
    expect(
      nativeWriteOutput({ intentId: "q", status: "queued" })
    ).toBeUndefined();
    expect(nativeWriteOutput(undefined)).toBeUndefined();
  });
});

describe("news never paints over a live action", () => {
  beforeEach(() => {
    post.mockReset();
    read.mockReset();
  });

  // THE REGRESSION THIS PINS (#1015, S3 — audit B3, tasks/findings.md#1).
  // Tasks' check-off posted `Task done` with an `Undo`, and the queued outcome
  // of that very write overwrote it a beat later, so the only door back from
  // an accidental check-off was gone before the member could reach it.
  it("suppresses a queued outcome while an action is on the line", () => {
    read.mockReturnValue({
      text: "Task done",
      action: { label: "Undo", run: () => undefined },
    });
    expect(surfaceWriteOutcome({ intentId: "q-1", status: "queued" })).toBe(
      true
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("suppresses an in-flight outcome while an action is on the line", () => {
    read.mockReturnValue({
      text: "Task done",
      action: { label: "Undo", run: () => undefined },
    });
    expect(surfaceWriteOutcome({ intentId: "f-1", status: "in-flight" })).toBe(
      true
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("still posts news when the line is quiet or carries no action", () => {
    read.mockReturnValue(null);
    expect(surfaceWriteOutcome({ intentId: "q-2", status: "queued" })).toBe(
      true
    );
    expect(post).toHaveBeenLastCalledWith(
      expect.stringContaining("Saved offline")
    );

    read.mockReturnValue({ text: "Saved offline" });
    expect(
      surfaceWriteOutcome(
        { intentId: "q-3", status: "queued" },
        { queuedMessage: "This change will sync automatically." }
      )
    ).toBe(true);
    expect(post).toHaveBeenLastCalledWith(
      "This change will sync automatically."
    );
  });

  // A refusal is not news: the member has to see it even mid-undo, because it
  // is the ANSWER to the write, not a report about its transport.
  it("still posts a refusal and a failure over a live action", () => {
    read.mockReturnValue({
      text: "Task done",
      action: { label: "Undo", run: () => undefined },
    });
    expect(surfaceWriteOutcome({ intentId: "p-1", status: "parked" })).toBe(
      false
    );
    expect(post).toHaveBeenCalledOnce();
    expect(
      surfaceWriteOutcome({
        intentId: "x-1",
        status: "failed",
        reason: "nope",
      })
    ).toBe(false);
    expect(post).toHaveBeenLastCalledWith(
      "Change not applied. The vault did not allow this change."
    );
  });
});
