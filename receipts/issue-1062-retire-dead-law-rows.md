# Issue #1062 — the law-estate half of the red `candidate` lane

Rolling bot issue ([#1062](https://github.com/srikanth235/centraid/issues/1062)): `candidate` has been red for 28 consecutive runs. Its territory causes are fixed under [#1052](https://github.com/srikanth235/centraid/issues/1052). What remains lives in files the law owns (`tests/claims.json`, `tests/inventory.json`, `scripts/ci/gate-classes.json`), which `estate-separation` forbids editing in the same change set as the product, so it is its own change. Every row removed here names a test, a workflow step or a gate whose subject v1 deleted; none of them can pass, and none of them can be made to pass without resurrecting the v0 tree.

## What changed

- `tests/claims.json#laws` — all 48 registered laws removed. Each named an `owner` under `packages/` or `apps/` that was deleted with the v0 TypeScript tree, so `lint:law-registry` reported 97 problems (an absent owner file and an absent tag, per law). `lint-law-registry` only scans `*.test.{ts,mjs,js}` files for `[law:<tag>]`, so the Rust and Kotlin suites that now assert these properties cannot carry a tag; registering them is a separate design, not a repair. The registry now holds zero laws, and the linter is still armed: an unregistered tag or a duplicate owner fails.
- `tests/claims.json#lanes` — the `real-model-goldens` lane removed. Its only workflow, `enrichment-live-weekly.yml`, is retired under #1052.
- `tests/inventory.json#advisory.steps` — the two `.github/workflows/ci.yml` rows removed (`Report generated binding drift`, `Advisory — Expo compatibility map`). `ci.yml` no longer exists, so `test:advisory-expiry` reported both as stale. The register is empty; a step that announces it will never fail still has to be registered.
- `scripts/ci/gate-classes.json` — the `lint:acp-min-versions` row removed. The gate's subject, `packages/server/src/acp/registry.ts`, is gone; the script and its `package.json` and `lint:product` rows retire under #1052.

Owner ruling (this session): open the law-estate changes on a second branch. **Merge order: the #1052 change set first, then this one.** This branch alone is not green: the weekly workflow still exists on it and writes evidence for the `real-model-goldens` lane this change removes, so `lint:evidence-mapping` (in `check:push`) fails, and `lint:acp-min-versions` stays a live gate whose script is missing. The #1052 branch alone is green (`lint:evidence-mapping` only warns that the lane has no writer); it leaves one classification with no script until this lands, which fails `gate-classes.test.mjs` case 4 and nothing in the candidate lane.

## Not changed

- `scripts/ci/gate-classes.test.mjs` fails four cases on `main` before either change set (`test:qualities` unclassified, `lint:schema-export` undefined, the `lint:product` bundle-size floor of 30). They are untouched here; classifying `test:qualities` needs a class, rung and reason that are the owner's to give.
- Other `tests/claims.json` claim rows still name deleted v0 owners; they are not read by a failing gate.

## Verification

Run in a worktree of `origin/main` with only this change applied:

```sh
bun run lint:law-registry        # law registry: ok (0 laws registered, 0 tag site(s)). exit 0
bun run test:advisory-expiry     # advisory-expiry: 0 advisory step(s) owned, dated and unexpired as of 2026-09-30. exit 0
bun run lint:ledgers             # check-ledgers: ok — 19 sections across 5 ledgers hold against origin/main. exit 0
bun run test:ratchet             # ratchet-floors: ok (no decreases vs origin/main). exit 0
node --test scripts/lint-law-registry.test.mjs scripts/ci/advisory-expiry.test.mjs scripts/ci/gate-classes.test.mjs   # pass 24, fail 4 (the four listed under Not changed, all present on main)
```

## Audit

Verdict: PASS (with one undisclosed ordering dependency, item 3, that the receipt should state)

- 1. Diff vs receipt: 4 files (receipt, gate-classes.json, claims.json, inventory.json). Structural JSON comparison against origin/main: in claims.json only `laws` (48 -> `{}`) and `lanes` (54 -> 53, only `real-model-goldens` gone, every other lane object identical) differ; no other key changed. inventory.json: only the two `advisory.steps` rows removed, `steps: {}` left. gate-classes.json: only `lint:acp-min-versions` removed. Counts match; no undisclosed edit.
- 2. All 48 removed laws have an `owner` under `packages/` or `apps/`; none of the 48 owner paths exists in this tree. `[law:<tag>]` occurs in no existing test file for any removed tag (only in `scripts/lint-law-registry.test.mjs` fixtures, which the linter excludes by exact path, plus prose in docs/coding-standards.md and the linter's own comments). No removed law has a live owner or tag. Minor: two prose mentions remain in claims.json claim rows (`[law:pending-overlay]` at ~L975, `[law:recognition-self-contained]` at ~L1517); no gate reads them.
- 3. `real-model-goldens` is referenced only by `.github/workflows/enrichment-live-weekly.yml` (its job name and `write-evidence.mjs --lane real-model-goldens`). DISCREPANCY: on THIS branch alone `bun run lint:evidence-mapping` (a member of `check:push`) FAILS: "enrichment-live-weekly.yml: writes evidence for lane real-model-goldens, which tests/claims.json#lanes does not register". It passes on origin/main (54 lanes). The receipt's verification list omits this gate and its "every row removed ... none can pass" framing does not cover it: this lane row is only dead once the sibling branch deletes the workflow. I merged the sibling branch (claude/adoring-gauss-20yqkw) into a throwaway worktree: `lint:evidence-mapping` then passes (53 lanes, every step mapped), as do lint:law-registry, test:advisory-expiry, lint:ledgers, test:ratchet. So the two branches must land together (the receipt says so for acp-min-versions only; it should also name evidence-mapping). Standalone here: lint:law-registry, test:advisory-expiry, lint:ledgers, test:ratchet, lint:path-filters all exit 0. `write-evidence.mjs` does not validate lane ids against claims (only park lookup), so no other reader breaks.
- 4. `.github/workflows/ci.yml` does not exist and no workflow step is named `Report generated binding drift` or `Advisory — Expo compatibility map`. The register is still enforced: `advisory-expiry.mjs` scans every workflow for step names matching `Advisory` or `(non-blocking)` and fails ("announces itself as advisory but has no entry") when unregistered; scripts/ci/advisory-expiry.test.mjs has "an unregistered advisory fails" and the stale-entry test. Current run: 0 steps, exit 0.
- 5. lint-law-registry is still armed with `laws: {}`: `claims-schema.mjs` still requires the `laws` key; the linter still reports malformed tags, duplicate owners across files, tags not in the registry, and (for any registered law) missing owner/statement/tag. `lint-law-registry.test.mjs` passes and covers the unregistered-tag, duplicate-owner and orphan cases.
- 6. gate-classes.test.mjs fails 4 subtests here (unclassified `test:qualities`, undefined `lint:schema-export`, bundle floor 25 vs 30). I ran the same test in a throwaway worktree of origin/main: the identical 4 fail with identical messages. None mention `lint:acp-min-versions` or any touched row. Pre-existing, confirmed by reproduction, not just inference.
- 7. Receipt commands re-run on this branch: lint:law-registry ok (0 laws, 0 tags), test:advisory-expiry ok (0 steps), lint:ledgers ok (19 sections), test:ratchet ok, node --test of the three files pass 24 / fail 4. All stated outcomes reproduce. (On origin/main lint:law-registry fails, consistent with the receipt's claim; "97 problems" not counted.)
- 8. Weakening vs retiring: every removed law/advisory/gate row names a subject (v0 owner tests, ci.yml steps, packages/server acp registry) that no longer exists; no thresholds, floors, or check logic changed, and the enforcing linters are intact. Not weakening. Caveat: the laws are removed rather than re-registered against the Rust/Kotlin tests that now assert them, which the receipt states openly as a separate design.

Not verified: the "97 problems" count; the sibling branch's own gates beyond the ones listed (lint:product on the merged tree fails at `security:lifecycle`, not investigated, unrelated to touched rows); `test:claims` and `lint:test-reachability` fail here for missing v0 files (validate-claims.mjs, desktop/vitest.config.ts), not compared against origin/main; CI itself was not run; whether other docs cite the removed law ids.
