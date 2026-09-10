import { describe, expect, it } from "vitest";

import { keepOriginalsMeta } from "./album-keep-originals";

describe("the album's Keep-originals sub-line", () => {
  it("says the album is excluded only when the switch is on", () => {
    expect(keepOriginalsMeta({ keepOriginals: true, pinsReady: true })).toBe(
      "Excluded from Free up vault"
    );
  });

  it("says the album is included when the switch is off", () => {
    expect(keepOriginalsMeta({ keepOriginals: false, pinsReady: true })).toBe(
      "Included in Free up vault"
    );
  });

  it("claims neither before the pin store has hydrated", () => {
    expect(keepOriginalsMeta({ keepOriginals: false, pinsReady: false })).toBe(
      "Checking this album's originals"
    );
  });
});
