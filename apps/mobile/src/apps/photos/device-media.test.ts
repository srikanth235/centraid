import { describe, expect, it, vi } from "vitest";

// `device-media.ts` also imports `expo-media-library` and `react-native` for
// the functions that resolve real bytes off the device — neither is touched
// by `capturedAtIso`, but both load native setup code that this plain "node"
// vitest project has no runtime for. Stand-ins only; this file asserts pure
// date logic, not device access.
vi.mock(import("expo-media-library"), () => ({}) as never);
vi.mock(import("react-native"), () => ({ Platform: { OS: "ios" } }) as never);

const { capturedAtIso } = await import("./device-media");

describe(capturedAtIso, () => {
  it("prefers creationTime when both timestamps are recorded", () => {
    expect(
      capturedAtIso({
        creationTime: Date.parse("2026-08-04T10:00:00.000Z"),
        modificationTime: Date.parse("2026-08-05T00:00:00.000Z"),
      })
    ).toBe("2026-08-04T10:00:00.000Z");
  });

  it("falls back to modificationTime when creationTime is absent", () => {
    expect(
      capturedAtIso({
        creationTime: null,
        modificationTime: Date.parse("2026-08-05T00:00:00.000Z"),
      })
    ).toBe("2026-08-05T00:00:00.000Z");
  });

  it("is undefined, never 1970, when neither timestamp is recorded", () => {
    // The defect this guards: `new Date(null ?? null ?? 0).toISOString()`
    // used to file the photo under 1970-01-01, an invented capture date.
    expect(
      capturedAtIso({ creationTime: null, modificationTime: null })
    ).toBeUndefined();
  });

  it("treats a recorded 0 as absent, the same as null", () => {
    // This media store has been seen substituting 0 for "not recorded" —
    // reading it as a literal 1970 capture would file the same defect back
    // in under a different value.
    expect(
      capturedAtIso({ creationTime: 0, modificationTime: 0 })
    ).toBeUndefined();
    expect(
      capturedAtIso({
        creationTime: 0,
        modificationTime: Date.parse("2026-08-05T00:00:00.000Z"),
      })
    ).toBe("2026-08-05T00:00:00.000Z");
  });
});
