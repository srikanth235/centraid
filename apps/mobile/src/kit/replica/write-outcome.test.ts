import { beforeEach, describe, expect, it, vi } from "vitest";

import { surfaceWriteFailure, surfaceWriteOutcome } from "./write-outcome";

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

  it("surfaces rejected write promises", () => {
    surfaceWriteFailure(new Error("transport down"), "Album not renamed");
    expect(alert).toHaveBeenCalledWith("Album not renamed", "transport down");
  });
});
