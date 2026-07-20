# Issue #478 — mobile-e2e: 51-minute job is 87% uncached setup

GitHub issue: [#478](https://github.com/srikanth235/centraid/issues/478)

## Checklist

- [x] Cache the built simulator `.app`, keyed on a fingerprint of the native inputs only
- [x] Scope the gateway build to its dependency subgraph instead of a full `bun run build`
- [x] A stale cache must never produce a false pass
- [ ] Cache CocoaPods, keyed on `Podfile.lock` — **rejected**, see Decisions
- [ ] Cache Turborepo — **rejected**, see Decisions

## What changed

`.github/workflows/e2e.yml`, `mobile-e2e` job only. Four edits:

**Cache the built simulator `.app`, keyed on a fingerprint of the native inputs only** — a new `Fingerprint the iOS native build inputs`
step hashes the tracked content of `apps/mobile/ios`, `apps/mobile/modules`,
`apps/mobile/plugins`, `apps/mobile/app.config.ts`,
`apps/mobile/src/version-core.cjs`, `apps/mobile/package.json`, the root
`package.json`, `bun.lock` and `.github/workflows/e2e.yml`, plus the Xcode
version, the iphonesimulator SDK version and `ImageOS`. A `Restore the built iOS
app` step keys `~/.cache/centraid-mobile-e2e` on that digest. `expo run:ios` is
now gated on a cache miss and copies its product into that directory; a new
`Install the cached mobile development app` step handles the hit via `xcrun
simctl install`, after asserting the bundle exists, that `CFBundleIdentifier` is
exactly `dev.centraid.mobile`, and that the Mach-O executable is present.

**Scope the gateway build to its dependency subgraph instead of a full `bun run build`** — now `bunx turbo run build --filter=@centraid/gateway`.
Measured with `turbo run build --dry=json`: 15 of 19 build tasks, dropping
`@centraid/data-plane` (a `cargo build --locked`), `@centraid/desktop`,
`@centraid/mobile` and `@centraid/test-kit`. Everything the mobile job consumes —
gateway, vault, app-engine, blueprints, skills, tunnel, client, design-tokens —
is still built.

**A stale cache must never produce a false pass.** The fingerprint is computed
from `git ls-files` (tracked content, including paths, so renames invalidate)
rather than a `hashFiles` glob, because `ios/Pods` and `ios/build` are ignored
build products that would otherwise let the key depend on prior build state. The
`.app` cache carries **no `restore-keys`** — a prefix fallback is exactly the
stale-binary hit this must never allow. The step fails loudly if the file list
comes back empty, since an empty digest would be a constant key and therefore a
permanent false hit.

**Removed two caches that were drafted and then rejected** — see Decisions.

## Decisions

**Rejected: cache CocoaPods.** A Pods cache hit leaves
`ios/Pods/Manifest.lock` matching `Podfile.lock`, so Expo CLI skips `pod install`
— and `pod install` is the only thing that runs the `centraid-tunnel` podspec's
`prepare_command`, which downloads the git-ignored `Iroh.xcframework` and
`IrohLib.swift`. Those are a `vendored_frameworks` entry and a compiled
`source_files` member of that pod, so suppressing the fetch breaks the native
build outright. The failure would not appear on the first run (empty cache) but
on the second native change — precisely the path a pods cache exists to serve.
Caught by the fresh-context audit; independently confirmed by reading
`apps/mobile/modules/centraid-tunnel/.gitignore` and the podspec, and by
`git ls-files` showing the xcframework untracked.

**Rejected: cache Turborepo.** A per-sha key never hits, so every run would
*save* a fresh multi-hundred-MB blob. Against GitHub's 10 GB per-repo budget with
LRU eviction the natural victim is the `.app` entry, which is only ever read and
never re-saved on a hit — trading a 32-minute win for a few minutes of build
replay, and evicting other workflows' caches besides.

**Dropped `--filter=@centraid/design-tokens`.** Verified redundant: it is already
in the gateway-only subgraph.

**The build invocation is a cache input.** `.github/workflows/e2e.yml` is in the
fingerprint, so changing `expo run:ios` flags cannot reuse a binary built the old
way.

## Out of scope

- The `mobile-e2e` lane is red for an unrelated product/test reason (the
  `home-loads` assertion). This issue is speed only; nothing here loosens or
  touches an assertion.
- Parallelising the three flows across simulators. Worth revisiting once the
  `.app` cache is proven, but today it would duplicate the native build per
  matrix leg and make the job slower.
- Simulator boot (145s) and the Maestro CLI download.

Also present in this branch's diff but belonging to **#474**, not to this issue —
the per-test timeout sweep committed separately, recorded in
`receipts/issue-474.md`: `packages/test-kit/src/vitest.ts`,
`packages/vault/src/blob/stream-ingress.test.ts`,
`packages/app-engine/src/handlers/handler-pool.test.ts`,
`packages/app-engine/src/handlers/handler-runner.contract.test.ts`,
`packages/gateway/src/preview/codec.test.ts`,
`packages/gateway/src/serve/connection-broker.test.ts`,
`packages/gateway/src/serve/outbox-executor.test.ts`. Likewise the Metro prewarm
fix and its extracted module, also #474:
`tests/agent-e2e-mobile/lib/harness.mjs`,
`tests/agent-e2e-mobile/lib/metro.mjs`.

## Verification

YAML parses, the job's 15 steps and both `if:` conditions resolve, and the
gateway subgraph still contains every package the mobile job needs:

```sh
node -e "const y=require('js-yaml'),f=require('fs');const d=y.load(f.readFileSync('.github/workflows/e2e.yml','utf8'));const s=d.jobs['mobile-e2e'].steps;console.log(s.length+' steps');s.forEach(x=>x.if&&console.log('IF',x.if))"
bunx turbo run build --filter=@centraid/gateway --dry=json | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.parse(s).tasks.map(t=>t.package).sort().join(' ')))"
```

The cache key was exercised locally — stable across three runs, and
mutation-tested by perturbing a hashed native input and confirming the digest
moves and then returns:

```sh
fp() { git ls-files -z -- 'apps/mobile/ios' 'apps/mobile/modules' 'apps/mobile/plugins' 'apps/mobile/app.config.ts' 'apps/mobile/package.json' 'apps/mobile/src/version-core.cjs' 'package.json' 'bun.lock' '.github/workflows/e2e.yml' | xargs -0 shasum -a 256 | shasum -a 256 | cut -d' ' -f1; }
before=$(fp); printf '\n' >> apps/mobile/app.config.ts; after=$(fp); git checkout apps/mobile/app.config.ts; test "$before" != "$after" && test "$before" = "$(fp)"
```

**Not verified, and it cannot be from here:** none of this has executed on a
macOS runner. The `.app` discovery path out of derived data, the tar round-trip
of the bundle, and behavioural parity of `simctl install` versus `expo run:ios`
all need a real run. A cold run only proves the build path still works — the
meaningful proof is run N+1 on an unchanged native tree showing a hit AND a
correct app launch, not merely a green Maestro result.

## Audit

Fresh-context sub-agent audit of the diff against issue #478, run before commit.
It read the podspec, `project.pbxproj`, `metro.config.js`, `ci-gateway.mjs` and
the harness, executed the fingerprint command, and ran `turbo --dry=json` scoped
and unscoped.

**Verdict: PASS** for the committed version. The audited version was **REFUTED**
(FAIL — 1 blocker, 3 risks, 4 nits); every finding is fixed below, and the checks
that carried it are re-stated with their outcome.

Per-check outcomes:

1. **Is the `.app` cache key's input set complete?** — **REFUTED** as audited: the
   build invocation was missing. Fixed by adding `.github/workflows/e2e.yml` to
   the hash. Re-checked: no `patches/`, `patchedDependencies`, `postinstall` or
   `Gemfile` exist to miss; `.xcode.env`, `Podfile.properties.json` and
   `expo-module.config.json` are tracked under hashed prefixes. **PASS.**
2. **Does the fingerprint step actually work?** — **PASS.** Executed locally: 52
   tracked files, digest stable across three runs, ordering deterministic,
   `xargs` batching cannot perturb it, paths included so renames invalidate.
3. **Is the cache-hit path correct?** — **PASS.** The harness launches by bundle
   id and gates on `simctl get_app_container`; `expo-dev-client` is not a
   dependency, so no packager-host file is needed. Bundle-id, executable and
   container assertions fail loudly rather than at flow time.
4. **Is the executable name right?** — **PASS.** `PRODUCT_NAME = Centraid` and
   `PRODUCT_BUNDLE_IDENTIFIER = dev.centraid.mobile` both confirmed in
   `apps/mobile/ios/Centraid.xcodeproj/project.pbxproj`.
5. **Does turbo scoping drop anything mobile needs?** — **PASS**, with the claim
   corrected: 15 of 19 tasks run, not a dramatic cut. Nothing mobile consumes is
   lost.
6. **Is `.turbo/cache` the right path?** — moot; the turbo cache was removed.
7. **YAML/shell correctness** — **PASS.** Parses; `steps.native.outputs.hash` is
   produced before use; both `if:` conditions fail safe toward a rebuild.
8. **CocoaPods cache safety** — **REFUTED**, and not repairable by a key change:
   the cache's own hit suppresses the fetch. Removed entirely.

The blocker was the CocoaPods cache suppressing `prepare_command` (above). Also
confirmed by the audit and fixed here: the build invocation was missing from the
fingerprint; the unbounded turbo cache could evict the `.app` entry; the
`--filter` saving is narrower than first claimed (15 of 19 tasks, not a
dramatic cut); `--filter=@centraid/design-tokens` was redundant; the step comment
wrongly claimed the vendored xcframework binaries were hashed; and
`toolchain="$(cmd1; cmd2)"` swallowed a failing `xcodebuild`. Every one is
addressed in this commit.

Confirmed correct by the audit and left as-is: the executable name `Centraid` and
bundle id `dev.centraid.mobile` both match `project.pbxproj`; the fingerprint's
ordering is deterministic and `xargs` batching cannot perturb it; `.turbo/cache`
is genuinely where this repo's turbo writes; `simctl install` is sufficient
because the harness launches by bundle id and `expo-dev-client` is not a
dependency; and there are no `patches/`, `patchedDependencies`, `postinstall` or
`Gemfile` inputs to miss.

## Steering

Verdict: **PASS**

Evidence for rubric checks:

1. **Every human-steering event in the transcript is recorded.**
   - One steering event in the session that produced this work: the operator
     reversed the squash target mid-task — having had the PR branch squashed,
     they redirected with "what I want is on main branch, squash all commits
     done today into single commit". Classified a **correction**: it reverses
     the branch the prior instruction was executed against.
   - That event is recorded against #474 in `receipts/issue-474.md`, the receipt
     homing that session's rows; it steered the squash commit, not this one.
   - **Check: PASS**
2. **No steering event is attributable to this commit's work.**
   - The #478 work was directed by a standing goal ("optimize the mobile e2e
     time and get it green"), not by a correction. The operator's question
     "did you see how much time it took for mobile e2e?" prompted measurement
     that was already committed to, and reversed no direction.
   - **Check: PASS**

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-caa407fd-499-1784565237-1 | claude-code | caa407fd-4992-4b19-9083-0461b452f3bb | #478 | claude-opus-4-8 | 59 | 55363 | 6033521 | 35524 | 90946 | 4.2512 | 376 | 590800 | 25261371 | 152959 |  |
| claude-code-caa407fd-499-1784565282-1 | claude-code | caa407fd-4992-4b19-9083-0461b452f3bb | #478 | claude-opus-4-8 | 2 | 4016 | 202699 | 226 | 4244 | 0.1321 | 378 | 594816 | 25464070 | 153185 |  |
| claude-code-caa407fd-499-1784565417-1 | claude-code | caa407fd-4992-4b19-9083-0461b452f3bb | #478 | claude-opus-4-8 | 18 | 17871 | 2100539 | 9015 | 26904 | 1.3874 | 396 | 612687 | 27564609 | 162200 |  |
| claude-code-caa407fd-499-1784565521-1 | claude-code | caa407fd-4992-4b19-9083-0461b452f3bb | #478 | claude-opus-4-8 | 4 | 824 | 437066 | 642 | 1470 | 0.2398 | 400 | 613511 | 28001675 | 162842 |  |
| claude-code-caa407fd-499-1784565594-1 | claude-code | caa407fd-4992-4b19-9083-0461b452f3bb | #478 | claude-opus-4-8 | 4 | 1032 | 437890 | 1414 | 2450 | 0.2608 | 404 | 614543 | 28439565 | 164256 |  |
