import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { tempDirSync } from "@centraid/test-kit/temp-dir";

import { lintReleaseWiring } from "./validate-release-wiring.mjs";

/**
 * The point of a linter test is the FAIL path: a structural gate that cannot
 * reject anything is worse than no gate, because it reports green. Every test
 * below sabotages one real invariant in a copy of the shipped workflows and
 * asserts the specific violation is named.
 */
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const WORKFLOW_DIR = path.join(REPO_ROOT, ".github/workflows");
const RELEASE_FILES = readdirSync(WORKFLOW_DIR).filter(
  (name) => name === "release.yml" || name.startsWith("lane-release-")
);

/**
 * Copy the real release workflows into a scratch root, optionally rewriting
 * one of them, and lint the result.
 * @param {Record<string, (text: string) => string>} [edits] file → mutation.
 * @returns {string[]} Violations.
 */
/**
 * A GitHub `${{ … }}` expression cannot be written as a plain string literal
 * (`no-template-curly-in-string`), so build it from a template literal with the
 * `$` escaped.
 * @param {string} name Secret name.
 * @returns {string} The YAML value text.
 */
function secretExpr(name) {
  return `\${{ secrets.${name} }}`;
}

function lintFixture(edits = {}) {
  const root = tempDirSync("release-wiring-");
  const dir = path.join(root, ".github/workflows");
  mkdirSync(dir, { recursive: true });
  for (const name of RELEASE_FILES) {
    const original = readFileSync(path.join(WORKFLOW_DIR, name), "utf8");
    writeFileSync(path.join(dir, name), edits[name]?.(original) ?? original);
  }
  for (const [name, edit] of Object.entries(edits)) {
    if (RELEASE_FILES.includes(name)) continue;
    writeFileSync(path.join(dir, name), edit(""));
  }
  return lintReleaseWiring(root);
}

describe("validate-release-wiring", () => {
  test("the shipped release lane satisfies every invariant", () => {
    expect(lintReleaseWiring(REPO_ROOT)).toStrictEqual([]);
  });

  test("an isolated copy of the shipped workflows is also clean", () => {
    // Guards the fixture itself: if this were red, every failure below would be
    // unattributable to its sabotage.
    expect(lintFixture()).toStrictEqual([]);
  });

  test("rejects a lane dropped from the release-check aggregator", () => {
    const errors = lintFixture({
      "release.yml": (text) =>
        // #915 gave release-check a `require-candidate` gate and reflowed the
        // list across lines; the sabotage drops `mobile` from wherever it sits.
        text.replace(/^\s*mobile,$/mu, ""),
    });
    expect(errors).toContain(
      "release-check.needs is missing job mobile — that lane could fail while the release reports success"
    );
  });

  test("rejects a newly added job that nobody aggregates", () => {
    const errors = lintFixture({
      "release.yml": (text) =>
        text.replace(
          "\n  release-check:",
          "\n  brand-new-surface:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n\n  release-check:"
        ),
    });
    expect(errors).toContain(
      "release-check.needs is missing job brand-new-surface — that lane could fail while the release reports success"
    );
  });

  test("rejects an aggregator that skips when a lane fails", () => {
    const errors = lintFixture({
      "release.yml": (text) =>
        // Drop `if: always()` from release-check, wherever the list wraps.
        text.replace(
          /^\s*if: always\(\)\n(?=\s*runs-on: ubuntu-latest\n\s*timeout-minutes)/mu,
          ""
        ),
    });
    expect(errors).toContain(
      "release-check must run with `if: always()` or a failed lane skips the aggregator entirely"
    );
  });

  test("rejects an aggregator that treats cancelled as a pass", () => {
    const errors = lintFixture({
      "release.yml": (text) =>
        text.replace("success | skipped", "success | skipped | cancelled"),
    });
    expect(errors).toContain(
      "release-check must treat only `success` and `skipped` as passing results"
    );
  });

  test("rejects an aggregator that no longer fails closed on empty results", () => {
    const errors = lintFixture({
      "release.yml": (text) => text.replace("refusing to pass", "passing"),
    });
    expect(errors).toContain(
      "release-check must fail closed when it receives no lane results"
    );
  });

  test("rejects the mobile store lane riding along on surfaces: all", () => {
    const errors = lintFixture({
      "release.yml": (text) =>
        text.replace(
          "github.event_name == 'workflow_dispatch' && needs.plan.outputs.surfaces == 'mobile'",
          "github.event_name == 'workflow_dispatch' && (needs.plan.outputs.surfaces == 'all' || needs.plan.outputs.surfaces == 'mobile')"
        ),
    });
    expect(errors).toContain(
      "mobile lane must NOT accept surfaces == 'all' — store submission stays opt-in (J7)"
    );
  });

  test("rejects a mobile lane reachable from a pushed tag", () => {
    const errors = lintFixture({
      "release.yml": (text) =>
        text.replace(
          "github.event_name == 'workflow_dispatch' && needs.plan.outputs.surfaces == 'mobile'",
          "needs.plan.outputs.surfaces == 'mobile'"
        ),
    });
    expect(errors).toContain(
      "mobile lane must be reachable only from workflow_dispatch, never a pushed tag"
    );
  });

  test("rejects a second workflow listening on pushed tags", () => {
    const errors = lintFixture({
      "release-desktop.yml": () =>
        "name: rogue\non:\n  push:\n    tags:\n      - 'v*'\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n",
    });
    expect(errors).toContain(
      "release-desktop.yml listens on pushed tags — release.yml is the single tag entry point (#557)"
    );
  });

  test("rejects a lane that grows its own trigger", () => {
    const errors = lintFixture({
      "lane-release-companion.yml": (text) =>
        text.replace(
          "on:\n  workflow_call:",
          "on:\n  workflow_call:\n  push:\n    branches: [main]"
        ),
    });
    expect(errors).toContain(
      "lane-release-companion.yml declares its own push: trigger — lanes are called by release.yml only"
    );
  });

  test("rejects an orphan lane file no release job calls", () => {
    const errors = lintFixture({
      "lane-release-orphan.yml": () =>
        "name: orphan\non:\n  workflow_call:\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n",
    });
    expect(errors).toContain(
      "lane-release-orphan.yml is never called by release.yml — an orphan release lane can never run"
    );
  });

  test("rejects a job calling a workflow file that does not exist", () => {
    const errors = lintFixture({
      "release.yml": (text) =>
        text.replace(
          "uses: ./.github/workflows/lane-release-companion.yml",
          "uses: ./.github/workflows/lane-release-typo.yml"
        ),
    });
    expect(errors).toContain(
      "release.yml job companion calls missing workflow lane-release-typo.yml"
    );
  });

  test("rejects forwarding a secret the lane never declared", () => {
    const errors = lintFixture({
      "release.yml": (text) =>
        text.replace(
          `      NPM_TOKEN: ${secretExpr("NPM_TOKEN")}`,
          `      NPM_TOKEN: ${secretExpr("NPM_TOKEN")}\n      APPLE_API_KEY: ${secretExpr("APPLE_API_KEY")}`
        ),
    });
    expect(errors).toContain(
      "release.yml job gateway-npm forwards APPLE_API_KEY, which lane-release-gateway-npm.yml does not declare under on.workflow_call.secrets"
    );
  });

  test("rejects secrets: inherit", () => {
    const errors = lintFixture({
      "release.yml": (text) =>
        text.replace(
          `    secrets:\n      NPM_TOKEN: ${secretExpr("NPM_TOKEN")}`,
          "    secrets: inherit"
        ),
    });
    expect(errors).toContain(
      "release.yml must not use `secrets: inherit` — each lane declares the secrets it accepts"
    );
  });

  test("rejects cancelling an in-flight release", () => {
    const errors = lintFixture({
      "release.yml": (text) =>
        text.replace("cancel-in-progress: false", "cancel-in-progress: true"),
    });
    expect(errors).toContain(
      "release.yml concurrency must set cancel-in-progress: false — a tag is immutable"
    );
  });

  test("rejects a widened workflow-level permission default", () => {
    const errors = lintFixture({
      "release.yml": (text) =>
        text.replace(
          "permissions:\n  contents: read\n\njobs:",
          "permissions:\n  contents: write\n\njobs:"
        ),
    });
    expect(errors).toContain(
      "release.yml must default to workflow-level `permissions: contents: read`"
    );
  });

  test("rejects a gateway-npm job that loses OIDC for provenance", () => {
    const errors = lintFixture({
      "release.yml": (text) => text.replace("      id-token: write\n", ""),
    });
    expect(errors).toContain(
      "gateway-npm job needs `id-token: write` for `npm publish --provenance`"
    );
  });

  test("rejects a gateway-npm job that forgets to restate contents: read", () => {
    // Job-level permissions REPLACE the workflow block, so dropping the restate
    // silently removes checkout's read access.
    const errors = lintFixture({
      "release.yml": (text) =>
        text.replace("      contents: read\n      # OIDC", "      # OIDC"),
    });
    expect(errors).toContain(
      "gateway-npm job must restate `contents: read` — job permissions replace the workflow block"
    );
  });

  test("rejects a desktop job that cannot create the GitHub release", () => {
    const errors = lintFixture({
      "release.yml": (text) =>
        text.replace(
          "    permissions:\n      contents: write\n    uses: ./.github/workflows/lane-release-desktop.yml",
          "    permissions:\n      contents: read\n    uses: ./.github/workflows/lane-release-desktop.yml"
        ),
    });
    expect(errors).toContain(
      "desktop job needs `contents: write` to create the GitHub release"
    );
  });

  test("a comment mentioning an invariant cannot satisfy it", () => {
    // Comments are stripped before matching, so prose about cancel-in-progress
    // does not stand in for the setting.
    const errors = lintFixture({
      "release.yml": (text) =>
        text.replace(
          "cancel-in-progress: false",
          "cancel-in-progress: true # was cancel-in-progress: false"
        ),
    });
    expect(errors).toContain(
      "release.yml concurrency must set cancel-in-progress: false — a tag is immutable"
    );
  });
});
