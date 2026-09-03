# issue-931 — four gates that enforce nowhere

[#931](https://github.com/srikanth235/centraid/issues/931) is a bug issue, so it
carries no acceptance-criteria checkboxes. The checklist below is its
**Expected** section written as four items, plus items 5 and 6 added in its
comments.

## Checklist

- [x] `lint:test-reachability` is in the `lint:product` bundle and every test file is reached by a runner
- [x] no `\x00` in a tracked text file, proved by a seeded case
- [x] `design:gallery` skips with a reason locally and stays fatal under `CI`
- [x] `candidate.yml` runs the rung-1 bundle and the commit-message check on the merged tip
- [x] the JS bundle fingerprint ignores test, spec, fixture and markdown modules
- [x] the rung-2 wall clock excludes runner queue wait without widening the ceiling
- [ ] item 7, load-sensitive timeouts — not this slice's; see `## Out of scope`
- [x] granted addition A: a data client is not a surface, expressed as an exclusion of the subtrees that draw nothing
- [ ] granted addition B: `test:fuzz:replay` green — the `wal-keys` target is filed as a finding, not fixed

## What changed

**1. Orphan test files — `scripts/lint-test-reachability.mjs`.** A new rung-1
contract gate: every `*.test.*` / `*.spec.*` file in the tree must be reached by
a runner. Reached means one of three things — matched by some vitest project's
`include` (and not removed by its `exclude`), named as an argument in a root
`package.json` script (that is how the `node --test` lanes take their files), or
sitting under a Playwright `testDir` and matching Playwright's spec pattern.

It runs under **bun**, not node, and that is load-bearing: the vitest configs are
TypeScript modules that compose each other — `apps/mobile/vitest.projects.ts`
builds its two projects out of one shared `nativeComponentFiles` array — so the
only faithful reading of an `include` is the object vitest itself would receive.
A regex over the config text answers a different question and goes wrong the
first time a project list is computed rather than written out. `RUNNERS` records
each entry-point config **with the working directory its lane runs from**,
because vitest resolves a project's `include` against a root that defaults to the
process CWD, not to the config file's folder (this is why
`packages/model-runtime/vitest.live.config.ts` is listed with
`cwd: packages/model-runtime`, and why `tests/integration-mobile/vitest.config.ts`
pins its own `root`). `assertEveryConfigModelled` fails when a
`vitest*.config.ts` appears that is neither a listed runner, nor a config a
runner composes, nor a Stryker/derived-coverage shape, so the table cannot fall
behind the tree in silence.

`scripts/lint-test-reachability.test.mjs` carries the seeded-red case the issue
asks for: an unlisted `scripts/foo.test.mjs` is reported as an orphan, and the
same file stops being reported the moment `scripts:test` hands it to
`node --test`. It also pins the glob compiler (`**`, `{a,b}`, `?(…)`, `@(…)`,
character classes; an unsupported extglob throws rather than compiling to
something that matches too much), the include/exclude interplay that the mobile
stub/RNTL split depends on, the Playwright `testDir` forms, and a live run of the
gate on this tree.

**The orphan it found, and the fix.** Run over 1,710 test files, the gate
reported exactly **one** orphan: `scripts/gateway-npm/publish.test.mjs` — four
`node:test` cases pinning `publish.mjs`'s refusal contract (it aborts before the
first `npm publish` spawn), sitting in no vitest project and named by no script.
`gateway:npm:helpers:test` in `package.json` — which
`.github/workflows/lane-release-gateway-npm.yml` runs — now names it beside
`pack-helpers.test.mjs` and `native-platforms.test.mjs`. Wired, not deleted, and
not converted.

**2. NUL bytes — `scripts/lint-no-nul-bytes.mjs`.** A second rung-1 contract
gate over every tracked file whose extension is not binary. The skip list is
**stated, not sniffed**, because "does it contain a NUL" is precisely the
question and cannot also be how the file is classified: `.bin .gz .icns .ico
.jar .jpeg .jpg .keystore .node .png .ttf .wasm .webp .woff .woff2` — the images
and app icons, the vendored web fonts, the Android keystore and gradle wrapper
jar, the wasm-bindgen bundle, the fuzz corpus seeds and the gzipped golden
vaults under `packages/vault/tests/golden/`. `scripts/lint-no-nul-bytes.test.mjs`
seeds the red directly: the `${a}\x00${b}` composite-key idiom fails with its
line and column, and the same line written with `\0` passes.

**The twelve hits, all fixed by escaping.** The gate found twelve tracked text
files carrying raw NULs, every one of them the same composite-key delimiter
idiom typed literally. Each is now `\0`, which is the same byte to the program
and ordinary text to git:

- `packages/vault/src/grant/authority-registry.ts` — the `BY_KEY` composite key
  the issue's third comment names (byte-identical on `origin/main`, so a kilobyte
  of #928 w1c grant-authority edits had been unreviewable).
- `packages/vault/src/grant/fulfillment.ts`, `packages/vault/src/gateway/ext.ts`,
  `packages/vault/src/enrich/clusters.ts`,
  `packages/vault/src/golden-snapshot.ts` — Map keys and hash separators.
- `packages/client/src/gateway-client-conversation-history.ts` — the attachment
  URL cache key.
- `packages/server/src/serve/support-bundle.ts` — the log bucket key.
- `packages/blueprints/src/photos-selection-bar.test.ts`,
  `tests/quality/user-facing-qualities.test.ts` — test-side keys.
- `scripts/security/supply-chain-core.mjs` — the provenance invocation id.
- `scripts/fuzz/mutate.mjs` — a NUL string in the fuzz value table.
- `packages/core/src/protocol/trace.ts` — the attribute-set join separator. This
  one arrived DURING the slice: it landed on `main` with
  [#927](https://github.com/srikanth235/centraid/issues/927)'s trace contract
  while this branch was open, and the rebase onto the new tip turned the gate red
  immediately. That is the gate working, one commit after it exists; the escape
  is the same two characters and `bun run --cwd packages/core test -- trace`
  stays green at 45 cases.

No behaviour changes: `"\0"` and a raw NUL are the same string, so every digest,
Map key and golden fingerprint is unmoved. The one tracked text file left
holding a NUL is `receipts/issue-573-toolchain-opinions-one-shot.md`, named as a
single-path exemption with its reason (see `## Decisions`); the entry is one
path, not a folder, so a NUL in a receipt that has not merged yet is still
caught.

**3. `design:gallery` — skip with a reason, fatal under CI.** The decision lives
in a new sibling module, `scripts/design-gallery-browser.mjs` — beside
`design-gallery-fidelity.mjs` and `design-gallery-lowering.mjs`, because
`scripts/design-gallery.mjs` was already within thirty lines of `repo-hygiene`'s
file-size ceiling and a decision this consequential reads better on its own.
`scripts/design-gallery.mjs` now asks `unrunnableVerdict(chromium)` before it
builds anything, and takes its launch options from `launchOptions()`.
`scripts/design-gallery-browser.test.mjs` (wired into `scripts:test`, as this
slice's own reachability gate requires) pins all three outcomes: a present
browser runs, an absent one with `CI` unset yields a non-fatal message naming
both fixes, and the same absence under `CI` yields the fatal `::error`
annotation. Run for real: locally the gate prints
`design:gallery: SKIPPED — <reason>` naming both fixes
(`bunx playwright install chromium`, or `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`)
and exits 0; under `CI` the same tree exits 1 with the annotation, because there
a missing browser means the workflow is misconfigured. This is
[#668](https://github.com/srikanth235/centraid/issues/668)'s `lint:node-version`
ruling applied to the same shape — one claim about the tree fused to one claim
about the machine, the second one making the first unrunnable, and a gate that
only ever fails for a reason unrelated to your diff being the gate that teaches
`--no-verify`.

`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` is honoured before the pinned download is
looked for, and passed to `chromium.launch({ executablePath })`. It is a NEW
name and not a duplicate: `git log origin/main -- apps/web/playwright.config.ts`
shows no such env, the #922 0a branch has not landed (no `claude/922-w1-0a-*`
ref exists on the remote), and Playwright's own `PLAYWRIGHT_BROWSERS_PATH`
answers a different question — it redirects the whole browsers directory and
already works with no code, whereas this container has a Chromium at build 1194
while the pinned Playwright asks for 1234. Nothing else in the file moves.

**4. Rung-1 gates on `main` — `candidate.yml`'s `rung1-on-main`.** One new job,
as the root's grant allows: harden-runner, checkout, the setup action, then
`bun run lint:product` and `bash .governance/run.sh commit-message-format` on the
merged tip, then the standard `Write lane evidence` step and evidence artifact.
`.governance/run.sh` accepts a bare directive id, so the second step is a
single-directive invocation and not a whole governance run. On `main` the
directive's merge-base search finds `origin/main` at HEAD, falls through every
candidate, and takes its documented HEAD fallback — which validates the SQUASH
subject the commit-msg hook never sees (#916 merged at 105 characters against a
100-character rule). `rung1-on-main` joins `promote`'s `needs:`, so red blocks
the promotion and is attributed through the existing
`[candidate] lane red — <lane>` rolling-issue loop with no new mechanism.
`tests/claims.json#lanes` gains the matching registry row (rung 3, platform
`any`, 1,200,000 ms, `contracts` over `vault` / `gateway` / `protocol` — the
three engine surfaces whose route, SQL, engine-conformance and ledger contracts
the bundle actually checks). `lint:workflow-pins`, `lint:path-filters`,
`lint:evidence-mapping` and `test:claims` all accept it.

**5. `apps/mobile/scripts/js-bundle-fingerprint.mjs` — test edits stop moving the
apk key.** `isBundleInput` drops `*.test.*`, `*.spec.*`, `*.test-fixtures.*`,
`__tests__/**` and `**/*.md` from the hashed inputs — the same shape
`G-turbo-inputs` (#915) applied to the build hash. A Hermes release bundle is
reachable from `index.ts`, so none of the excluded files can be inside the
artifact and the exclusion cannot produce a stale hit; the module's documented
over-approximation gets narrower, not wrong.
Measured on this tree: the hashed input set drops from **2,730 files to 1,935** (795 test, spec, fixture and markdown modules), and the digest is now blind to every one of them. `apps/mobile/scripts/js-bundle-fingerprint.test.mjs` proves both directions: a
test, spec, fixture or markdown edit under a bundled workspace package leaves the
digest unchanged, a `src` edit still moves it, and the live `bundleInputFiles()`
sweep contains nothing the filter would reject.

**6. `scripts/ci/pr-gate-wall-clock.mjs` — the budget prices work, not backlog.**
`wallClockMs` now returns the **union of the jobs' `started_at → completed_at`
intervals** as `ms` (the budgeted number), plus `spanMs` and `queuedMs` for the
summary. Overlapping lanes collapse into one interval exactly as before, so
parallelism is worth what it was and a genuinely slow gate is charged for every
minute; what is no longer charged is the gaps in which no gate job was running at
all. `tests/budgets.json` is **untouched** — the ceiling is the same 900,000 ms,
measured honestly. `scripts/ci/pr-gate-wall-clock.test.mjs` adds the fixture the
comment asks for (7 min + 7 min of work inside a 26-minute span: the old metric
fails it, the new one passes at 14 min), a case proving a lane running through
another's wait is still counted as work, and the summary's new queue line.
`docs/dev-environment.md` § "The rung-2 budget is enforced on the run that spends
it" and `TESTING.md` § suite wall-clock (the `pr-gate` paragraph, and the
`lanes["pr-gate"]` note below it) are rewritten to state the new metric, why it
changed, and that the ceiling did not move.

**Registration.** `scripts/lint-product.mjs` gains both new gates and
`scripts/ci/gate-classes.json` classifies both (contract, rung 1, with reasons);
`package.json` gains `lint:test-reachability` and `lint:no-nul-bytes`, adds both
`.test.mjs` files to the `scripts:test` `node --test` list, and adds
`publish.test.mjs` to `gateway:npm:helpers:test`.
`tests/quality/classification-ratchet.json` re-pins the `tests/claims.json`
whole-file fingerprint (`76aac1a07f17…` → `56f64c948746…`) with the reason in
`approvedDeviation`.

**Granted addition A — `check:ui-receipt`: a data client is not a surface.**
(Not one of the issue's numbered items; the issue's item 7 is load-sensitive
timeouts, which is out of scope below.) Granted into this
slice by the program root after the collision below was reported, and made the
way [#930](https://github.com/srikanth235/centraid/issues/930) made its
neighbour one commit earlier: by narrowing WHICH files are surfaces, never by
touching what a surface change owes. `scripts/validate-ui-receipt.mjs`'s
predicate treated every path under `packages/client/` as user-facing, so a
two-character NUL escape in an attachment-URL cache key demanded a screenshot of
a screen that had not moved.

**It is written as an EXCLUSION, not an allowlist, and the first attempt was
wrong.** That attempt kept `packages/client/src/react/**` plus the package's
stylesheets and dropped everything else — which would have stopped watching
`src/home-copy.ts` (the single spelling of every Home string), `src/icons.ts`
(innerHTML'd, member-visible SVG), `src/theme-vars.ts` (the token CSS applied
before first paint), `src/index.html` (the shell document) and eight further
`*-copy.ts` modules. The verifier caught it. The default therefore stays exactly
what it was — every path under `packages/client` is a surface — and
`CLIENT_NOT_A_SURFACE` names only the paths READ and confirmed to render
nothing: `src/replica/**`; the `src/gateway-client*.ts` family (the renderer's
HTTP client hub and its per-surface modules); beside them `gateway-auth.ts`,
`turn-stream.ts`, `vault-change-feed.ts`, `vault-change-sse.ts`,
`version-handshake.ts`, `device-blob-source.ts`, `device-enrichment-worker.ts`
and `device-roster.ts`; and, by file name only, the inline query engine
`react/blueprints/inlineQueryCtx.ts` and `inline-query-ctx-core*.ts`.
`status-channel.ts` was checked and LEFT OUT of the list, because it carries an
`"Undo"` action label, and `device-enrichment-compute.ts` was left out as
borderline — keeping a file as a surface is never a hole. On this formulation,
nothing exits the gate that could not exit it before: the exclusion removes
files from the watched set, it never adds an exit from the screenshot
requirement. The screenshot rule, the changed-emitter rule, the `apps/*` rule
and the blueprints test/fixture exclusion are all byte-identical.

**HOW the exclusions were checked, and the second thing the sweep found.** The
first pass said each was "checked for DOM calls, markup and user-visible
strings"; that was true of the DOM and markup half and not of the third, and the
verifier found two files holding member copy. The sweep was then redone
mechanically: `validateUiReceipt` was probed over all 800 tracked
`packages/client` paths to produce the exact excluded set, and every excluded
file was scanned for prose-shaped string literals (a quoted run of two or more
words, minus identifiers, MIME types and URLs) plus `innerHTML` /
`document.createElement` / `document.body`. Each hit was then judged by ONE
question, with the consumers grepped:

> Is this string composed for a member to read, or is it a diagnostic
> explaining a fault to whoever is debugging?

That line matters because `react/shell/ErrorBoundary.tsx:79` and several toasts
render `error.message` verbatim. Every module in this package throws, so "a
thrown string can reach a screen" would put the whole package back in the
watched set and make a refinement of this shape impossible for anyone. Composed
copy is the test; an echoed diagnostic is not.

**Three files carved BACK IN** (`CLIENT_COPY_EXCEPTIONS`, checked before the
patterns so a pattern can never win over one of them):

| file | why it draws |
| --- | --- |
| `src/replica/rebootstrap-copy.ts` | Its header is "WHAT A MEMBER IS TOLD WHEN THEIR REPLICA STARTS OVER (#883 C6)"; it holds the notice `headline`/`detail` strings, e.g. "This device is downloading its whole library again — your unsent changes stay queued." Found by the verifier. |
| `src/gateway-client-edges.ts` | `RECOVERY_REFUSALS` (lines 180-188), commented "the member reads a reason, not a code": "You already run this shared space." and three siblings, thrown at line 219 and read by `react/shell/routes/InlineAppRoute.tsx`. Found by the verifier. |
| `src/gateway-client-push.ts` | `registration.showNotification(reminder.title, { body: … "Task reminder" })` at line 133 — a Web Push body a member reads on a lock screen. Found by this sweep. |

For `gateway-client-edges.ts` the alternative was to move `RECOVERY_REFUSALS`
into a `*-copy.ts` module. Carving out by name is what shipped: moving it is a
product refactor across two files undertaken for a gate's convenience, and
leaving the module watched is the conservative direction — a false demand costs
a screenshot, a missed surface costs the gate.

**The verdicts on the rest.** After the carve-outs, 126 of 800 tracked
`packages/client` paths are excluded: 52 are `*.test.*` / `*.d.ts` and 74 are
source modules (45 directly under `src/`, 80 under `src/replica/` counting its
suites, 1 under `react/blueprints/`). Every prose-shaped literal in them falls
into one of four groups, and none is composed member copy:

| group | files | verdict |
| --- | --- | --- |
| **Request labels** — the second argument of the shared `request(…)` helper ("read atlas stats", "mint pairing ticket", "rename installed app", …) | every `gateway-client-*.ts` | Not a surface. They name the call for the thrown `GatewayClientError`; no UI reads them. |
| **Thrown invariants and parse failures** — "Intent id … was reused with another payload", "Replica bootstrap page is malformed", "Shape schema does not contain …", "provider did not honor CBSF range read" | `replica/{intent-store,memory-intent-store,query,read-plan,read-plan-clauses,store-core,windowed-bootstrap,shell-transport,sqlite-worker,storage-manifest,search,payload-hash,write-helpers}.ts`, `device-blob-source.ts`, `vault-change-{feed,sse}.ts`, `gateway-client-core.ts` | Not a surface. Diagnostics; reachable only through the generic `error.message` echo, which is the fallback path this rule deliberately does not count. |
| **The three the verifier flagged as borderline** — `replica/shell-session.ts:316` "The pending row is no longer available to edit" and its sibling admission reasons ("waiting for a connection", "saved locally; …"), `replica/search-refused-error.ts`, `replica/online-only-error.ts` | `replica/shell-session.ts`, `replica/search-refused-error.ts`, `replica/online-only-error.ts` | Not a surface, grepped: `ShellReplicaWriteResult` — the type carrying `reason` — appears nowhere outside `shell-session.ts` and its own contract tests, so no renderer reads those strings; the two error classes are `Error` subclasses whose messages are prefixed diagnostics ("Search refused in this scope: …", "Query requires the online vault: …") consumed by `catch` blocks that substitute their own copy. If any is ever surfaced verbatim, the same carve-out applies. |
| **Comments and internal defaults** — `replica/coordinator.ts:65` "the device is out of room" (a JSDoc line), `replica/intents.ts:376` `reason = "recovered after reload"` (a ledger field), `gateway-client-seam-fixtures.ts` / `gateway-client-contract-fixtures.ts` (test doubles) | as listed | Not a surface. Nothing is rendered; the fixture modules are test scaffolding. |

**The inline query engine (#922 wave 1).** The root added one case from the
Metro re-verifier: `react/blueprints/inlineQueryCtx.ts` draws nothing — it plans
replica reads — but the folder is a surface, so the ctx-core refactor was made to
photograph a screen that had not changed. It is excluded BY FILE NAME
(`inlineQueryCtx.ts` and `inline-query-ctx-core*.ts`, the modules that refactor
extracts), never by folder: `centraid-inline.ts` beside it posts status a member
reads and `kit-ask-inline.ts` holds "Ask your <app>", so a folder exclusion would
be the allowlist mistake again in a smaller box.

`scripts/validate-ui-receipt.test.mjs` — the `node:test` file #930 wired into
`scripts:test` — carries both directions, widened after each audit. The drawing
case asserts that `src/react/Shell.tsx`, `src/react/screens/Home.tsx`,
`src/styles.css`, `src/home-copy.ts`, `src/icons.ts`, `src/theme-vars.ts`,
`src/index.html`, `src/status-channel.ts`, `src/replica/rebootstrap-copy.ts`,
`src/gateway-client-edges.ts`, `src/gateway-client-push.ts` and
`src/react/blueprints/centraid-inline.ts` each still demand the screenshot; the
transport case asserts that `gateway-client-conversation-history.ts`,
`gateway-client.ts`, `replica/apply.ts`, `turn-stream.ts`,
`version-handshake.ts`, `react/blueprints/inlineQueryCtx.ts` and
`react/blueprints/inline-query-ctx-core.ts` together demand none.

**Granted addition B — `test:fuzz:replay`: the `wal-keys` target, filed rather
than patched.**
`scripts/fuzz/targets-storage.mjs` imports `parseWalPairMarkerKey` and
`walPairMarkerKey` from `packages/backup/dist/wal-format.js`. `git log -S
parseWalPairMarkerKey` names the commit: `cf616a09a`, #916's ontology close,
which deleted `journal.db` and collapsed the WAL pair marker into ONE TICK
MARKER PER GENERATION. That is a contract change, not a rename, on three axes at
once — `WalDbName` went from `"vault" | "journal"` to `"vault"`;
`WalPairMarker`/`WalPairMarkerAddress` (`{vaultGeneration, journalGeneration,
tickMs}`) became `WalTickMarkerAddress` (`{generation, tickMs}`); and
`walPairMarkerKey(marker: {…})` became `walTickMarkerKey(addr:
WalTickMarkerAddress)`. The target's invariants assert exactly the fields that
were removed (`marker.vaultGeneration`, `marker.journalGeneration`, and
`db === "vault" || db === "journal"` in the segment and closer checks), so
re-pointing the import would not restore the lane — it would assert a contract
the product no longer has. Per the root's bound, it is a **finding, not a fix**:
the import is left as it is and the lane stays red rather than being stubbed.
Deciding what the tick-marker key parser should now be fuzzed for belongs with
the owner of the marker contract.

**Which rung runs `test:fuzz:replay` today: rung 4.** `e2e.yml`'s
`fuzz-parsers` job runs `bun run test:fuzz` and then `bun run test:fuzz:replay`
`if: always()`, nightly, against the resolved candidate. It is therefore not
enforced nowhere, and it is NOT added to `rung1-on-main`: that job deliberately
pays no `bun run build`, and five of the six fuzz targets import each package's
built `dist`. What IS wrong is the claim in that job's comment — "the PR-path
guard is `test:fuzz:replay`, which replays only the committed crashers and
finishes in a second" — which describes a PR lane that does not exist. That
sentence is #931's own class and is filed for the workflow owner rather than
edited here.

**This receipt.** `receipts/issue-931-gates-that-enforce-nowhere.md` is new, so it
is not yet frozen by `doc-integrity`; the NUL gate's own test asserts that an
unmerged receipt at exactly this path is still scanned, so the single-path
exemption above cannot generalise into a folder.

## Out of scope

- **The issue's item 7, load-sensitive timeouts.** Filed on #931 as
  [comment 5525336103](https://github.com/srikanth235/centraid/issues/931#issuecomment-5525336103):
  on PR #948 head `61973cef5`, `coverage-shard (4)` failed with two 30 s
  timeouts in `packages/server/src/serve/vault-registry.test.ts:200` and `:318`
  on a shard whose wall time was 912 s against 2,783 s cumulative test time,
  and the same shard passed minutes earlier on the same base. It arrived after
  this slice's contract was set and its candidate fixes (a per-file timeout
  that scales with observed shard load, or moving the two restart/listener
  scenarios off a four-way coverage shard) are lane-shape decisions; it belongs
  to the wave-2 contract, not here.
- **The `wal-keys` fuzz target's invariants.** `scripts/fuzz/targets-storage.mjs`
  is left exactly as it is: the tick-marker contract that replaced the pair
  marker is #916's, and choosing what to fuzz it for is a decision for that
  contract's owner, not a rename this slice can apply.
- The `fuzz-parsers` comment in `.github/workflows/e2e.yml` that claims a
  PR-path guard which does not exist — filed, not edited.
- Any product code beyond the NUL escapes; `.governance/**` (read, never
  edited); any budget, floor or ratchet NUMBER — `tests/budgets.json`,
  `tests/floors.json` and `tests/inventory.json` are untouched.
- Item 4's `.github/workflows/candidate.yml` edit is normally
  [#927](https://github.com/srikanth235/centraid/issues/927)'s file; the program
  root granted it into this slice, capped at one new job, with #927 w2 not yet
  started.

## Decisions

**#930 re-pins the tests/claims.json whole-file fingerprint after removing the spent rename marker on the `golden-vault-archaeology` flow, superseding the #916 re-pin note rather than contradicting it — every sentence of #916's account of what that flow took over is kept, in receipts/issue-916-vault-ontology-review.md and in the flow's own `_comment`. `replacesMinimumTestsFlow` is a ONE-SHOT claim about the change set that makes a rename, checked against the merge base; once #916 landed, `schema-migration-corpus` existed at no base any more, so the marker could only ever report an unknown predecessor and `lint:ledgers` / `test:ratchet` were red on main itself. The marker and the `approvedMinimumTestsDeviation` that authorized it are removed together, because that note waives a future minimumTests drop on this flow by presence alone; the floor stays at 5, no claim row, severity, evidence selector or demonstrated-red date moves, and claimsGovernanceFingerprint is unchanged. Prior: #916. #928 w1b re-pins tests/claims.json once more, for the static app entity tripwire: it registers the new law `app-entity-tripwire` and its flow `blueprint-app-entity-tripwire-law` (owner packages/blueprints/src/app-entity-tripwire.test.ts, minimumTests 17), mirroring how `one-computation` is registered so the lane is owned. Additions to the law and flow registries only, and a NEW minimumTests floor, which is a tightening — no claim row, severity, evidence selector, demonstrated-red date or existing floor moves, and the 45 claim rows stay byte-identical, so claimsGovernanceFingerprint is unchanged. Prior: #930. #931 re-pins it once more after registering ONE new rung-3 lane, `rung1-on-main`, in `lanes` — the row `candidate.yml`'s new job needs before `lint:evidence-mapping` and `validate-nightly-wiring` will accept it. Registry addition only: no claim row, severity, evidence selector, demonstrated-red date, law, flow or `minimumTests` floor moves, and `claimsGovernanceFingerprint` (a digest of `claims.claims` alone) stays byte-identical — the whole-file digest moved only because `lanes` shares the file with `claims`. Prior: #928 w1b.**

- **The `tests/quality/classification-ratchet.json` re-pin carries root sign-off.**
  It is not a widened ceiling: the whole-file `tests/claims.json` digest had to
  move because `candidate.yml`'s new `rung1-on-main` job needs a `lanes` row, and
  `lanes` shares the file with `claims`. `approvedDeviation` carries the reason
  and chains after #928 w1b's note; the same text is quoted verbatim in
  `## Decisions` above, which is what `check-quality-knobs.mjs` requires. It was
  reported to the program root as a seam touched outside the original contract in
  the first slice report, and the root signed off by granting the
  `candidate.yml` job that requires the row and directing the slice forward
  through two verifier rounds without reversing it.
- **The gate runs under bun.** `lint:test-reachability` is the one member of
  `lint:product` invoked as `bun scripts/…` rather than `node scripts/…`
  (`lint:site-tokens` already sets that precedent). The alternative — a regex over
  the config text — cannot read `apps/mobile/vitest.projects.ts`'s computed
  project pair, and a reachability gate that over-matches reports every orphan as
  reached.
- **One named NUL exemption, `receipts/issue-573-toolchain-opinions-one-shot.md`.**
  Its NUL sits inside prose describing this exact idiom, and `receipts/*.md` are
  frozen at the default-branch baseline by the `doc-integrity` directive: the
  bytes on `main` may not be rewritten, only appended to. The gate cannot demand a
  fix that governance forbids. The entry names one path rather than the folder, so
  a NUL in an unmerged receipt is still caught while its author can still fix it.
- **`check:ui-receipt`: a data client is not a surface (predicate refinement, not
  a waiver), and it is an exclusion list on purpose.** Reported to the root as a
  collision and granted back into this slice, since
  `scripts/validate-ui-receipt.mjs` is a gate script and #931 is the gates issue.
  The precedent is #930's, one commit earlier and the same sentence shape: "a
  suite is not a surface" narrowed `packages/blueprints/apps/**` after every
  repair of an over-long test file had to photograph a screen that had not moved.
  The first attempt here inverted that — an allowlist of `src/react/**` plus
  stylesheets — and the verifier refuted it: most of what a member reads in this
  package (`home-copy.ts`, `icons.ts`, `theme-vars.ts`, `index.html`, the eight
  other `*-copy.ts` modules) lives outside `src/react/**`, so the allowlist
  stopped watching files that draw. The shipped form keeps the old default and
  subtracts only paths read and confirmed to render nothing, which is what makes
  "nothing exits this gate that could not exit it before" true: subtracting from
  the watched set cannot create an exit from the screenshot requirement, and a
  file left in the set is at worst a false demand, never a silent hole. The
  second verification then found the same class of hole twice more inside the
  exclusions, so the sweep was redone mechanically over all 800 tracked paths
  with the consumers grepped, and three files were carved back in — the rule it
  settled on, and why an echoed `error.message` does not make a module a
  surface, is written above and in the script's own header.
- **The `react/blueprints/` exclusion is by file name, never by folder.** The
  #922 wave-1 ctx-core refactor is the case the root brought: `inlineQueryCtx.ts`
  plans replica reads and draws nothing, yet the folder is a surface. Excluding
  the folder would repeat the allowlist mistake in a smaller box —
  `centraid-inline.ts` posts status a member reads and `kit-ask-inline.ts` holds
  "Ask your <app>" — so only the engine modules are named, and a test pins that
  `centraid-inline.ts` still demands evidence while `inlineQueryCtx.ts` does not.
- **`test:fuzz:replay` stays red, deliberately.** The alternative — re-pointing
  the import at `parseWalTickMarkerKey` — would leave the target asserting
  `marker.vaultGeneration` and `db === "journal"`, fields #916 deleted, so the
  lane would go green only if the invariants were rewritten too. Rewriting a
  fuzz target's invariants is a claim about what the new contract guarantees,
  and this slice has no standing to make it. Stubbing the import was never an
  option: a fuzz target that imports nothing proves nothing.
- **`RUNNERS` records a `cwd` per config.** Not decoration: with the repo root as
  CWD, `packages/model-runtime/vitest.live.config.ts`'s `src/**/*.live.test.ts`
  resolves against the repo root and matches nothing, and
  `model-goldens.live.test.ts` reads as an orphan. The lane's working directory is
  part of what the config means, so it is recorded beside it.

## Verification

Each box above, and the command that shows it:

- `lint:test-reachability` is in the `lint:product` bundle and every test file is reached by a runner — `bun run lint:product` (41 gates) and `bun scripts/lint-test-reachability.mjs`.
- no `\x00` in a tracked text file, proved by a seeded case — `node scripts/lint-no-nul-bytes.mjs` and `node --test scripts/lint-no-nul-bytes.test.mjs`.
- `design:gallery` skips with a reason locally and stays fatal under `CI` — `bun run design:gallery` and `CI=1 bun run design:gallery`, plus `node --test scripts/design-gallery-browser.test.mjs`.
- `candidate.yml` runs the rung-1 bundle and the commit-message check on the merged tip — `bun run test:claims`, `bun run lint:evidence-mapping`, `bun run lint:workflow-pins`, `bun run lint:path-filters`.
- the JS bundle fingerprint ignores test, spec, fixture and markdown modules — `bun run --cwd apps/mobile test -- js-bundle-fingerprint` (15 cases).
- the rung-2 wall clock excludes runner queue wait without widening the ceiling — `node --test scripts/ci/pr-gate-wall-clock.test.mjs` (8 cases), `tests/budgets.json` unchanged.
- granted addition A: a data client is not a surface, expressed as an exclusion of the subtrees that draw nothing — `node --test scripts/validate-ui-receipt.test.mjs` (7 cases) and `bun run check:ui-receipt`.

```
$ bun scripts/lint-test-reachability.mjs
test-reachability: scripts/gateway-npm/publish.test.mjs is matched by no vitest project's include, is named by no package.json script, and is owned by no Playwright config — its cases never run
   → the one orphan on this tree; wired into gateway:npm:helpers:test, then:
test-reachability: 1710 test files, every one reached by a runner

$ node scripts/lint-no-nul-bytes.mjs
   → 12 source files reported, escaped to \0, then (after the rebase onto
     dccf9e609, which re-landed authority-registry.ts with its two raw NULs
     and needed the same escape re-applied):
no-nul-bytes: 6049 tracked text files, none carrying a raw NUL

$ node --test scripts/lint-test-reachability.test.mjs      # pass 11, fail 0
$ node --test scripts/lint-no-nul-bytes.test.mjs           # pass  5, fail 0
$ node --test scripts/validate-ui-receipt.test.mjs         # pass  7, fail 0
$ node --test scripts/design-gallery-browser.test.mjs      # pass  4, fail 0
$ node --test scripts/ci/pr-gate-wall-clock.test.mjs       # pass  8, fail 0
$ node --test scripts/ci/gate-classes.test.mjs             # pass  6, fail 0

$ bun run design:gallery
design:gallery: SKIPPED — the pinned Playwright Chromium is not installed (/opt/pw-browsers/chromium-1234/chrome-linux64/chrome). Install it with `bunx playwright install chromium`, or point PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH at a Chromium you already have. CI runs this lane for real, where the baselines are enforced.
$ CI=1 bun run design:gallery                              # exit 1
::error title=design:gallery unrunnable::the pinned Playwright Chromium is not installed (/opt/pw-browsers/chromium-1234/chrome-linux64/chrome). Under CI a missing browser means the workflow is misconfigured, not that the gate is optional.

$ bun run test:claims
claims: 45 claims, 49 lanes, 193 derived flows, 56 deliberate n/a cells
nightly-wiring: 4 mobile device lane(s) discovered, all pinned to one Maestro version and none starting Metro
release-wiring: one tag entry point, every lane reachable and reusable-only, release-check aggregates every lane, mobile stays opt-in, secrets stay per-lane
$ bun run lint:evidence-mapping
evidence-mapping: 49 registered lanes, every evidence step mapped
$ bun run lint:workflow-pins
workflow-pins: 23 workflow(s) clean (SHA pins, bun pin, timeouts, no hand-rolled install, single PR + release entry point)
$ bun run lint:path-filters
path-filters: 10 filter(s) cover every workspace and top-level path (3 ledgered as always-on), and every read of one carries the `all` fallback
$ bun run lint:product
✓ 41/41 product gates passed
```

## Audit

**2026-09-03 — first pass, head `01f772cbd`.**

Verdict: REFUTED

Findings:

- `scripts/validate-ui-receipt.mjs:33` (`CLIENT_SURFACE_RE`) — the refinement
  drops files that draw, not only transport. Probed against the built predicate,
  `packages/client/src/home-copy.ts`, `src/icons.ts`, `src/theme-vars.ts` and
  `src/index.html` now return `[]` where they previously demanded evidence.
  `home-copy.ts` is, by its own header (#708), the single spelling of every
  string Home shows in both renderers ("Nothing in here yet"); `icons.ts`
  innerHTMLs the SVG a member sees; `theme-vars.ts` injects the token CSS before
  first paint; `index.html` is the shell document. `## What changed` §7 and the
  `## Decisions` entry describe the dropped set as "`src/replica/**`, the gateway
  clients and the transport modules beside them", and the Decisions entry states
  "nothing exits it that could not exit it before" — both are false for those
  four paths. Only `.tsx`/`.css` outside `src/react/` was checked
  (`src/styles.css`, correctly kept); the non-`.tsx` drawing modules were not.
  Fix: express the refinement as an EXCLUSION of the non-drawing subtrees
  (`src/replica/**`, `src/gateway-client*`, the transport modules) rather than an
  allowlist of `src/react/` + `*.css`, or extend the allowlist to
  `src/index.html`, `src/icons.ts`, `src/theme-vars.ts` and the `*-copy.ts`
  modules, and correct both prose claims.
- `receipts/issue-931-gates-that-enforce-nowhere.md:188-190` — the quoted
  `classification-ratchet.json` re-pin is `a3d830db… → be04aaf5…`; the file's
  actual transition is `76aac1a07f17…` → `56f64c948746…`. Neither quoted digest
  appears in the diff. Fix: quote the digests the file carries.
- `receipts/issue-931-gates-that-enforce-nowhere.md:317-337` — two quoted
  transcript lines do not reproduce on this tree: `test-reachability: 1705 test
  files` reproduces as `1710` (the slice's own four new test files plus one), and
  `claims: 45 claims, 49 lanes, 192 derived flows` reproduces as `193 derived
  flows`. Fix: re-run and paste the current output, or say which pre-slice tree
  the numbers were taken on.

Non-blocking observations:

- `scripts/lint-test-reachability.mjs:403` — `run()` carries a JSDoc
  `@param {{cwd?: string}} [options]` for a parameter it does not accept.
- `scripts/design-gallery-browser.mjs:31` — `IS_CI` accepts only `"true"`/`"1"`,
  so a provider that sets `CI` to another truthy value gets the non-fatal path.
- `scripts/design-gallery.mjs:67` — an unrelated blank line is removed; not
  described.
- The issue's fourth comment files a further item ("load-sensitive timeouts") that
  is neither in `## Checklist` nor in `## Out of scope`, while `## What changed`
  reuses the label "item 7" for the `check:ui-receipt` work.

Verified:

- Diff ↔ receipt: 34 files, every one named by `## What changed`; no scope creep,
  no file described that is not there. `.github/workflows/e2e.yml`,
  `tests/budgets.json`, `tests/floors.json`, `tests/inventory.json` and
  `tests/suite-wall-clock.json` are untouched; `scripts/fuzz/targets-storage.mjs`
  is byte-identical, and `git log -S parseWalPairMarkerKey` names `cf616a09a`
  (#916) as the commit that removed the symbol — the target still asserts
  `marker.vaultGeneration`, `marker.journalGeneration` and `db === "journal"`, so
  item 8's "finding, not a fix" is accurate and the unticked box is justified.
- NUL escapes are pure substitutions. For all twelve files,
  `git show 9e130654a:<f> | perl -pe 's/\x00/\\0/g'` is byte-identical to the
  branch version, and no `\0` is followed by a digit (no legacy-octal hazard), so
  every runtime string is unchanged.
- Ratchet: `claimsGovernanceFingerprint` is byte-identical
  (`71625bd5f205…` both sides) and `sha256(claims.claims)` is identical
  (`302fc39107…`, 45 rows) — the whole-file digest moved only because `lanes`
  gained `rung1-on-main`. The `approvedDeviation` chains after #928 w1b.
- Rung-2 metric: `wallClockMs` returns the union of busy intervals; overlap still
  collapses, and the added fixture (7+7 min inside a 26-min span) plus the
  "lane running through another's wait" case show work is never shortened.
  `tests/budgets.json` and `tests/suite-wall-clock.json` are untouched.
- `rung1-on-main`: candidate.yml has no `pull_request` trigger, so the PR path is
  untouched; all three actions are SHA-pinned (`lint:workflow-pins` green); the
  claims row mirrors `suite`'s shape; `.governance/run.sh <id>` supports a bare
  directive id, and `commit-message-format`'s Mode B does fall back to validating
  the tip subject when the merge base equals HEAD. No `lint:product` member reads
  a built `dist/`, so the job's lack of a build step is sound.
- Item 5's numbers reproduce exactly: the pathspec sweep is 2,730 files
  unfiltered, 1,935 after `isBundleInput`, 795 dropped.

Gates run (worktree `931-gates-that-enforce-nowhere` @ `01f772cbd`, Linux
container, Node 22, `packages/core` and `packages/vault` `dist/` rebuilt first):

- `bun run format:check` → clean, 5,364 files.
- `bun run lint` → clean.
- `bun run lint:product` → 41/41 passed.
- `bun run scripts:test` → 613 pass, 0 fail.
- `bun run lint:workflow-pins` → 23 workflows clean.
- `bun run lint:path-filters` → 10 filters, clean.
- `bun run lint:evidence-mapping` → 49 lanes, every evidence step mapped.
- `bun run test:claims` → 45 claims, 49 lanes, 193 derived flows.
- `node scripts/check-quality-knobs.mjs` → no silent widening.
- `bun run gateway:npm:helpers:test` → 19 pass (publish.test.mjs wired).
- typecheck: `packages/core`, `packages/vault`, `packages/client`,
  `packages/server`, `packages/blueprints`, `apps/mobile` → all clean.
- `bun run --cwd packages/core test` → 291 pass.
- `bun run --cwd packages/vault test` → 1,569 pass, 2 skipped.
- `bun run --cwd packages/client test` → 2,420 pass.
- `bun run --cwd packages/server test -- support-bundle` → 15 pass.
- `bun run --cwd packages/blueprints test -- photos-selection-bar` → 35 pass.
- `bun run --cwd apps/mobile test -- js-bundle-fingerprint` → 15 pass.
- `node --test` on the new files → lint-test-reachability 11, lint-no-nul-bytes
  5 (via scripts:test), design-gallery-browser 4, validate-ui-receipt 7 — all
  green.
- `bun run design:gallery` → exit 0, `SKIPPED — the pinned Playwright Chromium is
  not installed …`; `CI=1` and `CI=true` → exit 1 with the `::error` annotation.
- `bash .governance/run.sh` → 21 passed, 1 pending (this attestation).

Falsification attempts:

1. Planted `scripts/zz-orphan-verify.test.mjs`, `git add`ed but uncommitted:
   `bun run lint:test-reachability` exited 1 naming the file; after removal,
   `1710 test files, every one reached by a runner`.
2. Planted a raw NUL in a staged `scripts/zz-nul-verify.mjs`:
   `node scripts/lint-no-nul-bytes.mjs` exited 1 at `1:13`; after removal,
   `6047 tracked text files, none carrying a raw NUL`.
3. Probed `validateUiReceipt` directly over every non-`src/react/` module in
   `packages/client/src` — this is what produced finding 1.

**2026-09-03 — re-verification, head `f953c021d`** (rebased onto `dccf9e609`;
series `b19a72a07 → cce4e2cc2 → a6adee7ba → f953c021d`).

Verdict: REFUTED

Fixed and confirmed:

- Finding 1's shape is right now. `CLIENT_SURFACE_RE` is gone; the default —
  every `packages/client` path is a surface — is restored and
  `CLIENT_NOT_A_SURFACE` subtracts from it. Probed all 800 tracked
  `packages/client` files against the real predicate: 672 demand evidence, 128 do
  not. `home-copy.ts`, `icons.ts`, `theme-vars.ts`, `index.html`,
  `status-channel.ts`, `device-enrichment-compute.ts`, `styles.css` and the eight
  further `*-copy.ts` modules are all back in the watched set, and the widened
  test pins them.
- Findings 2 and 3 are fixed. `tests/quality/classification-ratchet.json` reads
  `76aac1a07f17…` on `origin/main` → `56f64c948746…` on this head, exactly as the
  receipt now quotes, and `claimsGovernanceFingerprint` is `71625bd5f205…` on both
  sides. The re-run transcript reproduces line for line: `1710 test files`,
  `45 claims, 49 lanes, 193 derived flows`, `6049 tracked text files`,
  `41/41 product gates`, and the real `::error title=design:gallery unrunnable::`
  under `CI`.
- Re-escape after the rebase (check b): for all twelve files,
  `git show origin/main:<f> | perl -pe 's/\x00/\\0/g'` is byte-identical to the
  branch version — including `authority-registry.ts` re-escaped on #949's
  content, 8,788 → 8,790 bytes. No `\0` is followed by a digit anywhere in the
  twelve, so no literal decodes differently.
- Non-blocking items done: the `run()` JSDoc no longer declares a parameter it
  does not take; `IS_CI` now treats any `CI` other than empty / `0` / `false` as
  CI — probed `CI` unset, `0`, `false`, `FALSE` → exit 0 with the skip, and
  `yes`, `true`, `1` → exit 1 with the annotation; the blank line in
  `design-gallery.mjs` is restored; the issue's item 7 is now an unticked
  checklist row pointing at `## Out of scope`, where it is described with its
  evidence; the two granted additions are relabelled A and B rather than
  "items 7 and 8".

Remaining finding:

- `scripts/validate-ui-receipt.mjs:44-52` — two excluded paths carry
  member-visible copy, so `## What changed` §"Granted addition A"'s claim that
  each excluded subtree "was checked for DOM calls, markup and user-visible
  strings before being named" does not hold, and the same class of hole the first
  pass found survives in two files:
  - `packages/client/src/replica/rebootstrap-copy.ts`, swept up by
    `/^packages\/client\/src\/replica\//u`. Its own header is "WHAT A MEMBER IS
    TOLD WHEN THEIR REPLICA STARTS OVER (#883 C6)", and it holds the notice
    `headline`/`detail` strings a member reads, e.g. `"This device is downloading
    its whole library again — your unsent changes stay queued."` (line 58).
  - `packages/client/src/gateway-client-edges.ts`, named by
    `/^packages\/client\/src\/gateway-client[\w.-]*\.ts$/u`. Lines 178-188 are
    `RECOVERY_REFUSALS`, commented "the member reads a reason, not a code":
    `"You already run this shared space."`, `"That shared space is no longer
    live."` and two more, consumed by
    `packages/client/src/react/shell/routes/InlineAppRoute.tsx`.

  Fix: carve both out of the exclusions — e.g.
  `/^packages\/client\/src\/replica\/(?!rebootstrap-copy\.ts$)/u` and an
  explicit `gateway-client-edges.ts` exception (or move `RECOVERY_REFUSALS` into
  a `*-copy.ts` module) — and add both to the drawing case in
  `scripts/validate-ui-receipt.test.mjs`.

  Borderline, reported not filed: several excluded `src/replica/**` modules throw
  operator-shaped messages (`shell-session.ts:316` "The pending row is no longer
  available to edit", `search-refused-error.ts`, `online-only-error.ts`). These
  read as developer diagnostics rather than composed member copy; if any is
  surfaced verbatim, the same carve-out applies.

Gates run on `f953c021d` (same container, Node 22):

- `bun run format:check` → clean, 5,364 files.
- `bun run lint` → clean.
- `bun run lint:product` → 41/41.
- `bun run scripts:test` → 613 pass, 0 fail.
- `bun run lint:no-nul-bytes` → 6,049 tracked text files, none carrying a NUL.
- `bun run lint:test-reachability` → 1,710 test files, all reached.
- `bun run test:claims` → 45 claims, 49 lanes, 193 derived flows.
- `bun run lint:workflow-pins` → 23 clean · `lint:evidence-mapping` → 49 lanes ·
  `lint:path-filters` → 10 clean · `check-quality-knobs.mjs` → no widening.
- `bun run --cwd packages/vault build` then typecheck of `packages/vault` and
  `packages/client` → clean; `bun run --cwd packages/vault test -- grant` →
  55 pass.
- `node --test scripts/validate-ui-receipt.test.mjs` → 7 pass ·
  `bun run check:ui-receipt` → evidence verified.
- `bash .governance/run.sh` → **22/22**.

Falsification attempt: probed every tracked `packages/client` path against the
shipped predicate and read the 128 excluded files for DOM calls, markup and
prose-shaped string literals rather than trusting the list — which is what
surfaced the remaining finding.

## Session

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-09-03 | claude-code | 60f9e86b-149f-5fc9-84c0-f2160b6b6f3c |
