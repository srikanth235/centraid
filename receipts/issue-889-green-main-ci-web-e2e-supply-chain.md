# Receipt — issue #889 · Green `main`'s red `ci` and `security` lanes

`main` at `1a1a88f9` (#886) failed `ci` (`client-e2e / web-e2e`, then `check`)
and `security` (`rust supply-chain`). Three causes: two e2e harness defects and
one yanked crate. No product source changed.

## Checklist

- [ ] `ci` job `client-e2e / web-e2e` is green on the fixing PR.
- [x] `agenda-compact-band` passes both its compact and pointer mounts.
- [x] `web-pwa-cache` passes in full-suite order, not only in isolation.
- [ ] `security` job `rust supply-chain` is green: cargo-audit and cargo-deny clean over all three crates.
- [x] No gate, budget, allowlist, or test weakened.

## What changed

`apps/web/tests/e2e/agenda-compact-band.spec.ts` — the spec's `mount()` helper
waited for `nav[data-band="app"]` after every mount, including the pointer
mount at the end of the test, where Agenda claims no band by design. That is
the swap the spec's own last two assertions make, so the helper contradicted
the test: the pointer mount hung its full 15s and failed. Each layout now waits
for its own arrival signal — the band on compact, the Agenda rail
(`aside[aria-label="Agenda rail"]`, `packages/blueprints/apps/agenda/Chrome.tsx`)
on pointer. `agenda-compact-band` passes both its compact and pointer mounts.

`apps/web/tests/e2e/web-pwa-cache.spec.ts` — `beforeEach` registered a bare
`/sw.js`, while the shell registers `/sw.js?v=${SERVICE_WORKER_VERSION}`
(`apps/web/src/iroh-transport.ts`). Two script URLs on one scope, so the
shell's own lazy registration installs a SECOND worker whose `skipWaiting()` +
`clients.claim()` lands under the second tab's in-flight navigation and aborts
it — `net::ERR_ABORTED` on `second.goto("/")`, then a 60s test timeout. The
`beforeEach` now registers the shell's stamped URL, and the file drops from
~90s to ~20s because the second install was also re-running the activate-time
chunk crawl.

`web-pwa-cache` passes in full-suite order, not only in isolation.

`apps/web/tests/e2e/perf-waterfall.spec.ts` — the same bare `/sw.js`
registration sat inside the window the "sw tunnel cache" probe times, so a
second worker's crawl was writing into the measurement. Same fix: register the
shell's stamped URL, imported from `apps/web/src/sw-version.ts`.

`packages/tunnel/native/Cargo.lock`, `packages/tunnel/data-plane/Cargo.lock`
and `apps/web/iroh-wasm/Cargo.lock` — `chacha20 0.10.1` (transitive: `rand
0.10.2` → hickory/iroh) was yanked upstream; `cargo deny` fails it under
`[advisories] yanked = "deny"` and `cargo audit --deny warnings` reports it in
all three crates. Bumped to the published `0.10.2` with `cargo update -p
chacha20`. Lockfiles only — no manifest, no `deny.toml`, no ignore list edit.
No gate, budget, allowlist, or test weakened.

## Decisions

Both e2e failures are harness defects, so the fix is in the specs, not in the
product: the shipped service worker and the shipped Agenda band behave as their
own specs describe. The alternative — making the product tolerate a second
registration of the same scope — would be paying for a mistake only the tests
make.

`perf-waterfall.spec.ts` was not red in CI, but it carried the identical
registration bug inside a timed window; leaving it would leave a known-bad
measurement in place. It is the same one-line change, so it rides along rather
than becoming a second PR.

The nightly `web-e2e` job runs this same Playwright suite, so it inherits both
fixes; the rest of the nightly and weekly reds are listed as out of scope
below because they need runners this environment does not have.

## Out of scope

- Nightly `e2e` lanes needing runners unavailable here: `web-e2e-cross-browser`,
  `mobile-e2e-android`, `mobile-e2e-ios`, `test-health-report`.
- `Companion e2e` live-relay and `soak-weekly`.
- `perf-waterfall`'s shell warm/cold byte ratio measuring `0.1513` against its
  `0.15` budget on the 2026-08-29 nightly (passed on retry) — recorded, not
  re-budgeted.
- Widening `deny.toml`, its `[advisories] ignore` list, or any test timeout.

## Verification

```sh
bun install --frozen-lockfile
bunx turbo run build --filter=@centraid/server...
bun run --cwd apps/web e2e            # 37/37 green (was 2 failed, 1 flaky)
bun run format:check && bun run lint
bun run --cwd apps/web typecheck
cargo install cargo-audit cargo-deny --locked
node scripts/security/rust-supply-chain.mjs --require
```

The two e2e failures were reproduced first, deterministically, in the CI
ordering (`web-pwa-cache` fails only when another test in the file runs before
it; running the pair `-g "immutable blobs|multiple shell tabs"` reproduces it
3/3). The service-worker diagnosis is evidence, not inference: an instrumented
worker logged no fetch event at all for the aborted navigation, the
registration read `activated`, and an immediate retry of the same `goto`
returned 200. `rust-supply-chain.mjs --require` reports `cargo-audit` and
`cargo-deny` clean over `apps/web/iroh-wasm`, `packages/tunnel/data-plane` and
`packages/tunnel/native`. The two CI-green boxes stay unchecked until GitHub
says so on the PR head.

## Audit

Self-review against the two ground truths (the diff and issue #889), not an
independent fresh-context sub-agent: this session runs under a harness
instruction not to spawn sub-agents unless the user asks, so the author≠auditor
split the directive wants did not happen. Recording that honestly rather than
claiming an independent verdict.

1. **`## What changed` matches the diff — PASS.** Worktree vs `1a1a88f9` is six
   files: the three spec files named above and the three `Cargo.lock` bumps,
   each `chacha20` `0.10.1` → `0.10.2` and nothing else.
2. **Each `- [x]` item is realized in the diff — PASS.** The compact/pointer
   mount split is the `mount()` ternary; the full-suite-order pass is the
   stamped registration in `beforeEach`; no gate, config, budget, or
   allowlist file appears in the diff at all.
3. **The `## Checklist` mirrors the issue's acceptance criteria — PASS.** Same
   five items, same order and wording; the two lane-green boxes stay open.

**Overall: SHIP**, with the caveat in this section's first paragraph.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-30 | claude-code | 38fa9adc-3f1a-5237-af78-d54cade3f6d4 |
