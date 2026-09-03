import { describe, expect, it } from "vitest";

import { asDrivePrefs, DEFAULT_DRIVE_PREFS } from "./docs-view-prefs";

describe(asDrivePrefs, () => {
  it("defaults to list rows, date changed, newest first", () => {
    expect(DEFAULT_DRIVE_PREFS).toStrictEqual({
      view: "list",
      sortKey: "changed",
      sortDir: -1,
    });
  });

  it("narrows whatever the store held back to a valid pair", () => {
    expect(asDrivePrefs(null)).toStrictEqual(DEFAULT_DRIVE_PREFS);
    expect(
      asDrivePrefs({ view: "grid", sortKey: "size", sortDir: 1 })
    ).toStrictEqual({ view: "grid", sortKey: "size", sortDir: 1 });
    expect(
      asDrivePrefs({ view: "carousel", sortKey: "vibes", sortDir: 0 })
    ).toStrictEqual(DEFAULT_DRIVE_PREFS);
  });
});
