# Issue #483 — mobile agent-e2e flows pass/fail for reasons unrelated to what they assert

Getting the `mobile-e2e` lane green (#474/#478) surfaced six flows that were
green while observing nothing, or red for an unrelated reason. #483 asked for a
lint/review checklist so the next one is caught mechanically instead of by
advancing CI one failure deeper. This fold delivers the linter, wires it into the
per-PR gate, documents the review-only rules, and brings the existing flows into
compliance.

## Checklist

- [x] Added `scripts/lint-e2e-flows.mjs`, a linter over the mobile Maestro flows.
- [x] The linter self-tests its own rules and fails on a zero-step scan.
- [x] Wired `lint:e2e-flows` into `check:pr` and the CI `static` job.
- [x] Recorded the review-only rules in the layer `AGENTS.md`.
- [x] Brought the existing flows into compliance.

## What changed

- **Added `scripts/lint-e2e-flows.mjs`, a linter over the mobile Maestro flows.**
  It parses the Maestro YAML embedded in the flow/harness template literals and
  enforces two rules:
  - `unasserted-input`: every `inputText:` must be followed, before a
    `clearState` launch wipes the field, by an `assertVisible`/`extendedWaitUntil`
    that observes the typed value (literals match by substring; `${…}`
    interpolations by identity).
  - `route-name`: no `assertVisible`/`assertNotVisible`/`extendedWaitUntil` may
    key on `Home/Photos/Docs/Agenda/Settings/Apps`.
  - Escape hatch `# e2e-lint-allow: <rule> — <reason>` on the step or the comment
    block above it.
- **The linter self-tests its own rules and fails on a zero-step scan.** Eight
  built-in positive/negative fixtures run before it judges the repo, and a scan
  that matches zero Maestro steps FAILs — so the check cannot rot into
  always-passing (mirrors `lint-css-classes.mjs` / `lint-types.sh`).
- **Wired `lint:e2e-flows` into `check:pr` and the CI `static` job.** A
  `package.json` `lint:e2e-flows` script, added to the `check:pr` chain, and a
  `bun run lint:e2e-flows` step in `.github/workflows/ci.yml`'s `static` job next
  to `test:matrix` (the flows run nightly; linting their source is offline/fast).
- **Brought the existing flows into compliance.**
  `tests/agent-e2e-mobile/flows/native-v0-resilience.mjs`'s Photos/Docs/Agenda
  tab checks now `extendedWaitUntil` on a screen-unique accessibilityLabel
  ("Search photos" / "Add document or folder" / "Create event") instead of the
  tab label (Settings already used the unique "Desktop link"); and in
  `tests/agent-e2e-mobile/lib/harness.mjs` the throwaway keyboard-provoking
  keystroke and the secret bearer token carry `# e2e-lint-allow: unasserted-input`
  with the reason each cannot be asserted.
- **Recorded the review-only rules in the layer `AGENTS.md`.** A new "Flow
  authoring rules" section in `tests/agent-e2e-mobile/AGENTS.md` states all four
  rules, marks which two the linter enforces, and documents the annotation syntax.

## Decisions

- **Enforce only the two mechanically-decidable rules; keep the other two as
  review.** #483 lists four rules. "Every `inputText` is asserted" and "no
  assertion on a route/tab label" are decidable from the flow source, so they are
  linted. "Every `tapOn` is anchored" and "assert only published strings" require
  judgment (what counts as help copy; whether a string is a deliberate a11y name),
  so they live in the AGENTS.md checklist, not the linter. A false-positive linter
  that forces noise-suppression comments everywhere would be worse than none.
- **Fix native-v0's assertions rather than exempt them.** The three tab asserts
  were genuine vacuity, not false positives, so the honest move was to re-key them
  on screen-unique accessibilityLabels — not to `# e2e-lint-allow` them. The
  labels are Pressable `accessibilityLabel`s (the same construct `template-gate`
  already matches green in CI), verified end-to-end by this fold's own
  `mobile-e2e` run; local device verification was not possible (no booted
  simulator / running Metro in this environment, and a native rebuild is ~30 min).

## Out of scope

- The desktop Playwright agent-e2e flows (`tests/agent-e2e`) — those use CDP
  assertions, not Maestro YAML; the string-vacuity shapes do not apply.
- Adding accessibilityLabels to the Settings gateway-URL `TextInput` so flows can
  select it by name instead of its placeholder — tracked separately in #482.
- Making the linter a warning tier or extending it to rule 3/4 (tapOn anchoring,
  published-string judgment) — those are not mechanically decidable and stay in
  the review checklist.

## Verification

```sh
# Linter is green on the compliant flows (self-test runs first):
node scripts/lint-e2e-flows.mjs
# → ok   e2e-flows — 43 Maestro step(s) across 4 file(s), no vacuous assertions

# It catches the pre-fix violations (git stash the flow fixes, re-run):
# → FAIL — 5 … native-v0 asserts "Photos"/"Docs"/"Agenda" [route-name];
#          harness inputText "x" and the token [unasserted-input]

# Syntax of every edited flow/script:
node --check scripts/lint-e2e-flows.mjs
node --check tests/agent-e2e-mobile/flows/native-v0-resilience.mjs
node --check tests/agent-e2e-mobile/lib/harness.mjs
```

The rewritten native-tab assertions were verified end-to-end by a dispatched
`mobile-e2e` run on this branch — [run 29797949507](https://github.com/srikanth235/centraid/actions/runs/29797949507),
`mobile-e2e` → **success** with a full native rebuild (root `package.json`
changed, busting the build-fingerprint cache) on a factory-fresh simulator:

```
Assert that "Search photos" is visible... COMPLETED
Assert that "Add document or folder" is visible... COMPLETED
Assert that "Create event" is visible... COMPLETED
[runFlow] native-v0-resilience PASS in 291832ms
```

All three flows passed (home-loads, template-gate, native-v0-resilience). The
run-level conclusion is `failure` only for `publish-nightly-report`, the
main-only GitHub Pages deploy that cannot pass from a feature-branch dispatch.

## Audit

Verdict: **PASS**

1. **Every file changed by this work is covered by a receipt.** — the six paths
   above are enumerated in "What changed"; this receipt (#483) homes them all.
   Check: PASS.
2. **No unrelated file is swept in.** — the diff is confined to the linter, its
   two wiring points, the two flows it lints, the layer AGENTS.md, and this
   receipt. Check: PASS.

## Steering

Verdict: **PASS**

1. **Every human-steering event in the transcript is recorded.** — one directive
   produced this work: "please work on it and fold into the current PR", in reply
   to a status question about whether #483 was sorted. Classified a **new task**
   (it opens work, reverses no prior direction), recorded here against #483.
   Check: PASS.
2. **No correction is attributable to this commit.** — the operator gave no
   course-correction on the approach; the scope (linter + gate + doc + flow
   compliance) was chosen and executed without redirection. Check: PASS.

## Accounting

<!-- Accounting rows are maintained by the agent-token-accounting and agent-steering-accounting pre-commit hooks. Keys are opaque — do not parse. -->

### Costs

| cost-key | agent | session | issue | model | input | cache-create | cache-read | output | new-work | cost-usd | cum-input | cum-cache-create | cum-cache-read | cum-output | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| claude-code-caa407fd-499-1784603324-1 | claude-code | caa407fd-4992-4b19-9083-0461b452f3bb | #483 | claude-opus-4-8 | 206 | 300835 | 12887288 | 137900 | 438941 | 11.7724 | 1061 | 1775120 | 111197564 | 505540 |  |
| claude-code-caa407fd-499-1784603452-1 | claude-code | caa407fd-4992-4b19-9083-0461b452f3bb | #483 | claude-opus-4-8 | 14 | 26536 | 1098626 | 17424 | 43974 | 1.1508 | 1075 | 1801656 | 112296190 | 522964 |  |
| claude-code-caa407fd-499-1784603509-1 | claude-code | caa407fd-4992-4b19-9083-0461b452f3bb | #483 | claude-opus-4-8 | 3 | 19020 | 489879 | 3564 | 22587 | 0.4529 | 1078 | 1820676 | 112786069 | 526528 |  |
| claude-code-caa407fd-499-1784607016-1 | claude-code | caa407fd-4992-4b19-9083-0461b452f3bb | #483 | claude-opus-4-8 | 62 | 41954 | 6018398 | 26260 | 68276 | 3.9282 | 1140 | 1862630 | 118804467 | 552788 |  |
