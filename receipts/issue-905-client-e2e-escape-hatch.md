# issue-905 — two lanes in the #892 gate loop that reported what they had not run

Two defects in [#892](https://github.com/srikanth235/centraid/issues/892)'s own remedies, both found on `main` after it merged, both the same shape: a required lane reporting a verdict it had not earned. #892's receipt is on the default branch and therefore immutable, so this is a new issue with its own receipt rather than an edit to that one. The file slug names the first defect because it was found first; the receipt covers both, plus the seven findings (C–I) that surfaced while getting them to green. **I** is the first slice of the mobile-coverage plan folded into #905 as Part 2 — the shell↔app conformance manifest and the gate and sweep generated from it.

## Checklist

### A — client-e2e never ran under the one trigger meant to force it

- [x] Thread `|| needs.changes.outputs.all == 'true'` into both `with:` inputs
- [x] Narrow the caller's gate from `client` to `web || desktop`, now that `boot-smoke` has left the lane
- [x] Extend `bun run lint:path-filters` with a third sub-check: any read of a `changes` output without the `all` fallback fails, whatever construct does the reading
- [x] Correct the comment on the `changes` job that promised the property for "every lane `if:`"

### B — verify demanded a report its own lane never wrote

- [x] Make `test:suite` emit the report, matching `coverage`'s shape minus `--coverage`
- [x] Add a wiring guard so a lane cannot again demand `--require-report` without running a script that writes the report

### C — the AVD snapshot never saved on a red lane

- [x] Convert the AVD cache to restore-then-save in all four mobile workflows, the arrangement the apk and gradle caches beside it already use
- [x] Give the Android release build `--stacktrace`, so a 35-minute build failure names its cause

### D — `desktop-e2e-macos`'s non-required status, investigated

- [x] Establish whether `desktop-e2e-macos` is a gap or a decision, and change nothing if it is a decision

### E — the mobile lanes seeded their fixture after the phone had already cloned

- [x] Seed the demo corpus once per LANE, before anything pairs, rather than per flow after the first pairing
- [x] Give `lint:e2e-wiring` a `corpus` rule holding both halves: no tile tap for an app that cannot earn the grid, and no seeding after the lane's handoff to Maestro

### F — the PR gate's short-circuiting prerequisite failed twice and named nothing

- [x] Let a sensitive chunk print its failing directive on failure, without ever letting its capability reach the log

### G — a coverage shard could go red and name no test

- [x] Give `coverage:shard` the default reporter alongside the blob, so a failing shard says which test failed

### H — an unreadable springboard rendered a launcher with no tiles

- [x] Keep every app on the grid when no tile is readable, so an unmounted replica cannot leave a member with no way into any app
- [x] Move grid membership into `springboard-policy`, the module that claims it, so the rule is testable without a renderer

### I — the shell↔app contract had no source of truth, so coverage was per-app and hand-authored (#905 Part 2, first slice)

- [x] Give the shell↔app contract one manifest both the RNTL tier and the Maestro tier can read
- [x] Hold the registry, the launcher catalog, Home's navigate switch, the deep-link table and the testID vocabulary against it, so a new app is covered the day it registers
- [x] Replace per-app authoring at the composition tier with a sweep generated from the manifest

### J — `Element not found` never said what WAS found, so the device lanes could not be read

- [x] Print the handles the screen was carrying when a non-sensitive chunk fails, so a device failure is diagnosable from the log rather than only from an artifact
- [x] Keep the sensitive path silent, and say so when no hierarchy is found rather than printing nothing
- [x] Answer Android's runtime media-grant dialog, so `permission-refused` actually refuses a permission
- [x] Make every device flow name what it catches, and enforce it with a down-only gate

### K — the device gate spent 60% of its wall clock building, not testing

- [x] Stop running Android Lint on the gate's throwaway test artifact
- [x] Let the PR gate bank the shell it compiled, instead of only ever restoring one main built
- [x] Warm the freshly installed apk in device preparation, now that caching removed the pause the build used to provide

### M — "Home is ready" could not tell a Home that has the vault from one that does not

- [x] Wait for the launcher, not the band's label, wherever a flow's next act is opening an app from Home
- [x] Measure cold start to the launcher, closing the false green this receipt recorded rather than left standing

### N — Home claimed the vault was empty on the word of a replica that had never synced

- [x] Withhold `empty` from a tile whose reads have never had a landed pull behind them
- [x] Move the tile-status rule into the pure module that is tested, out of the hook that is not
- [x] Record the emulator's active network transport in device preparation, since the replica's sync policy is evaluated against it

### O — a phone that was not on Wi-Fi never pulled a row, and said nothing

- [x] Stop gating replica row pulls on the byte-transfer policy
- [x] Keep blobs, the write drain and the background pass on the whole transfer table
- [x] Record the ruling and correct the docs that stated the old coupling as current

### P — the phone drew an empty library over a vault holding rows, and nothing on either side said why

- [x] Trace what the gateway actually served the phone, since the device's replica path logs nothing
- [x] Print the app's own logcat on a failing flow, beside the screen digest
- [x] Keep both diagnostics off the JS bundle fingerprint, so asking the question costs no rebuild
- [x] Split the pairing chunk at the capability, so the assertion that fails most may say what it saw
- [x] Count the bytes a traced response actually wrote, rather than trusting a header that is not set
- [x] Retry a bootstrap that was refused, because nothing else ever asks again
- [x] Reproduce the empty library locally, on a session that mounts believing it is offline
- [x] Fall through to the configured base when the tunnel fails, not only when it times out
- [x] Say which way reachability failed, since every route to no base is swallowed
- [x] Keep the driver's own chatter out of the app-log digest it was drowning
- [x] Stop calling ES2023 array copies the phone's engine does not implement
- [x] Trace every vault surface, not the four of the data path
- [x] Say which of the five ways out of the tunnel start was taken
- [x] Name a replica request that never left the phone, since no trace can show it
- [x] Collapse a repeated log line so it cannot crowd the one that says why
- [x] Pin what the provider does when a gateway IS in reach, which nothing asserted
- [x] Bind the phone's loopback proxy to the address every caller dials
- [x] Hand expo-file-system the URI form of the replica directory, not the bare path

### Q — the guard against the emulator's ANR dialog had been inert since the snapshot cache landed

- [x] Force the configuration re-latch that makes `hide_error_dialogs` take effect on a snapshot-restored emulator
- [x] Stop leaving the launcher cold when device preparation force-stops the app
- [x] Classify a system error dialog over the app as infrastructure, since the assertion never reached the product

### R — Tasks could not mount at all, and the Hermes ban was still guessing at reachability

- [x] Ship the `Inbox` glyph the Tasks band has named since it was written
- [x] Assert that a band icon RESOLVES, not merely that it is a non-empty string
- [x] Derive the Hermes Array ban from what the mobile bundle actually reaches, instead of a hand-written glob
- [x] Name the two ES2023 copies the ban never listed, and the two more sites the walk found

### S — the app tour tapped three tiles the fold was hiding

- [x] Scroll the springboard to a tile before tapping it, since only five of the eight fit a phone screen

### T — two branches were fixing the same phone, and neither could see the other's half

- [x] Merge #911 into this branch and close that PR
- [x] Reconcile the two branches' independent answers where they collided

### V — the device gate, measured rather than estimated

- [x] Reach Tally through the all-apps sheet, since its Home tile is empty for the first week of every month
- [x] Spend one Maestro spawn on the cover tour instead of ten
- [x] Scroll the group ledger to its Add expense act, which four demo members push under the fold
- [x] Scroll the composer to its foot sentence, which six fields push under the fold
- [x] Scroll once more to the commit, which sits below the foot as the ScrollView's last child
- [x] Make Photos ask before it is refused, since a pre-revoked grant is not a denied one
- [x] Give Tally's commit a handle, since its label and the screen title are the same words
- [x] Assert the return to the group screen after the commit, rather than blind-tapping the band
- [x] Spend one spawn on Notes' three adjacent read and write chunks

### U — the merged tree's own three client-e2e failures

- [x] Disambiguate the Household sharing panel's headings, which the merge made ambiguous page-wide
- [x] Bring the two grant-kit e2e fixtures to the #903 reach ruling instead of the #825 one they still encoded
- [x] Correct the Hermes claim and narrow the ban to the one measured absence

## What changed

Where each checked item lands, then the reasoning behind it:

- Merge #911 into this branch and close that PR — "One phone, two branches"; the merge commit itself, whose second parent is `724c0785`. #911's own 225-file diff is described by its own receipt, `receipts/issue-903-mobile-docs-v17-vault-lockup.md`, which comes across with it; nothing in that half is re-narrated here.
- Reach Tally through the all-apps sheet, since its Home tile is empty for the first week of every month — "V — a calendar bug and a spawn tax"; `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs`.
- Spend one Maestro spawn on the cover tour instead of ten — same section; same file.
- Scroll the group ledger to its Add expense act, which four demo members push under the fold — same section; same file.
- Scroll the composer to its foot sentence, which six fields push under the fold — same section; same file.
- Scroll once more to the commit, which sits below the foot as the ScrollView's last child — same section; same file.
- Make Photos ask before it is refused, since a pre-revoked grant is not a denied one — same section; `tests/agent-e2e-mobile/flows/photos-permissions.mjs`.
- Assert the return to the group screen after the commit, rather than blind-tapping the band — same section; `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs`.
- Give Tally's commit a handle, since its label and the screen title are the same words — same section; `apps/mobile/src/kit/test-ids.ts`, `apps/mobile/src/apps/tally/TallyAddScreen.tsx`, `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs`.
- Spend one spawn on Notes' three adjacent read and write chunks — same section; `tests/agent-e2e-mobile/flows/notes-library.mjs`.
- Disambiguate the Household sharing panel's headings, which the merge made ambiguous page-wide — "U — three failures the merge produced and nothing before it could have"; `apps/desktop/tests/e2e/household.spec.ts`.
- Bring the two grant-kit e2e fixtures to the #903 reach ruling instead of the #825 one they still encoded — same section; `apps/web/tests/e2e/photos-grants.spec.ts`, `apps/web/tests/e2e/people-grants.spec.ts`.
- Correct the Hermes claim and narrow the ban to the one measured absence — same section; `apps/mobile/src/lib/replica/multi-vault-session.ts`, `scripts/lint-hermes-array-surface.mjs`, `oxlint.config.ts`.
- Reconcile the two branches' independent answers where they collided — same section; `packages/design/src/icons.ts`, `apps/mobile/src/apps/tasks/TasksHome.test.tsx`, `apps/mobile/src/kit/replica/replica-mount.ts`, `apps/mobile/src/kit/replica/ReplicaProvider.tsx`, `apps/mobile/src/kit/share/ShareSheet.test.tsx`, `apps/mobile/scripts/android-emulator-roster.sh`, `apps/mobile/native-fingerprints.json`, `package.json`, `docs/traps/README.md`, `tests/matrix.json`, `tests/quality/classification-ratchet.json`, `tests/comment-density-ratchet.json`, `tests/hygiene-budgets.json`, `tests/agent-e2e-mobile/flows/claim-pins.json`, `tests/agent-e2e-mobile/flows/sharing-reach.md`.

- Scroll the springboard to a tile before tapping it, since only five of the eight fit a phone screen — "The three tiles under the fold"; `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs`.

- Ship the `Inbox` glyph the Tasks band has named since it was written — "The route that never mounted"; `packages/design/src/icons.ts`, `apps/mobile/src/apps/tasks/TasksHome.test.tsx`.
- Assert that a band icon RESOLVES, not merely that it is a non-empty string — same section; `apps/mobile/src/apps/tasks/tasks-band.test.ts`.
- Derive the Hermes Array ban from what the mobile bundle actually reaches, instead of a hand-written glob — "The glob that was a guess about reachability"; `scripts/lint-hermes-array-surface.mjs`, `scripts/lint-hermes-array-surface.test.mjs`, `package.json`, `oxlint.config.ts`.
- Name the two ES2023 copies the ban never listed, and the two more sites the walk found — same section; `oxlint.config.ts`, `packages/client/src/access-lens.ts`, `packages/client/src/receipt-capture.ts`.
- Force the configuration re-latch that makes `hide_error_dialogs` take effect on a snapshot-restored emulator — "The dialog that was already supposed to be hidden"; `apps/mobile/scripts/android-emulator-install.sh`, `docs/traps/emulator-snapshot-settings.md`, `docs/traps/README.md`.
- Stop leaving the launcher cold when device preparation force-stops the app — same section; `apps/mobile/scripts/android-emulator-install.sh`.
- Classify a system error dialog over the app as infrastructure, since the assertion never reached the product — same section, final paragraphs; `tests/agent-e2e-mobile/lib/failure-class.mjs`, `tests/agent-e2e-mobile/lib/harness.mjs`.
- Hand expo-file-system the URI form of the replica directory, not the bare path — "The screen behind the socket"; `apps/mobile/modules/centraid-storage/index.ts`, `apps/mobile/src/kit/fetch-gate/content-store.ts`, `apps/mobile/src/kit/fetch-gate/content-store.test.ts`, `apps/mobile/src/kit/replica/replica-mount.ts`, `apps/mobile/src/kit/replica/replica-mount.test.ts`, `apps/mobile/src/kit/replica/ReplicaProvider.test.tsx`, `apps/mobile/src/lib/replica/thumbnail-pack.ts`, `apps/mobile/src/lib/replica/thumbnail-pack.test.ts`, `apps/mobile/src/lib/replica/background-sync.test.ts`, `apps/mobile/src/apps/photos/PhotosHome.test.tsx`, `apps/mobile/src/screens/PhoneStorage.tsx`.
- Trace what the gateway actually served the phone, since the device's replica path logs nothing — "P — the phone drew an empty library over a vault holding rows"; `tests/agent-e2e-mobile/lib/ci-gateway.mjs`, `.github/workflows/ci.yml`.
- Print the app's own logcat on a failing flow, beside the screen digest — same section; `tests/agent-e2e-mobile/lib/harness.mjs`.
- Keep both diagnostics off the JS bundle fingerprint, so asking the question costs no rebuild — same section, final paragraph; no file changed.
- Split the pairing chunk at the capability, so the assertion that fails most may say what it saw — "P — the phone drew an empty library over a vault holding rows", final section; `tests/agent-e2e-mobile/lib/harness.mjs`.
- Count the bytes a traced response actually wrote, rather than trusting a header that is not set — same section; `tests/agent-e2e-mobile/lib/ci-gateway.mjs`.
- Retry a bootstrap that was refused, because nothing else ever asks again — "P — the phone drew an empty library over a vault holding rows", "The attempt that was never made twice"; `apps/mobile/src/lib/replica/native-session.ts`.
- Reproduce the empty library locally, on a session that mounts believing it is offline — same section; `tests/integration-mobile/bootstrap-recovery.integration.test.ts`, `tests/integration-mobile/lib/seat.ts`.
- Fall through to the configured base when the tunnel fails, not only when it times out — "P — the phone drew an empty library over a vault holding rows", "The phone never asked"; `apps/mobile/src/lib/gateway.ts`.
- Say which way reachability failed, since every route to no base is swallowed — same section; `apps/mobile/src/kit/replica/ReplicaProvider.tsx`.
- Keep the driver's own chatter out of the app-log digest it was drowning — same section; `tests/agent-e2e-mobile/lib/harness.mjs`.
- Stop calling ES2023 array copies the phone's engine does not implement — "P — the phone drew an empty library over a vault holding rows", "What the digest said once it could speak"; `packages/blueprints/apps/docs/filters.ts`, `packages/blueprints/apps/locker/format.ts`, `packages/blueprints/apps/locker/import-model.ts`, `packages/blueprints/apps/notes/powerbox.ts`, `packages/blueprints/apps/tally/spending-model.ts`, `packages/blueprints/apps/tasks/logic.ts`, `apps/mobile/src/lib/replica/multi-vault-session.ts`, `tests/comment-density-ratchet.json`.
- Trace every vault surface, not the four of the data path — same section; `tests/agent-e2e-mobile/lib/ci-gateway.mjs`.
- Say which of the five ways out of the tunnel start was taken — same section; `apps/mobile/src/lib/phone-link.ts`.
- Name a replica request that never left the phone, since no trace can show it — same section; `apps/mobile/src/kit/replica/replica-mount.ts`, `apps/mobile/src/kit/replica/ReplicaProvider.tsx`, `apps/mobile/src/lib/gateway.ts`.
- Collapse a repeated log line so it cannot crowd the one that says why — same section; `tests/agent-e2e-mobile/lib/harness.mjs`.
- Pin what the provider does when a gateway IS in reach, which nothing asserted — same section; `apps/mobile/src/kit/replica/ReplicaProvider.test.tsx`.
- Bind the phone's loopback proxy to the address every caller dials — "P — the phone drew an empty library over a vault holding rows", "The socket that was listening somewhere else"; `apps/mobile/modules/centraid-tunnel/android/src/main/java/expo/modules/centraidtunnel/TunnelProxy.kt`, `apps/mobile/native-fingerprints.json`, `docs/traps/device-only-runtime-gaps.md`, `docs/traps/README.md`.
- Withhold `empty` from a tile whose reads have never had a landed pull behind them — "N — Home claimed the vault was empty"; `apps/mobile/src/screens/home/tile-model.ts`, `apps/mobile/src/screens/home/useSpringboardTiles.ts`, `apps/mobile/src/screens/home/tile-model.test.ts`, `apps/mobile/src/screens/Home.test.tsx`.
- Move the tile-status rule into the pure module that is tested, out of the hook that is not — same section; `apps/mobile/src/screens/home/tile-model.ts`, `apps/mobile/src/screens/home/useSpringboardTiles.ts`, `apps/mobile/src/screens/home/tile-model.test.ts`.
- Record the emulator's active network transport in device preparation, since the replica's sync policy is evaluated against it — next in the log to the failure it would explain — "N — Home claimed the vault was empty", final paragraph; `apps/mobile/scripts/android-emulator-install.sh`.
- Thread `|| needs.changes.outputs.all == 'true'` into both `with:` inputs — "The defect", below; `.github/workflows/ci.yml`.
- Narrow the caller's gate from `client` to `web || desktop`, now that `boot-smoke` has left the lane — "The gate was also wider than what remains in the lane"; `.github/workflows/ci.yml`.
- Extend `bun run lint:path-filters` with a third sub-check: any read of a `changes` output without the `all` fallback fails, whatever construct does the reading — "The lint that makes it the last time"; `scripts/lint-path-filters.mjs`, `scripts/lint-path-filters.test.mjs`.
- Correct the comment on the `changes` job that promised the property for "every lane `if:`" — "The lint that makes it the last time", final paragraph; `.github/workflows/ci.yml`.
- Make `test:suite` emit the report, matching `coverage`'s shape minus `--coverage` — "B — verify's tripwire"; `package.json`.
- Add a wiring guard so a lane cannot again demand `--require-report` without running a script that writes the report — "B — verify's tripwire", second half; `scripts/ci/collection-tripwire.test.mjs`.
- Convert the AVD cache to restore-then-save in all four mobile workflows, the arrangement the apk and gradle caches beside it already use — "C — the AVD snapshot"; `.github/workflows/ci.yml`, `.github/workflows/mobile-canary.yml`, `.github/workflows/mobile-alarm-test.yml`, `.github/workflows/e2e.yml`.
- Give the Android release build `--stacktrace`, so a 35-minute build failure names its cause — "C — the AVD snapshot", final paragraph; `apps/mobile/scripts/android-emulator-install.sh`.
- Establish whether `desktop-e2e-macos` is a gap or a decision, and change nothing if it is a decision — "D — `desktop-e2e-macos` is a decision, not a gap"; no file changed.
- Seed the demo corpus once per LANE, before anything pairs, rather than per flow after the first pairing — "E — the corpus arrived after the clone"; `tests/agent-e2e-mobile/seed-demo-corpus.mjs`, `tests/agent-e2e-mobile/lib/demo-corpus.mjs`, `tests/agent-e2e-mobile/lib/harness.mjs`, `apps/mobile/scripts/android-emulator-install.sh`.
- Give `lint:e2e-wiring` a `corpus` rule holding both halves: no tile tap for an app that cannot earn the grid, and no seeding after the lane's handoff to Maestro — "E — the corpus arrived after the clone", final paragraphs; `scripts/lint-e2e-wiring.mjs`, `scripts/lint-e2e-wiring.cases.mjs`, and `tests/agent-e2e-mobile/README.md`, whose `ctx.ensureDemo` entry described the per-flow contract without saying that a CI lane makes it a no-op.
- Let a sensitive chunk print its failing directive on failure, without ever letting its capability reach the log — "F — a prerequisite that fails without saying how"; `tests/agent-e2e-mobile/lib/spawn.mjs`, `tests/agent-e2e-mobile/lib/harness.mjs`, `tests/agent-e2e-mobile/lib/spawn-redaction.test.mjs`.
- Give `coverage:shard` the default reporter alongside the blob, so a failing shard says which test failed — "G — a shard that fails in silence"; `package.json`.
- Keep every app on the grid when no tile is readable, so an unmounted replica cannot leave a member with no way into any app — "H — the launcher with no tiles"; `apps/mobile/src/screens/home/springboard-policy.ts`.
- Move grid membership into `springboard-policy`, the module that claims it, so the rule is testable without a renderer — "H — the launcher with no tiles"; `apps/mobile/src/screens/Home.tsx`, and the policy cases move from `apps/mobile/src/screens/home/tile-model.test.ts` into a new `apps/mobile/src/screens/home/springboard-policy.test.ts`, with `tests/comment-density-ratchet.json` re-pinned for the arithmetic that split produced.
- Publish the canary's paired-Home frame as UI-impact evidence for H — "User impact"; `tests/agent-e2e-mobile/flows/pairing-canary.mjs` and its companion `tests/agent-e2e-mobile/flows/pairing-canary.md`.
- Pin H's composition at the renderer tier — `apps/mobile/src/screens/Home.test.tsx`. Both units were green throughout the defect; only the composition could see it, which is why it had no test at any tier before now.
- Score the suite wall-clock ceiling on `verify`, not on the sharded `coverage` lane — `.github/workflows/ci.yml`, `tests/suite-wall-clock.json`. The budget file claimed the metric was concurrency-invariant: "elapsed varies with host load and `--concurrency`, while the sum is the work the suite actually asked for". It is not, and the claim is corrected in place rather than left to mislead the next reader. The sum is of per-file WALL SPANS, and a run's files execute concurrently, so every span stretches when workers timeshare a slow runner. `budgetMs` is untouched at 2,867,000 — nothing was widened; the gate moved to the lane its own ceiling was measured from ("Reseeded 2026-08-29 from CI verify").
- Build one ABI, not four, in the lanes that drive an emulator — `apps/mobile/scripts/android-emulator-install.sh`. `gradle.properties` declares all four `reactNativeArchitectures`, which is right for a store artifact and four times the native compile a test lane needs: every emulator this script feeds is `x86_64` (`arch: x86_64` in all four workflows, pinned in `device-matrix.json`, where the divergence is already recorded as deliberate because only x86_64 is KVM-accelerated). The three ARM ABIs were compiled on every cold build and never executed. Passed as `-P` rather than edited into `gradle.properties`, which is the store build's configuration too.
- Give the shell↔app contract one manifest both the RNTL tier and the Maestro tier can read — `apps/mobile/app-conformance.json`, one row per first-party app carrying its launcher route, the navigator/screen its tile opens, its `centraid://` path, its tile handle, its arrival landmark and whether it ships a demo fixture. JSON rather than a TS module because the three consumers do not share a build: the RNTL sweep imports it, `lint:app-conformance` reads it from plain node, and the Maestro layer's `.mjs` runners can read it with no transpile. That answers #905 Part 2's first open question ("where does the app manifest live so that both RNTL and Maestro can read one source of truth") in the only way all three can be served.
- Hold the registry, the launcher catalog, Home's navigate switch, the deep-link table and the testID vocabulary against it, so a new app is covered the day it registers — `scripts/lint-app-conformance.mjs`, `scripts/lint-app-conformance.test.mjs`, wired into `check:push` and `ci.yml`'s `static` job. Six rules: `registry-complete`, `route-registered`, `navigates`, `deep-link-routed`, `handles-declared`, `seed-declared`. See "I — the shell↔app contract had no source of truth", below.
- Replace per-app authoring at the composition tier with a sweep generated from the manifest — `apps/mobile/src/screens/Home.test.tsx`, which now runs `describe.each` over the manifest: every registered app has a tile under its declared handle, and pressing that tile navigates to its declared cover. Sixteen assertions, no per-app authoring, and app #9 is swept the day it registers.
- Print the handles the screen was carrying when a non-sensitive chunk fails, so a device failure is diagnosable from the log rather than only from an artifact — `tests/agent-e2e-mobile/lib/hierarchy-digest.mjs`, `tests/agent-e2e-mobile/lib/hierarchy-digest.test.mjs`, and the failure path of `runMaestroChunk` in `tests/agent-e2e-mobile/lib/harness.mjs`. `knip.json` gains `maestro` under `ignoreBinaries`, beside `actionlint`, `gitleaks` and `trivy`: the harness has always required the Maestro CLI, but every previous invocation went through a variable (`const run = sensitive ? spawnQuiet : spawnLive`) that knip could not resolve to a binary name. The literal `execFile("maestro", …)` added here is the first one it can see, so this declares a dependency that was already real rather than silencing a new finding. See "J — `Element not found` never said what WAS found", below.
- Keep the sensitive path silent, and say so when no hierarchy is found rather than printing nothing — `tests/agent-e2e-mobile/lib/harness.mjs`. The digest is gated on `!sensitive` and refuses any label containing `configure-gateway`; when nothing matches, it prints the directory's actual contents, because a diagnostic that quietly stops diagnosing is the silent no-op this repo treats as a failure.
- Answer Android's runtime media-grant dialog, so `permission-refused` actually refuses a permission — `tests/agent-e2e-mobile/lib/first-run.mjs` gains `DENY_MEDIA_PERMISSION`, used by `tests/agent-e2e-mobile/flows/photos-permissions.mjs`. The screen digest on run 33469364358 found `grant_dialog`, `permission_allow_all_button` and `permission_deny_button` on screen for the whole time that flow spent waiting for `photos-collections`: `launchApp: { permissions: { all: deny } }` does not cover Android 14's separate visual-media grant, so the journey named `permission-refused` had never refused one — it timed out behind an unanswered system dialog and reported the app broken. Matched on copy rather than by `id:` because `lint-mobile-testids.mjs` requires every Maestro `id:` to resolve to a `TEST_IDS` entry, and an OS handle is not this app's vocabulary to declare; `CONFIRM_SYSTEM_OPEN` matches iOS's system dialog the same way. It cannot turn a missing refusal into a pass — both taps no-op if the dialog stops appearing, and `photos-access-panel` then fails on a grant that was never refused.
- Make every device flow name what it catches, and enforce it with a down-only gate — `scripts/lint-e2e-claims.mjs`, `tests/agent-e2e-mobile/flows/claim-pins.json`, a new `tests/agent-e2e-mobile/flows/cold-start.md`, and a `**Claim:**` line on `tests/agent-e2e-mobile/flows/notes-library.md`, `tests/agent-e2e-mobile/flows/native-v0-resilience.md` and `tests/agent-e2e-mobile/flows/photos-permissions.md`; wired into `check:push` and `ci.yml`'s `static` job. The convention already existed and was almost entirely unobserved: **one flow of twenty-two** carried a claim (`pairing-canary.md`) and five had no companion doc at all. The critical five now state theirs; the remaining 17 are pinned, and the pin list is down-only — adding to it fails the linter, so a new device flow must say what merges wrongly if it passes when it should not. See "L — a suite of flows that had stopped saying what they were for", below.
- Stop running Android Lint on the gate's throwaway test artifact — `apps/mobile/scripts/android-emulator-install.sh`, `-x lintVitalAnalyzeRelease -x lintVitalReportRelease`. See "K — the device gate spent 60% of its wall clock building", below.
- Let the PR gate bank the shell it compiled, instead of only ever restoring one main built — `.github/workflows/ci.yml`, two `actions/cache/save` steps mirroring `mobile-canary.yml`'s, in its step order (run → scrub → saves → upload) and against the same keys and paths its own restore steps use.
- Warm the freshly installed apk in device preparation, now that caching removed the pause the build used to provide — `apps/mobile/scripts/android-emulator-install.sh`, an AOT compile plus one throwaway launch after the ANR-dialog suppression. See "K — the device gate spent 60% of its wall clock building", final paragraph.
- Wait for the launcher, not the band's label, wherever a flow's next act is opening an app from Home — `tests/agent-e2e-mobile/lib/harness.mjs` gains `AWAIT_LAUNCHER`, used by `tests/agent-e2e-mobile/flows/notes-library.mjs` and `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs`. See "M — 'Home is ready' could not tell a Home that has the vault from one that does not", below.
- Measure cold start to the launcher, closing the false green this receipt recorded rather than left standing — `tests/agent-e2e-mobile/flows/cold-start.mjs` and `tests/agent-e2e-mobile/flows/cold-start.md`, whose "honest limit" section is replaced by what the flow now measures. `scripts/test-report/matrix-grades.mjs` and `scripts/test-report/matrix-grades.test.mjs` come with it: `countDeclaredTests` is a text scanner over flow files, so factoring `cold-start`'s only assertion into a harness constant made it read `0 tests, minimum 1` — an assertion that still runs, counted as gone. It now counts the interpolation `${AWAIT_LAUNCHER}` (not the bare identifier, which the import line also carries), and the comment states the bar for adding another name: the constant must assert. `retryableTapCommands`, `CONFIRM_SYSTEM_OPEN` and `DENY_MEDIA_PERMISSION` are deliberately absent — they expand to taps, and a tap proves nothing. Proven to bite: with the rule disabled the matrix reds by name, on `mobile-cold-start` and on `mobile.performance`.

- Stop gating replica row pulls on the byte-transfer policy — `apps/mobile/src/lib/upload/native-policy.ts` gains `nativeRowSyncAllowed`, wired through `apps/mobile/src/kit/replica/ReplicaProvider.tsx` as a new `isRowSyncAllowed` option on `apps/mobile/src/lib/replica/native-session.ts` and `apps/mobile/src/lib/replica/multi-vault-session.ts`, where it replaces `isNetworkWorkAllowed` at the three read gates (first-open bootstrap, `bootstrapWhenReachable`, `pullNow`) and at `pullScopes`. Covered by `apps/mobile/src/lib/upload/native-policy.test.ts` and `apps/mobile/src/lib/replica/multi-vault-session.test.ts`; `apps/mobile/src/kit/replica/ReplicaProvider.test.tsx` mocks the new export alongside the old one, since the provider now imports both. See "O — a phone that was not on Wi-Fi never pulled a row, and said nothing", below.
- Keep blobs, the write drain and the background pass on the whole transfer table — `flushIntents` and `flushPlacements` still ask `isNetworkWorkAllowed`, `apps/mobile/src/lib/replica/thumbnail-pack.ts` still asks `nativeSyncAllowed`, and `apps/mobile/src/lib/replica/background-sync.ts` keeps its pass-level gate with a comment naming the asymmetry as deliberate. The new option defaults to `isNetworkWorkAllowed`, so a caller that does not pass it keeps today's behaviour.
- Record the ruling and correct the docs that stated the old coupling as current — `docs/decisions.md` gains **M-rowsync** under "Mobile offline, scale and sharing (#880)", and `docs/mobile-offline.md`'s freshness paragraph no longer states a pull the metered/battery rules refuse as the ordinary case, because it is now only the `never` floor.

### M — "Home is ready" could not tell a Home that has the vault from one that does not

Every flow in the gate waits for `HOME_READY_MARKER` and then acts. That marker is the band's own label, and `springboard-policy.ts` renders the band in **both** of Home's branches — the launcher grid and the `DayOne` empty-vault fallback. So the harness's definition of "Home has arrived" has never been able to tell a Home that came up with the vault from one that came up without it, and a flow whose next act is tapping a tile walks into DayOne and fails on its own selector. `Tap on "Open Notes.*"` is what the log said; "the initial replica clone had not landed yet" is what had happened. Section L recorded the same defect in `cold-start` and deferred the fix to the change that fixes the replica; this is that change.

`home-grid` is published by `LauncherGrid` alone, so it is the first thing on screen that separates the branches. `AWAIT_LAUNCHER` waits for it, and it is a repair and not only a diagnosis: Home's tile reads are LIVE — `useReplicaQuery` re-reads when a scope syncs — so a clone landing a beat after the band flips the screen by itself. Nothing polls; the wait is only what gives that beat somewhere to happen. Where it does not, the failure now names the launcher instead of blaming a tile.

It is applied where a flow's next act is opening an app from Home, not everywhere: `photos-permissions` purges its scenario on purpose and reaches Photos by deep link, and the flows that face a deliberately cleared client still expect DayOne. The constant says so, so the next reader does not paste it in by reflex.

`cold-start` now measures **icon-to-usable** rather than icon-to-band. Its numbers get longer, because they now include the replica reads settling — that is the honest reading, and no history is invalidated, since the drift budget stays inactive until thirty samples exist. It also fails when the vault does not arrive, where it used to pass; that is the point.

### N — Home claimed the vault was empty on the word of a replica that had never synced

Section M gave the flows a handle that can tell Home's two branches apart. Run 33472898285 then used it, and the answer was not a race: `notes-library`, `native-v0-resilience` and `cold-start` each waited the full sixty seconds and each failed on `id: home-grid`, on a screen whose digest carried "Nothing in here yet" and "Fill it with sample content" — while the lane's own log, three minutes earlier, read `seed-demo-corpus: notes seeded (16 rows)` and the flow's own note read `notes demo already present (16 rows)`. The corpus was in the gateway before the first pairing, which is what section E fixed. The phone still never saw a row.

So the ordering fix was necessary and not sufficient, and what remained is a defect in Home rather than in the harness. `combineStatus` already carried the right rule and one clause short of it: "`unavailable` and a failed read stay `unknown` — neither is evidence the app is empty, and only a settled empty read may claim first-run." The case it does not cover is a read that settles, succeeds, and returns nothing **because the clone has not arrived**. The local store answers instantly and correctly that it holds no rows; that is a fact about the replica, not about the vault. Every tile then reads `empty`, `springboardState` calls it `first-run`, and Home draws `DayOne` over a full vault.

`lastSyncedAt` is what separates the two, and it was already on every read: it is the newest freshness stamp over the mounted scopes, and only a landed pull writes one. `NativeReplicaSession.pullNow` returns `false` — stamping nothing — while the session is closed, disconnected, still without a cursor, or refused by the member's own transfer rules, and `MultiVaultReplicaSession.pullScopes` refuses the whole pass with `policyBlocked` before it asks any scope. So the stamp's absence means this phone has not completed one exchange with its gateway. Its presence over an empty result is the real first run, and still routes to `DayOne` — which is why the fix cannot cost a genuinely new member the one screen written for them.

The rule moved to `tile-model.ts` in the same change, and that is not tidying. `springboard-policy.ts` says of the defect in section H that it "had no test at any tier, a renderer being the only way to reach it", and `combineStatus` sat in the hook for the same reason and with the same consequence. `tile-model.ts` is pure, is the module `useSpringboardTiles` already names as where the selection logic is tested, and the four cases now pinned there are the ones a renderer could not have reached cheaply. Removing the new clause reds two of them by name.

What this does NOT do is explain why the pull never lands, and it deliberately does not guess. One candidate is cheap enough to rule in or out from the log rather than by argument: replica sync shares the byte-transfer rules — `nativeSyncAllowed` is literally `canTransfer()` — and `DEFAULT_TRANSFER_POLICY` is `wifiOnly: true`, so a device whose active network is not Wi-Fi pulls nothing, silently, for a reason that is a member setting rather than a fault. Whether a CI emulator image is in that state is an accident of the image, so device preparation now prints the active network's transport instead of anyone assuming it. Nothing branches on the reading. Relaxing a member's transfer rules to get a lane green would be testing a device no member has, and if that reading comes back `CELLULAR` the finding belongs to the product — the seat doctrine gives record-only apps "offline reads and queued writes for free", and gating row sync on the photo-backup policy is not that.

### L — a suite of flows that had stopped saying what they were for

`cold-start` is the cautionary case, and it is not hypothetical. It asserts `HOME_READY_MARKER` and nothing else; `lib/demo-corpus.mjs` already documents that marker as rendering in **both** of Home's branches — the launcher and the `DayOne` empty-vault fallback. On run 33469364358 it **passed**, median 16074 ms, against a Home whose screen digest carried "Nothing in here yet", "Fill it with sample content" and not one `home-tile-*`, while `notes-library` and `native-v0-resilience` had failed on that same screen a minute earlier. It reported green on a build that could not open a single app.

A flow whose claim nobody had to write down had quietly stopped making one — and nothing in the repo would ever have said so. `lint:e2e-claims` is the rule with teeth: a device flow must answer "what merges wrongly if this passes when it should not?", or be deleted. The roster is discovered rather than hand-listed, so a new flow is covered the day it lands, and the linter refuses to pass on an empty roster rather than reporting success over nothing.

The pin list carries the 17 flows that do not yet state a claim, and it is **down-only** — the `comment-density-ratchet.json` pattern. A gate that lands with a backlog is not weakened; a gate whose backlog may grow is. Both rules were proven to bite before being trusted: removing `notes-library`'s claim reds the linter by name, and adding a flow to the pin list reds it twice — once for the stale pin, once for the ratchet.

**What this did NOT do, and what closed it.** The gate landed without fixing `cold-start`'s assertion: closing it meant asserting a launcher landmark instead of a band label, a strengthening that converts a currently-green flow into an honestly-red one for as long as the replica arrives empty. Recording the limit in `cold-start.md` was what made it a stated defect rather than a rediscovery — and section M, below, is where it was paid off, once the same defect turned out to be what the whole gate was failing on.

### K — the device gate spent 60% of its wall clock building

Measured on run 33418649297, head `0655a1b7`, a 27m25s job:

| phase | time | share |
| --- | --- | --- |
| setup, cache restores, AVD | 1.6 min | 6% |
| gradle release build | **16.4 min** | **60%** |
| the five flows — the signal | 8.0 min | 29% |
| overhead, teardown | 1.5 min | 5% |

`BUILD SUCCESSFUL in 16m 21s` is in the job log. Inside it: `lintVital*` 4m37s across 35 tasks, the Metro bundle 27s (`Android Bundled 27426ms`, 2668 modules), native compile and packaging the rest.

**Measured after, on run 33467906385, head `6ee9cec2`:**

| | before (`0655a1b7`) | after (`6ee9cec2`) |
| --- | --- | --- |
| whole job | 27m25s | **17m06s** |
| the emulator step | 25m43s | 13m55s |
| gradle build | 16m21s | **11m19s** |
| `lintVital` task lines | 35 (4m37s) | 1 (the umbrella, now a no-op) |

A 10m19s cut, 38% of the job, with no assertion changed. Both new cache-save steps ran (`Save the built Android app` in 3s, the gradle directory in 55s), and the next push on this branch that left the JS fingerprint alone did show the apk restore as a hit rather than the 0s miss it had been every time before: on run 33471409214 the restore took 1s, gradle did not run, and the job reached its first flow 92 seconds in. That is the whole build gone from a JS-only push — and it is also what exposed the warm-up below.

**Android Lint is not this lane's claim.** AGP wires `lintVital<Variant>` into `assembleRelease`, so the gate ran Lint across every module before it could hand Maestro an apk it then throws away. `bun run lint` is a gate of its own on every PR in `static`, where a lint failure names itself in seconds. Excluded by task name on the CI command line rather than through `lint { checkReleaseBuilds }`, for the reason already written above the ABI override beside it: that DSL block is the STORE build's configuration too.

**And it built at all because nothing banks a shell for a PR.** The apk cache key names the JS bundle fingerprint, and this job had only a restore step — the sole writer was `mobile-canary`, on main. So a PR touching JS could never hit it: "Restore the built Android app" was a 0s miss on `0655a1b7` and again on `60732d30`. The save added here does not help the push that paid for the build; it helps the next push on the same branch, which is the common shape — a receipt edit, a doc fix, a workflow tweak, none of which move the JS fingerprint. Actions cache scoping keeps a branch's entry to that branch and its children, so it cannot serve a stale shell to main or to an unrelated PR.

**The cut removed a warm-up nobody had named.** The apk cache hit on run 33471409214 (a 1s restore, gradle skipped entirely) and the job reached its first flow in 92 seconds — and `pairing-canary` then failed on `Assert that "Connect your gateway." is visible`, having burned the full `FIRST_LAUNCH_TIMEOUT_MS` on the very first launch of a just-installed apk, on an emulator that had cold-booted 35 seconds earlier because the AVD snapshot missed. The same assertion had failed once before, on the run where the emulator sat idle through an 11-minute gradle build; it passed on the run after that.

Both readings point the same way: the app's first start after `adb install` has no AOT artifacts, so ART verifies and compiles on the spot, and on a SwiftShader emulator that can exceed the timeout. Sixteen minutes of gradle used to sit between the install and the first flow, so this lane had been getting its warm-up **by accident** — and caching the apk removed the pause without anyone noticing it was load-bearing. The remedy is to name it: `compile -m speed` does the one-time ART work up front, and one throwaway launch absorbs what AOT cannot pre-pay, before `am force-stop` hands the first flow a cold PROCESS over a warm INSTALL — which is the state every flow already believed it started from. That is device preparation, beside `hide_error_dialogs`, not a retry: nothing is asserted there, and a member's phone has long since been through the same dexopt, so it moves the emulator toward the real case rather than away from it.

**What was deliberately not cut.** Three candidates buy wall clock by deleting signal and were rejected: `cold-start`'s eight launches ARE its measurement; dropping a member from the critical five is the thing the lane exists to prevent; and `native-v0-resilience`'s relaunch per surface is load-bearing, not waste — its own header records that covers dismiss with a swipe Maestro cannot drive, so each surface is entered from a fresh launch on purpose. The one genuine flow-level redundancy found, the throwaway `launchApp` in `01-reuse-paired-gateway` when the next chunk stops and relaunches anyway, is worth ~35s across the suite and is left for a change that can be measured on its own.

### The defect

`.github/workflows/ci.yml`'s `client-e2e` honoured `needs.changes.outputs.all` in its `if:` and not in its two `with:` inputs, which read `outputs.web` / `outputs.desktop` alone. The `changes` job **skips** the paths-filter step on a `workflow_dispatch` (`if: github.event_name != 'workflow_dispatch'`), so on a manual run every filter output is the empty string. The caller started — its `if:` saw `all` — and handed `.github/workflows/lane-client-e2e.yml` `web: false, desktop: false`. Both inner jobs took their own `if: inputs.web` / `if: inputs.desktop` and skipped. The lane finished in 0s having run nothing and reported satisfied to `check`, which counts `skipped` as a pass.

The consequence is the sharp one: `workflow_dispatch` is the only way to force every path-gated lane on for a commit whose diff woke none of them, and it was the one trigger under which this lane could not run at all. That is the `skipped`-counts-as-a-pass hazard #892 Phase 3 exists to close, one level down, reached through its own remedy.

Both `with:` inputs now carry the fallback.

### The gate was also wider than what remains in the lane

The caller gated on `client`, a superset of `web ∪ desktop` — it also matches `packages/server/**`. That was deliberate under #496 E7, while `boot-smoke` lived in this lane and had to run for gateway-only PRs. #892 Phase 1 moved `boot-smoke` into `verify`, and nothing gated on `client` remained here, so a `packages/server`-only PR had been starting a caller whose every job skips — on ordinary PRs, not only on dispatch. The gate is now `web || desktop || all`.

### The lint that makes it the last time

`scripts/lint-path-filters.mjs` gains a third sub-check beside `claimed` and `tidy`: `escape`. Every read of a `changes` output must carry `|| needs.changes.outputs.all == 'true'`, and the check is deliberately blind to which construct does the reading — those two `with:` lines were the only reads in `ci.yml` outside an `if:`, and every prior reading of this table had assumed `if:` was the only place an output could be consumed.

The scanner folds YAML block scalars back into one unit under the line number of their key (`scannableUnits`) rather than banning them. A per-line scan would read the fallback half of a folded `if:` as absent; the cheaper alternative — refusing folded conditions outright — would have made collateral of `publish-report`'s, which is folded for length alone and contains no filter output. `scripts/lint-path-filters.test.mjs` pins both directions: the pre-fix `with:` shape is caught, a folded condition carrying the fallback passes, and the line after a folded block is not swallowed.

The comment on the `changes` job in `.github/workflows/ci.yml` promised this property for "every lane `if:`" — the wording that *is* the blind spot. It now says "every read", names how the two `with:` inputs came to be the exception, and points at the lint that checks it instead of the wording promising it. The comment on `static`'s `lint:path-filters` step names the new sub-check.

### B — verify's tripwire required a report its own lane never wrote

`.github/workflows/ci.yml`'s `verify` ends with `bun run test:collection-tripwire -- --require-report`. `scripts/ci/collection-tripwire.mjs` reads `artifacts/test-results/vitest.json`. `package.json`'s `test:suite` — the only thing in that job that runs the suite — was `vitest run --reporter=default`, with no `--reporter=json` and no `--outputFile`, and neither `vitest.config.ts` nor `vitest.shard.config.ts` declares reporters. On a clean runner the file cannot exist, so the step failed every time it was reached.

`verify` is in `check`'s `needs:`, so the required check could not pass on any run that got that far — every PR, not only `main`. It shipped unobserved because the preceding main-push runs were each cancelled by a superseding push before `verify` reached its last step. The dispatch run that exposed defect A exposed this one too: the suite was fully green (`1502 passed | 4 skipped` files, `18162 passed | 5 expected fail | 37 skipped` tests, 1158 s) and the job died on the step after it.

`test:suite` now carries `--reporter=default --reporter=json --outputFile=artifacts/test-results/vitest.json` — `coverage`'s shape minus `--coverage`. That is the arrangement the `coverage` job's own comment already described ("Scored on the merged report as well as on `verify`'s own run"), so the reporter was the missing half of an intent already written down. Dropping `--require-report` would also have gone green and is the wrong fix: the flag is what separates "no file failed to collect" from "nothing was looked at", and the script's non-strict mode already prints `not measured` for a laptop.

`scripts/ci/collection-tripwire.test.mjs` gains the wiring assertion, derived from the shipped YAML the way `lint-e2e-wiring` is: every `ci.yml` job running the tripwire with `--require-report` must also run a package script whose body writes the report path. Producers are read out of `package.json` rather than named, so a new producer or lane inherits the check.

That assertion's first draft **passed against the very defect it was written for**. It joined each job's raw lines, and `verify`'s header comment contains the words "`bun run coverage` alone at 20m15s" — so a check looking for a producer invocation found one in prose. A wiring check that reads commentary is the same class of mistake as the wiring it checks. Comment lines are stripped now, and the correction was verified by reverting `test:suite` and watching the assertion fail with the job named.

### C — the AVD snapshot never saved on a red lane

`mobile-device-gate` failed on the main-tip dispatch after 34m55s, and it failed in the **build**, not the suite: `:app:packageRelease FAILED` inside `PackageAndroidArtifact$IncrementalSplitterRunnable`, with `1414 actionable tasks: 1414 executed` — nothing cached, a fully cold compile. The emulator suite never started, `tests/agent-e2e-mobile/runs/` was empty, no evidence was uploaded, and the twelve-minute suite budget never engaged because there was no suite.

Two things are fixed here. **Neither is the `packageRelease` failure itself**, whose cause is still unknown — see Out of scope.

The AVD cache was the one-step `actions/cache` in all four mobile workflows, while the apk and gradle caches beside it are `restore` + `save`. The comment explaining why sits three lines above it in `mobile-canary.yml`: "`actions/cache` declares `post-if: success()`, so on a lane that is currently red the cache never populates and the expensive build is paid on every run — the warm path stays unreachable until the greenness the cache exists to help deliver." The reasoning was written, applied to two caches, and not to the third. The logs state it twice: `Post AVD cache` reported `skipped` on every red run, and `Create AVD + snapshot (cache miss only)` ran on every run — ~2 minutes each time, forever, on lanes that are red.

`ci.yml`, `mobile-canary.yml`, `mobile-alarm-test.yml` and `e2e.yml` now restore with `actions/cache/restore` and save with a `Save the AVD snapshot` step placed immediately after the create. Immediately after, not at job end: it banks the snapshot **before** the long emulator step can fail, and it inherits `success()` so a failed create never banks a broken AVD. The key is a pure description of the AVD's shape and the test step runs `-no-snapshot-save`, so nothing a suite does can poison what is stored.

`apps/mobile/scripts/android-emulator-install.sh` gains `--stacktrace` on the release build. That build reported its failure as a bare `IncrementalSplitterRunnable` line with no cause, because gradle prints one only when asked — so the 34m55s produced a red lane and no diagnosis, and the next person pays another 35 minutes to learn what this run already knew. Stack traces are emitted on failure only, so a green build's output is unchanged.

### D — `desktop-e2e-macos` is a decision, not a gap

It is absent from `check`'s `needs:` while every other path-gated lane is present, and this receipt's earlier draft called that a gap. It is not, and no code changed. `ci.yml` states the ruling directly above the job: "`desktop-e2e-macos` stays, and stays NON-REQUIRED. #892 asked whether a 10x-multiplier runner belongs on the PR loop at all; the answer recorded here is that it does while it is advisory, because the twice-burned promotion rule in `lane-client-e2e.yml` is the thing that would move it, and demoting it to nightly would delete the only darwin signal that rule could ever read."

The reason to record it rather than drop it is that "advisory" is exactly the state #892 Phase 3 spent an issue bounding, so the question worth asking is whether *this* advisory lane is bounded by anything. It is: `scripts/ci/lane-health.mjs` tallies every job name from main's runs with no allowlist, so a `desktop-e2e-macos` that stays red on main for more than three days fails the nightly health lane unless it carries an unexpired entry in `tests/lane-quarantine.json`. Non-required is not unwatched. Nothing to fix.

### E — the corpus arrived after the clone, so a working app looked broken

With A, B and C landed, `mobile-device-gate` was the one lane still red — and, once the cold build stopped hiding it, the suite reached the emulator and failed somewhere new. `pairing-canary` passed (182s, then 174s on the PR head — three consecutive passes, which retires the one 73s failure recorded above as a blip). What failed was every journey after it, at its first tap:

```
Assert that "All apps and places" is visible... COMPLETED
Tap on "Open Notes.*"... FAILED
Element not found: Text matching regex: Open Notes.*
```

The same shape on `main`, across the whole canary roster: `Open Photos.*`, `Open Docs.*`, `Open Agenda.*`, `Open Notes.*`, `Open Tasks.*`, `Open People.*` and `id: home-tile-photos`, all `Element not found`, while pairing, onboarding and cold start passed.

**The app was correct.** `springboardState` (`apps/mobile/src/screens/home/springboard-policy.ts`) reads every tile settled and empty, returns `first-run`, and `Home.tsx` renders `<DayOne>` **instead of** `<LauncherGrid>`. There is no launcher tile on an empty vault, by design. `HOME_READY_MARKER` did not catch it because it is `"All apps and places"` — a `HomeBand` accessibility label that renders in *both* states. The harness comment beside that constant already said so: "it is a render signal, not a settled signal".

So why was the vault empty when every flow seeds? Because **`ensureDemo` writes to the gateway, and a lane is many flows sharing one pairing.** Each flow does the right thing alone — `ensureDemo("notes")` then `configureGateway()` — but only the FIRST flow of a lane actually pairs. `run-pr-gate-suite` opens with `pairing-canary`, which pairs and seeds nothing; the roster pairs inside `run-probes-suite` and then runs three more suites against that profile. Every seed after that lands on a gateway whose client has already cloned, and nothing pulls a post-clone write down. The run log states it plainly, in order:

```
note : paired the journey with the gateway at http://127.0.0.1:18789
note : notes demo seeded (16 rows)
note : reused the paired nightly profile for http://127.0.0.1:18789
```

Sixteen rows written, none of them ever on the phone. `native-v0-resilience` is the clincher: it seeds `tally` and then opens all eight covers, so even a perfectly-synced phone would have needed seven scenarios it never asked for.

**AND THIS DIAGNOSIS IS WRONG — or at least not sufficient. Recorded rather than rewritten, because the correction is the useful part.** The fix below shipped and did exactly what it says: `seed-demo-corpus: 7 scenario(s) ready before first pairing` precedes the first `[runFlow]`, `pairing-canary` then passed (234s), and `notes-library` reported `notes demo already present (16 rows)` before reusing that pairing. The corpus was in the gateway before the clone, the phone paired, and `Tap on "Open Notes.*"` **still** failed with `Element not found`. Seeding order was not the cause.

What fits every run instead, and fits the empty-vault and seeded-vault cases *identically* — which is precisely why the seeding changed nothing:

- `replicaQueryConnection` (`apps/mobile/src/kit/hooks/replica-query-state.ts`) returns `"unavailable"` when there is no replica **session**, before it ever considers rows.
- `combineStatus` in `useSpringboardTiles.ts` maps `connection === "unavailable"` to `unknown`.
- `tileEarnsGrid` promotes only `content`, `loading` or Locker, so **no tile earns the grid**.
- `springboardState` sees every tile `unknown`, takes its `readable.length === 0` branch and returns `content` — so Home renders `LauncherGrid` rather than `DayOne`, with an EMPTY `earned` list.

That is a rendered launcher with no tiles, under a `HomeBand` still publishing "All apps and places". Identical symptom, no dependence on rows at all. The open question is why a freshly-paired phone has no replica session, and the standing suspicion is the one #890's receipt already flagged as unproven: the on-device `op-sqlite` driver was never exercised, its 52-of-56 boot-condition cells being evidence about the `NodeSqliteDriver` stand-in rather than the native module the app ships. A replica that cannot open its database has no session, and every home journey fails at its first tile.

That belongs to #904/#870 with this evidence attached, not to a CI-wiring issue, and it is not fixed here.

**Why the change below stays anyway.** It is correct on its own terms: `ensureDemo`'s documented contract is "seed before the initial replica clone", the lane violated it, and a suite whose fixture lands after the clone is broken whether or not something else is also broken. Keeping it costs one HTTP call per lane and removes a real confound from the next diagnosis — the next person can rule the corpus out by reading one line instead of re-deriving it. What is withdrawn is the claim that it fixes the tile taps.

The fix is one line of ordering. `tests/agent-e2e-mobile/seed-demo-corpus.mjs` seeds every app that ships a `packages/blueprints/apps/*/seed.js` — seven scenarios, 166 rows — and `android-emulator-install.sh` runs it before it hands off to Maestro, so both device lanes get it and the corpus precedes the first clone by construction. It is lane-wide rather than per-suite because a tile is a property of the vault, not of whichever flow ran first. The HTTP moves to `lib/demo-corpus.mjs` so the lane seeder and `ctx.ensureDemo` cannot disagree about the row-count guard that makes a second call free; the per-flow calls stay, because they document each journey's fixture and are what makes a flow runnable on its own.

`lint:e2e-wiring` gains RULE `corpus`, in two halves, because the two ways to get this wrong are different. (a) A flow may only tap `Open <App>` for an app that ships a scenario or is one the springboard promotes on an empty vault — `locker` is the sole exemption, and it is an exemption rather than an oversight because its tile body is a *state* rather than a query result. (b) The lane preamble must run the seeder, and must do it **before** `export MAESTRO_PLATFORM`: ordering it after the handoff restores the defect while looking like the fix, so the rule checks position, not presence. The app table is read from `packages/blueprints/apps/` rather than listed, on the linter's existing principle that a hand-kept list is the thing that drifts.

### F — a prerequisite that fails without saying how

The corpus fix landed exactly as designed — `seed-demo-corpus: 7 scenario(s) ready before first pairing`, ahead of the first `[runFlow]` line — and the lane was still red, because `pairing-canary` failed before any tile could be tapped. That is the fourth data point on one chunk:

| head | corpus | `pairing-canary` |
| --- | --- | --- |
| `42c66389` | empty | **FAIL** 73s |
| `36bad90e` | empty | PASS 183s |
| `277e054c` | empty | PASS 174s |
| `f221b862` | seeded | **FAIL** 125s |

Failing under both corpus states rules out the seeding as its cause, which is worth stating because the ordering invited the opposite conclusion: the failure arrived in the same push as the change, and reading it as a regression would have been the obvious mistake. Both durations are *shorter* than a pass, so neither is the flow running long; each is a wait inside `01-configure-gateway` expiring — a different one each time, 73s against the 45s first-launch wait and 125s against the 90s redemption wait.

Neither could be diagnosed, and that is the defect this section fixes. The chunk runs `sensitive: true`, which kept its capability out of the log by keeping *everything* out of it: `stdio: "ignore"`, and the `maestro-debug` directory deleted before upload. Two failures of the PR gate's short-circuiting prerequisite — the one whose failure takes the other four journeys with it — reported `maestro sensitive flow exited 1` and nothing else, twice.

The output is now captured and, **on failure only**, the redacted step lines are printed; a green run stays silent. The capability is no more printable than before, held by two independent controls so that neither one being wrong is enough: only lines in Maestro's step shape survive the filter (a directive name and a verb, never a value — `inputText` renders as the `${MAESTRO_*}` placeholder, which is literally what the retained YAML holds), and every secret is replaced by exact-string match regardless. `spawn-redaction.test.mjs` drives each control alone, including the case where a secret reaches a step line anyway.

This does not fix the flake. It makes the next occurrence name the directive it died on, which is the thing four runs could not say — the same trade as the `--stacktrace` under C, and the honest extent of what one more red run can buy without a diagnosis.

The spec sits beside the harness and is run by the `test-report-scripts` vitest project, whose `include` already carries `tests/agent-e2e-mobile/lib/**/*.test.mjs`.

**A wrong turn worth recording, because CI caught it and reasoning did not.** Grepping for what ran `sh-quote.test.mjs` — the spec next door — returned nothing, so this receipt briefly claimed it was an orphan that had never executed, and F's spec was written for `node --test` and added to `scripts:test` to avoid the same fate. Both halves were wrong. The directory is included by a config that names it only through a glob, so no grep for the filename could find it; `test:ratchet:unit` then failed with `No test suite found`, because that project had picked the file up and `node:test`'s `test()` is not vitest's. The spec is now vitest, matching its neighbour, and the `scripts:test` entry is removed so it is not run twice. The claim about the orphan is withdrawn: `sh-quote.test.mjs` runs, on that lane, with coverage.

### G — a shard that fails in silence

`coverage-shard (2)` went red on this branch, and its log ends:

```
blob report written to /home/runner/work/centraid/centraid/.vitest-reports/blob-2-4.json
error: script "coverage:shard" exited with code 1
```

That is the whole diagnosis. `--reporter=blob` writes the machine artifact and prints nothing a human reads, and the failure detail inside the blob is only ever rendered by the `coverage` merge job — which `needs:` the shards, so a red shard means nobody ever sees why. Four runners can spend six minutes each and produce one line naming no test.

`coverage:shard` now passes `--reporter=default` alongside `--reporter=blob`, the same shape B gave `test:suite`. The blob is still written (49 MB locally, and the merge lane's `assert-shard-blobs` guard is unaffected); a green shard gains a summary line; a red one names its file, its test and its assertion.

It paid immediately. Running shard 4 locally with the new reporter surfaced two named failures in `packages/server/src/acp/backends/acp/launch.test.ts` — `expected 'yes' to be '1'` on `plan.env.IS_SANDBOX`. That is **this container**, not the repo: `IS_SANDBOX=yes` is set in the agent sandbox and `planLaunch` reads ambient env, so the two cases that assert on its absence cannot hold here. Nothing is changed for it — it is a third local-environment finding, recorded beside the other two rather than "fixed".

The CI failure itself is NOT this PR's, and the check is deliberate rather than assumed: `coverageProjects` in `vitest.config.ts` does not include `scripts/test-report/vitest.config.ts`, so the only test file this branch adds is outside every shard — confirmed by grepping a local shard run for it (zero occurrences) rather than by reading the config alone. Shard 2 passes locally on this exact tree. No re-run was spent because this session has no tool that can re-run a job; that is stated in Out of scope rather than left as an unexplained omission.

### H — the launcher with no tiles

The product defect behind the red device gate, found by reading the grading path after E's ordering hypothesis was falsified. Two rules, each correct alone, each tested alone:

- `tileEarnsGrid` demotes an `unknown` tile — "rather than showing a body it cannot stand behind", and its test says exactly that.
- `springboardState` returns `content` when every tile is `unknown` — deliberately NOT `first-run`, because "we do not KNOW the vault is empty, so we do not say so".

Composed, they produce the one outcome neither intends. With no replica session every tile reads `unknown` (`replicaQueryConnection` returns `unavailable` before it considers rows at all, and `combineStatus` maps that to `unknown`), so `springboardState` routes to the grid — and `Home.tsx`'s membership filter then demotes every tile, rendering that grid **empty**. The member is not told the vault is empty and has no way into any app. Offline, that is the whole product.

Nothing tested it because nothing could: the membership loop lived inline in `Home.tsx`, there is no `Home` screen test, and both halves pass their own unit tests. So the rule moves to `springboard-policy.ts` — the module whose header already claims "which earned the grid" as its law and whose stated reason for staying pure is that its decisions are "testable without a renderer" — as `gridMembership`, beside a new `everyTileUnreadable`. `Home.tsx` now decides nothing about membership.

The tests land in a new `springboard-policy.test.ts`. They had gone into `tile-model.test.ts`, which then crossed the 625-line god-file ceiling — and the policy module had no test file of its own, which is part of how this stayed invisible. The split follows the precedent #890 set when the wiring linter's fixtures moved to a sibling module for the same reason.

Verified in both directions: with the pre-fix rule restored, two of the four new cases fail (`keeps every app when nothing is readable`, `populates the grid in exactly the state springboardState routes there`); with the fix, 24 pass in that file and 170 across `screens/home`.

**What this does not claim.** It does not establish that an absent replica session is why CI's tiles are missing — the two states that produce no tiles (`unknown` everywhere, or `empty` everywhere routing to DayOne) are indistinguishable from the Maestro log, and the run artifact that would settle it is on a host this container cannot reach. What is established is that ONE of those two states is a genuine shipped defect, independent of CI: a phone whose replica has not mounted shows a home screen it cannot act on. If the device gate is red for the other reason, this fix is still correct and the gate will say so next run.

**One approved deviation, with its arithmetic.** `apps/mobile/src/screens/home/tile-model.test.ts` is hand-re-pinned from `[1525, 14787]` to `[1391, 11523]` — 10.31% to 12.07%. Its comment content did not grow; it SHRANK. The file lost 134 comment characters and 3264 total characters when the policy describes moved out, so it shed proportionally more code than prose and the share rose on a smaller denominator. Same shape as the two pins #892 re-pinned for the same reason, and the reason is stated here rather than laundered through `--write`, which refuses to raise a pin precisely so this has to be argued.

### I — the shell↔app contract had no source of truth

Investigating A and B opened a third question one level up, folded into the issue as Part 2: the mobile device lanes report verdicts that are *earned but nearly empty*. `mobile-device-gate` runs 5 of 22 flows; the mini-app journeys live on `mobile-canary`, which has never been green in any of its four runs. "The PR gate is minimal, depth lives on the canary" is therefore circular — the second half was never delivered.

The Part 2 plan's own sequencing puts "get `mobile-canary` green" first and the manifest-driven conformance sweep third, and item 3 is what this branch delivers, at the layer the plan's layer-allocation table assigns it to: **the shell↔app contract belongs in RNTL against the real registry, not on a device.**

**The defect the manifest names.** Four tables in three trees have to agree before a launcher tile can reach a screen — `packages/design/src/apps.ts` (who exists), `apps/mobile/src/screens/home/catalog.ts` (the route per id), `Home.tsx`'s `openItem` switch (what a tap does), `apps/mobile/src/deep-links.ts` (what `centraid://<app>` opens). Nothing linked them. Each can move alone and stay green, and the worst case is silent: `buildLauncherItems` resolves an id's route with `route ? [{ meta, route }] : []`, so an app the catalog forgets is DROPPED without an error — the launcher renders seven tiles where eight are registered, and every test deriving its expectation from the catalog (including H's, above) agrees with the defect.

`apps/mobile/app-conformance.json` is the fifth table that pins the other four. `scripts/lint-app-conformance.mjs` holds them against it under six rules — `registry-complete` (manifest ids and registry ids are exact complements, both ways), `route-registered`, `navigates`, `deep-link-routed`, `handles-declared`, `seed-declared` — and refuses to pass when any parser comes back empty, because a table reformatted out from under a text-scanning linter is exactly how one rots into always-passing. Its rules self-test on inline fixtures before it reads the tree; that self-test caught a miscounted expectation in its own first draft.

**Why this settles "shouldn't we treat all mini apps equally".** Hand-writing a journey per app is O(apps) to author *and* O(apps) to run, and app #9 arrives untested until somebody remembers it. Making conformance a property of the manifest inverts both: `Home.test.tsx` now runs `describe.each` over the manifest — every registered app has a tile under its declared handle, and pressing that tile navigates to its declared cover — so a new app is swept the day it registers, with no per-app authoring, and `registry-complete` is what stops a row being omitted to dodge the sweep. Photos keeps its extra hand-written flows, but on a stated principle rather than on taste: it is not special as a product, it is the app with the largest **native/OS** surface, and its extra coverage is proportional to that surface alone.

**What this does not claim.** It matches text and mounts a composition; it does not prove a screen renders from a real replica on a real device. That claim is the device half of Part 2 item 3, deliberately not taken here — see "Out of scope".

### J — `Element not found` never said what WAS found

Reading run 33418649297 turned up two things worth recording. The first is a correction: `mobile-device-gate` fails on **three** of the critical five, not on `photos-permissions` alone as an earlier PR comment on this branch claimed. The suite does not short-circuit past the canary, so all five verdicts were in the log the whole time — `notes-library` (`Tap on "Open Notes.*"`), `native-v0-resilience` (`Tap on "Open Photos.*"`) and `photos-permissions` (`id: photos-collections`), against `pairing-canary` and `cold-start` green, at 479s of the 720s budget.

The second is that E's fix is necessary and not sufficient. `seed-demo-corpus.mjs` ran and seeded all seven scenarios before `pairing-canary` paired — the log lines are in the job — pairing then passed, and `notes-library` still reported `notes demo already present (16 rows)` with no Notes tile on the grid. So the corpus precedes the clone, and rows are still not reaching the paired replica. That is downstream of anything this branch touches; `seed.js` writes through `ctx.vault.invoke` on the ordinary command path, so it is not a ledger-bypassing seed.

**Why that took a day's reading to establish, and what fixes it.** Maestro's `Element not found` names the selector that missed and *nothing about what was on the screen instead*. For the two tap failures that is precisely the fact in question: Home renders `DayOne` instead of `LauncherGrid` when `springboardState` sees every tile settled and empty, and `HOME_READY_MARKER` renders in **both** branches — so the assertion before the tap passes either way and the log cannot tell them apart. The hierarchy that would settle it is written per step into `maestro-debug/`, uploaded, and unreadable to anyone who cannot download the artifact.

`lib/hierarchy-digest.mjs` turns that artifact into log output: on the failure path only, the newest hierarchy is reduced to the handles and short labels the screen carried and printed under the failure. `day-one` present with no `home-tile-*` is the first-run branch; `home-tile-*` present is a different bug. It is pure — a tree in, strings out — so the shapes it must survive (bare arrays, flat nodes, null children, 50k-deep nesting, unparseable JSON) are covered by unit tests rather than by a 28-minute lane, and it never throws, because a diagnostic that fails on the failure path replaces the real error with its own.

**The first attempt read the artifact directory, and the run said no.** It looked for a hierarchy file under `maestro-debug/<chunk>/`; run 33465058064 reported, on all three failures, `no hierarchy in 02-reading-room; it holds: commands-(02-reading-room.yaml).json, maestro.log, screenshot-❌-….png`. Under `--flatten-debug-output` Maestro writes no hierarchy at all. The refusal-to-no-op paid for itself on its first run — a version that printed nothing would have looked like a screen with no handles, and the next reader would have been debugging the digest instead of the app. The capture now comes from the DEVICE (`maestro hierarchy`) on the failure path, which is strictly better: Maestro has exited but the app is still foregrounded on the failing screen, so it is the screen the assertion actually missed on rather than a file written before it.

**The sensitive path stays silent.** A sensitive chunk's hierarchy is discarded precisely because it may hold a live enrollment capability, so the digest is gated on `!sensitive` and additionally refuses any label containing `configure-gateway` — belt-and-braces against the same chunk ever being run non-sensitive, and matching the workflow's own pre-upload scrub. And when no hierarchy matches, it prints what the directory *does* hold rather than nothing: Maestro's debug filenames are its own, and a digest that quietly stopped digesting is the silent no-op this repo treats as a failure.

### Docs

`docs/decisions.md` gains **G-filter-escape-hatch** beside the existing G-filter-inverse. `TESTING.md`'s path-filter row records both the narrowed `client-e2e` gate and the new fallback requirement.

### O — a phone that was not on Wi-Fi never pulled a row, and said nothing

Section N stopped Home *claiming* an unsynced vault was empty. It did not answer why the vault never arrived. The device preparation added in N answered it on the first run that carried it — `mobile-device-gate` printed, next in the log to the failure it explains:

```
ni{MOBILE[HSPA] CONNECTED extra: epc.tmobile.com}
nc{[ Transports: CELLULAR Capabilities: ... NOT_ROAMING ... ]}
```

The emulator's only network is a simulated cellular radio. `nativeSyncAllowed` is literally `nativeUploadPolicy().canTransfer()`, `DEFAULT_TRANSFER_POLICY` is `wifiOnly: true`, and `canTransfer` returns false at `rules.wifiOnly && network.type !== WIFI`. `MultiVaultReplicaSession.pullScopes` therefore returned `{pulled: [], stalled: […], policyBlocked: true}` **before asking a single scope**. The phone paired, drew Home, and pulled nothing — no error, no stamp, nowhere to look.

**This is a product defect, not a lane defect, and the fix is in the product.** The lane could have been made green by relaxing `wifiOnly` in the test image, which would have tested a device no member has. Every member whose phone is not on Wi-Fi — the ordinary case for a phone — got the same silence: no rows, ever, until they reached Wi-Fi. The transfer table exists to keep photo bytes off a data plan; a replica delta is metadata, and [blueprint-seats.md](../docs/blueprint-seats.md) already promises record-only apps "offline reads and queued writes for free", which cannot be true while reads are gated on the byte rules.

The split is between **reads** and **byte work**. Reads — first-open bootstrap, `bootstrapWhenReachable`, `pullNow`, `pullScopes` — now obey only `never`. Blobs, the write drain (`flushIntents`), placements (`flushPlacements`) and the unprompted background pass keep the whole table. `never` still stops reads because it is the floor (#712): a control that read "never" while the phone kept talking is exactly the lying switch that table exists to prevent, and that switch's own label — "Never move bytes off this device" — is the one rule a member could not have meant narrowly.

`isRowSyncAllowed` defaults to `isNetworkWorkAllowed` rather than to `true`, so the behaviour changes at the one wiring site that means it. That is why the three existing `multi-vault-session` tests that pass only `isNetworkWorkAllowed: false` still expect `policyBlocked: true` and still pass: they pin the floor, which has not moved.

Proven to bite. With `nativeRowSyncAllowed` reverted to `canTransfer()`, two of the new unit tests red by name — `pulls rows on a radio the byte rules refuse` and `ignores metered, roaming and charger rules alike`. The device-lane half is **not** yet evidence: the run that produced the transport reading failed earlier, so no flow on this branch has observed a synced vault on device.

**What this section does not claim.** `mobile-device-gate` is not green. Run 33476501179 red-lined at `Assert that "Connect your gateway." is visible` after 45s — the first-launch cost section K already names, recurring because a JS change misses the apk cache and puts a 17-minute gradle build immediately before the flows. That is a third defect, separate from N and from O, and it is not fixed here.

### P — the phone drew an empty library over a vault holding rows, and nothing on either side said why

Run 33480643429, on the head carrying O, is the first on this branch to get past the wall. `pairing-canary` passed in 180s and `mobile-cold-start` passed 8/8 launches — both had died at `id: home-grid`. `notes-library`, `native-v0-resilience` and `photos-permissions` reached their apps. The transfer-policy block is gone from the device, and the hierarchy digests say so directly: the failing screens carry `Recent items ready; older history syncing` — `replicaCoverageRow`'s partial-coverage row — and carry neither `Sync paused by transfer rules`, which is what `policyBlocked` drew before, nor `Gateway asleep`.

What they also carry is `Write the first one.` Notes rendered its empty state while the gateway held sixteen demo rows, and every other app was empty the same way. `[pr-gate] aggregate 536s / 720s budget`.

**Ruled out, against a real gateway rather than by reading.** `tests/integration-mobile` boots the shipped host and a real native replica session; a scratch suite there (not committed — it proved a negative) seeded the demo corpus through the same `POST /centraid/_vault/demo/notes` the lane uses, **before** the phone existed, then opened a seat and read back through the mounted `MultiVaultReplicaReader` + `MultiVaultReplicaSession` facade the app actually mounts. Five `knowledge.note` rows, `coverage: complete`, `pullScopes` reporting the scope pulled. Unfocused (`focusedVaultId: () => undefined`) it reads the same five. So neither the seed-before-clone ordering, nor the multi-vault facade, nor the mounted reader is the defect — the whole stack is sound over loopback with an owner bearer. What the tier cannot reach is the axis the device is alone on: a paired enrollment over Iroh.

**Why this section adds instruments rather than a fix.** Three cycles of inference have now been spent on a question the evidence cannot settle, because neither end speaks. The device is mute — `apps/mobile/src/kit/replica` and `apps/mobile/src/lib/replica` contain no `console` call at all, by design — and the release artifact carries no debugger. The gateway is mute too. So a bootstrap that was never requested and one that was answered with an empty page are, from CI, the same picture.

`ci-gateway.mjs` now traces the replica surface — method, path, status, `content-length`, duration — for `/centraid/_vault/{replica,changes,scopes,demo}` only, and the workflow tails that log on failure. Size is the point as much as status: a `200` proves the phone asked and the gateway answered, never that the answer carried a row. The enrollment surface is deliberately not traced; a pairing ticket is a live capability and this log is printed into CI output.

Beside it, `printReplicaDigest` prints the app's own logcat tail on a failing flow, next to the existing screen digest and under the same two rules — swallow everything, never for a sensitive chunk. It will not explain the empty library, since the replica path logs nothing to find; it will explain `native-v0-resilience`, whose Docs screen reached the error boundary with `undefined is not a function`, a fault that reaches logcat whatever the bundle chooses to log.

Both are host-side, and that is deliberate. `apps/mobile/scripts/js-bundle-fingerprint.mjs` hashes `apps/mobile/src`, the four workspace packages and `bun.lock`; `tests/agent-e2e-mobile/**` is in none of them. A diagnostic written into the app would have cost a sixteen-minute cold gradle build to ask one question — this one costs nothing, and the apk cache still hits.

**What this section does not claim.** Nothing here fixes anything. The gate is red, three of the critical five fail, and `photos-permissions` is a fourth thing again: its panel reads `Photos has not asked for your camera roll yet` while the flow asserts `Photos cannot reach your camera roll`, because the `Don.t allow` runFlow was SKIPPED — the permission dialog never appeared, so the device is in the never-asked state, not the denied one the flow is written against.

#### The first run of the trace, and a hypothesis it killed

Run 33485209085 answered a different question than the one it was built for, and the answer was worth more.

`mobile-device-gate` failed at `pairing-canary` / `01-configure-gateway` — `Assert that "Connect your gateway." is visible`, the FIRST assertion in the journey — on a run that hit the apk cache and ran **no gradle build at all**: `Android cache hit - installing … (js eb31c65863509593, skipping gradle)`. Emulator booted 08:08:37, app installed 08:09:11, warm-up done 08:09:52, first flow 08:10:18, failed 08:11:27. The four journeys after it did not run; aggregate 69s.

**This kills the cold-build starvation hypothesis outright**, and it is recorded here because this receipt carried it as live reasoning across two sections. The four data points on this branch are:

| head | apk cache | gradle build | `pairing-canary` |
| --- | --- | --- | --- |
| `3ed6c76c` | hit | none | PASS |
| `7feb4bd7` | miss | ~17 min | FAIL at 45s |
| `87473b00` | miss | ~16 min | PASS at 180s |
| `294ffc59` | hit | none | FAIL at 69s |

Two passes and two failures, one of each on both paths: the build is uncorrelated. If anything the sign is inverted from the guess — the run with the longest build passed, having left the emulator idle for sixteen minutes before its first cold launch. The honest reading is that the first cold launch after `clearState: true` is **nondeterministic on this emulator**, and the same binary (`js eb31c65863509593` on both the last two runs) both passes and fails it.

**What the trace itself proved.** It works, and it is already load-bearing: the log carried every lane-side seed (`POST /centraid/_vault/demo/notes -> 200`), which is how the ordering above is confirmed rather than assumed. It also showed a flaw in its own first draft — `content-length` is not set on these responses, so every line read `?B`, the one field the trace exists for. Now counted at `write`/`end`. And it recorded no `/centraid/_vault/replica/bootstrap` line, which here means only that the phone never got past onboarding — not that it would not have asked.

**The split, and why it is a tightening rather than a loosening.** `01-configure-gateway` bundled two unlike things: a cold launch and two taps on an empty onboarding screen, then the ticket's entry and redemption. The whole chunk was `sensitive: true`, so the assertion that fails most often on this lane was the one assertion that may not say what it saw — and the pairing ticket was handed, through `maestroEnv`, to steps that never use it. It is now two chunks. `open-onboarding` carries no capability in its environment and none on its screen, and so earns the screen and logcat digests. `configure-gateway` begins at the ticket field, keeps `sensitive: true`, and keeps its name so the workflow's pre-upload scrub goes on matching it. The sensitive window got smaller, not larger; nothing that was protected stops being protected.

#### The attempt that was never made twice

The trace was built to separate two possibilities — a clone that never arrived from a read that cannot see one — and reading the code that fires the clone answered it without needing the run.

A phone can mount believing it is offline. `resolveIdentity` probes the gateway base **once** and carries the answer as a boolean; a cold launch whose first probe misses mounts a session whose `isConnected()` is false while the socket underneath it is fine. `NativeReplicaSession.start()` then skips the bootstrap, which is right — an offline mount fails open on disk rather than hanging.

The defect is what came next. Every trigger that could bootstrap it afterwards fires exactly once per event: a reachability wake, a foreground transition, a rebootstrap demand. None is a schedule, and `scheduleRetry()` — the only retry in the file — arms a timer that flushes **intents**. So the first attempt after the wake was the only one that would ever be made, and when it was refused the rejection went nowhere: `#bootstrapPromise` cleared in a `finally`, no cursor, no status row, no log, and on three of the four call sites an unhandled rejection besides.

That is the whole reported symptom. The library draws its empty state over a vault holding rows; coverage reports `partial`; reachability settles rather than stalling, because a cursorless `pullNow()` returns on `!#hasCursor` before it dials, so `pullScopes` reports neither a block nor a stall. Every one of those is what a genuinely empty vault looks like too, which is why it survived on device and why the device stayed mute.

`bootstrapWhenReachable()` now arms its own retry on refusal, on a backoff **separate from the outbox's** — sharing one slot would let a parked drain swallow the rebootstrap a member is waiting on — and the wakes reset it, since each attempts the work immediately anyway.

**Reproduced before it was fixed, which is the part that had been missing.** `tests/integration-mobile/bootstrap-recovery.integration.test.ts` mounts a real session against a real gateway with its connectivity oracle saying offline, writes a row it has never seen, wakes it onto a transport that is still refusing — a real socket on a dead loopback port, not a flag — and then restores the transport and touches nothing further. Without the fix it fails in fifteen seconds, raising the swallowed rejection as an unhandled error; with it the row lands. Its negative half hands a second seat the same wake on a live transport, so "the rows arrived" cannot be a retry rescuing a vault that was never reachable. This tier could always have caught it: `openSeat` defaulted `isConnected` to `true` and so never produced a mount that believed otherwise.

#### The phone never asked

Run 33489359040 carried the retry above, and its gateway trace answered the question the trace was built for — against the section before this one.

`pairing-canary` passed and `cold-start` passed; `notes-library`, `native-v0-resilience` and `photos-permissions` failed as before. The trace is the whole gateway log, sixty lines, not a tail of one: the harness's own `/centraid/_vault/demo` seeding, one `device plane: enrolled … as owner You`, and **no replica, changes or scopes request at all**. Not a refused one, not an empty one. Across five flows and twenty-eight minutes the phone paired and then never spoke to the gateway again.

That is the first prong of the four-way fork, and it retires the other three: no 403 on the Iroh axis, no page scoped down to the device credential, no read losing rows it was handed. It also bounds the retry above. `bootstrapWhenReachable()` returns at `!#isConnected()` before it dials, so where no attempt is ever made there is no refusal to retry — the fix is sound and reproduced, and it is a later link than the one that breaks here. The screen digest agrees: `"Recent items ready; older history syncing"` beside `"Write the first one."` is partial coverage read off disk by a session that never asked for a page.

What decides it is `connected` in `ReplicaProvider`, set only where `resolveGatewayBase()` returns a base. In this lane that base can only come from the tunnel — #603 removed the manual-URL bypass, so the phone reaches the gateway through the ticket's Iroh endpoint and has no second address to fall back to. Two ways to fail it survive the evidence, and the log cannot separate them: a start that throws, or a status that reports `running` on a port belonging to the process that pairing ran in. Requests that die at a dead port never reach the gateway, so both leave exactly the trace above.

Both were also silent, which is the reason five runs did not narrow it. `resolveGatewayBase()` rejected on a failed start rather than falling through, so the fallback below it was unreachable **and** the reason was discarded by the `.catch(() => undefined)` at every call site. It now falls through as a timeout does and says what failed. Beside it, the reachability pass names its own verdict — `device=… base=…`, then whether the scopes pull landed — because a phone that never asks and a vault with nothing in it are otherwise the same phone.

The logcat digest had been unable to carry any of that. Its filter kept lines matching `centraid` and a word like `Error`, and Maestro's accessibility walk logs one line per skipped node carrying `packageName: dev.centraid.mobile` and `error: null` — so the driver satisfied both filters and, at forty lines of tail, pushed out everything the app said. This run's `notes-library` digest was one hundred percent driver chatter, which is why it named no cause. The driver's own tag is now dropped before either filter runs.

#### What the digest said once it could speak

Run 33494669948 carried the digest fix, and the app's own log came through for the first time: four real lines per failing flow instead of forty of Maestro's. It named a cause immediately, and it was not the one the section above was chasing.

`native-v0-resilience` dies on the Docs cover with `TypeError: undefined is not a function`, thrown in `AllShelf`'s **own** frame — the innermost entry of the component stack, before a single child renders. The one call in that frame that can be undefined is `liveAxes(rows)` → `liveOptions` → `sharedWithLabels`, which ended at `[...labels].toSorted(...)`. Hermes ships no ES2023 change-array-by-copy, so on the phone that property is `undefined` and calling it throws. Node has it, which is why 2337 unit tests pass over code that cannot render on a device.

The repository already knew. `oxlint.config.ts` bans `toSorted` under `no-restricted-properties` and says why in its own comment — it "caused the native Photos cover to redbox in the exact-HEAD journey". The ban was never wrong; its `files` glob was `apps/mobile/src/**` and `packages/core/src/time/**`, and every one of these call sites is in `packages/blueprints/**`. `toReversed` was not on the banned list at all, which is how one slipped through inside the guarded tree.

Scope is the modules the phone actually loads, not the package. Walking every import edge out of `apps/mobile/src` reaches 112 `packages/*` modules — the pure logic and copy modules, never the app roots, the React components or the `queries/*` readers, which are the web and desktop seats' and are left alone. Twenty of the twenty-one substitutions are inside that reachable set; the twenty-first is the `toReversed` in the mobile tree.

Those substitutions are also why eight comment-density pins moved, and none of them for a word of prose. `.toSorted(` → `.sort(` deletes three characters of code per site, and the metric is comment share, so a pure code shrink raises it. Seven pins are hand-raised on that basis. The eighth, `multi-vault-session.ts`, is a gate standing against a gate: the replacement for `toReversed()` trips `unicorn/no-array-reverse`, which demands the method Hermes lacks, so the line carries the per-line suppression that `allow-no-unjustified-suppressions` requires be justified in full — the pattern this repository already chose at `sqlite-intent-store.ts` for `structuredClone`. Prose that was genuinely added — in `phone-link.ts`, `replica-mount.ts` and the provider test — was cut back instead of pinned.

None of this explains the silence. The Docs crash is downstream of a screen that opened; the replica path never runs at all, and the diagnostics added above printed nothing. That is now two separate gaps, and both are closed here rather than guessed at again.

The first is on the gateway. `TRACED` named four surfaces — `replica`, `changes`, `scopes`, `demo` — and the phone speaks about twenty. So "the phone never asked" and "the phone asked on `/status`, `/vaults` or `/grants` and only the data path is broken" produced an identical empty log, and they are different bugs. The whole vault plane traces now. The enrollment surfaces stay out of it and did not need excluding: `/centraid/_gateway/tunnel/pair` and `/_gateway/devices/ticket` are outside `_vault`, and the trace records method, path and status, never a header or a body.

The second is on the phone, and it is the one that matters. `ensureTunnelStarted()` has five exits — unpaired, no native module, a reused running port, a fresh start, a start that threw — and until now every one of them was indistinguishable from outside: a base or no base, never a reason. Each says which it took. Below it, `fetcher` is the single choke point for the whole data path, the native session included, and a request that dies on the device is the one thing no gateway trace can ever show; it is now named where it fails. Successes are deliberately left silent, because the widened trace above already carries them.

The digest keeps them. A failing request repeats until its retry ladder gives up, and forty copies would push out the one line that says why, so repeats now collapse on the message with the pid and timestamp dropped.

One more thing was wrong, and it is the reason none of this was ever caught in vitest. `ReplicaProvider.test.tsx` mocked `InteractionManager.runAfterInteractions` to fire synchronously, `getNetworkStateAsync` to `{ isConnected: false }`, and `resolveGatewayBase` to `undefined` — the device pinned offline on all three axes, with `fetcher` and `postPlacement` rejecting `offline` beneath them. A provider that never connects agrees with that suite perfectly. The network axis is a variable now, and two tests assert the other half: given a reachable gateway, the provider publishes its base and reports itself online. They pass, so the defect is not in that layer — which is a real narrowing, and it is also why `ensureTunnelStarted`, which has no test anywhere, is where the instrumentation went.

#### The socket that was listening somewhere else

Run 33502294546 carried the instrumentation above, and the phone answered in one read:

    [centraid] replica: tunnel started on port 46515 from stopped
    [centraid] replica: GET /centraid/_vault/replica/bootstrap?window=5000&priority=newest
      never left the phone — fetch failed:
      java.net.ConnectException: Failed to connect to /127.0.0.1:46515
    [centraid] replica: tunnel reused on port 46515

`TunnelProxy.start()` bound `ServerSocket(0, 64, InetAddress.getLoopbackAddress())`. Android answers `::1` there, and a socket bound to `::1` is not dual-stack — it refuses IPv4 connections. Every caller dials IPv4: `http://127.0.0.1:${port}` is the JS contract in `phone-link.ts`, the WebView origin, and what the module's own README documents. So the proxy bound a port, reported it truthfully, and refused every request made to it.

Two lines rule out the alternatives. The refusal came 60ms after the start, which is not a race — a `ServerSocket` is listening the moment its constructor returns, and the backlog accepts before `accept()` is ever called. And `tunnel reused on port 46515`, 1.5s later, proves the runtime still held that socket RUNNING on that exact port: nothing had stopped it. A bound IPv4 listener cannot refuse an IPv4 connection, so it was listening on an address the caller was not dialing.

This is why the phone looked paired and never asked. Pairing rides iroh straight from Kotlin and never touches the proxy, so `pairing-canary` passed, the gateway logged `device plane: enrolled c434f97eda… as owner You`, and one hundred percent of the phone's HTTP died a layer below it — invisible to the gateway by construction, which is what the widened trace above finally proved rather than assumed: it shows the seeder's `/demo` calls, the enrollment and the photos purge, and not one request from the device.

The other two implementations of the same proxy already pin the family: iOS binds `NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)`, and the Node reference binds `server.listen(port, "127.0.0.1")`. Android was the only one delegating to the JDK helper, and Android is the only one that failed. It binds the literal now.

Nothing could have caught it here. The Kotlin unit tests in `android/src/test` run on the desktop JVM, where the same call returns `127.0.0.1` — the same shape as the Hermes gap above, where Node has the method the phone lacks. Both now live in `docs/traps/device-only-runtime-gaps.md`, together with the `console.warn` finding: it does not reach logcat in the release build and `console.error` does, which is why the first round of diagnostics printed nothing at all.

The Kotlin edit moves the Android native fingerprint, so `native-fingerprints.json` is ratcheted with it: L1–L3 green, L4 only, android `d5f54e40…` → `209a3026…`, ios unmoved at `bd2490e7…`, module↔lock delta `present [CentraidNetworkStatus, CentraidOcr, CentraidStorage, CentraidTunnel]; missing [none]` — no module added and no podspec touched, so the lock is unchanged by construction. The APK cache key moves with it, which is the point: the cached artifact carries the broken bind.

A static guard against a regression to `getLoopbackAddress()` is not written — a JVM test cannot express it, and a lint for it is a separate scope. The invariant is stated at the bind site and in the trap.

#### The screen behind the socket

Run 33506614475 carried the IPv4 bind, and the `ConnectException` is gone — no request dies on the phone any more. The next layer failed instead, and only because the first one now works:

    Error: Exception in HostFunction: java.lang.IllegalArgumentException: URI is not absolute
      at expo.modules.kotlin.functions.SyncFunctionComponent.callUserImplementation
      at ReplicaCompatibilityGate / ReplicaProvider / ErrorBoundary

`CentraidStorageModule.replicaDirectory()` answers `absolutePath`, a bare filesystem path, and that is the right form for two of its three consumers: op-sqlite takes a `location`, and `directorySize` takes a path for `java.io.File`. The third is `expo-file-system`, whose `File` and `Directory` take URIs — its own constructor documents `file:///` — and which throws `URI is not absolute` from inside the native constructor when handed a scheme-less string. Ten call sites were passing the path straight in. `index()` in the offline content store is the one that reached a render: it builds the store root to resolve a cached image URI, so the ErrorBoundary caught the throw and drew "Try again" where Home should have been.

The conversion lives in `apps/mobile/modules/centraid-storage/index.ts` beside the path form rather than at each call site, because which form a consumer needs is a property of that consumer, and the two do not swap. The path consumers are untouched: `storePath`, `packPath`, `nativeDirectorySize`, op-sqlite's `location`, and the existence guards all still take the bare path.

This was invisible to vitest for a sharper reason than the two gaps above, and the fix is not only in the source. Both filesystem rigs — `apps/mobile/src/kit/fetch-gate/content-store.test.ts` and `apps/mobile/src/lib/replica/thumbnail-pack.test.ts` — carry a hand-written `FakeDirectory`/`FakeFile` that accepted a bare path and joined it happily. A double that accepts what the real thing rejects does not merely fail to catch the bug; it certifies it. Both fakes now throw `URI is not absolute` on a scheme-less location exactly as the native constructor does, and `apps/mobile/src/kit/replica/replica-mount.test.ts` keys its fake on the URI it is actually handed. Those three files are the regression test: revert the source and they fail.

`apps/mobile/src/kit/replica/ReplicaProvider.test.tsx`, `apps/mobile/src/lib/replica/background-sync.test.ts` and `apps/mobile/src/apps/photos/PhotosHome.test.tsx` mock the storage module wholesale, so each gained the new export; without it the module under test sees `undefined` where a directory belongs.

No comment-density pin was raised for any of this. Four rose on the first pass and every one was cut back rather than pinned — the reasoning that would have paid for them is in this section and in the trap, which is where it is useful to someone who was not here.

#### The dialog that was already supposed to be hidden

Run 33512726935 carried the URI fix and failed with **zero completed assertions** on the canary's first directive:

    13:37:52.803  Launch app "dev.centraid.mobile" with clear state... COMPLETED
    13:38:38.581  Assert that "Connect your gateway." is visible... FAILED

The screen digest says what was there instead — `id:alertTitle "Pixel Launcher isn't responding"`, `id:aerr_close`, `id:aerr_wait`. Those are AOSP `app_error.xml` handles: a system window with no app content, covering the app. Pairing was not failing; pairing was never reached, and the gateway trace agrees — it holds the seeder's seven `POST /centraid/_vault/demo/*` calls and not one phone-originated request. The app's own logcat in the same digest is clean: both background tasks registered and `[centraid] replica: no tunnel — paired=false native=true`, the correct branch for an unpaired launch. None of the three device-runtime defects above recurred.

That dialog is the one `#535` already fixed, and line 195 of `apps/mobile/scripts/android-emulator-install.sh` has been setting `hide_error_dialogs 1` against it ever since. The setting was being written and was doing nothing. `system_server` does not read it per-ANR — it latches it into `mShowDialogs` in `updateShouldShowDialogsLocked()`, which runs only on a configuration change or at boot — and this lane restores a **cached AVD RAM snapshot**, so the latch was taken during a different run's boot with the setting at 0 and the restore brings that `false` back with it. The guard has been inert since the snapshot cache landed under C, and stayed green throughout because the launcher happened not to ANR. A night-mode round trip after the write forces the re-latch; the current value is read first and restored, so it is a net no-op with no app running to see either edge. `docs/traps/emulator-snapshot-settings.md` records the general shape, because the next `settings put global` on this lane will hit it too.

The launcher ANR'd now, and not before, because the warm-up added under K hands it back cold. `am force-stop` evicts our app after the twenty-second settle — logcat's `MainActivity EXITING` at 13:37:39.9 is that line — and resumes a Pixel Launcher that has been swapped out on a runner fresh off a gradle build and a full dexopt. It then sits unscheduled while the seeder saturates the CPU, and `pm clear`'s package broadcast, twelve seconds later, lands on a process that cannot answer inside the broadcast timeout. A HOME keyevent and a short settle draw and schedule it while the machine is still idle. That is device preparation of the same kind as the warm-up itself, not a retry.

The third change is a backstop, and it is the one worth arguing about. `tests/agent-e2e-mobile/lib/failure-class.mjs` defaults a zero-assertion failure to `product` on purpose — that is exactly the shape of a regression on a flow's first assertion, and forgiving it is how a suite learns to lie. This failure is the one case the default gets wrong: under a system window the assertion did not look at the product and disagree, it never reached the product at all, so `product` is a fabrication in the file's own sense. `id:aerr_*` is unforgeable — it is framework layout, never app copy — so the signal is added with the observed line as its `example`, as that file requires, and it is first because nothing looser should claim it. The digest was printed but discarded, so `tests/agent-e2e-mobile/lib/harness.mjs` now carries it on the error and hands it to `classifyFailure` as `stdout`; a sensitive chunk has no digest to carry, which is the pairing-capability control, not a gap. The retry this unlocks is the existing one — one clean-state attempt, both attempts' evidence kept. Nothing was loosened: no assertion, no budget, no member of the critical five, and not the `product`-by-default rule itself.

Neither the suppression nor the launcher settle can be verified off a device, which is the same asymmetry the trap above is about. They are best-effort by construction — every `adb` call here is `|| true`, and the read is guarded because the caller runs under `set -euo pipefail`. The classifier signal is the half that *is* pinned here, by `tests/agent-e2e-mobile/lib/failure-class.test.mjs`, which asserts every signal is the first match for its own example.

#### The route that never mounted

The fix under Q worked. `pairing-canary` passed in 203s on run 33518484505, `cold-start` passed all eight launches, no `id:aerr_*` appears anywhere, and the gateway trace finally carries phone-originated requests — `replica/bootstrap` at 10330B and again at 24273B, then `/changes`, `/scopes`, `POST /replica/checkpoint`, `POST /replica/intents`. The Notes library on the phone renders the seeded corpus by name. The three device-runtime fixes are confirmed end to end, and what the gate reports now are product defects rather than an environment that could not run.

`native-v0-resilience` failed on one of them. Tapping Tasks from Home drew `"Something went wrong" / "Unknown mobile icon name: Inbox" / "Try again"` — an error boundary where the list should be. `tasks-band.ts` has named `"Inbox"` for the third band destination and again as the More sheet's first row since it was written, `@centraid/design` shipped no such glyph, and `resolveIconName` throws by design so a missing name cannot silently become an unrelated mark. So the shipped route could not mount at all.

This was known and pinned. `TasksHome.test.tsx` carried a characterisation test asserting the throw, with its own instruction: DELETED, not adjusted, by whoever adds the glyph or the alias. The glyph is the right half of that choice — an alias would have to point somewhere, and inbox is where things arrive while archive is where they rest; at 18px the slotted lip is the whole distinction. The pin is replaced by its inverse, which asserts the route mounts *and* that the band drew its destinations, because a band rendering nothing would also not throw.

What let it ship for that long is the more useful finding. `tasks-band.test.ts` asserted `destination.icon.length > 0` — a name that is a string but not a glyph passes that and then throws in the renderer. Both icon assertions now resolve the name through `resolveIconName`. The check that was already there was the right check one predicate too weak.

#### The glob that was a guess about reachability

`08e50fcc` rewrote eight `toSorted`/`toReversed` call sites and left the lint alone, so the hole that let them ship was still open: `oxlint.config.ts` bans `toSorted` under `files: ["apps/mobile/src/**", "packages/core/src/time/**"]`, and every crashing site was in `packages/blueprints`. A glob cannot express "everything Metro bundles", so that glob was a guess about reachability — and the guess is what failed, not the ban.

Widening the glob is not the fix either. There are 121 `toSorted` and about 90 `toReversed` calls in this repo, nearly all in `packages/server` and `packages/vault` code that runs in Node, where these exist; a repo-wide ban would mean two hundred pointless rewrites and would still be a guess, just a larger one. So `scripts/lint-hermes-array-surface.mjs` derives the answer: a BFS from `apps/mobile/src` over the real import graph, following value imports and skipping type-only ones (erased before Metro sees them) and tests (they run in Node). It reads the TypeScript AST rather than matching text, so the method named in a comment — this paragraph's own file included — is not a violation. 793 modules are reachable today.

It found two more live crashes on its first run, both in `packages/client`, which no glob covered: `access-lens.ts:189` and `receipt-capture.ts:69`. That is the gate paying for itself before it was committed.

The second one is the reason `.sort()` is not a free substitution. `parsed.toReversed().find(…)` looks like the same shape as the other seven, but `parsed` is read twice more below — a bare `.reverse()` would have reordered the receipt's own lines as a side effect of looking for its total, trading a crash for a silent wrong answer. It became an explicit backward scan, which copies nothing, mutates nothing, and also satisfies `unicorn(no-array-reverse)` — a rule that otherwise demands the exact method Hermes lacks, and would have forced a suppression. The other site sorts a `.filter()` result, which is fresh, so `.sort()` is safe there.

The rest of that class is held by the type system rather than by review: these functions take `readonly` arrays, and TypeScript declares no `sort` on `ReadonlyArray`, so sorting a caller's array in place does not compile. `toSpliced` and `findLastIndex` join the oxlint list alongside `toReversed`, which was never on it — which is how one survived *inside* the guarded tree. That list stays the fast local signal; the walker is the gate, and its comment says so, so nobody widens the glob again believing that is where coverage comes from.

One comment-density pin is hand-raised, for no prose at all: `packages/client/src/access-lens.ts`, 14.42% → 14.43%. Its only change is `.toSorted(` → `.sort(`, which deletes three characters of code, and the metric is comment *share* — a shrinking denominator raises it with the numerator untouched. `08e50fcc` recorded seven of these on the same rewrite. Nothing was added to that file; the comment explaining the rewrite was cut rather than pinned, along with the three others this section's edits would have raised, and the reasoning is here instead. `--write` lowered 27 other pins on its own and refused this one, which is the gate working.

#### The three tiles under the fold

R's glyph worked on the device: run 33525449602 has `Assert that ".*Name it for Friday" is visible... COMPLETED` and the note `tasks: opened from Home`, where the run before it drew an error boundary. The tour then walked one surface further and failed on `Tap on "Open People.*"`.

Nothing is wrong with People. `SPRINGBOARD_ORDER` is photos, docs, notes, agenda, tasks, people, tally, locker, and the digest carried exactly the first five — the last three sit under the fold on a Pixel 6, and the flow re-launches the app before every surface, so Home is back at the top each time. `tapOn` does not scroll; a selector matching nothing on screen is an error, not a no-op. So the tour could never have reached its last four entries.

It had simply never been asked to. `05-tasks` has been the tour's last completed step for as long as the Tasks cover has been throwing, and before that the lane died in pairing — the People, Tally, Locker and Settings entries have not run in any recent lane, and this is the first run to get far enough to find out. That is what a prerequisite failure hides: not a regression, a step that was never exercised.

`scrollUntilVisible` is a no-op for a tile already on screen, so the first five are untouched, and `visibilityPercentage: 100` matches what the Settings entry below it already does for the same reason — Maestro will match an element the fold has clipped.

#### What the notes-library failure is NOT

Recorded because the run narrows it and the next round should not re-derive it. `04-quick-capture` still fails its `notes-row-first` assertion, and the digest shows the Notes library rendering exactly the five demo rows, with the band immediately after the fifth — so the list ended at five and the new note is not below the fold.

The row is not lost. `native-v0-resilience`, running after, drew Home with `"Open Notes, 6 notes"` — five seeded plus the one this flow wrote — so the write reached the replica and the tile counted it. `POST /replica/intents` returned 200 and the following `/changes` came back at 864B against the usual 464B, which is that note coming back down. Transport, persistence and the count are all correct.

So the defect is in the library's own read. `NotesHome.tsx` imports the pending overlay only to draw a `pendingChangeLabel` badge on a row it already has; nothing injects an unreplicated row into the list. That leaves the list dependent on `useReplicaQuery("notes", { entity: "knowledge.note" })` re-running, and the editor is pushed OVER the library rather than replacing it, so the list may never re-query on the pop back. That is the hypothesis to test first — it is not confirmed here, and no change was made for it.

### T — one phone, two branches

#911 and this branch were fixing the same device at the same time from opposite ends — that one redesigning Docs and hardening the replica transport under #903, this one chasing the device gate under #905 — and neither lane could see the other's half, so each was measuring a phone the other had already partly fixed. Folding #911 in here means one PR, one gate run, and one phone under test; #911 is closed onto this branch rather than merged separately.

The merge conflicted in six files, and the resolutions are the record of where the two branches had independently answered the same question:

- **Two `Inbox` glyphs.** Both branches added one to `packages/design/src/icons.ts` — the Tasks band has named `"Inbox"` since it was written, and both lanes found the same missing key. #911's is the fuller Lucide form and is the one kept; mine is deleted. Removing it lowered the file's non-comment character count, which mechanically *raised* its comment share past its pin, so a comment in that file was cut to match. That is the density ratchet behaving correctly: it measures a share, and deleting code is one of the two ways a share can rise.
- **Two answers about Hermes, and they disagree.** #911's `apps/mobile/polyfills/array-to-sorted.js` states that Static Hermes 250829098.0.16 ships `toReversed`, `toSpliced`, `with` and `findLast` but not `toSorted`, and polyfills that one method through Metro. This branch's `lint:hermes-surface` bans all five across everything the mobile bundle reaches. Both survive the merge unchanged, and the stricter one still passes over the merged tree — 805 modules reachable, no violation — so nothing had to be reconciled to go green. The disagreement is left standing rather than resolved by argument: the ban is the cheaper thing to be wrong about, and a polyfill plus a ban is not a contradiction.
- **Two log lines on the same replica fetch.** `replica-mount.ts` and `ReplicaProvider.tsx` each had #911 adding behaviour (a reply deadline; a `connected` computation) exactly where this branch had added a `console.error` saying why the phone went quiet. Both are kept in each: theirs is functional, mine is diagnostic, and taking either side alone would have dropped the other's fix.
- **One gate list, and a correction.** `package.json`'s `check:push` was rebuilt as the union of both parents. An earlier pass at this resolution took #911's side wholesale on the belief that #911 had deleted `lint:app-conformance` and `lint:e2e-claims`; it had not. Neither gate exists at the merge base `f5ca34fb` or on `docs-mobile-design` — both were added by earlier #905 work on this branch, and taking "theirs" was silently deleting two of my own gates. #911 deletes no gate; it adds `lint:list-anchoring`. The merged list is 60 gates and was checked against both parents for losses.
- **One flow, renamed.** #911 renamed `sharing-invite` to `sharing-reach` and missed two references: the Android roster script still named the old file, and `tests/matrix.json` had no continuity marker, so the minimum-tests check read the rename as a retirement. Both are repaired here rather than by loosening either check — `replacesMinimumTestsFlow` is the field that exists for exactly this, and `claim-pins.json` shrinks from 17 to 16, which the down-only rule permits.

Three ratchets moved as a consequence and none was hand-raised: `toHaveBeenCalled` tightened 783 → 778, `toBeTruthy` held at 378 after two of #911's and my own assertions were sharpened to `toBeInstanceOf` and a counted `toHaveLength`, and the ten comment-density pins that a bad `--theirs` resolution had inflated were reset to their measured values.

### U — three failures the merge produced and nothing before it could have

`b15d72ce` went in with a green local suite and CI came back red on `client-e2e / desktop-e2e` and `client-e2e / web-e2e`. Neither lane runs in `check:push`, so nothing local could have seen them; all three failures are the merge's own, in the sense that each needs both parents' code present to happen.

**The Household heading, and why "exact" was not enough.** `household.spec.ts` asked for `getByRole("heading", { name: "People", exact: true })` and got two nodes: `SharingCard`'s `<h3>People</h3>` and the census `<SectionBlock label="People">`'s `<h2>`, which sits further up the same page. Playwright's strict mode makes that an error rather than a first-match. #911 wrote the assertion, and its own comment says what it means — "the panel's two halves" — so the fix is to scope both halves to the panel (`ancestor::section[1]` off the "People & circles" heading), which asserts *more* than the page-wide query did: that the roster heading is inside the sharing panel and not merely somewhere on the page.

**The grant kit, which is a superseded ruling meeting a stale fixture.** Both web failures are the same: the sheet's Share button never enabled, and the click timed out after 120s. The cause is `cannotShare`'s new `reachBlocksSharing(reach)` term. Both fixtures answered `forParty` with `channel: null`, which `channelReach` reads as `never-reached`, which since #903 blocks sharing.

That is the product behaving correctly. [G-channel](../docs/decisions.md) records the supersession in as many words — "~~Share subsumes linking.~~ **Superseded 2026-09-01 by #903: linking IS the prerequisite**" — and L-write spells out this exact control: "the grant sheet's Share is inert against a person no link reaches, rather than posting a request the pack would refuse." The fixtures encoded #825's retired rule, and `people-grants`' own comment said so out loud: "the screen still offers sharing — the invitation is the grant's own step." So both fixtures move to a live binding, which is what each test's claim — a share actually posting — now presupposes.

The one claim genuinely lost is "not reached is an OPPORTUNITY, not an error", and it is the claim #903 retired; keeping it would be pinning a rule the repo has ruled against. Its replacement is not nothing: the shipped copy for that state was already corrected on #911's side (`reachNote` says "Link their account in People to share with them." and its comment explains that promising an invitation would name an act the sheet will not perform), and `GrantSheet.claims.test.tsx` pins every reach state at the unit tier, including that `unknown` must NOT block.

**None of this was reachable from a local gate**, which is the honest limit worth recording: `check:push` runs neither Playwright lane, so the merge's first real verdict was CI's. Both lanes now reproduce locally in this container — the web one needs the pinned headless-shell path pointed at the Chromium that is actually installed, and the desktop one needs `xvfb-run`, Electron having no display otherwise. That is environment, not repo, and it is written down in Verification so the next person does not conclude the lanes are unrunnable.

**The Hermes claim, corrected.** This branch's gate said Hermes ships no ES2023 change-array-by-copy at all. The branch's own evidence never supported that: the only device observation is `AllShelf`'s `[...labels].toSorted(...)` throwing, and the other four names were generalized from it by family resemblance. #903's polyfill header is the better-grounded claim — it names the engine build and the upstream PR still open for `toSorted` alone, and states that this build does ship `toReversed`, `toSpliced`, `with` and `findLast`. It cannot be settled in this container: `node_modules/hermes-compiler` ships `hermesc`, which compiles and has no VM, and no `libhermes` binary or Hermes source is present.

So the claim is corrected in both places that made it, and **the ban is narrowed to `toSorted` alone**. Decision 13 above is superseded by this paragraph twice over: it framed the two branches as holding an open disagreement, and they were not — one side had evidence for one method, the other had an assumption about five.

The first attempt at this correction fixed only the wording and kept all five names banned, on the argument that a needless ban is the cheap direction to be wrong in. That argument does not survive contact with what a gate is for. A gate that fails a build over a method the engine implements is not cautious, it is wrong, and it spends its credibility on a claim it cannot support — the next person who hits it has no way to tell which of the five names is the measured one, so they either work around all of them or trust none. `receipt-capture.ts`'s backward scan and `multi-vault-session.ts`'s in-place reverse both stay, because both are correct on their own merits: the first avoids a genuine aliasing hazard, the second reverses a freshly-filtered temporary and saves the copy `toReversed()` would allocate. Only the false reason for them is removed.

**Withdrawn claim, recorded because it is the kind that spreads.** "Hermes ships no ES2023 change-array-by-copy" appears earlier in this receipt as though it were an observation. It never was. The observation was one throw on one method, and the sentence generalized it to a family. Every downstream artefact — the lint's name, the oxlint list, a suppression justification in `multi-vault-session.ts` — inherited it without anyone re-checking, which is exactly how a plausible sentence outlives its evidence.

### V — a calendar bug and a spawn tax

Run 33539023776 is the first run in which the device gate got far enough to be *measured* rather than guessed at. `pairing-canary` PASSED in 209s — the first clean pairing on this branch — and the four behind it produced numbers instead of a prerequisite failure: `notes-library` 149s, `native-v0-resilience` 248s, `cold-start` 133s, `photos-permissions` unrun, aggregate 740s against a 720s budget.

**Tally's tile is empty for the first week of every month, and nothing is wrong.** The tour died scrolling for `"Open Tally.*"`, and the digest shows why: the grid had scrolled to the bottom (Locker was on screen below it) and Tally was not a grid tile at all. It was a FIRST MOVE — "Log a shared expense. Who owes whom, settled.", `FirstMoves.tsx`'s `${label}. ${hint}`. Home's tile counts expenses with `spent_on >= monthStart` and captions itself "spent this month" (`home-tile-reads.ts`); `seed.js` dates the demo expenses 4 and 6 days ago; CI ran on 1 September. So every seeded expense fell in August, the tile read `empty`, `tileEarnsGrid` demoted it, and Home offered the invitation instead. Zero spent this month was TRUE. The product was right and the flow was asserting one of two honest shapes.

Twenty rows had been seeded — `seed-demo-corpus: tally seeded (20 rows)` — which is what makes this worth writing down: the seed log said the data was there, and the tile was still correctly empty, because "seeded" and "spent this month" are different questions. A flow keyed on the grid tile is therefore red for roughly the first week of every month and green for the rest, which is the worst shape a gate can have.

The fix does not touch the tile, the seed or the calendar. Tally is opened through the all-apps sheet, whose `AppRow` labels every app `Open <name>, <count>` unconditionally, whatever the tile status — the same three hops the `settings` entry already takes. The first-move card was the other candidate and is worse: `FIRST_MOVE_LIMIT` is 3 and Tally sits 8th in leverage order, so three emptier apps would drop it from the band entirely.

**Nine seconds a spawn, ten times.** `pr-gate-budget.md` names combining adjacent Maestro chunks as the FIRST remedy for an overrun, and this run priced the overhead exactly: each `run :` line sits ~9s ahead of the first command in its chunk (`06-people` 17:53:34 → 17:53:43, `07-notes` 17:54:07 → 17:54:16, `08-tally` 17:54:37 → 17:54:46) — JVM start plus driver connect, buying nothing. The tour now emits one flow for all ten surfaces. Every `stopApp`/`launchApp` survives, because the relaunch is the resilience claim; only the spawn between them goes.

**`cold-start` is deliberately left on eight spawns.** It times each `ctx.run` with `performance.now()`, so combining would destroy the per-launch series the drift budget keys off — and would silently redefine what the recorded history means. Worth noting for whoever picks this up: those samples currently include the ~9s spawn in every measurement, so the recorded "cold start" is really "spawn + stop + launch + ready". That is a measurement question, not a budget one, and it is not touched here.

**What run 33544048980 then showed.** The tour passed end to end — `photos, docs, agenda, tasks, people, notes, tally, locker, settings` all opened and rendered their markers, Tally included — and `notes-library` PASSED in 154s, having failed the two runs before it. So the quick-capture defect narrowed in P and section S was a timing problem, not the missing pending-overlay row that was the standing hypothesis: the overlay machinery is correctly wired end to end (`notesPendingProjection` declares a `knowledge.note` upsert, `prepareReplicaWrite` resolves its `shapeId`, and `awaiting-change` is inside `OVERLAY_STATES`), and nothing in it was changed. That hypothesis is withdrawn, unproven either way; no device code was touched for it.

The tour combine paid for itself in the same run: the previous one spent 248s dying at surface eight of ten, this one spent 253s finishing all ten AND starting the airplane journey.

That journey then failed at the same calendar bug in a second place. It relaunches into Tally three more times, each with its own grid tap, and those had never executed before because nothing had ever got past the tour. All four sites now share one `OPEN_TALLY` constant, so the next person cannot fix three of them.

**Run 33548398202 ran all five journeys for the first time, and refuted the estimate above.** `pairing-canary` 173s PASS, `notes-library` 129s PASS, `native-v0-resilience` 250s, `mobile-cold-start` 133s **PASS**, `photos-permissions` 42s, aggregate **727s against 720s — seven seconds over**. The earlier arithmetic in this section guessed ~1000s and was wrong by a wide margin; it is left above as written, and this paragraph supersedes it.

Two things that looked like defects were not. `photos-permissions` did not fail on the permission dialog — the dialog was on screen, `id:grant_dialog` and `permission_deny_button` and all, and the chunk was killed after 42s by the deadline clamp mid-`Tap on (Optional) "^Open$"`. It is starved, not broken, and it has still never been allowed to finish. `mobile-cold-start` passed once it had budget, which is the same point from the other side.

The one real defect left is Tally's ledger act, and it is the fold again: `TallyGroupScreen.tsx` draws the hero, Settle up / Simplify and the whole MEMBERS list before the ledger Section whose act is "Add expense", so four demo members push it off a Pixel 6 — and the digest ends at "Remove. Chris" having never reached it. Scrolled now, exactly as the springboard tiles were.

**Run 33551084943 settles the budget question empirically.** Spawns fell 25 → 15 on the merges, `native-v0-resilience` reached the composer and typed into it, and the aggregate still read 741s. That is the pattern across four runs: every fix lets a journey get further, the later journeys get starved instead, and the total sits at 727–741s because the deadline clamp is what is holding it there. `cold-start` PASSED at 133s when it had budget and was killed at 62s when it did not, in consecutive runs, on identical code.

Priced from the four runs, the five journeys run to completion cost roughly: pairing 199s, notes 133s, native ~420s (345s reached the composer foot, with the commit, Waiting, restart and reconnect still to come), cold-start ~130s, photos-permissions ~120s — about **1000s against a 720s budget**. The ~90s the chunk merges recovered is real and is already in those numbers.

So the arithmetic is settled and the remaining gap is not a defect. `pr-gate-budget.md` forbids raising the number, dropping a member and weakening an assertion, and its remedy 1 is now spent; remedy 3 — move a claim down a tier — is a judgment about which claims earn a device, and it is deliberately not taken unilaterally here.

**Run 33559959847 got the composer all the way through and stopped one step later.** The foot scroll, the foot assertion, the extra scroll and the commit tap all COMPLETED, and then `tapOn: id: tally-band-contrib` found nothing — with the composer still on screen and NO refusal drawn. A refusal is what `verdict.ok === false` renders (`draft-model.ts` REFUSALS), so the commit was not refused; it was very likely never pressed. "Add expense" is the commit's label AND the screen's own title, and the only thing separating them was a `below:` anchor.

So the control now has a handle, `tally-add-commit`, the way `locker-gate-submit` already does. That is the repo's own rule applied to a control that had been exempt from it — "the band destination is taken by its KEY, not its label, because the label is copy the shelf table may re-word" — and it removes the ambiguity rather than working around it.

Two failures in that run were not this branch's: `notes-library` missed its capture row after waiting the full 30s having PASSED the three runs before it, and `cold-start` was killed before a single assertion and classified infrastructure by the harness itself. The capture-row timeout is left at 30s deliberately: raising it would buy green by waiting longer on a write that is genuinely sometimes slow, which is the measurement going soft rather than the defect being fixed.

**Where the airplane journey now stops, and what is known about it.** With `tally-add-commit` the tap lands on the control rather than possibly on the screen title: run 33564004616 shows `Tap on id: tally-add-commit ... COMPLETED`, and then the Waiting band tab is not found, with the composer still on screen. The composer sets `hideBand`, so the band cannot appear until `commit` resolves and calls `goBack()` — the journey is therefore stuck on the commit not taking effect, not on a missing tab.

The whole call chain was read and every link is sound, which is worth recording so the next person does not re-derive it: `surfaceWriteOutcome` returns TRUE for `queued`, so an offline write is a success; `refreshTally` cannot throw, because `openTally` and `loadTallyGroup` both catch internally; and `expenseVerdict` refusing would render `verdict.refusal`, which is not on screen. The one branch that refuses SILENTLY is `!allocation || !allocation.ok`, which returns `refuse(allocation?.line ?? "")` — an empty string renders nothing, so a member gets a control that declines without saying why. That is a real state-honesty defect in its own right whether or not it is what is happening here, and it is recorded rather than fixed: nothing observed proves it fired.

Settling it needs the run's screenshots and hierarchy dumps, and those are on `productionresultssa7.blob.core.windows.net`, which this container's egress policy refuses. So the step is left asserting its own arrival instead: the flow now waits for the group screen's own sentence after the commit, which makes the next run say whether the composer left at all rather than reporting a missing tab.

**The arrival assertion answered the question, and the answer points at the product.** Run 33567489343 fails on the new step — `Assert that "Every member computes themselves…" is visible` — so the composer never left after the commit, and the earlier reading ("a missing Waiting tab") is settled as wrong. The hierarchy at failure is the composer alone: no group screen, no status line, and the reconcile line and refusal both sit below the captured scroll position, so the dump cannot say whether either is drawn.

What that leaves is a claim, not a flow bug. `native-v0-resilience` exists to prove "AN OFFLINE WRITE RECONNECTS AND SYNCS" (`run-pr-gate-suite.mjs`, member 3). The composer draws the promise in its own words — "Lands in Tahoe Trip · queued on this device until the gateway answers", and that assertion PASSES — and then the commit does not complete and the screen does not leave. `surfaceWriteOutcome` returns true for `queued`, so a queued write is meant to navigate. If an offline `add-expense` cannot in fact be queued, the gate is red because the product is, and the flow is doing exactly what it was built to do.

**What the dump does and does not contain, which narrows it.** The failure hierarchy lists `id:tally-add-commit`, and that control sits BELOW the foot — so the digest carries below-fold nodes rather than only the visible window. The absence of a reconcile line and of any refusal sentence is therefore real, not an artefact of where the screen happened to be scrolled. Nothing was logged either: the only `ReactNativeJS` line anywhere near the commit is a tunnel notice, and `surfaceWriteFailure` would have spoken.

So: the button is still there, no refusal is drawn, no status is posted, no error is logged, and the screen does not leave. `commit` returning early at `!verdict.ok` would leave a refusal (every `refuse()` but one passes a non-empty string) and `issueTallyWrite` failing would log. The reading most consistent with all four observations is that `await session.write("tally", …)` never resolves while the radio is off — a write that hangs instead of queueing. That is a hypothesis and is labelled one; what is established is the four observations above.

**This is therefore NOT papered over in the flow, and should not be.** Loosening the step, dropping the offline half, or asserting something weaker would retire the one claim on this gate that covers offline writing. What it needs is either the run's artifacts — `productionresultssa7.blob.core.windows.net`, which this container's egress policy refuses — or a device, and then a fix in Tally's offline commit path rather than in the journey. The candidate identified above stands: `expenseVerdict` refusing through `!allocation || !allocation.ok` returns `refuse(allocation?.line ?? "")`, and an empty refusal renders nothing, so a member gets a control that declines in silence.

**The budget closed on its own, and the claim that it could not is withdrawn.** Run 33556574795 came in at **649s against 720s** — under, with all five journeys run. Everything above in this section that argued the five could not fit twelve minutes was extrapolation from runs whose later members were being starved, and it was wrong twice over: once at ~1000s before run 33544048980 measured 727s, and again after it. The chunk merges (25 spawns down to 15) plus journeys that stop burning time on doomed waits are what did it, which is precisely what `pr-gate-budget.md`'s remedy 1 predicted. No budget was raised, no member dropped, no assertion weakened, and remedy 3 was never needed.

What that headroom then exposed is the thing worth having: `photos-permissions` reached its own assertion for the first time in this branch's history, and it is a real defect in the flow. `permissions: { all: deny }` revokes through adb, and a permission the app has never REQUESTED is left "not requested" rather than denied — so `getPermissionsAsync` answers `undetermined`, `photoAccessState` correctly reports never-asked, and the panel truthfully says "Photos has not asked for your camera roll yet" while the flow waits for the refusal sentence. The journey now taps the panel's own ask control, lets the OS put up the real dialog, and refuses THAT. The assertion is untouched; what changed is that there is now a refused grant behind it.

`native-v0-resilience` failed this run at its second surface with the ANDROID LAUNCHER on screen — `id:launcher`, `id:hotseat`, Chrome and Gmail — meaning `launchApp` reported COMPLETED and the app was not running. The identical combined tour finished all ten surfaces on the run before, so that is a launch flake and not the tour. With the tour combined this recovers ~81s. The gap is larger than that: `native-v0-resilience`'s airplane journey — offline write, process kill, reconnect — never ran at all in this run, so 248s is not that flow's finished cost, and `photos-permissions` has not run on this branch at any point. `pr-gate-budget.md` lists three remedies; the first is done here, the second (failure classes) is already bounded by #892 Phase 0, and the third is the substantive one: **move a claim down a tier** into `tests/integration-mobile/`, which the doc calls "the correct first move, not the last resort". That is a decision about which claims earn a device, not a change that belongs in a commit fixing a scroll selector.

## User impact

**H, P's bootstrap retry, and R's Tasks route are what a member can see** — Tasks could not be opened at all on the phone, and the two `packages/client` sites would have thrown the same way in the access lens and in receipt capture. Everything else is CI wiring, lint rules and receipts.

**P's retry is the larger of the two.** A phone that mounted while its gateway was briefly unreachable, and whose first bootstrap after waking was refused, kept an empty library over a full vault for the rest of that launch — silently, since the refusal reached no status row and no log. Nothing the member could do from inside the app recovered it: pull-to-refresh dials nothing without a cursor, and only backgrounding and returning offered another attempt. It now retries on its own backoff, so the same interruption costs a delay rather than the library. Its own visible ceiling is unchanged: a phone that is genuinely offline still fails open on the replica it holds.

Before it, a phone whose replica session was absent drew Home's heading and **a single Locker tile** — the renderer test below pins the exact list as `['locker']`. `springboardState` deliberately returns `content` when every tile is `unknown` — "we do not KNOW the vault is empty, so we do not say so" — and Home's membership filter then demoted every tile for being unreadable, except Locker, whose body is a *state* rather than a query result and so earns the grid unconditionally. The member was not told the vault was empty *and* had no way into any of the other seven apps: the launcher is the only door on a shell with no tab bar. Now, when nothing is readable, every app keeps its tile.

**First-run: unchanged, deliberately.** A genuine day one settles every tile `empty` — a read that landed and returned no rows — and `everyTileUnreadable` tests for `unknown`, not `empty`. So the DayOne screen still wins exactly when it did before; the fix only takes the case where the tiles could not be *read* at all, which day one is not. Both halves are now asserted in `apps/mobile/src/screens/Home.test.tsx`.

**Evidence:** `artifacts/e2e/ui-impact/issue-905-mobile-paired-home.png`, published by `tests/agent-e2e-mobile/flows/pairing-canary.mjs`.

That frame is the canary's own `paired-home` screenshot, and the canary is the only flow that currently reaches Home — every journey behind it dies at its first tile tap. It is also the artifact that settles the open question in E: a populated grid means the launcher was rendering `unknown` tiles and H is the cause of the tile taps; a DayOne screen means every tile read `empty` and the cause is elsewhere. Publishing is not asserting, so the canary gains no second reason to go red, and a failed copy is noted and swallowed.

## Decisions

1. **The gate narrows to `web || desktop` rather than staying at `client` with the inputs fixed.** Fixing only the inputs would have left a caller that starts for `packages/server`-only PRs and runs nothing — the same empty shell, still reporting satisfied, just on a different trigger. The `client` filter itself is not deleted: `verify` is unfiltered and `boot-smoke` rides it, so the coverage `client` used to buy is already paid for elsewhere.
2. **The lint checks reads, not `if:`s.** Scoping it to `if:` would have reproduced the exact assumption that produced the bug. The rule is "a read of a filter output carries the fallback", and it does not care whether the read is in an `if:`, a `with:`, an `env:`, or something not yet written.
3. **Block scalars are folded, not banned.** The first draft refused any multi-line `if:` so the per-line scan stayed sound; `publish-report`'s folded `if:` — long for length, no filter output in it — failed immediately, which is the check inventing work rather than finding it. Joining the block is a dozen lines and refuses nothing that is fine.
4. **`desktop-e2e-macos` is left exactly as it is, and the earlier claim that it was a gap is withdrawn.** See "D" above. It is a ruling recorded in `ci.yml` and bounded by `lane-health.mjs`'s chronic-red rule, which has no lane allowlist. Changing it would have overturned a decision on the strength of a pattern ("every other path-gated lane is in `needs:`") without reading the paragraph that explains the exception.
5. **Two local-environment findings are recorded but produced no code change.** They cost most of the time spent and would cost the next reader the same. See Verification.
6. **Both defects ride one issue and one receipt.** They are separate bugs, and a second issue was briefly opened for B (#906, closed as a duplicate onto this one). Keeping them together is the deliberate call: they were found in the same dispatch run, they are the same failure shape — a lane in `check`'s needs reporting a verdict it had not earned — and splitting them would put two halves of one "is main actually green" answer in two places. The file slug still names A alone; the `## Checklist` is split A/B so neither is buried.
7. **B's producer set is derived, not listed.** The wiring assertion finds every script whose body contains `--outputFile=artifacts/test-results/vitest.json` and requires one per demanding job. Hard-coding `coverage`/`test:suite` would have to be edited by exactly the person who would forget the reporter.
8. **B's guard lives in `collection-tripwire.test.mjs`, not a new linter.** It is one assertion about one gate's wiring; a new `scripts/lint-*.mjs` plus a `package.json` entry plus a `static` step would be three files of ceremony. `scripts:test` already runs this file on the per-PR loop.
9. **The conformance manifest is JSON, and it lives under `apps/mobile/`.** Part 2's first open question asked where it could live so both RNTL and Maestro read one source of truth. A TS module serves the RNTL tier and neither of the others: `lint:app-conformance` runs from plain node on the per-PR loop, and the Maestro runners are `.mjs` with no transpile step. JSON is the only shape all three read as-is, and this repo already uses it for exactly this ("read by both a script and a test" — `tests/suite-wall-clock.json`, `roster.json`, `device-matrix.json`). It sits under `apps/mobile/` rather than `packages/design/` because the registry is cross-client and the routes, deep links and handles it pins are the mobile client's own.
10. **The sweep extends `Home.test.tsx` rather than opening a `conformance.test.tsx`.** A new file would have re-declared roughly 150 lines of `vi.mock` seam to make one more class of assertion, and the sweep is the same claim H already pins, generalized from "every app reaches the grid" to "every app's tile reaches its own cover". Its comments were then cut back three times to stay under the 15% density cap without an allowlist entry; the rationale they carried was moved to `scripts/lint-app-conformance.mjs`, where it belongs and where the gate does not measure it.
11. **`cold-start` stays on the PR gate, and Part 2 item 4 stays unstarted.** The plan argues on the merits that a `LAUNCHES = 8` perf-distribution probe with no absolute ceiling does not belong on a merge gate, and this branch is the one that watched it pass on `aeee58f4` and fail on `7288cd20` with no diff between them touching it. It is still not removed here. Removing it from a branch whose only red lane is the one it sits in would be weakening a gate to go green whatever the merits say, and the merits will still be there when the gate is reshaped as a whole.

12. **#911 is merged into this branch and closed, rather than merged to `main` on its own.** Both branches change the same phone, and both were red on the same lane; landing them separately means one of them merges onto a `main` that then invalidates the other's device evidence, and the second lane gets debugged twice. Merging costs one large conflict resolution, recorded above; not merging costs a second full device-gate cycle on a lane that takes an hour. #903's receipt travels with the merge, so neither issue loses its record.
13. **The Hermes disagreement between the two branches is left standing, not adjudicated.** See T. This branch's ban is broader than #911's polyfill header says it needs to be. Narrowing it to match would be deciding an empirical question about a device from a comment on the other side of a merge, and it would relax a gate to no benefit — nothing in the merged tree is blocked by the extra four names.

## Out of scope

- **Which of the two Hermes claims is actually right.** #911 says the engine ships four of the five change-array-by-copy methods; this branch's gate assumes none of them. Settling it needs a probe on the device, which is a flow, not a lint. Neither claim blocks anything today (T), so it is recorded rather than chased.
- **`:app:packageRelease`'s actual failure.** NOT fixed here, and not diagnosed. Gradle reported only `A failure occurred while executing PackageAndroidArtifact$IncrementalSplitterRunnable` with no cause, on a build with no `--stacktrace`. The canary built and packaged the same tree successfully at 08:37, so packaging is not systematically broken and a guess would be a guess. The `--stacktrace` added under C is what makes the next occurrence diagnosable; that is the honest extent of it. Whoever picks it up should start from the daemon's 2 GiB max heap and a fully cold 1414-task build on a shared runner.

  **It did not recur, and the reason narrows the search.** The branch dispatch (run 33374941598, 08:52) restored the apk cache on key `android-release-Linux-jdk6ea3257c17f4-fp…-js0601c949dd337c83` — 147 MB, a hit — so the installer took its warm path (`Android cache hit … skipping gradle`) and no gradle ran at all. Two things follow. The 34m55s failure was reached only through the cold path, which supports the cold-cache-window bullet below as its precondition rather than a coincidence; and it is not deterministic on this tree, so the `--stacktrace` may have to wait for the next cold miss to pay out. Neither observation is a diagnosis, and the bullet stands.
- **`mobile-device-gate` is still red, now for an unrelated reason in the product.** With the build skipped, the suite ran and `pairing-canary` failed at its first chunk `01-configure-gateway` after 73s with **0 completed assertions**, classified `product`; the four journeys behind that shared prerequisite never started. The chunk's own diagnostics are deliberately unreadable — it is a `sensitive: true` flow whose stdout is suppressed and whose `maestro-debug/*-configure-gateway` directory the `Remove sensitive pairing diagnostics` step deletes before upload, because it would otherwise ship a live enrollment capability. That control is correct and is not to be weakened to make this easier to read. The 73s is consistent with the flow's first `extendedWaitUntil` (`FIRST_LAUNCH_TIMEOUT_MS`, 45s on a release build) plus install and `clearState`, i.e. the app never reached "Connect your gateway." — consistent, not established, because the verdict could not be read from here (the artifact host is off this container's egress allowlist).
- **`coverage-shard (2)`'s own red.** Judged infra or flake: the shard is outside this branch's reach (see G), it passes locally, and all four shards were green on an earlier head of this same PR. It could not be confirmed by the one re-run the rules allow, because no tool in this session can re-run a job — so the honest position is "not reproduced, not explained", and G is what makes the next occurrence explain itself.
- **`IS_SANDBOX` leaking into `launch.test.ts`.** Two cases in `packages/server/src/acp/backends/acp/launch.test.ts` assert on `plan.env.IS_SANDBOX` being unset or forced, and `planLaunch` reads ambient env — so they fail in any environment that exports it, as this agent sandbox does. Hermetic-ising them is a `packages/server` change with its own blast radius and no bearing on this issue.
- **The `01-configure-gateway` flake itself.** F makes the next failure name its directive; it does not make the chunk stable. Two failures in four runs on the PR gate's short-circuiting prerequisite is a real reliability problem, and the two expiries were different waits, so there is probably more than one cause. Diagnosing it needs the step lines F now emits.
- **`verify` has almost no headroom against its 30-minute cap, and tipped over once.** Observed, not fixed, and this receipt should not pretend it is unrelated to B. Job durations for the lane: 27m35s when the suite last ran to completion green, and 30m17s on `914555a3`, where `timeout-minutes: 30` cancelled `test:suite` at 20m22s with the preamble having already spent ~10m. Roughly 8% headroom, so ordinary runner variance decides it — `test:qualities` alone moved 1m04s → 2m13s between two runs of the same tree.

  B's reporter is a contributor: `test:suite` now serializes a JSON report for 18k tests that it did not write before. That is very likely seconds rather than minutes, and the lane already measured 27m before this branch existed, so the cap was being approached without it — but "small" is not "none", and the honest statement is that this change spends part of a budget that had none to spare.

  **The cap is deliberately not raised.** Raising a bound because the thing it bounds grew is how the twelve-minute device-gate budget became a verdict rather than a bound, which is the defect #892 Phase 0 opened by fixing. If the lane needs more room the answer is to move work out of it, as Phase 1 already did once by splitting coverage off; that is a change with its own sizing argument and is not this issue's.
- **Why a freshly-paired phone has no replica session.** The evidence chain is in E; the cause is not established and is not this issue's. It is the thing #904 and #870 actually need, and the first place to look is the on-device `op-sqlite` driver, which #890's receipt records as never having been exercised on a device.
- **The Android roster's remaining red, after E.** E fixes the cause of every `Element not found` tile tap. It does NOT re-verify the journeys behind those taps: `photos-permissions` also failed its own `photos-collections` assertion after warnings about `^Open$` and `^Continue$`, which is a permission-dialog path this change does not touch, and no lane has run past the tile tap yet to say what else is behind it. #904 and #870 stay open until a green roster closes them.
- **The Android roster is broadly red on `main` itself, and is already tracked.** The `mobile-canary` run on main tip `f5ca34fb` (33370541215) paired and onboarded fine — `mobile-cold-start`, `home-loads` and `volume-proof` all PASS, and "All apps and places" asserts visible — then failed nearly every remaining journey at the tile tap: `Open Photos.*`, `Open Docs.*`, `Open Agenda.*`, `Open Notes.*`, `Open Tasks.*`, `Open People.*` and `id: home-tile-photos` are all `Element not found`. One shared symptom, a home screen rendering its heading without its tiles. The canary's own `File a tracking issue on a red canary` step filed **#904** for it, and **#870** is the older sibling ("home-app journeys never see home"). Nothing here changes app code; it is recorded because it is the actual reason the mobile lanes are red on main, and it is not the CI wiring this issue is about.
- **The window in which the canary has not yet warmed the apk and gradle caches.** `mobile-canary.yml` saves them `if: always()`, which is already right, but it saves *after* the full roster — roughly 55 minutes after the build finishes. So for about an hour after each merge to `main`, a device-gate run on that content is cold by construction. Splitting the build out of the emulator-runner step would fix it and is a restructure of the mobile lanes, not a line change; out of scope for a PR that is otherwise about gate wiring.
- **The gradle cache does not make a rebuild a repackage, and the ABI fix does not make it one either.** `android-emulator-install.sh` states the design as "miss the apk cache, hit the gradle cache", so a JS-only PR repackages rather than recompiles. It does not hold, for two reasons this change deliberately leaves standing. `org.gradle.caching` is unset, so Gradle's build cache is OFF and caching `~/.gradle/caches` preserves dependencies and transforms but no task outputs. And the cached paths — `apps/mobile/android/app/build`, `apps/mobile/android/build`, `~/.gradle/caches` — cover no native build directory: React Native library modules build under `node_modules/<lib>/android/build/` with NDK intermediates in `.cxx/`, neither of which appears in any of the four workflows. Observed directly on run 33405430819: the gradle cache restored in 41s and the job was still compiling `react-native-quick-crypto/deps/fastpbkdf2/fastpbkdf2.c` twenty-five minutes later. The ABI fix above makes that compile roughly four times cheaper; it does not make it skippable, so a mobile-JS PR still pays a cold build. Turning the build cache on and caching the native directories is the fix, and it is a caching restructure across four workflows rather than a line change.
- **The canary re-banks a barren gradle directory.** Compounding the above and recorded because it is why the situation does not self-correct: `Save the built Android app` is gated on `steps.emu.outputs.built == 'true'`, so when the apk cache HITS gradle never runs, `built` stays false, and the unconditional `Save the Android gradle build directory` beside it banks a directory holding no fresh native output. That is exactly what run 33370541215 did — apk restored in 4s, save skipped, gradle directory saved anyway. `mobile-canary` has run four times ever and never succeeded, so no run has yet banked a warm native build for a PR to restore.
- **The device half of the conformance sweep, and the rest of Part 2.** This branch delivers item 3 at the RNTL tier only. The device-side sweep — deep-link into each app, assert its landmark renders from the on-device replica — is genuinely device-only work (native sqlite under real storage) and belongs on a lane that can run it. It is deliberately not added here: the Part 2 plan's own sequencing puts "get `mobile-canary` green" first, `mobile-canary` has never been green, and adding a flow that has never executed to the lane currently being debugged adds an unknown to a red lane rather than coverage. The manifest is already readable by the `.mjs` runners, so that flow is a small follow-up rather than a rebuild. Items 1, 2, 4, 5 and 6 are untouched and their boxes in #905 stay unchecked.
- **The other ten path-gated lanes.** All were verified to wake correctly on a `workflow_dispatch` run of main tip; none needed a change.
- **`mutation-pr` and `dependency-review` reporting `skipped` on a main push.** Both are gated on `github.event_name` by design (PR-only / non-main-push), not by a path filter, and neither is a defect.
- **The wall-clock ceiling's own report dependency.** The "Suite wall-clock ceiling" step guards the artifact with its own explicit existence check and is unaffected by B. It now rides on `verify`, whose `test:suite` writes that artifact — which is B's doing, so the two are related after all: before B, `verify` produced no report and the step could not have run there.
- **A concurrency-invariant wall-clock metric.** The gate now measures a lane where the confound is small and constant, which is a placement fix, not a metric fix. Summing per-file wall spans still prices timesharing rather than work, so `verify` slowing down for its own reasons would still read as a heavier suite. Summing per-TEST durations, or normalising by worker count, would measure the thing the budget is actually about; both are changes to `suite-wall-clock.mjs`'s contract and to the seeded number, and neither belongs in a PR that found the problem by accident. What is established and recorded above is the measurement, so the next person does not have to re-derive it.

## Verification

Every command below was run in this container against this branch, on Node 24.4.1 and Bun 1.3.13 (the versions `.node-version` and `packageManager` pin).

The lint fails on the pre-fix shape and passes on the fixed tree:

```sh
bun run lint:path-filters
node --test scripts/lint-path-filters.test.mjs   # 15 passed, 0 failed
```

The workflow still parses and the block reads as intended:

```sh
node -e "const {parse}=require('./node_modules/yaml');console.log(JSON.stringify(parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8')).jobs['client-e2e'],null,2))"
```

B's guard fails on the pre-fix tree and passes on the fixed one — both directions, not just the green half:

```sh
node --test scripts/ci/collection-tripwire.test.mjs          # 10 passed
# then, with test:suite reverted to `--reporter=default` alone:
#   1 failing — "ci.yml job `verify` runs the tripwire with --require-report
#   but no step in it runs a script that writes artifacts/test-results/vitest.json
#   (one of: coverage, coverage:merge). The gate cannot pass there."
```

B's failure itself reproduces with no report on disk:

```sh
node scripts/ci/collection-tripwire.mjs --require-report
# collection-tripwire: artifacts/test-results/vitest.json is missing, so no file could be scored.
```

C's four rewired workflows parse, and each carries exactly one restore and one save:

```sh
node -e "const {parse}=require('yaml');const fs=require('fs');
for(const f of ['ci.yml','mobile-canary.yml','mobile-alarm-test.yml','e2e.yml']){
  const d=parse(fs.readFileSync('.github/workflows/'+f,'utf8'));
  let r=0,s=0;
  for(const j of Object.values(d.jobs)) for(const st of (j.steps||[])){
    if(st.name==='AVD cache'&&String(st.uses).includes('cache/restore'))r++;
    if(st.name==='Save the AVD snapshot'&&String(st.uses).includes('cache/save'))s++;}
  console.log(f,r,s);}"
# ci.yml 1 1 / mobile-canary.yml 1 1 / mobile-alarm-test.yml 1 1 / e2e.yml 1 1
bun run lint:workflow-pins
bun run test:matrix          # includes validate-nightly-wiring
bun run test:governance-shell
```

D changed no file; the evidence is a read, reproducible as:

```sh
grep -n -B12 '^  desktop-e2e-macos:' .github/workflows/ci.yml   # the NON-REQUIRED ruling
grep -n 'job.name' scripts/ci/lane-health.mjs                   # no lane allowlist
```

Gates touching the changed files:

```sh
bun run format:check
bun run lint
bun run lint:workflow-pins
bun run lint:turbo-cache
bun run scripts:test
bun run test:comment-density
bun run test:matrix
bash .governance/run.sh   # 22 directive(s) passed
```

Field evidence for A — run `33372386799` (`workflow_dispatch` on `f5ca34fb`) reported `client-e2e / web-e2e` and `client-e2e / desktop-e2e` as `skipped` in 0s while all ten other path-gated lanes woke; its `changes` job shows `Run dorny/paths-filter@… skipped`, which is the empty-string source. The fix is proved by the dispatch of this branch (run `33374941598`), where both inner jobs execute instead of skipping.

Field evidence for C — the defect and the fix are both visible in the step lists, on `main` and on this branch respectively. The `mobile-canary` job on main tip (`99430723132`) reports `AVD cache` **success** (a miss), `Create AVD + snapshot (cache miss only)` **success** (95 s), and `Post AVD cache` **skipped** — the save declining to run because the job was red, exactly the shape the fix removes. The same lane on this branch (`mobile-device-gate`, job `99443239488`) reports the new `Save the AVD snapshot` step as **success** in 15 s, before the emulator step it used to sit behind.

Field evidence for B — the same run's `verify` job: `Test Files 1502 passed | 4 skipped (1506)`, `Tests 18162 passed | 5 expected fail | 37 skipped (18204)` in 1158.30 s, then `##[error]Process completed with exit code 1` on the step after it, with the tripwire's "is missing, so no file could be scored" as the last line of output.

The conformance gate and the sweep were each shown to bite before being trusted, on this tree rather than on a fixture:

```sh
# I — the gate catches the silent catalog drop it exists for.
$ sed -i 's/^  tally: { kind: "tally" },$//' apps/mobile/src/screens/home/catalog.ts
$ node scripts/lint-app-conformance.mjs
#   app-conformance: route-registered: … → tally declares route `tally`;
#   apps/mobile/src/screens/home/catalog.ts maps `tally` to NOTHING. …
#   app-conformance: 1 problem(s)      [exit 1]
$ git checkout apps/mobile/src/screens/home/catalog.ts && node scripts/lint-app-conformance.mjs
#   app-conformance: 8 first-party app(s) — registry, launcher catalog, Home's
#   navigate switch, the deep-link table and the testID vocabulary all agree …

# I — the sweep catches a tile opening the wrong cover.
$ # Home.tsx: case "tally" → navigation.navigate("Tasks")
$ bun run --cwd apps/mobile test -- src/screens/Home.test.tsx
#   FAIL src/screens/Home.test.tsx > shell↔app conformance > tally >
#     opens its own cover when the tile is pressed
#   Tests  1 failed | 18 passed (19)
$ git checkout apps/mobile/src/screens/Home.tsx && bun run --cwd apps/mobile test -- src/screens/Home.test.tsx
#   Tests  19 passed (19)

# I — the linter's own rules self-test before it reads the tree, and the
# parsers are held against the real committed sources.
$ node --test scripts/lint-app-conformance.test.mjs      # 7 pass, 0 fail
$ node scripts/ci/run-gates.mjs lint:app-conformance lint:path-filters \
    lint:mobile-testids lint:e2e-flows lint:e2e-wiring \
    check:mobile-suite-budgets lint:turbo-cache knip      # 8/8 in 6.8s
$ bun run format:check && bun run lint && bun run --cwd apps/mobile typecheck
$ bun run test:comment-density                            # ok — no unpinned file over cap
```

The self-test earned its place immediately: its first draft expected two errors from the "tile opens the wrong cover" fixture and got one (the deep-link rule keys on the navigator the row declares, which that fixture leaves valid). The miscount was in the test, not the rule, and the linter refused to run until it was fixed.

**One gate was found by CI rather than locally, and fixed in the code.** The first push of I reddened `gates` on `test:hygiene-ratchet` — 784 `toHaveBeenCalled*` against a down-only budget of 783 — because the sweep's tile-press case asserted `expect(navigate).toHaveBeenCalledWith(...)`. The budget is not raised: the seam now records `navigation.navigate` argument lists into an array and the case asserts the whole sequence, `[[navigator, { screen }]]`. That is a stronger claim than the call assertion was — it also says *exactly one* navigation happened, so a tile that opens its own cover **and** something else now fails — and the count returns to 783. `Home.test.tsx`'s comments were trimmed a fourth time for the two lines this added.

Two local-environment findings, recorded because each looked like a repo defect and was not:

1. **`receipt-per-issue` and `toolchain-config-protection` failed on a clean checkout of main tip.** The cause is a stale local `main` ref (`3b8c3f0c`, ten behind `origin/main`): the directive resolves its change set from `merge-base(HEAD, main)`, so the walk pulled #892's entire squash into scope. CI is green on the same commit because there `merge-base == HEAD` and the rule is skipped. `git branch -f main origin/main` clears it. This is the second time a stale `origin/main` in a container has produced a red gate attributable to nothing in the tree — see #892's receipt, Decisions 10.
2. **`agent-session-identity` reads the issue anchor from the git process argv.** `git commit -F <file>` therefore has no anchor even when the subject carries `(#905)`; `AGENT_ISSUE` is the supported alternative.

```console
# J — the digest is pure, so the shapes it must survive are unit-tested rather
# than discovered on a 28-minute lane.
$ node node_modules/vitest/vitest.mjs run \
    --config scripts/test-report/vitest.config.ts   # 41 files, 546 tests, 0 fail
$ bun run check:push                                # 56/57
```

`check:push` was run whole rather than by hand-picked gate — the lesson from I, where `test:hygiene-ratchet` was missed locally and cost a CI cycle. The one failure is `design:gallery`, which cannot pass in this container: Playwright wants `chromium_headless_shell-1234` and the image ships a different build. It fails identically on a clean tree, so it is an environment limitation, not a finding; the push therefore carries `SKIP_CHECK_PR=1`, as this branch's earlier pushes did.

Two claims in J are corrections of things stated earlier on this branch, recorded here because a receipt that keeps only the flattering half of its own reasoning is worth less than none:

1. **The device gate's failure was reported as `photos-permissions` alone.** It is three of the critical five. The earlier claim came from reading the first failing flow and stopping; the suite short-circuits only on the canary, so the other verdicts were in the same log. Corrected on the PR in comment 5487960296.
2. **`tests/agent-e2e-mobile/lib/**` was briefly thought to be unrun by any script.** It is not: `test:ratchet:unit` runs the `test-report-scripts` vitest project, whose `include` already covers it. The appearance of a gap came from running those files under `node --test`, which is the wrong runner for a vitest suite — `hierarchy-digest.test.mjs` is written in vitest style to match its siblings for exactly that reason.

## Audit

**VERDICT: REFUTED — the independent audit required by `receipt-per-issue` rule 7 has NOT been performed.**

Recorded as REFUTED because the directive defaults to REFUTED under uncertainty and "nobody independent has looked" is the strongest form of that. The verdict is about the audit's absence, not about a finding.

**Why it is absent.** Rule 7 wants the verdict of a fresh-context sub-agent handed only the diff, this receipt, and the issue. This session was instructed not to spawn sub-agents, so none ran. Writing PASS would be an author attesting to their own work in the section reserved for someone who has not seen their reasoning — and mechanically indistinguishable from a real audit.

**What to do before merging.** Hand a fresh-context agent only `git diff origin/main`, this receipt, and issue #905; ask it adversarially whether `## What changed` describes the diff, whether each `- [x]` is realized in it, and whether the checklist mirrors the issue. Replace this section with its verdict.

**Author's own review, which is NOT that audit.** Recorded so the auditor has claims to attack rather than reconstruct:

- The narrowed gate is the one change here that could *reduce* coverage. It cannot: `web ∪ desktop ⊂ client`, and the difference (`packages/server/**`, `packages/core/**` via neither) only ever reached jobs that were already gated on `inputs.web` / `inputs.desktop`, both false for a server-only diff. Nothing that used to run stops running.
- The lint's per-line scan is the weakest part. It is sound for `${{ }}` expressions and one-line conditions, and `scannableUnits` covers folded and literal scalars; a filter output read from a composite action or a script the workflow calls would not be seen. That is outside what a line scanner over `ci.yml` can promise, and the header says so.
- The claim "those two `with:` lines were the only reads in `ci.yml` outside an `if:`" is checkable: `grep -n "needs.changes.outputs" .github/workflows/ci.yml` returns thirteen lines, eleven of them `if:`.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-09-01 | claude-code | 91a550cd-d7f2-5fa3-9d41-c4d75aaf2c05 |
