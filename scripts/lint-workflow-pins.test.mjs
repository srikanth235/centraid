import assert from "node:assert/strict";
import test from "node:test";

import { lintWorkflowSource } from "./lint-workflow-pins.mjs";

const clean = `name: x
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - uses: ./.github/actions/setup
      - run: bun test
`;

test("a fully pinned, bounded workflow is clean", () => {
  assert.deepEqual(lintWorkflowSource("w.yml", clean), []);
});

test("a floating tag is rejected", () => {
  const source = clean.replace(
    "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2",
    "actions/checkout@v4"
  );
  const errors = lintWorkflowSource("w.yml", source);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /floating ref `actions\/checkout@v4`/u);
});

test("a moving branch ref is rejected the same way a tag is", () => {
  const source = clean.replace(
    "- uses: ./.github/actions/setup",
    "- uses: dtolnay/rust-toolchain@stable"
  );
  const errors = lintWorkflowSource("w.yml", source);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /rust-toolchain@stable/u);
});

test("repo-local and docker:// refs are exempt", () => {
  const source = clean.replace(
    "- run: bun test",
    "- uses: docker://rhysd/actionlint:1.7.12\n      - run: bun test"
  );
  assert.deepEqual(lintWorkflowSource("w.yml", source), []);
});

test("a hardcoded bun-version is rejected", () => {
  const source = clean.replace(
    "      - uses: ./.github/actions/setup\n",
    "      - uses: oven-sh/setup-bun@4bc047ad259df6fc24a6c9b0f9a0cb08cf17fbe5 # v2.0.2\n        with:\n          bun-version: 1.3.13\n"
  );
  const errors = lintWorkflowSource("w.yml", source);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /hardcodes a Bun version/u);
});

test("a job without timeout-minutes is rejected, and names the job", () => {
  const source = clean.replace("    timeout-minutes: 10\n", "");
  const errors = lintWorkflowSource("w.yml", source);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /job `build` has no timeout-minutes/u);
});

test("every job is checked, not just the first", () => {
  const source = `${clean}  publish:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
  const errors = lintWorkflowSource("w.yml", source);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /job `publish` has no timeout-minutes/u);
});

test("a step key that merely looks like a job key is not treated as one", () => {
  // `with:` / `env:` blocks sit at 8+ spaces; only 2-space keys under `jobs:`
  // are jobs. A regression here would demand timeout-minutes on a `with:` map.
  const source = `name: x
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4
        with:
          path: |
            a
            b
`;
  assert.deepEqual(lintWorkflowSource("w.yml", source), []);
});

test("a governance-kit:managed workflow is exempt — its policy lives upstream", () => {
  const source = `# governance-kit:managed kit-version=0.12.0
name: Governance
jobs:
  governance:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@93cb6efe18208431cddfb8368fd83d5badbf9bfd
`;
  // No timeout-minutes and a bare SHA with no version comment — both would be
  // violations in a repo-owned workflow. Editing a kit file breaks its
  // integrity digest, so the lint must not demand a change it cannot make.
  assert.deepEqual(lintWorkflowSource("governance.yml", source), []);
});

test("a hand-rolled bun install is rejected — the setup action owns it", () => {
  const source = clean.replace(
    "      - run: bun test\n",
    "      - run: bun install --frozen-lockfile\n"
  );
  const errors = lintWorkflowSource("w.yml", source);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /runs `bun install` by hand/u);
});

test("a named-step install is caught too, not just `- run:`", () => {
  // The 33 copies this replaced were not uniformly shaped: npm-gateway-publish
  // spelled it `- name: Install JS deps` / `run: bun install …`, which a
  // `- run:`-anchored pattern would have walked straight past.
  const source = clean.replace(
    "      - run: bun test\n",
    "      - name: Install JS deps\n        run: bun install --frozen-lockfile\n"
  );
  const errors = lintWorkflowSource("w.yml", source);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /runs `bun install` by hand/u);
});

test("only ci.yml may listen on pull_request", () => {
  const source = `name: web
on:
  pull_request:
    paths:
      - 'apps/web/**'
${clean.slice(clean.indexOf("jobs:"))}`;
  const errors = lintWorkflowSource(".github/workflows/web.yml", source);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /only ci\.yml may/u);
});

test("ci.yml itself may listen on pull_request", () => {
  const source = `name: ci
on:
  pull_request:
${clean.slice(clean.indexOf("jobs:"))}`;
  assert.deepEqual(lintWorkflowSource(".github/workflows/ci.yml", source), []);
});

test("a `pull_request` mention that is not a trigger is not flagged", () => {
  // `github.event.pull_request.number` in a concurrency group, and the word in
  // a comment, are both fine — only a two-space `pull_request:` key is a
  // trigger.
  const source = `name: security
# not a pull_request gate
concurrency:
  group: x-\${{ github.event.pull_request.number || github.ref }}
${clean.slice(clean.indexOf("jobs:"))}`;
  assert.deepEqual(
    lintWorkflowSource(".github/workflows/security.yml", source),
    []
  );
});

test("a job that calls a reusable workflow is exempt from timeout-minutes", () => {
  // GitHub REJECTS timeout-minutes on a `uses:` job — the bound belongs to the
  // called workflow's jobs, which this linter checks when it walks that file.
  // Demanding it here would make the workflow unparseable.
  const source = `name: ci
jobs:
  client-e2e:
    needs: changes
    if: needs.changes.outputs.client == 'true'
    uses: ./.github/workflows/lane-client-e2e.yml
    with:
      web: true
`;
  assert.deepEqual(lintWorkflowSource(".github/workflows/ci.yml", source), []);
});

test("only release.yml may listen on push tags", () => {
  const source = `name: release-desktop
on:
  push:
    tags:
      - 'v*.*.*'
${clean.slice(clean.indexOf("jobs:"))}`;
  const errors = lintWorkflowSource(
    ".github/workflows/release-desktop.yml",
    source
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /only release\.yml may/u);
});

test("release.yml itself may listen on push tags", () => {
  const source = `name: release
on:
  push:
    tags:
      - 'v*.*.*'
${clean.slice(clean.indexOf("jobs:"))}`;
  assert.deepEqual(
    lintWorkflowSource(".github/workflows/release.yml", source),
    []
  );
});

test("a `tags:` key inside a job is not mistaken for a trigger", () => {
  // docker/metadata-action takes a `tags:` input. Only a header-level, 4-space
  // `tags:` under `push:` is a trigger.
  const source = `name: lane-release-gateway-image
on:
  workflow_call:
jobs:
  docker:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: docker/metadata-action@8e5442c4ef9f78752691e2d8f8d19755c6f78e81 # v5
        with:
          tags: |
            type=semver,pattern={{version}}
`;
  assert.deepEqual(
    lintWorkflowSource(
      ".github/workflows/lane-release-gateway-image.yml",
      source
    ),
    []
  );
});
