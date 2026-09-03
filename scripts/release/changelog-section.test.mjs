import { describe, expect, test } from "vitest";

import { changelogSectionBody } from "./changelog-section.mjs";

const CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- a feature",
  "",
  "## [0.2.0] - 2026-02-01",
  "",
  "### Fixed",
  "",
  "- a fix",
  "",
  "## [0.1.0] - 2026-01-01",
  "",
  "- first",
  "",
].join("\n");

describe("changelogSectionBody", () => {
  test("captures the whole section body, not the first line", () => {
    expect(changelogSectionBody(CHANGELOG, "Unreleased")).toContain(
      "### Added"
    );
    expect(changelogSectionBody(CHANGELOG, "Unreleased")).toContain(
      "- a feature"
    );
  });

  test("stops at the next section rather than running to end of file", () => {
    const body = changelogSectionBody(CHANGELOG, "0.2.0");
    expect(body).toContain("- a fix");
    expect(body).not.toContain("- first");
    expect(body).not.toContain("## [0.1.0]");
  });

  test("runs to end of input for the last section", () => {
    expect(changelogSectionBody(CHANGELOG, "0.1.0")).toContain("- first");
  });

  test("returns null for an absent section", () => {
    expect(changelogSectionBody(CHANGELOG, "9.9.9")).toBeNull();
  });

  test("distinguishes an absent section from an empty one", () => {
    const empty = ["## [Unreleased]", "", "## [0.1.0]", "", "- x", ""].join(
      "\n"
    );
    expect(changelogSectionBody(empty, "Unreleased")).toBe("\n");
  });
});
