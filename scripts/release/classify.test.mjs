import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

const CLASSIFY = path.resolve(import.meta.dirname, "classify.mjs");

function classify(lines, args = []) {
  const file = path.join(tempDirSync("centraid-classify-"), "CHANGELOG.md");
  writeFileSync(file, `${lines.join("\n")}\n`);
  const result = spawnSync(process.execPath, [CLASSIFY, file, ...args], {
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout);
}

const unreleased = (...body) => [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  ...body,
];

describe("D4 patch-vs-minor classification", () => {
  test("Fixed-only is the only shape that earns a patch", () => {
    expect(classify(unreleased("### Fixed", "", "- a fix"))).toMatchObject({
      bump: "patch",
      onlyFixed: true,
    });
  });

  for (const heading of [
    "Added",
    "Changed",
    "Removed",
    "Deprecated",
    "Security",
  ]) {
    test(`${heading} forces a minor`, () => {
      expect(
        classify(unreleased(`### ${heading}`, "", "- a change"))
      ).toMatchObject({ bump: "minor", onlyFixed: false });
    });
  }

  test("Fixed mixed with a non-Fixed heading is a minor", () => {
    expect(
      classify(
        unreleased(
          "### Fixed",
          "",
          "- a fix",
          "",
          "### Added",
          "",
          "- a feature"
        )
      )
    ).toMatchObject({ bump: "minor" });
  });

  test("bullets under no heading cannot be proven fix-only, so minor", () => {
    expect(classify(unreleased("- an unclassified change"))).toMatchObject({
      bump: "minor",
    });
  });

  test("an empty section is an empty patch candidate", () => {
    const result = classify(unreleased("## [0.1.0] - 2026-01-01", "", "- old"));
    expect(result.bump).toBe("patch");
    expect(result.rationale).toContain("no changelog bullets");
  });

  test("a missing section defaults to minor rather than silently patching", () => {
    expect(
      classify(["# Changelog", "", "## [0.1.0] - 2026-01-01", "", "- old"])
    ).toMatchObject({ bump: "minor" });
  });

  test("--version classifies a named release, not Unreleased", () => {
    const lines = [
      ...unreleased("### Added", "", "- a feature", ""),
      "## [0.2.0] - 2026-02-01",
      "",
      "### Fixed",
      "",
      "- a fix",
    ];
    expect(classify(lines, ["--version", "0.2.0"])).toMatchObject({
      bump: "patch",
    });
    expect(classify(lines)).toMatchObject({ bump: "minor" });
  });

  test("the repo's own CHANGELOG classifies from its real content", () => {
    const repoChangelog = path.resolve(
      import.meta.dirname,
      "../../CHANGELOG.md"
    );
    const result = spawnSync(process.execPath, [CLASSIFY, repoChangelog], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).rationale).not.toContain(
      "no changelog bullets"
    );
  });
});
