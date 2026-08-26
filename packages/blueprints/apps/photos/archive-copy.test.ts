// Hide and Archive are one act: the same words on every seat.
import { describe, expect, it } from "vitest";

import {
  PHOTOS_ARCHIVE,
  PHOTOS_ARCHIVE_EMPTY,
  PHOTOS_UNARCHIVE,
  photosArchiveVerb,
} from "./shared-copy.ts";

describe("hide vs archive mean the same thing on every seat", () => {
  it("names the archived_at write Archive / Unarchive, never Hide", () => {
    expect(photosArchiveVerb(false)).toBe(PHOTOS_ARCHIVE);
    expect(photosArchiveVerb(true)).toBe(PHOTOS_UNARCHIVE);
    expect(PHOTOS_ARCHIVE).toBe("Archive");
    expect(PHOTOS_UNARCHIVE).toBe("Unarchive");
    expect(PHOTOS_ARCHIVE_EMPTY).toBe("Archive is empty.");
    expect(PHOTOS_ARCHIVE.toLowerCase()).not.toContain("hide");
    expect(PHOTOS_UNARCHIVE.toLowerCase()).not.toContain("hide");
  });
});
