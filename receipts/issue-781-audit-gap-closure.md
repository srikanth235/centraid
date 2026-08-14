# Receipt — issue #781: testing-strategy gap backlog (2026-08 audit)

#781 is a standing backlog, not a single change. It closes only when no matrix
cell, gap, or skip cites it any longer. This receipt is the running record of
the categories closed against it; each wave appends a subsection and the
Checklist below stays unchecked until the last category is fixed or split.

## Checklist

- [ ] Every category above is either fixed or split into a dedicated issue, and
      the citations in `tests/matrix.json` / `tests/skips.json` follow the split.
- [ ] This issue closes only when no matrix cell, gap, or skip cites it any
      longer.

Neither is checked, and neither is claimed. Wave 1 (#782) re-homed the
citations; this wave closes **no category outright**. Both sections below are
sub-items of the single **"Hygiene ratchets"** bullet, and that bullet names
five things: the two count budgets (done here), the Android probe omission
(done here), test-lint scope excluding `.test.mjs` (untouched — raw `mkdtemp`
in 11 files and `Math.random()` in the pairing harness are still unlinted), 19
nonzero fixed sleeps still uninventoried, and `packages/model-runtime` still
absent from every `ci.yml` path filter. Three of five remain.

Every one of #781's eleven categories is therefore still open: nightly signal,
sharing-plane ownership, unfloored production code, missing matrix presence,
the app-admission contract, the deterministic-env test home, stale ratchets,
gates still outside CI, the #587 D21 rulings, hygiene ratchets (partially
closed here), and the env-gated live/hardware lanes. Later waves on this branch
work several of them; none of them closes with this commit.

## What changed

### Assertion-hygiene ratchet (#781 "Hygiene ratchets")

The backlog recorded two conventions with **zero mechanical backing**:
`toHaveBeenCalled*` had grown ~600 → 1,023 (+70%, against a suite that grew
+20%) and `toBeTruthy` 304 → 390, above its own pre-#545 baseline. Both are
TESTING.md rules that no lint rule can own, and the reason is specific rather
than incidental: oxlint's `prefer-to-be-truthy` / `prefer-to-be-falsy` are off
under #573 because their autofix runs the **wrong direction** — it rewrites the
house-style `toBe(true)` into the strictly weaker `toBeTruthy()`, and applying
it over this suite weakened 1,117 `toBe(true)` and 720 `toBe(false)`
assertions. `prefer-called-with` is worse: it rewrites `toHaveBeenCalled()`
into `toHaveBeenCalledWith()`, which asserts the mock was called with *zero*
arguments. A rule that cannot be autofixed can still be ratcheted, so it is
now a count budget rather than a lint.

`scripts/test-report/hygiene-ratchet.mjs` (new, 256 lines) measures both
families over `**/*.test.{ts,tsx}` and enforces `tests/hygiene-budgets.json`
(new) as a **down-only** budget, seeded 2026-08-14 at `toBeTruthyFalsy: 413`
and `toHaveBeenCalled: 840` from 1,216 test files. It borrows skip-inventory's
mechanics deliberately — `node:fs/promises` `glob` + `Array.fromAsync`,
`\\`→`/` normalization, substring excludes for `node_modules/`, `dist/`,
`build/`, and `scripts/test-report/` — the last because those files are the
detectors and their own fixtures quote the counted matchers verbatim, the same
exclusion and the same reason skip-inventory carries.

Three properties are worth naming because they are where a count gate usually
goes wrong:

- **Slack is a hard failure, not a warning.** A measured count *below* budget
  fails, exactly as `test:ratchet` fails on an over-wide skip budget. A budget
  that may sit above the measurement is not down-only — it is a ceiling that
  drifts upward by neglect, and the improvement that earned the slack goes
  unbanked. `--write` (`reconcileBudgets`) reconciles with
  `Math.min(previous, measured)`, so the escape hatch can only ever **lower** a
  number and cannot launder a regression.
- **Counting is over whole file text, not per line**, so a formatter-wrapped
  `expect(fn)\n  .not\n  .toHaveBeenCalled()` is still classified correctly.
  There is a test for exactly that shape.
- **Bare `.not.toHaveBeenCalled()` is exempt**, matched by named groups
  (`negated && suffix === ""`). Asserting a call did *not* happen is complete on
  its own — there is no `toHaveBeenCalledWith` equivalent of "never called", so
  demanding arguments there would weaken the assertion rather than sharpen it.
  This is why the budget is 840 rather than the family total of 1,031: 191
  negated-bare sites are exempt. `.not.toHaveBeenCalledWith(...)` and
  `.not.toHaveBeenCalledTimes(...)` **do** count, since those carry an argument
  or arity the positive form should carry too. The suffix pattern is
  `[A-Za-z]*` rather than an enumeration, so `OnceWith` / any future family
  member is covered without editing the detector.

The gate also fails on a non-integer budget and on a budgeted metric no
detector measures, so `tests/hygiene-budgets.json` cannot rot into a file that
names ceilings nobody checks. Failure messages carry the delta, the remedy, and
the top five offender files.

`scripts/test-report/hygiene-ratchet.test.mjs` (new, 245 lines, 16 tests) covers
the nested-directory and both-extension globs, the `node_modules` and detector
exclusions, the wrapped-negation shape, and the negated-bare exemption. It runs
on the existing `test:ratchet:unit` lane, which `scripts/test-report/vitest.config.ts`
picks up without an edit.

`package.json` gains `test:hygiene-ratchet` and wires it into `check:push`
immediately after `test:ratchet`, its sibling gate. `.github/workflows/ci.yml`
runs it in the `gates` job added by #782, after `test:quarantine`.

`TESTING.md` gains an **"Assertion-hygiene ratchet (#781)"** subsection next to
the skip budget, and the `prefer-to-be-truthy` bullet under "ultracite vitest
preset (#573)" now points at the count gate — the doc previously described a
convention it had no way to hold.

### Android nightly probe parity (#781 "Hygiene ratchets", Android omission)

`tests/experience-budgets/mobile.json` claimed `cold-start` runs "on the
nightly mobile-e2e-ios / mobile-e2e-android jobs", but
`apps/mobile/scripts/android-emulator-e2e.sh` ran only `home-loads`,
`template-gate`, `native-v0-resilience`, and the photos suite. The Android lane
produced no cold-start, frame-drop, or volume evidence at all, so the budget
file asserted a probe host that did not exist.

The three flows were checked for genuine platform-dependence before assuming
the omission was accidental, and **all three are platform-neutral**:

- `volume-proof.mjs` and `cold-start.mjs` touch the device only through
  `ctx.configureGateway()` and Maestro `stopApp` / `launchApp` /
  `extendedWaitUntil` built against `ctx.state.appId`. No `xcrun`, no simulator
  API, no platform branch. `cold-start`'s gate is `rigDriftBudget(...)` over a
  JSON ledger, which is filesystem-only.
- `scroll-frames.mjs` deep-links `centraid://perf-frames?ms=6000`. That scheme
  is registered on Android — `apps/mobile/android/app/src/main/AndroidManifest.xml`
  carries `VIEW` + `DEFAULT` + `BROWSABLE` with `android:scheme="centraid"` on
  `.MainActivity` — and `openLink` already runs on this lane today via
  `photos-permissions.mjs` in the photos suite. The frame capture is not an
  iOS mechanism: `apps/mobile/src/kit/perf/FrameProbe.tsx` is a plain RN
  component mounted unconditionally in `apps/mobile/App.tsx`, gated only on
  `__DEV__` (true for the `assembleDebug` apk this lane installs), using
  `expo-linking` + `requestAnimationFrame` with no `Platform.OS` anywhere in it
  or in `apps/mobile/src/lib/perf/frame-sampler.ts`. Both target surfaces exist
  on Android (`apps/mobile/src/apps/people/PeopleHome.tsx` has no platform
  gate; Photos already runs here). The readout is recovered from
  `runs/<id>/maestro-debug/`, which the harness writes on both platforms, and a
  failed parse **fails** the flow rather than reading as zero — so an
  Android-specific hierarchy surprise surfaces loudly instead of silently
  scoring 0 dropped frames.

So `tests/experience-budgets/mobile.json` is **untouched**: its claim became
true rather than being walked back. `apps/mobile/scripts/android-emulator-e2e.sh`
gains the three invocations in the iOS job's exact order, with the same
`MAESTRO_PLATFORM=android` prefix and `|| ec=$?` non-short-circuit convention,
inside the existing `set +e` / `set -e` / `exit "$ec"` frame; error handling and
exit-code aggregation are unchanged. No new environment variable is needed
(`MAESTRO_GATEWAY_URL` is already exported into `GITHUB_ENV` before the emulator
step; `MAESTRO_GATEWAY_TOKEN` defaults to `""`) and no new artifact path
(quality evidence goes to repo-root `artifacts/scale/`, screenshots to
`tests/agent-e2e-mobile/runs/`, both already uploaded by this job).

Two `.github/workflows/e2e.yml` edits carry the change:

- `mobile-e2e-android` `timeout-minutes` **90 → 120**. This lane can pay a
  cold-cache Gradle build (~21 min, #535) before any flow runs, and the three
  added journeys each perform their own pairing handshake plus 20 relaunches, 8
  launches, and two 6-second sample windows on a swiftshader emulator. iOS does
  the same seven invocations in 60 minutes, but on a hardware-accelerated
  simulator with no build step.
- The iOS job's `Remove sensitive pairing diagnostics` step is mirrored onto
  Android, which lacked it. The harness already `rm -rf`s that directory in a
  `finally`, so this is belt-and-braces — but a run that dies before the
  `finally` could otherwise ship pairing diagnostics inside the `runs/`
  artifact, and the existing Android flows already pair.

### Quality observation recorded, not fixed

`QUALITY.md` gains one Open entry. Nightly mobile evidence is keyed by flow,
not by flow × platform: `writeFlowVerdict` writes `artifacts/e2e/<slug>.json`
and `recordQualityResult` writes `artifacts/scale/<owner-slug>.json`, neither
carrying a platform component, while `test-health-report` downloads
`nightly-evidence-*` with `merge-multiple: true`. iOS and Android therefore
collide last-write-wins. This pre-dates the change (`home-loads`,
`template-gate`, and `native-v0-resilience` already collide), but adding
`cold-start` and `scroll-frames` to Android extends it to the *numbers*, where
the merged report now hides one platform's milliseconds and frame-drop count
behind the other's. It is not corrupting a gate today — the `quality-history`
cache is restored only in `quality-performance-scale` and `restore-year3`,
never in the mobile jobs, so `rigDriftBudget` returns `null` on both platforms
and no cross-platform samples interleave — but extending that cache to mobile
would turn a display bug into a false ratchet. The fix is a platform segment in
both evidence paths plus a reader update, which is wider than the parity slice
that found it, so it is recorded rather than smuggled in.

### Files changed in this wave

```text
.github/workflows/ci.yml
.github/workflows/e2e.yml
QUALITY.md
TESTING.md
apps/mobile/scripts/android-emulator-e2e.sh
package.json
receipts/issue-781-audit-gap-closure.md
scripts/test-report/hygiene-ratchet.mjs
scripts/test-report/hygiene-ratchet.test.mjs
tests/hygiene-budgets.json
```

## Out of scope

- The remaining #781 categories listed under Checklist above. They are separate
  slices on this branch or later issues, not silent omissions.
- The flow × platform evidence-key collision, recorded in `QUALITY.md` for the
  reasons given above.
- `tests/experience-budgets/mobile.json`, deliberately untouched — the parity
  fix made its existing claim true.
- The stale-ratchet reseed (`tests/suite-wall-clock.json`, coverage floors,
  `tests/experience-budgets/{desktop,web}.json`). Reseeding needs a full
  coverage and timing run on a quiet machine; doing it while sibling slices are
  still mutating the test tree would bank numbers that are wrong by the time
  they land.

## Decisions

**Hygiene slack is a hard failure, not a warning.** The brief for this slice
proposed warning on an under-budget measurement, then deferred to
skip-inventory's precedent. skip-inventory makes slack a hard error
(`Ratchet _budget down to N`), so the hygiene ratchet does the same. A budget
permitted to sit above its measurement is not a down-only budget: the slack
accumulates, the ceiling stops describing the tree, and the next regression
hides inside room that a previous improvement paid for. `--write` keeps the
correction cheap without weakening the property, because it is monotonically
decreasing by construction.

**Bare `.not.toHaveBeenCalled()` is exempt by design, not by convenience.**
Exempting it is the difference between a gate that measures assertion strength
and one that measures a string. QUALITY.md's #496 re-measurement found all 186
bare sites were negated and zero positive bare calls remained; counting the
negated ones would have made the budget rise on a suite that had already been
cleaned, which is the failure mode a ratchet exists to prevent.

**`mobile-e2e-android`'s timeout is raised rather than the flow set trimmed.**
Bumping a timeout to accommodate new work is normally a smell. Here the
alternative was to keep an experience budget asserting a probe host that does
not run, which is the precise dishonesty class this backlog exists to close.

## Verification

```bash
bun run test:hygiene-ratchet
# hygiene: 1216 test files at budget — toBeTruthy/toBeFalsy 413,
# toHaveBeenCalled* (excluding .not.toHaveBeenCalled()) 840
```

That figure is the **staged tree**, measured over index blobs. Run against the
working tree during this session the gate reports more files and goes red
(416/845), because sibling slices for later #781 waves have untracked test
files on disk. That is the gate behaving correctly on a dirty tree, not a
defect, and it is stated here rather than hidden because the number a reader
reproduces will differ until those slices land.

```bash
bun run test:ratchet:unit    # 18 files / 258 tests passed, coverage thresholds held
bun run scripts:test         # 173/173
```

Demonstrated red for the hygiene gate: a scratch `tests/hygiene-scratch.test.ts`
carrying one `toBeTruthy()`, one `toHaveBeenCalledWith(1)`, and one
`.not.toHaveBeenCalled()` drove the gate to exit 1 at 414/413 and 841/840 —
i.e. the negated-bare line correctly did **not** move the count. The scratch
file was deleted and the gate returned green.

```bash
bash -n apps/mobile/scripts/android-emulator-e2e.sh   # clean
bun run lint:e2e-flows
# ok e2e-flows — 66 Maestro step(s) across 7 file(s), no vacuous assertions
bun run lint:workflow-pins
# workflow-pins: 19 workflow(s) clean
node scripts/test-report/validate-nightly-wiring.mjs
# nightly-wiring: e2e.yml owns pairing lifecycle, ticket-hygiene,
# cross-network-relay, and mutation-testing; standalone pairing-relay-e2e removed
```

**Device execution of the three added Android flows is unverified in-container**
— there is no emulator, no `adb`, and no Maestro here. Everything asserted about
their platform-neutrality above is static tracing of the harness, the manifest,
and the probe component; the first real proof is the next nightly
`mobile-e2e-android` run.

The hygiene budgets were seeded from a tree that sibling slices on this branch
are still mutating, and their drift is **upward** — later waves add test files
that add sites. `--write` cannot help there: it is `Math.min` by construction
and only ever lowers. Each later wave that legitimately adds sites must raise
its budget by hand, in a reviewed edit that says what the extra assertions buy.
That is the gate working as designed — an upward move is exactly the event it
exists to make visible — and it is recorded here so the next wave does not
reach for `--write` and find it silently unhelpful.

## Audit

Fresh-context correspondence audit against `git diff --cached` and issue #781.
The working tree carries unstaged sibling-slice files; everything below was
judged against the index, and where a number is tree-dependent it was measured
from index blobs (`git show :<path>`) rather than from the dirty tree.

**Round 2.** Round 1 returned PASS / **REFUTED** / PASS: the checkbox discipline
was honest but the surrounding prose claimed the wave "closes two of the
backlog's categories outright" and listed only eight of #781's eleven
categories as remaining. That, plus three minor infidelities under check 1, was
fixed and re-staged; this section is the re-adjudication of the updated staged
diff. **Round-2 verdict: PASS / PASS / PASS.** The staged file set is unchanged
(same ten paths, same byte counts everywhere except the receipt), so every
round-1 finding about the code and workflow content still stands as written.

**Check 1 — "## What changed" faithfully describes the diff: PASS.** All ten
staged paths are named in the prose and in the "Files changed" block, and each
hunk is accounted for: `package.json` (new `test:hygiene-ratchet` + insertion
into `check:push` immediately after `test:ratchet`), `.github/workflows/ci.yml`
(one `- run` after `test:quarantine`), `.github/workflows/e2e.yml` (exactly two
edits — `timeout-minutes: 90 → 120` and the mirrored `Remove sensitive pairing
diagnostics` step, byte-identical to the iOS one at line 386), the Android
script (comment block + three invocations in the iOS job's exact order,
`volume-proof` → `cold-start` → `scroll-frames` between `native-v0-resilience`
and the photos suite, inside the existing `set +e` / `ec=$?` frame),
`TESTING.md` (new subsection + amended `prefer-to-be-truthy` bullet; the
in-page anchor `#assertion-hygiene-ratchet-781` resolves), `QUALITY.md` (one
Open entry), and the two new script files plus `tests/hygiene-budgets.json`.
Nothing in the diff weakens a gate, budget, lint config, or allowlist: every
change is additive, `bun run lint:workflow-pins` still passes with the raised
timeout, and no existing exemption list is widened. Round 1 raised three minor
infidelities under this check; all three are now fixed in the staged diff and
were re-verified: the `Remove sensitive pairing diagnostics` step now sits
immediately after the `script:` line and **before** the "Bank the apk … Guarded
on the build having actually produced an apk" comment, so that comment once
again documents the `Save the built Android app` step directly beneath it
(e2e.yml:562-579); the quoted `test:hygiene-ratchet` output now reads "1216
test files", which is exactly what the staged tree measures, and a new
paragraph states that the working-tree run reports 416/845 red because of
sibling slices' untracked files; and the `validate-nightly-wiring.mjs` quote is
now complete, matching the tool's real output byte for byte ("…and
mutation-testing; standalone pairing-relay-e2e removed"). One round-1 nit is
deliberately left as-is and remains accurate enough to pass: the
skip-inventory-borrowing sentence lists `build/` among the excludes, which
skip-inventory's own `SCAN_EXCLUDE` does not carry (`node_modules/`, `dist/`,
`scripts/test-report/`), though the clause attributing borrowing — "the last" —
is about `scripts/test-report/`, which skip-inventory does carry. No tracked
test file matches any exclusion substring, so the exclusions change no count
either way.

**Check 2 — no "- [x]" item, and honesty of the unchecked state: PASS in round
2 (REFUTED in round 1).** Round 1's finding stands as a record of what was
wrong: the receipt claimed the wave "closes two of the backlog's categories
outright" when both delivered sections are sub-items of the single "Hygiene
ratchets" bullet, three of whose five named items are untouched, and its
"remaining categories" list named eight of the issue's eleven — dropping
"Hygiene ratchets", "Nightly signal", and "Env-gated live/hardware lanes", and
keeping only the `design:gallery` half of "Gates still outside CI". The staged
text now says the wave closes **no category outright**, names both sections as
sub-items of "Hygiene ratchets", enumerates that bullet's five items with three
marked untouched, and lists all eleven categories as still open. Each of those
statements was checked against the diff rather than taken on trust: test-lint
scope still excludes `.test.mjs`, no sleep inventory exists, and
`packages/model-runtime` still matches nothing in `ci.yml` (grep returns no
hit) — so "three of five remain" is exactly right, and "hygiene ratchets
(partially closed here)" is the honest label. Both checkboxes remain unchecked,
neither acceptance criterion is met, and nothing elsewhere in the receipt now
claims otherwise.

**Check 3 — "## Checklist" mirrors the issue's checklist: PASS.** Both items
reproduce #781's acceptance criteria verbatim, in order, with only line
wrapping differing.

**Verification claims re-run.** `bash -n apps/mobile/scripts/android-emulator-e2e.sh`
clean; `bun run lint:e2e-flows` → "66 Maestro step(s) across 7 file(s)", exactly
as quoted; `bun run lint:workflow-pins` → "19 workflow(s) clean", as quoted;
`node scripts/test-report/validate-nightly-wiring.mjs` green, and the receipt's
quote of it is now complete. All four were re-run in round 2 with identical
results. `bun run test:hygiene-ratchet` is **red on the working tree today**
(416/413 and 845/840) — but that is sibling slices' untracked test files, not
the staged change: counting index blobs with the detector's own
`countHygieneSites` over the same globs and excludes yields **1216 files,
`toBeTruthyFalsy` 413, `toHaveBeenCalled` 840** (re-measured in round 2,
unchanged), i.e. the seeded budgets are exact on the staged tree, and the
family total 1,031 with 191 negated-bare exemptions reproduces
(840 + 191 = 1,031). Round 1 flagged the closing claim that `--write`
"reconciles them before merge, and can only lower them" as backwards for this
branch; the staged text now states the drift is upward, that `--write` is
`Math.min` and cannot help, and that a later wave adding sites must raise its
budget by hand in a reviewed edit — which is both true of the code and the
right policy reading, since an upward move is precisely the event the gate
exists to surface. The
`test:ratchet:unit` and `scripts:test` lanes were not re-run in full (parallel
agents); the new file alone runs green at **16/16**, and the lane's include
globs do resolve to 18 files, consistent with the quoted "18 files".

**Ratchet mechanics vs. prose: accurate.** `validateHygieneBudgets` fails on
`measured > budget` *and* on `measured < budget` (down-only in both
directions), on a non-integer budget, and on a budgeted key no detector
measures; counting is `matchAll` over whole file text, so a formatter-wrapped
`expect(fn)\n .not\n .toHaveBeenCalled()` is classified correctly (verified
directly: that shape plus a bare negation count 0, while
`toHaveBeenCalledWith(1)` and `.not.toHaveBeenCalledTimes(2)` count 2);
`reconcileBudgets` is `Math.min(previous, measured)`, so `--write` is
monotonically decreasing and preserves the `_comment`.

**Platform-neutrality of the three flows: upheld.** `volume-proof.mjs` and
`cold-start.mjs` touch the device only via `ctx.configureGateway()` and
`stopApp`/`launchApp`/`extendedWaitUntil` against `ctx.state.appId`;
`scroll-frames.mjs` adds `openLink: centraid://perf-frames`. Greps for `xcrun`,
`simctl`, `Platform.OS`, `darwin`, and `ios` over the three flows,
`tests/agent-e2e-mobile/lib/frame-report.mjs`,
`apps/mobile/src/kit/perf/FrameProbe.tsx`,
`apps/mobile/src/lib/perf/frame-sampler.ts`, and
`apps/mobile/src/apps/people/PeopleHome.tsx` return nothing.
`AndroidManifest.xml` line 30-35 carries `VIEW` + `DEFAULT` + `BROWSABLE` with
`android:scheme="centraid"` on `.MainActivity`; `photos-permissions.mjs` (in
`run-photos-suite.mjs`, already on this lane) already issues `openLink` there.
`FrameProbe` is mounted unconditionally at `apps/mobile/App.tsx:567` and gated
only on `__DEV__`, which holds for the `:app:assembleDebug` apk this script
builds. `harness.mjs` resolves `${APP_ID}.debug` for android and passes
`--debug-output` on both platforms. `MAESTRO_GATEWAY_URL` is exported to
`GITHUB_ENV` at e2e.yml:472, before the emulator step, and
`MAESTRO_GATEWAY_TOKEN` defaults to `""` in the harness. The `quality-history`
cache is restored only at lines 755 and 803 (`quality-performance-scale`,
`restore-year3`), never in the mobile jobs — the QUALITY.md entry's reasoning
holds. No genuine iOS dependency found that the receipt missed.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-14 | claude-code | 36f0a126-2d40-5128-b3ea-59456606a925 |
