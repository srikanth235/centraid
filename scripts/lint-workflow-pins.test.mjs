import assert from 'node:assert/strict';
import test from 'node:test';

import { lintWorkflowSource } from './lint-workflow-pins.mjs';

const clean = `name: x
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
      - uses: ./.github/actions/setup-bun
      - run: bun test
`;

test('a fully pinned, bounded workflow is clean', () => {
  assert.deepEqual(lintWorkflowSource('w.yml', clean), []);
});

test('a floating tag is rejected', () => {
  const source = clean.replace(
    'actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2',
    'actions/checkout@v4',
  );
  const errors = lintWorkflowSource('w.yml', source);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /floating ref `actions\/checkout@v4`/);
});

test('a moving branch ref is rejected the same way a tag is', () => {
  const source = clean.replace(
    '- uses: ./.github/actions/setup-bun',
    '- uses: dtolnay/rust-toolchain@stable',
  );
  const errors = lintWorkflowSource('w.yml', source);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /rust-toolchain@stable/);
});

test('repo-local and docker:// refs are exempt', () => {
  const source = clean.replace(
    '- run: bun test',
    '- uses: docker://rhysd/actionlint:1.7.12\n      - run: bun test',
  );
  assert.deepEqual(lintWorkflowSource('w.yml', source), []);
});

test('a hardcoded bun-version is rejected', () => {
  const source = clean.replace(
    '      - uses: ./.github/actions/setup-bun\n',
    '      - uses: oven-sh/setup-bun@4bc047ad259df6fc24a6c9b0f9a0cb08cf17fbe5 # v2.0.2\n        with:\n          bun-version: 1.3.13\n',
  );
  const errors = lintWorkflowSource('w.yml', source);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /hardcodes a Bun version/);
});

test('a job without timeout-minutes is rejected, and names the job', () => {
  const source = clean.replace('    timeout-minutes: 10\n', '');
  const errors = lintWorkflowSource('w.yml', source);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /job `build` has no timeout-minutes/);
});

test('every job is checked, not just the first', () => {
  const source = `${clean}  publish:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
  const errors = lintWorkflowSource('w.yml', source);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /job `publish` has no timeout-minutes/);
});

test('a step key that merely looks like a job key is not treated as one', () => {
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
  assert.deepEqual(lintWorkflowSource('w.yml', source), []);
});

test('a governance-kit:managed workflow is exempt — its policy lives upstream', () => {
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
  assert.deepEqual(lintWorkflowSource('governance.yml', source), []);
});
