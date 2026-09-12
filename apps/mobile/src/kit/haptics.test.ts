// The one moment channel (#1015, S15): three moments, three feedback types,
// and a failing native module that never reaches the interaction.
import { beforeEach, describe, expect, it, vi } from "vitest";

import { hapticsStub } from "../test/haptics-stub";

vi.mock(import("expo-haptics"), () => hapticsStub());

const Haptics = await import("expo-haptics");
const { hapticLanded, hapticMode, hapticSelect } = await import("./haptics");

describe("the one moment channel", () => {
  beforeEach(() => {
    vi.mocked(Haptics.selectionAsync).mockClear();
    vi.mocked(Haptics.impactAsync).mockClear();
    vi.mocked(Haptics.notificationAsync).mockClear();
  });

  it("ticks for a band selection", () => {
    hapticSelect();
    expect(Haptics.selectionAsync).toHaveBeenCalledOnce();
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
    expect(Haptics.notificationAsync).not.toHaveBeenCalled();
  });

  it("knocks for a mode change, harder than a selection tick", () => {
    hapticMode();
    expect(Haptics.impactAsync).toHaveBeenCalledWith(
      Haptics.ImpactFeedbackStyle.Medium
    );
  });

  it("answers a landed destructive write, once", () => {
    hapticLanded();
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(
      Haptics.NotificationFeedbackType.Success
    );
  });

  it("swallows a rejecting native module", async () => {
    vi.mocked(Haptics.selectionAsync).mockRejectedValueOnce(
      new Error("no such module")
    );
    expect(() => hapticSelect()).not.toThrow();
    await Promise.resolve();
  });

  it("swallows a native module that throws synchronously", () => {
    vi.mocked(Haptics.impactAsync).mockImplementationOnce(() => {
      throw new Error("unavailable");
    });
    expect(() => hapticMode()).not.toThrow();
  });
});
