import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import {
  assertNoOpenNightlyQualityIssues,
  parseOpenNightlyIssues,
} from "./nightly-quality-blockers.mjs";

const realRoot = path.resolve(import.meta.dirname, "../..");
const FIXTURE_VERSION = "0.4.2";

const REPO_POINTING_GIT_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

function stripRepoPointingGitEnv(env) {
  const out = { ...env };
  for (const key of REPO_POINTING_GIT_VARS) delete out[key];
  return out;
}

const isolatedEnv = {
  ...stripRepoPointingGitEnv(process.env),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  CENTRAID_NIGHTLY_QUALITY_ISSUES: "[]",
};

describe("nightly release blocker", () => {
  test("parses only actionable open issue rows", () => {
    expect(
      parseOpenNightlyIssues(
        JSON.stringify([
          { number: 9, title: "nightly red", url: "https://example.test/9" },
          { number: "bad", title: "ignored", url: "https://example.test/x" },
        ])
      )
    ).toStrictEqual([
      { number: 9, title: "nightly red", url: "https://example.test/9" },
    ]);
  });

  test("blocks release preparation when a nightly red issue is open", () => {
    expect(() =>
      assertNoOpenNightlyQualityIssues(() => ({
        status: 0,
        stdout: JSON.stringify([
          { number: 9, title: "nightly red", url: "https://example.test/9" },
        ]),
        stderr: "",
      }))
    ).toThrow(/release blocked.*#9/iu);
  });
});

function makeFixtureRoot(options = {}) {
  const root = tempDirSync("centraid-release-");
  cpSync(
    path.join(realRoot, "scripts/release"),
    path.join(root, "scripts/release"),
    { recursive: true }
  );
  mkdirSync(path.join(root, "apps/mobile/src"), { recursive: true });
  cpSync(
    path.join(realRoot, "apps/mobile/src/version-core.cjs"),
    path.join(root, "apps/mobile/src/version-core.cjs")
  );
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify(
      {
        name: "release-fixture",
        version: options.version ?? FIXTURE_VERSION,
        workspaces: { packages: [] },
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    path.join(root, "CHANGELOG.md"),
    options.changelog ??
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "### Fixed",
        "",
        "- a fix",
        "",
      ].join("\n")
  );
  return root;
}

function runPublish(root, args) {
  return spawnSync(
    process.execPath,
    [path.join(root, "scripts/release/publish.mjs"), ...args],
    { cwd: root, encoding: "utf8", env: isolatedEnv }
  );
}

function runPrepare(root, args) {
  return spawnSync(
    process.execPath,
    [
      path.join(root, "scripts/release/prepare.mjs"),
      "--allow-uncandidated",
      "release fixture repo: no remote, never promoted",
      ...args,
    ],
    { cwd: root, encoding: "utf8", env: isolatedEnv }
  );
}

describe("fixture isolation", () => {
  test("a hook environment is scrubbed of every repo-pointing git variable", () => {
    const hookEnv = {
      PATH: "/usr/bin",
      GIT_DIR: "/real/repo/.git/worktrees/wt",
      GIT_WORK_TREE: "/real/repo",
      GIT_COMMON_DIR: "/real/repo/.git",
      GIT_INDEX_FILE: "/real/repo/.git/index",
      GIT_PREFIX: "sub/",
      GIT_OBJECT_DIRECTORY: "/real/repo/.git/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/other/objects",
    };
    const scrubbed = stripRepoPointingGitEnv(hookEnv);
    for (const key of REPO_POINTING_GIT_VARS) {
      expect(
        scrubbed,
        `${key} would redirect fixture git at the real repo`
      ).not.toHaveProperty(key);
    }
    expect(scrubbed.PATH).toBe("/usr/bin");
  });

  test("the env these fixtures actually run under carries none of them", () => {
    for (const key of REPO_POINTING_GIT_VARS) {
      expect(
        isolatedEnv,
        `${key} leaked into the fixture env`
      ).not.toHaveProperty(key);
    }
  });

  test("a fixture git init lands in its own cwd", () => {
    const fixture = tempDirSync("centraid-fixture-");
    spawnSync("git", ["init", "-q"], { cwd: fixture, env: isolatedEnv });
    expect(existsSync(path.join(fixture, ".git"))).toBe(true);
  });
});

describe("release publish guards", () => {
  let root;
  beforeAll(() => {
    root = makeFixtureRoot();
  });

  test("refuses a publish with no --version", () => {
    const result = runPublish(root, ["--issue", "656"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: node scripts/release/publish.mjs");
  });

  test("refuses a version that is not X.Y.Z", () => {
    const result = runPublish(root, ["--version", "0.5", "--issue", "656"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: node scripts/release/publish.mjs");
  });

  test("refuses a publish with no --issue", () => {
    const result = runPublish(root, ["--version", "0.5.0"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("publish requires --issue N");
  });

  test("refuses issue #0", () => {
    const result = runPublish(root, ["--version", "0.5.0", "--issue", "0"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("#0 is forbidden");
  });

  test("refuses a non-numeric issue reference", () => {
    const result = runPublish(root, [
      "--version",
      "0.5.0",
      "--issue",
      "GH-656",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("publish requires --issue N");
  });

  test("refuses an unknown ship surface", () => {
    const result = runPublish(root, [
      "--version",
      "0.5.0",
      "--issue",
      "656",
      "--surfaces",
      "desktop,teleporter",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown surface "teleporter"');
  });

  test("refuses a ship set that is only continuous surfaces", () => {
    const result = runPublish(root, [
      "--version",
      "0.5.0",
      "--issue",
      "656",
      "--surfaces",
      "web,docs",
      "--dry-run",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "refusing publish that only lists continuous surfaces"
    );
  });

  test("allows a sideline-only ship set through the continuous guard", () => {
    const result = runPublish(root, [
      "--version",
      "0.5.0",
      "--issue",
      "656",
      "--surfaces",
      "companion",
      "--dry-run",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).surfaces).toEqual(["companion"]);
  });
});

describe("release publish derivation", () => {
  test("derives the annotated tag and previous version from the root manifest", () => {
    const root = makeFixtureRoot();
    const result = runPublish(root, [
      "--version",
      "0.5.0",
      "--issue",
      "656",
      "--dry-run",
    ]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.tag).toBe("v0.5.0");
    expect(report.prev).toBe(FIXTURE_VERSION);
    expect(report.version).toBe("0.5.0");
  });

  test("derives a numbered beta tag under --beta --beta-n", () => {
    const root = makeFixtureRoot();
    const result = runPublish(root, [
      "--version",
      "0.5.0",
      "--issue",
      "656",
      "--beta",
      "--beta-n",
      "3",
      "--dry-run",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).tag).toBe("v0.5.0-beta.3");
  });

  test("ships the tag-cadence surfaces by default", () => {
    const root = makeFixtureRoot();
    const result = runPublish(root, [
      "--version",
      "0.5.0",
      "--issue",
      "656",
      "--dry-run",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).surfaces).toEqual([
      "desktop",
      "gateway-image",
      "gateway-npm",
    ]);
  });

  test("computes the native build number from the semver", () => {
    const root = makeFixtureRoot();
    const result = runPublish(root, [
      "--version",
      "1.2.3",
      "--issue",
      "656",
      "--dry-run",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).syncReport.build).toBe(1_002_003);
  });

  test("a dry run leaves the version stamp and CHANGELOG untouched", () => {
    const root = makeFixtureRoot();
    const changelogBefore = readFileSync(
      path.join(root, "CHANGELOG.md"),
      "utf8"
    );
    const result = runPublish(root, [
      "--version",
      "0.5.0",
      "--issue",
      "656",
      "--dry-run",
    ]);
    expect(result.status).toBe(0);
    expect(
      JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version
    ).toBe(FIXTURE_VERSION);
    expect(readFileSync(path.join(root, "CHANGELOG.md"), "utf8")).toBe(
      changelogBefore
    );
  });
});

describe("release prepare guards", () => {
  test("refuses to prepare a HEAD that was never promoted", () => {
    const root = makeFixtureRoot();
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "scripts/release/prepare.mjs"),
        "--allow-dirty",
        "--skip-check",
      ],
      { cwd: root, encoding: "utf8", env: isolatedEnv }
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no candidate has ever been promoted");
  });

  test("refuses to prepare from a dirty working tree", () => {
    const root = makeFixtureRoot();
    spawnSync("git", ["init", "-q"], { cwd: root, env: isolatedEnv });
    writeFileSync(path.join(root, "untracked.txt"), "dirty\n");
    const result = runPrepare(root, ["--skip-check"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("working tree not clean");
  });

  test("increments only the patch component on a patch bump", () => {
    const root = makeFixtureRoot();
    const result = runPrepare(root, ["--allow-dirty", "--skip-check"]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.bump).toBe("patch");
    expect(report.current).toBe(FIXTURE_VERSION);
    expect(report.next).toBe("0.4.3");
  });

  test("increments the minor and zeroes the patch on a minor bump", () => {
    const root = makeFixtureRoot({
      changelog: [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        "### Added",
        "",
        "- a feature",
        "",
        "## [0.4.2] - 2026-01-01",
        "",
        "- old",
        "",
      ].join("\n"),
    });
    const result = runPrepare(root, ["--allow-dirty", "--skip-check"]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.bump).toBe("minor");
    expect(report.next).toBe("0.5.0");
  });

  test("emits a publish command that still requires a real issue number", () => {
    const root = makeFixtureRoot();
    const result = runPrepare(root, ["--allow-dirty", "--skip-check"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).publishCommand).toBe(
      "node scripts/release/publish.mjs --version 0.4.3 --issue N --surfaces desktop,gateway-image,gateway-npm"
    );
  });

  test("prepare never stamps the version it proposes", () => {
    const root = makeFixtureRoot();
    const result = runPrepare(root, ["--allow-dirty", "--skip-check"]);
    expect(result.status).toBe(0);
    expect(
      JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version
    ).toBe(FIXTURE_VERSION);
  });
});
