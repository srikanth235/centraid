# Issue #1062 — the law-estate half of the red `candidate` lane

Rolling bot issue ([#1062](https://github.com/srikanth235/centraid/issues/1062)): `candidate` has been red for 28 consecutive runs. Its territory causes are fixed under [#1052](https://github.com/srikanth235/centraid/issues/1052). What remains lives in files the law owns (`tests/claims.json`, `tests/inventory.json`, `scripts/ci/gate-classes.json`), which `estate-separation` forbids editing in the same change set as the product, so it is its own change. Every row removed here names a test, a workflow step or a gate whose subject v1 deleted; none of them can pass, and none of them can be made to pass without resurrecting the v0 tree.

## What changed

- `tests/claims.json#laws` — all 48 registered laws removed. Each named an `owner` under `packages/` or `apps/` that was deleted with the v0 TypeScript tree, so `lint:law-registry` reported 97 problems (an absent owner file and an absent tag, per law). `lint-law-registry` only scans `*.test.{ts,mjs,js}` files for `[law:<tag>]`, so the Rust and Kotlin suites that now assert these properties cannot carry a tag; registering them is a separate design, not a repair. The registry now holds zero laws, and the linter is still armed: an unregistered tag or a duplicate owner fails.
- `tests/claims.json#lanes` — the `real-model-goldens` lane removed. Its only workflow, `enrichment-live-weekly.yml`, is retired under #1052.
- `tests/inventory.json#advisory.steps` — the two `.github/workflows/ci.yml` rows removed (`Report generated binding drift`, `Advisory — Expo compatibility map`). `ci.yml` no longer exists, so `test:advisory-expiry` reported both as stale. The register is empty; a step that announces it will never fail still has to be registered.
- `scripts/ci/gate-classes.json` — the `lint:acp-min-versions` row removed. The gate's subject, `packages/server/src/acp/registry.ts`, is gone; the script and its `package.json` and `lint:product` rows retire under #1052.

Owner ruling (this session): open the law-estate changes on a second branch. The two change sets land together: this branch alone leaves `lint:acp-min-versions` a live gate whose file is missing, and the #1052 branch alone leaves a classification with no script.

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
