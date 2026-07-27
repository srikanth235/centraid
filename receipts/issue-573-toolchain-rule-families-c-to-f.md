<!-- governance: allow-receipt-per-issue #573 landed in two independent
     changesets. The first (families A, B, H) merged with #565 and its receipt
     `issue-573-toolchain-opinions-one-shot.md` is now frozen by doc-integrity
     — correctly, since it is the record of what was true when that shipped.
     This receipt covers families C-F, which are a separate branch, a separate
     review, and a separate set of decisions. Editing the frozen one to append
     them would rewrite history to look like a single landing; the duplicate is
     the honest shape. -->

# Issue #573 — rule families C, D, E and F

Second changeset for the toolchain umbrella. Families **A, B, H** landed with
#565 and are recorded in
[issue-573-toolchain-opinions-one-shot.md](issue-573-toolchain-opinions-one-shot.md),
which is frozen. This receipt covers **C** (ultracite vitest preset), **D**
(`typescript/method-signature-style`), **E** (bulk style rules) and **F** (long
tail). It is deliberately a **partial** landing put up for review as a draft PR.

## Checklist

- [x] 56 rules removed from the pinned-off block in `oxlint.config.mjs`
- [x] Repo typechecks (32/32 packages) and the full suite is green (36/36)
- [x] `no-await-in-loop` audited site-by-site and explicitly declined, with the measurement recorded in the config next to the rule
- [x] Every rule whose fix was wrong is reverted with a comment saying why, not silently dropped
- [ ] Families C-F at zero findings — **2,453 open**, itemised per rule in #573
- [ ] ultracite oxfmt style (G): not started, must be its own formatting-only commit
- [ ] js-plugins preset (I): not started, needs a measurement before adopt/decline

## What changed

56 rules left the pinned-off block and the bulk of their findings are fixed
across ~1,400 files: roughly **19,000 → 2,453**. Produced by eight parallel
agents partitioned by package, then integrated and verified centrally.

### Five fixes the rules got wrong

Each of these would have shipped as a regression under a mechanical sweep.

- **An agent left a probe sentinel in a live assertion.** Satisfying
  `vitest/require-to-throw-message` it replaced `main`'s bare
  `.rejects.toThrow()` in `packages/gateway/src/serve/revocation-severs-planes.test.ts`
  with `.rejects.toThrow('ZZPROBEZZ')` — evidently a marker to discover the
  real message, never replaced. That test guards that revoking a device severs
  its iroh plane; it would have shipped permanently red. It now asserts the
  real 401 `unauthorized` application-close reason. A repo-wide sweep for other
  probe-shaped literals in `toThrow(...)` found none. The agent that wrote it
  was stopped mid-verification, and its finding count alone looked like
  progress — which is the argument for running the suite over *integrated*
  output rather than trusting per-agent greens.
- **`require-unicode-regexp` silently broke the app bundler.** esbuild compiles
  plugin `filter` patterns with Go's RE2 engine, which has no `u` flag. Flagging
  `build.onResolve({ filter: /.*/ })` made esbuild reject the filter, so the
  hook never fired and `prepareBundledIndex` produced **zero bundles**. Nothing
  threw; 16 app-engine tests caught it. Three sites (`app-bundle.ts` ×2,
  `query-bundle.ts`) reverted with a comment and a scoped disable. A regex
  literal handed to a foreign engine is not a JS regex, and no lint rule can
  tell.
- **`vitest/require-mock-type-parameters` is unsatisfiable for generic
  exports.** `vi.fn()` returns `Mock<(...args: any[]) => any>`, assignable to
  anything; supplying a type parameter makes `Mock<T>` erase the callee's own
  generic, so `<T>(res, op) => Promise<T>` collapses to `Promise<unknown>` and
  stops being assignable to the module being mocked. Six mocks (`readJson`,
  `fetchJson`, `companionJson`, `appRead`, `appWrite`) keep bare `vi.fn()` with
  a comment. Some share of the 466 open findings is this same case and cannot
  be fixed at all.
- **`typescript/method-signature-style` is a strictness change, not
  cosmetics.** Method shorthand is bivariant; property style is contravariant
  under `strictFunctionTypes`. Converting `SubtleCryptoLike` made it
  unsatisfiable by the DOM's real `SubtleCrypto`, which is the one thing that
  interface exists to accept — it keeps method shorthand behind a scoped
  disable saying so. The same change paid for itself: the whole-`globalThis`
  cast that bivariance had been masking is gone, and `globalThis.crypto?.subtle`
  now assigns with no cast at all.
- **`prefer-arrow-callback` costs component identity.** It rewrote
  `memo(function AssetCell(…))` into an anonymous arrow, erasing the name React
  DevTools, error boundaries and the profiler show. Reverted; the only such
  site in the repo.

### Three source files were binary to git

`packages/agent-runtime/src/multimodal.ts`,
`packages/automation/src/fire/memory-cursor-store.ts` and
`packages/tunnel/src/tunnel.integration.test.ts` each embedded a **literal
control byte** (NUL, BEL) where an escape belongs. They were the only three
source files git classified as binary — undiffable, and unmergeable by any
3-way tool, which is exactly how this surfaced during integration.
Pre-existing on `main`, not introduced here; now escaped, with identical
runtime values.

### Test-quality fixes made along the way

- `apps/desktop/src/main/update-watcher-wiring.test.ts` asserted on the exact
  source text `/beta/i.test`, so it broke the moment the regex gained a `u`. It
  now matches the rule's presence without pinning the flag spelling.
- `packages/client/src/react/shell/routes/InsightsRoute.test.tsx` mocked
  `getGatewayHealth` as resolving `null`. It is declared non-nullable — the
  offline path is reached through the consumer's own
  `getGatewayHealth().catch(() => null)`. The typed mock surfaced it; the test
  now rejects, which is what actually happens when the gateway is down.
- Four files crossed the 500-line cap once `require-top-level-describe` added a
  wrapper. Each got a real extraction rather than reflowed lines:
  `people-test-kit.ts` (tag-scheme queries, also removing a hand-retyped
  `FLAGS_SCHEME_URI` literal duplicated in `locker.test.ts`),
  `outbox-executor-test-kit.ts`, `backup-conflict-provider.ts`, and
  `domTestKit.ts` (the React `value`-setter idiom that ten screen tests each
  carry their own copy of).

## Decisions

- **`no-await-in-loop` stays off — measured, not dodged.** The pinned
  annotation said 722 sites; the measured number is **2,276** (1,765 in tests,
  511 in source). In tests the loop *is* the scenario. In source the hits sit
  exactly where ordering is the correctness property:
  `packages/backup/src/wal-restore.ts` (14 — applying WAL segments concurrently
  corrupts the restore), `packages/gateway/src/backup/backup-service.ts` (19),
  `packages/gateway/src/serve/build-gateway.ts` (17, ordered startup),
  `packages/automation/src/handler/runner.ts` (10, user-authored steps in author
  order). A rule whose findings mean "correct" in the large majority of its hits
  is not a gate — enabling it buys ~550 inline suppressions and teaches readers
  to skim past the marker. The config now carries the measurement and the
  reasoning next to the rule.
- **A second receipt rather than an edit to the frozen one.** See the waiver at
  the top of this file.
- **Three gateway CLI tests are at `main`'s version, lint work dropped.** An
  agent had wrapped `admin.test.ts`, `founding-admin.test.ts` and
  `status-admin.test.ts` in `describe` blocks while `main` was concurrently
  changing the same lines for #568 item C. A half-merged test guarding
  auth-gated dial tickets is worse than an unlinted one.

## Out of scope

- **The 2,453 findings still open**, itemised per rule in #573. The largest
  block — 1,086 `require-unicode-regexp` and 40 `prefer-named-capture-group`,
  nearly all in test files — exists because of a flaw in how the parallel work
  was partitioned, not because the sites are hard: the regex agent was told to
  skip files another agent owned, and the agents owning those files were scoped
  to vitest rules only, so the intersection belonged to nobody. The next pass
  must be cut by **rule**, not by package.
- **Item G (oxfmt restyle)** — printWidth 100→80, single→double quotes,
  `trailingComma` `all`→`es5`, `sortImports` on. Rewrites ~2,745 files, so it
  must be last and formatting-only.
- **Item I (js-plugins preset)** — ultracite 7.9 moved the `react-doctor` rules
  out of the `react` preset into an opt-in `ultracite/oxlint/js-plugins`
  preset, so this repo is not running them at all, and never ran `sonarjs` or
  `eslint-plugin-github`. Three devDeps and a slower lint pass; needs a
  measurement first.
- **Migrating the other nine screen tests onto `domTestKit.ts`**, and the 28
  gateway test files that each declare their own `silentLogger`.
- **Parallelizing the source loops `no-await-in-loop` flags** where nothing
  depends on the ordering — a perf change with its own risk, belongs in a
  commit that can be measured.

## Verification

Run on this branch at the integrated state:

```
bunx turbo run typecheck
```

32 of 32 packages pass.

```
bunx turbo run test --concurrency=2
```

36 of 36 tasks pass.

```
bunx oxlint -c oxlint.config.mjs .
```

2,453 findings, down from roughly 19,000; the per-rule breakdown is posted on
#573. This is expected to fail the `static` CI job — the PR is a draft and the
remaining work is tracked, not hidden.

```
bunx vitest run src/http/app-bundle.test.ts src/http/query-bundle.test.ts
```

24 pass — the regression proving the esbuild RE2 revert is correct.
