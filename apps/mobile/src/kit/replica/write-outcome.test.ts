import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  nativeWriteOutput,
  surfaceWriteFailure,
  surfaceWriteOutcome,
} from "./write-outcome";

const { alert } = vi.hoisted(() => ({
  alert: vi.fn<typeof import("react-native").Alert.alert>(),
}));
vi.mock(import("react-native"), () => ({
  Alert: {
    alert,
    prompt: vi.fn<typeof import("react-native").Alert.prompt>(),
  },
}));

describe("native write outcome surface", () => {
  beforeEach(() => alert.mockReset());

  it("surfaces each non-executed admission outcome", () => {
    const onParked = vi.fn<() => void>();
    expect(
      surfaceWriteOutcome({ intentId: "i-1", status: "parked" }, { onParked })
    ).toBe(false);
    expect(onParked).toHaveBeenCalledOnce();

    expect(surfaceWriteOutcome({ intentId: "i-2", status: "queued" })).toBe(
      true
    );
    expect(alert).toHaveBeenLastCalledWith(
      "Saved offline",
      expect.stringContaining("sync automatically")
    );

    expect(surfaceWriteOutcome({ intentId: "i-3", status: "in-flight" })).toBe(
      true
    );
    expect(alert).toHaveBeenLastCalledWith(
      "Saving",
      expect.stringContaining("sync status")
    );

    expect(
      surfaceWriteOutcome({
        intentId: "i-4",
        status: "failed",
        reason: "nope",
      })
    ).toBe(false);
    expect(alert).toHaveBeenLastCalledWith("Change not applied", "nope");

    expect(surfaceWriteOutcome({ intentId: "i-5", status: "executed" })).toBe(
      true
    );
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
    expect(alert).not.toHaveBeenCalled();
  });

  it("surfaces rejected write promises", () => {
    surfaceWriteFailure(new Error("transport down"), "Album not renamed");
    expect(alert).toHaveBeenCalledWith("Album not renamed", "transport down");
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
