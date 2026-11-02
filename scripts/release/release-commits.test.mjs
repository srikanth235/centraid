import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  classifyBump,
  commitsSinceLastTag,
  parseCommit,
  releaseNotes,
} from "./release-commits.mjs";

describe("parseCommit", () => {
  test("splits type, scope, text and issue", () => {
    expect(parseCommit("feat(photos): add albums (#12)")).toEqual({
      type: "feat",
      scope: "photos",
      text: "add albums",
      issue: "12",
      breaking: false,
    });
  });

  test("a `!` or a BREAKING CHANGE body marks the commit breaking", () => {
    expect(parseCommit("fix!: drop old route (#3)")?.breaking).toBe(true);
    expect(
      parseCommit({
        subject: "fix: tweak (#4)",
        body: "BREAKING CHANGE: format moved",
      })?.breaking
    ).toBe(true);
  });

  test("merge, revert, fixup and release commits are not releasable", () => {
    for (const s of [
      "Merge branch 'x'",
      'Revert "feat: a (#1)"',
      "revert: a (#1)",
      "fixup! fix: a (#1)",
      "chore(release): 0.4.3 (#9)",
    ]) {
      expect(parseCommit(s)).toBeNull();
    }
  });
});

describe("D4 patch-vs-minor classification", () => {
  test("any feat earns a minor", () => {
    expect(
      classifyBump(["fix(a): x (#1)", "feat(b): y (#2)", "docs: z (#3)"])
    ).toMatchObject({ bump: "minor", candidate: true });
  });

  test("without a feat the bump is a patch", () => {
    for (const subjects of [
      ["fix(a): x (#1)"],
      ["docs: z (#3)", "chore(ci): w (#4)", "refactor: v (#5)"],
    ]) {
      expect(classifyBump(subjects)).toMatchObject({
        bump: "patch",
        candidate: true,
      });
    }
  });

  test("a breaking marker never picks major", () => {
    const fix = classifyBump(["fix!: break (#1)"]);
    expect(fix).toMatchObject({ bump: "patch", breaking: true });
    expect(fix.rationale).toContain("major is a human decision");
    expect(classifyBump(["feat!: break (#2)"]).bump).toBe("minor");
  });

  test("no releasable commits is not a candidate", () => {
    for (const subjects of [[], ["chore(release): 0.4.3 (#9)"], ["Merge x"]]) {
      expect(classifyBump(subjects)).toMatchObject({
        bump: null,
        candidate: false,
      });
    }
  });
});

describe("releaseNotes", () => {
  test("groups Features / Fixes / Other and keeps each (#N)", () => {
    expect(
      releaseNotes(
        [
          "docs(readme): clarify (#5)",
          "fix: crash on open (#2)",
          "feat(photos): add albums (#1)",
          "chore(release): 0.4.3 (#9)",
          "perf(core): faster open (#6)",
        ],
        "0.5.0"
      )
    ).toBe(
      [
        "## Features",
        "",
        "- **photos**: add albums (#1)",
        "",
        "## Fixes",
        "",
        "- crash on open (#2)",
        "",
        "## Other",
        "",
        "- **readme**: clarify (#5)",
        "- **core**: faster open (#6)",
        "",
      ].join("\n")
    );
  });

  test("omits empty groups and falls back to a plain line", () => {
    expect(releaseNotes(["fix: a (#1)"], "1.0.1")).not.toContain("## Features");
    expect(releaseNotes([], "1.0.1")).toBe("Centraid 1.0.1\n");
  });
});

describe("commitsSinceLastTag", () => {
  const env = {
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  /** @param {string} cwd @param {string[]} args */
  const git = (cwd, args) => {
    expect(spawnSync("git", args, { cwd, env }).status).toBe(0);
  };

  test("reads only the commits after the newest v* tag, all of them if none", () => {
    const repo = tempDirSync("centraid-release-commits-");
    git(repo, ["init", "-q"]);
    const commit = (/** @type {string} */ subject) => {
      writeFileSync(path.join(repo, "f"), subject);
      git(repo, ["add", "."]);
      git(repo, ["commit", "-q", "-m", subject]);
    };
    commit("feat: old feature (#1)");
    expect(commitsSinceLastTag(repo).map((c) => c.subject)).toEqual([
      "feat: old feature (#1)",
    ]);
    git(repo, ["tag", "-a", "v0.1.0", "-m", "v0.1.0"]);
    commit("fix: after the tag (#2)");
    expect(commitsSinceLastTag(repo).map((c) => c.subject)).toEqual([
      "fix: after the tag (#2)",
    ]);
  });
});
