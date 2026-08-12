# Issue #753 — retire the `tools/` root; the model runtime becomes an ordinary package

## User impact

None at runtime. This is a structural refactor: the same bundled recognition
automations (`photo-ocr`, `faces`, `embed-image`, `embed-text`, `transcript`)
ship the same bytes and fire through the same automation spine. What changes is
where their build-time source and local model assets live in the repository,
and one fewer workspace root for every gate to enumerate.

## Checklist

- [x] `tools/` directory no longer exists; the workspaces glob lists only `packages/*` and `apps/*`
- [x] `coverage-scope-reachability` constitution text and `check.sh` amended in the same commit that removes the root; governance suite green
- [x] `packages/model-runtime` exists with the model plumbing, resolver, `models.lock.json`, and the live/mutation test lanes; a root `bun install` acquires no ONNX/sharp/FFmpeg (724-4 preserved)
- [x] Generated handlers rebuild byte-identical apart from the intended renamed path strings
- [x] Docs, CI, coverage floors, mutation seeds, sonar scope, and knip config reflect the new shape; no non-historical doc references `tools/recognition-automations`
- [ ] Handler sources co-located under `packages/blueprints/automations/<id>/src/` with a rebuild drift check — deferred, see Decisions
- [ ] Gateway resolves model assets from `<data dir>/model-runtime/`; `CENTRAID_MODEL_RUNTIME_DIR` overrides; the old env var name is gone from the tree — deferred, blocked on the trust-model open question
- [ ] Installer verifies weights AND native deps against lockfile hashes before first use; installation happens only on explicit user action — deferred, blocked on the trust-model open question
- [ ] Capture OCR and recognition automations pass end-to-end against the data-dir store (the #731 browser-proof flow re-run) — not attempted; there is no data-dir store until lane (c2) lands, and the rebuild-diff proof below is what replaces it for this change set
- [ ] `packages/blob-format` folded into `packages/protocol` — deferred as recorded in the issue

## What changed

**The `tools/` directory no longer exists; the workspaces glob lists only `packages/*` and `apps/*`.** Its sole occupant,
`tools/recognition-automations`, moved wholesale to `packages/model-runtime`
and the now-empty root was deleted. `package.json` drops `tools/*` from the
`workspaces` glob. The package is renamed `@centraid/model-runtime`, and its
`description` and `README.md` are rewritten around the generic concept it
actually holds — pinned model assets, the native inference dependencies that
execute them, the shared TypeScript model plumbing (ONNX wrapper, tokenizer,
CTC, NMS, geometry), and the build-time handler sources — rather than the
capability-specific "recognition" framing that made the folder read as though
it contained the automations themselves. It does not: the automations live in
`packages/blueprints/automations/`, and always did.

**`packages/model-runtime` exists with the model plumbing, resolver, `models.lock.json`, and the live/mutation test lanes; a root `bun install` acquires no ONNX/sharp/FFmpeg (724-4 preserved).**
The `runtime/` asset directory stays outside the workspace set exactly as
before: `packages/*` matches `packages/model-runtime` but not
`packages/model-runtime/runtime`, so the isolation decision 724-4 depends on is
structurally unchanged. A clean `bun install` at the repo root installed 1515
packages with no native ML dependency among them.

**`coverage-scope-reachability` constitution text and `check.sh` amended in the same commit that removes the root; governance suite green** — honouring the
constitution's cardinal rule. The directive drops the `tools/*/src` source-tree class, its
`vitest.config.ts` instrumentation requirement, its floor-glob prefix case, and
its `git ls-files` globs; the self-test synthetic id moves from a `tools/` path
to a `packages/` one. The directive's own `constitution.md` and the
`CONSTITUTION.md` directive body, rationale, and Evolution Log are updated
together. The Evolution Log change is purely additive, so the `doc-integrity`
frozen-section rule still holds.

**Generated handlers rebuild byte-identical apart from the intended renamed path strings.**
Rebuilding all five handlers and diffing against the committed artifacts
produced exactly three changed lines in each of the five: the generated-source
banner, plus a two-line `RuntimeNotInstalledError` operator message inlined
from `packages/model-runtime/src/onnx.ts` that names the setup command and the
runtime directory. No other byte moves in any of the five artifacts, which is
the evidence the move is content-neutral. Note the build emits minified output
that `oxfmt` then formats; comparing an unformatted build against the committed
artifact is not a meaningful diff.

**Docs, CI, coverage floors, mutation seeds, sonar scope, and knip config reflect the new shape; no non-historical doc references `tools/recognition-automations`.**
Path references were updated across `README.md`, `TESTING.md`, `CHANGELOG.md`
(an Unreleased entry naming the old asset path), `docs/recognition-automations.md`,
`docs/glossary.md`, `docs/photos-derived-ledger.md`, `docs/photos-dogfood.md`,
`docs/sonarcloud.md`, the weekly live-model workflow, the mutation seed (whose
id, label, and report artifact name all follow), the test-report scripts, and
the three `tests/*.json` knob files. `packages/automation/src/manifest/enricher-templates.test.ts`
built the old path from separate `"tools"` / `"recognition-automations"` string
segments, so it needed a hand edit rather than a path substitution. Receipts
and the historical `docs/decisions.md` / `CONSTITUTION.md` amendment rows were
deliberately left naming the old path — they are records of what was true when
written.

**Post-audit remediation.** A fresh-context audit of this change set (recorded
under `## Audit`) refuted three claims and found four real gaps, all fixed here
rather than argued away. (a) The third file of the amended directive,
`.governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/directive.yaml`,
still advertised `tools/*/src` as an enumerated source-tree class and as a
required Vitest instrumentation glob; leaving it stale would have violated the
constitution's cardinal rule, since it is part of the same directive as the
`check.sh` this change amends. It is now updated in the same commit. (b)
`docs/decisions.md` 724-4 asserted in the present tense that
`tools/recognition-automations` holds the build sources; it now names
`packages/model-runtime`, records the old name and the issue that retired it,
and states explicitly why the nested `runtime/` stays outside the workspace
set. The decision's substance is unchanged — this is a path correction, not a
re-decision. (c) `scripts/test-report/diff-coverage.mjs` still matched
`^(?:packages|apps|tools)/` when classifying instrumentable sources, and
`scripts/mutation/run.test.mjs` still accepted a seed `cwd` starting with
`tools/`; both now permit only `packages/` and `apps/`, so a future stray
`tools/` path fails rather than silently passing. The test title in
`scripts/test-report/diff-coverage-run.test.mjs` was corrected to match. (d)
`tests/quality/classification-ratchet.json` is named here as changed surface,
and the handler-artifact sentence above was corrected — the audit showed all
five artifacts change three lines, not one.

**Post-CI remediation — a third source-root enumeration the local gate cannot
see.** CI's `static` lane failed on `bun run lint:types`. The cause is the same
class of latent invariant this change set exists to remove:
`scripts/lint-types.sh`'s `assert_workspace_coverage` walks `packages/* apps/*`
and fails closed when a workspace has both `src/` and a `tsconfig.json` but is
absent from its explicit `TARGETS` list. Under `tools/` the package was never
walked, so the omission could not be observed; moving it to `packages/` made the
script correctly notice an untargeted TypeScript workspace. `packages/model-runtime`
is now listed in `TARGETS` and passes both type-aware passes clean, which is the
outcome the directive intends — the package gains type-aware lint coverage it
never had under the retired root, rather than being exempted from it.

This was invisible to the pre-push gate because `lint:types` is a `check:pr`
step, not a `check:push` step; `check:push` runs `lint:type-floor`, which is a
different gate. `lint:workflow-pins` is the only other `static` step outside
`check:push`, and it passes. That gap between the local push tier and the CI
`static` lane is a standing property of the tier budgets in
[docs/dev-environment.md](../docs/dev-environment.md#the-local-gate-loop), not
something this change introduced — but it is the reason this defect reached CI,
and it is worth knowing that a workspace-set change is precisely the kind of
edit whose blast radius escapes the push tier.

### Files — moved into `packages/model-runtime`

- `packages/model-runtime/.gitignore`
- `packages/model-runtime/LICENSES.md`
- `packages/model-runtime/README.md`
- `packages/model-runtime/automation-handlers/embed-image.js`
- `packages/model-runtime/automation-handlers/embed-text.js`
- `packages/model-runtime/automation-handlers/faces.js`
- `packages/model-runtime/automation-handlers/photo-ocr.js`
- `packages/model-runtime/automation-handlers/transcript.js`
- `packages/model-runtime/build-automation-handlers.ts`
- `packages/model-runtime/fixtures/README.md`
- `packages/model-runtime/fixtures/model-goldens.json`
- `packages/model-runtime/fixtures/ocr-golden.svg`
- `packages/model-runtime/fixtures/opencv-lena.jpg.base64`
- `packages/model-runtime/models.lock.json`
- `packages/model-runtime/ort-types.d.ts`
- `packages/model-runtime/package.json`
- `packages/model-runtime/runtime/package.json`
- `packages/model-runtime/setup.ts`
- `packages/model-runtime/src/capabilities/embed.test.ts`
- `packages/model-runtime/src/capabilities/embed.ts`
- `packages/model-runtime/src/capabilities/faces.ts`
- `packages/model-runtime/src/capabilities/ocr.test.ts`
- `packages/model-runtime/src/capabilities/ocr.ts`
- `packages/model-runtime/src/capabilities/transcript.test.ts`
- `packages/model-runtime/src/capabilities/transcript.ts`
- `packages/model-runtime/src/config.ts`
- `packages/model-runtime/src/ctc.test.ts`
- `packages/model-runtime/src/ctc.ts`
- `packages/model-runtime/src/face-geometry.test.ts`
- `packages/model-runtime/src/face-geometry.ts`
- `packages/model-runtime/src/image-geometry.test.ts`
- `packages/model-runtime/src/image-geometry.ts`
- `packages/model-runtime/src/model-goldens.live.test.ts`
- `packages/model-runtime/src/models-lock.test.ts`
- `packages/model-runtime/src/nms.test.ts`
- `packages/model-runtime/src/nms.ts`
- `packages/model-runtime/src/ocr-postprocess.test.ts`
- `packages/model-runtime/src/ocr-postprocess.ts`
- `packages/model-runtime/src/onnx.test.ts`
- `packages/model-runtime/src/onnx.ts`
- `packages/model-runtime/src/preprocess.test.ts`
- `packages/model-runtime/src/preprocess.ts`
- `packages/model-runtime/src/tokenizer.test.ts`
- `packages/model-runtime/src/tokenizer.ts`
- `packages/model-runtime/src/types.ts`
- `packages/model-runtime/stryker.config.mjs`
- `packages/model-runtime/tsconfig.json`
- `packages/model-runtime/vitest.config.ts`
- `packages/model-runtime/vitest.live.config.ts`
- `packages/model-runtime/vitest.mutation.config.ts`

### Files — updated in place

- `.github/workflows/enrichment-live-weekly.yml`
- `.governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/check.sh`
- `.governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/constitution.md`
- `CHANGELOG.md`
- `CONSTITUTION.md`
- `README.md`
- `TESTING.md`
- `bun.lock`
- `docs/glossary.md`
- `docs/photos-derived-ledger.md`
- `docs/photos-dogfood.md`
- `docs/recognition-automations.md`
- `docs/sonarcloud.md`
- `knip.json`
- `oxlint.config.ts`
- `package.json`
- `packages/automation/src/manifest/enricher-templates.test.ts`
- `packages/blueprints/automations/embed-image/automations/embed-image/handler.js`
- `packages/blueprints/automations/embed-text/automations/embed-text/handler.js`
- `packages/blueprints/automations/faces/automations/faces/handler.js`
- `packages/blueprints/automations/photo-ocr/automations/photo-ocr/handler.js`
- `packages/blueprints/automations/transcript/automations/transcript/handler.js`
- `scripts/ci/configure-sonarcloud.mjs`
- `scripts/lint-types.sh`
- `scripts/mutation/run.test.mjs`
- `scripts/mutation/seeds.mjs`
- `scripts/test-report/diff-coverage-run.test.mjs`
- `scripts/test-report/diff-coverage.test.mjs`
- `scripts/test-report/enrichment-live-run.mjs`
- `scripts/test-report/generate.mjs`
- `scripts/test-report/generate.test.mjs`
- `scripts/test-report/validate-nightly-wiring.mjs`
- `tests/coverage-floors.json`
- `tests/matrix.json`
- `tests/mutation-floors.json`
- `vitest.config.ts`

## Out of scope

- The automation engine, trigger kinds, and fire spine (`packages/automation` is
  untouched apart from one test's path construction).
- Lane (b) of the issue: co-locating handler sources under
  `packages/blueprints/automations/<id>/src/` plus the rebuild drift check.
- Lane (c2): the gateway-managed asset store under the data dir, the native-dep
  installer, and the `CENTRAID_AUTOMATION_RUNTIME_DIR` → `CENTRAID_MODEL_RUNTIME_DIR`
  rename. The env var keeps its current name in this change set.
- Lane (a): folding `packages/blob-format` into `packages/protocol`.
- The `packages/gateway` split and the two-CLI question, both named out of
  bounds by the issue.

## Verification

Replay with:

```sh
bun install
bun run --cwd packages/model-runtime typecheck
bun run --cwd packages/model-runtime test
bun run --cwd packages/model-runtime build:automations
bun run format
bun run knip
bun run lint:types
bun run lint:workflow-pins
bun run check:push
bash .governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/check.sh
```

- `bun install` — 1515 packages, no native ML dependency pulled (724-4 holds).
- `bun run --cwd packages/model-runtime typecheck` — pass.
- `bun run --cwd packages/model-runtime test` — 12 files, 91 tests passed.
- `bunx turbo run test --filter=@centraid/automation --filter=@centraid/model-runtime --filter=@centraid/blueprints` — 9 tasks successful; blueprints 100 files / 3375 tests.
- `bun run --cwd packages/model-runtime build:automations` then `bun run format` — rebuilt artifacts differ from the committed ones only in the renamed path strings described above.
- `bun run knip` — exit 0 (pre-existing configuration hints only).
- `bun run lint:packages` (sherif) — no issues found.
- `bun run lint:types` — 27 targets `ok`, including the newly listed
  `packages/model-runtime`; exit 0. This is the gate that failed in CI before
  `packages/model-runtime` was added to `TARGETS`, and it is not part of
  `check:push`.
- `bun run lint:workflow-pins` — 19 workflows clean; the only other `static`
  step outside `check:push`.
- `coverage-scope-reachability` — passes; `GOVERNANCE_COVERAGE_SCOPE_SELFTEST=1` still demonstrates red, now emitting the `packages/__coverage_scope_selftest_unowned__` synthetic id.
- `bun run check:push` — 37/39 gates passed in 206.6s. The two failures and
  their disposition are recorded under Decisions.
- `bunx turbo run test --filter=@centraid/app-engine` — 60 files, 632 tests
  passed, isolating the one `test:affected` failure as load-induced.

## Decisions

**Lane (b) is deferred, and the issue's placement for the model library was wrong.**
Issue #753 proposed moving handler sources into
`packages/blueprints/automations/<id>/src/`. Implementation contact refuted the
supporting half of that plan and weakened the rest. The handlers' real coupling
is to the model library (they import `../src/capabilities/*.js` and
`../src/onnx.js` directly), not to the blueprint that ships their artifact.
Relocating the sources alone would force either four-level cross-package
relative imports or a new exports map plus a `devDependency` edge from
`packages/blueprints` — a package consumed by mobile and client — onto
Node-flavoured model plumbing, with knip configuration to match. The
co-location benefit is better served by the rebuild drift check, which is
independent of where the source sits. Lane (b) therefore stays open as a
separate decision rather than shipping half of it here. This receipt records
the reversal; the issue should be updated before anyone picks lane (b) up.

**Lane (c2) is blocked, not skipped.** The gateway-managed asset store needs the
native-dependency trust model resolved first — that was flagged as open
question 1 on the issue and is a security posture (the gateway installing npm
packages onto a user's machine), not a refactor. Nothing in this change set
depends on it.

**Quality-knob deviation.** #753 re-pins the whole-file `tests/matrix.json` fingerprint after a pure one-to-one path rename (the `tools/recognition-automations` workspace became `packages/model-runtime`) in two law owners and one `workspaceSurfaces` lane key; the governed `qualities` / `demonstratedRed` payload is untouched, so `matrixGovernanceFingerprint` is unchanged and no floor, statement, flow, capability, or demonstrated-red date moved.

**`check:push` settles at 37/39; both remaining failures are environmental.**
An earlier run reported 36/39. The third failure then, `lint:quality-knobs`, was
genuinely caused by this change and is resolved by the re-pin recorded above
rather than by loosening a floor; it now passes. The two that remain do not.

`design:gallery` fails because Playwright's Chromium is absent at
`/opt/pw-browsers/chromium_headless_shell-1234/` in this container — an
environment gap, unrelated to the diff. It is not a CI gate on pull requests
either; no `static` step runs it.

`test:affected` fails on a single process-lifecycle test, and *which* one moves
between runs: `packages/design` `src/edge-upload.test.ts` on the first run,
`packages/agent-runtime`'s SIGTERM→SIGKILL teardown on the second,
`packages/app-engine` `src/handlers/handler-pool.test.ts > "a hung handler is
still terminated on timeout without poisoning the pool"` on the third. Each
passes in isolation — the app-engine package runs 632/632 green on this branch
under `bunx turbo run test --filter=@centraid/app-engine` — and each is a
timeout- or teardown-bounded assertion, the exact shape that goes red when a
loaded container starves a timer. None of the three packages is touched by this
change set. CI is the tiebreaker and agrees: the `verify` lane ran the full
suite under coverage and passed.

## Audit

Fresh-context audit of the staged diff against this receipt and issue #753.

REFUTED — Check 1, does `## What changed` faithfully describe the diff. Two
statements are contradicted by the diff itself. (a) "Rebuilding all five
handlers … produced exactly three changed lines in `photo-ocr` … with the other
four handlers changing only their banner" is false: all five staged
`handler.js` artifacts change three lines each — the banner plus the two-line
`RuntimeNotInstalledError` operator message inlined from
`packages/model-runtime/src/onnx.ts` (see the identical `-`/`+` pairs for
`'Run "bun run --cwd tools/recognition-automations setup" first …'` in
`packages/blueprints/automations/{embed-image,embed-text,faces,photo-ocr,transcript}/automations/*/handler.js`).
The substantive claim (changes are intended path strings only) holds, but the
per-file description does not. (b) "The directive's own `constitution.md` and
the `CONSTITUTION.md` directive body, rationale, and Evolution Log are updated
together" omits that the third file of the same directive,
`.governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/directive.yaml`,
is untouched and still advertises the two things the receipt says were dropped:
`tools/*/src` as an enumerated source-tree class (lines 6–7) and
`tools/*/src/**` as a required Vitest instrumentation glob (lines 16–18). It
now contradicts its own `check.sh` and `CONSTITUTION.md`. Minor: the
`### Files — updated in place` list omits `tests/quality/classification-ratchet.json`,
which the diff does modify (the re-pin is disclosed under `## Decisions`, so
this is incompleteness rather than concealment).

REFUTED — Check 2, is each `- [x]` item realized. Items 1, 3, 4 and most of 5
verify. Item 1: `tools/` is gone from the tree and from `git ls-files`, and
`package.json` `workspaces.packages` is now `["packages/*", "apps/*"]`. Item 3:
`packages/model-runtime/{package.json,models.lock.json,src/**,vitest.live.config.ts,vitest.mutation.config.ts,stryker.config.mjs}`
are present; the 724-4 claim is structurally sound — the staged `bun.lock` is
11+/11- across three hunks (workspace-entry rename and resolution alias only,
no dependency-graph change) and lists `packages/model-runtime` but not
`packages/model-runtime/runtime`, so the single-level `packages/*` glob does
not reach the ML dependency set in `packages/model-runtime/runtime/package.json`.
Item 4: verified content-neutral apart from path strings (see Check 1 for the
inaccurate count). Item 2 is NOT fully realized: the directive was amended in
`check.sh` and `constitution.md` but its `directive.yaml` still states the
retired `tools/*/src` rule (evidence above), so the directive's own text no
longer matches the check it ships with. Item 5 is partially unrealized: the
retired root also survives in `scripts/test-report/diff-coverage.mjs:72,79`
(`isInstrumentableSource` still matches `^(?:packages|apps|tools)/` under a
doc-comment claiming it "aligns with root vitest coverage include", which this
diff just narrowed), in the test title at
`scripts/test-report/diff-coverage-run.test.mjs:68`, and in
`scripts/mutation/run.test.mjs:82` (`seed.cwd.startsWith("tools/")` is still an
accepted seed prefix). The four `- [ ]` items were confirmed genuinely not
done, with no silent credit taken: no `packages/blueprints/automations/*/src/`
directory exists, `CENTRAID_MODEL_RUNTIME_DIR` appears nowhere in the tree
while `CENTRAID_AUTOMATION_RUNTIME_DIR` remains in `src/config.ts` and all five
handlers, and `packages/blob-format` still exists. Independently re-verified
claims: the `coverage-scope-reachability` check passes and its self-test still
demonstrates red with the `packages/` synthetic id; `scripts/check-quality-knobs.mjs`
exits 0; the re-pin in `tests/quality/classification-ratchet.json` is a genuine
one-to-one rename that widens nothing — the recomputed governed payload hash
over `{qualities, demonstratedRed}` is `22c1e4c9…f3db`, identical to the
committed `matrixGovernanceFingerprint`, the three changed `tests/matrix.json`
lines are all in `laws` owners and one `workspaceSurfaces` key (outside the
governed payload), and the floors in `tests/coverage-floors.json` (66/49) and
`tests/mutation-floors.json` (80) are byte-identical apart from their key.

REFUTED — Check 3, does `## Checklist` mirror issue #753's acceptance criteria.
Three of the issue's eight criteria are not faithfully carried over. (a) "Capture
OCR and recognition automations pass end-to-end against the data-dir store (the
#731 browser-proof flow re-run)" has no corresponding checklist line at all,
checked or deferred. (b) "Installation happens only on explicit user action" is
dropped from the merged deferred item on line 19, which keeps only the
lockfile-hash half of that criterion. (c) The issue's "ARCHITECTURE.md layout,
docs/recognition-automations.md, and decisions pointers reflect the new shape;
no doc references `tools/recognition-automations`" is restated as "no
non-historical doc references", and the "decisions pointers" clause is dropped —
yet the issue's lane (d) explicitly required "Rename/retire decision 724-4's
path reference in docs", and `docs/decisions.md:402` still asserts in the
present tense that "`tools/recognition-automations` holds TypeScript build
sources and local assets … isolated to its non-workspace `runtime/` directory".
That row now names a path that does not exist. (ARCHITECTURE.md needed no edit:
its layout tree never listed `tools/`, and its `packages/` block is a selective
list that also omits several existing packages.) The remaining criteria map
cleanly, and the receipt's extra item 4 (rebuild differs only in intended path
strings) is a reasonable restatement of the byte-identity half of criterion 3
given lane (b)'s deferral.

Must fix before publication: (1) correct the handler-diff sentence in
`## What changed` — all five handlers changed banner + the two-line runtime
error message; (2) amend
`.governance/packs/srikanth235/centraid/directives/coverage-scope-reachability/directive.yaml`
in this same commit so the directive's summary matches its `check.sh`, per the
constitution's cardinal rule; (3) update `docs/decisions.md` 724-4's live path
reference (explicitly in scope per the issue) or state in the receipt why the
row is being kept verbatim; (4) drop the stale `tools/` handling in
`scripts/test-report/diff-coverage.mjs` and `scripts/mutation/run.test.mjs`;
(5) add `tests/quality/classification-ratchet.json` to the updated-in-place file
list, and add checklist lines for the two unrepresented issue criteria.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-12 | claude-code | 802618c9-428c-5b9d-9db6-12d3ab2ed1cd |
