import { describe, expect, it, vi } from "vitest";

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
    expect(
      capturedAtIso({ creationTime: null, modificationTime: null })
    ).toBeUndefined();
  });

  it("treats a recorded 0 as absent, the same as null", () => {
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
