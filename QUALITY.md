# Quality Tracker

## Open

- **Banner-heavy modules are a size smell, not a comment smell.** The files
  that need many section banners to stay navigable —
  `packages/server/src/engine/handlers/dispatcher.ts`,
  `packages/server/src/engine/conversation/store.ts`,
  `packages/server/src/serve/build-gateway.ts`,
  `packages/server/src/doctor/integrity-checks.ts`, and the `acp/` cluster —
  are using comments to draw module boundaries the file layout doesn't.
  The #861 sweep normalized the banner style but deliberately did not touch
  the shape (settled Q4 on the issue): whether these modules should split is a
  code-ownership question that wants its own proposal, not a comment fix.

- **Two dead exports serving a retired builder view.** `CodeLang`
  (`packages/client/src/format.ts`) and `DiffRow`/`diffRows`
  (`packages/client/src/diff.ts`) are referenced only inside their own
  defining files — the builder Code view / Diff toggle they served is gone.
  Found by the #861 Phase 2 comment sweep (a comment-only pass, so the
  exports were left in place); they want deleting under their own change.

- **Comments still speaking "chat" for the conversation ledger.** ~8 comment
  sites (`packages/client/src/centraid-api.d.ts`,
  `gateway-client-conversation.ts`, `gateway-client.ts`, and one contract-test
  header) use the banned "chat"/"chat session" vocabulary for the
  conversation ⊃ turn ⊃ item ledger. Neighbouring occurrences are real UI
  strings, so the rename wants one coherent pass with the vocabulary rule in
  hand, not a piecemeal comment sweep (#861).

- **Blueprint handler contracts live in inert JSDoc, not types.** The
  `apps/photos` action/query handlers are dynamically loaded default exports;
  their only stated contract is a `@type {import('…').ActionHandler}` JSDoc
  tag that tsc ignores in `.ts`. The #861 doctrine's encoding ladder says this
  fact wants to climb: type the exports (e.g. `satisfies ActionHandler`) and
  the ~20 tags can then be deleted as redundant with the checker.

- **Sub-wave stamps in test-name string literals.** Seven
  `apps/mobile/src/apps/photos/*.test.ts` `describe()` titles still carry
  `(issue #721 B5)`-style process stamps. Strings, not comments, so out of
  #861's comment-only scope; safe to rename in a test-title pass.

- **A second offline write never settles its promise.** With the gateway
  severed, the first `window.centraid.write` of a session resolves `queued` as
  it should; every write issued after it in the same session queues, applies
  its optimistic row, paints the pending chip — and never resolves or rejects.
  Measured in `apps/web/tests/e2e/offline-search.spec.ts` (#846) with two
  offline renames raced against a 30s timer, both orders round: the second one
  reports `never-settled` whichever row it is, so it follows the ORDER, not the
  row or its values. Nothing is lost — the outbox is correct and the reconnect
  drain settles both — but a caller that awaits its own write hangs forever,
  and any app that disables a control until the write returns strands it. That
  spec routes around it by taking the pending rows from the UI instead of from
  the promise. Not pinned: the durable behaviour is right and #846 is a search
  fix, so this wants an issue of its own against the write rail.

- **`countDeclaredTests` counts prose.** The regex in
  `scripts/test-report/matrix-grades.mjs` is `\b(?:test|it)(?:\.\w+)*\s*\(`,
  which matches the ordinary English `it (` inside a comment — #842 W3.1 had a
  comment reading "…a per-test cap under it (TESTING.md)" counted as a fifth
  test declaration. The slice reworded its comment, but the consequence is
  general: any `minimumTests` floor seeded from a file whose comments contain
  `it (` or `test (` is inflated by that much, and the floor then reads as
  satisfied by tests that do not exist. Not pinned — no invariant is violated
  and no current floor is known to be wrong — but a floor derived from a
  miscount is a floor that cannot bite. Fixing it means either excluding
  comments from the scan or requiring the match to start a statement.

- **Cheap gateway reads are starved by app-engine worker spawns under
  composition.** With sync, search, writes, blob ingest, turns and automations
  running together on a 4-vCPU host (`WORKER_MAX_CONCURRENT` = 2),
  `GET /centraid/_vault/atlas/browse/ref-search` goes from ~5 ms p95 solo to
  217–444 ms p95 — ×27–66 — while the heavier lanes degrade only ×3–5. Nothing
  is refused and every result is correct, so this is a fairness observation
  rather than a defect against any current ruling:
  `tests/scale/composite-load.scale.test.ts` publishes the per-lane factors and
  deliberately gates only the aggregate throughput factor and an absolute
  worst-lane p95, because a ratio over a ~5 ms denominator fences scheduler
  noise rather than the product. Worth an issue if in-gateway reads should get
  priority over worker-backed handler work (#842 W4.1).

- **The desktop crash log is correct as a local file and wrong the moment
  anything shares it.** `apps/desktop/src/main/crash-log-core.ts`'s
  `toCrashRecord` writes the raw error message and the full stack — absolute
  paths, and therefore the OS username — into `<userData>/crash.log`. That is
  the right shape for a sovereign local file nobody uploads, and it is the
  wrong shape for anything a person attaches to a support request. #842 W8.1
  built the redacted-at-write-time alternative
  (`packages/server/src/serve/anomaly-ledger.ts`) but did not migrate the
  desktop crash log onto it: the two have different lifecycles (one is written
  by the main process before a vault may even be mounted) and merging them is
  a design question, not a rename. Recorded as an observation rather than
  pinned — nothing today copies `crash.log` into a shareable artifact, so no
  invariant is violated. It becomes a defect the day something does.

- **A parallel wave leaves repo-wide gates unrun, and only the sweep finds
  out.** The three #834 wave slices each verified their own tree (per-tree
  `oxlint` over changed files, per-package typecheck, per-app suites) and
  reported clean; the wave-3 sweep then found four reds none of them could
  have seen — a manifest/pending-overlay law disagreement in
  `packages/blueprints` (a new action with no projection row), eleven root
  `bun run lint` findings across the wave trees, an
  `lint:engine-conformance` vocabulary hit, and a U4 copy flag on a string
  written during the sweep itself. Each was cheap to fix and none needed a
  gate knob, but they arrived at the end of the umbrella rather than inside
  the slice that caused them. The norm worth considering
  ([docs/multi-agent.md](docs/multi-agent.md)): a slice's exit condition is
  the repo-wide gate for the lanes its tree participates in — at minimum
  `bun run lint` and the owning package's whole `test` — not the subset of
  files it touched.

- **A place shared into an audience scope may be phrased against the wrong
  Home.** #816 made "what leaves with a copy" a decided question for the OS
  share path (`share-place.ts`: a chosen precision, GPS stripped below the
  exact rung, and the Home-relative rung suppressed in `"shared"` context).
  In-product sharing through an audience scope was not audited to a
  conclusion in that umbrella, because the answer lives in `packages/vault`:
  if a sharer's `kind: "home"` place row can reach a receiver's scope, the
  receiver's own info panel would phrase that photograph relative to somebody
  else's Home — a wrong statement, not merely a leak. Needs a vault-side read
  of how place rows travel with a scope.

- **Two container-hermeticity defects found by an attempted in-container full
  coverage run** (13,203 green / 3 red, all environmental): (1)
  `packages/agent-runtime/src/backends/acp/launch.test.ts` inherits the real
  `process.env` through `planLaunch`, so a host that exports `IS_SANDBOX`
  (this container: `yes`) fails two assertions — the test should stub the
  variable, not trust the host; (2)
  `packages/gateway/src/serve/gateway-db-lock.integration.test.ts` shells out
  to the `sqlite3` CLI, absent here — a candidate for the new
  `tests/env-red.json` inventory (guard on CLI presence) or a rewrite against
  `node:sqlite`.
- **Five `photos-*.mjs` Maestro flows are unlinted.** `scripts/lint-e2e-flows.mjs`
  `FILES` omits all five photos flows (`photos-search.mjs` even carries a
  marker for a nonexistent rule name, `input-observed`). Adding them may
  surface latent findings in five flows at once, so it deserves its own pass
  rather than a drive-by (#781 wave 3 added only the new `places-seat.mjs`).
- **`PlacesView` prints raw coordinate-shaped place names** on shelf cards
  (`row.name` without `readableName`), while the web shelf and the phone's own
  map refuse them — seeded places are coordinate-named, so real shelves show
  headings like "39.0021, -120.1131". Cosmetic divergence; fix alongside the
  next Places pass.
- **`google-contacts-pull` renders yearless birthdays as `---09-05`** (the
  `"--"` placeholder plus the joining `"-"`); vCard's yearless form is
  `--09-05`. Asserted as-is with a NOTE in
  `packages/blueprints/automations/pull-connectors.test.ts` so the fix must
  flip a test. `google-calendar-invite-send` also uses wall-clock `new Date()`
  (DTSTAMP) and `Math.random()` (MIME boundary) inside the published handler —
  nondeterminism the connector lane's lint doesn't catch; its tests
  deliberately don't assert those bytes.
- **`apps/desktop/tests/e2e` standalone `tsc` has 13 pre-existing errors**
  (missing `window.CentraidApi` augmentation when run outside the harness)
  and `apps/web/tests/e2e/tsconfig.json` likewise; neither is wired to a gate,
  so spec type rot is invisible. Wire or retire the configs.
- **Web shell palette click race after reload**: the Search button paints
  before its listener attaches, so early clicks are silently lost. Four web
  e2e specs work around it with a retry poll; the product should attach before
  paint or render disabled.
- **People surfaces no pending-state marker** (no `kit-pending-chip` anywhere
  in the app) and `AddPersonModal` closes only on `executed` — an offline add
  looks like a failure while the row is in fact projected and durable.
- **The daily rollup has no per-day failure split, so the bars carry one
  segment.** The automations and insights surfaces draw a bar per day, and the
  v9 bar block stacks succeeded-then-failed with a fail-first clamp
  (`packages/design/src/blocks/bars.ts`). The rollup the gateway records does
  not separate the two, so every bar is drawn as a single run count and the
  legend is withheld rather than invented. When the rollup gains the split the
  block needs no change — only the caller's second segment.

- **No run durations are recorded, so both surfaces withhold the
  median-duration fact.** The v9 facts panel for automations names a typical
  run duration. Nothing in the run ledger stores a start/finish pair, so
  desktop, PWA and mobile all omit the row instead of computing something that
  would look authoritative and be wrong. Recording the pair is a gateway-side
  change; the panels already have the slot.

- **`ShelfStrip` and `MoreSheet` are near-duplicates in Photos and Docs.** The
  shelf *model* is now shared (`packages/blueprints/apps/_shared/shelves.ts`),
  but these two components are still written twice because their CSS modules
  genuinely diverge (`--content-margin` vs `--sp-4`, the mono-numeric token
  trio, Docs' `meta`/`footer` rows against Photos' bare count). The repo's
  shared-component pattern is one component plus one shared CSS module
  (`_shared/SearchScaffold.tsx`), so merging them changes rendered output and
  needs `design:gallery` baselines regenerated — too much for a drive-by.

- **Modals are the one control the shell hand-rolls.** Six raw `<dialog>`
  elements with no kit component behind them: `AllAppsSheet`, `PaletteScreen`,
  `VaultModal`, `TestConnectionModal`, `ConnectFlowModal`, `RenameGatewayModal`.
  Three of the four modals share `vaultModalStyles.profModal`, so it is
  half-centralised by copying a class name rather than by a component. This is
  the largest remaining gap between the shell and the design system — the audit
  in #765 found the shell otherwise clean (zero raw `<input>`, `<textarea>` or
  `<table>`; mobile has zero raw `<TextInput>` and routes all 692 `<Text>`
  through the kit's `NativeText`).

- **Two raw `<button>`s carry no styling at all.** `AutomationThreadScreen` and
  `RunViewScreen` each render `<button type="button" onClick={onBack}>` with no
  class, against a kit with 32 `<Button>` uses. (`CaptureOverlay` was the third
  until quick capture was retired from this seat.) Eight more raw buttons use a
  local class and four already ride shared ones (`controlsCss.chip`,
  `buttonCss.ghost`); the unstyled two are the unambiguous misses.

- **21 mobile `<Pressable>`s act as buttons without the kit.** Many carry
  `accessibilityRole="button"` explicitly. They cluster in `apps/agenda`,
  `apps/tasks`, `apps/tally`, `apps/locker` and `apps/people` — the same apps as
  the entry below, and the same root cause.

- **The design gates enforce tokens, not components.** This is the structural
  reason the three items above drift silently: a hand-rolled `<button>` or
  `<dialog>` styled with `var(--…)` passes `lint-design-tokens`,
  `lint-hairline`, `lint-type-floor` and every other gate green. The gates ask
  "did you use a raw value?", never "did you use the component that exists?".
  Closing that would need a rule that knows which elements have kit equivalents
  — worth doing before the vocabulary grows again.

- **Six blueprint apps still draw their own chrome.** `agenda`, `locker`,
  `notes`, `people`, `tally` and `tasks` each carry a hand-rolled `Chrome.tsx`
  (231, 105, 295, 378, 306 and 223 lines) with its own topbar, hamburger,
  drawer scrim and theme button — a second chrome inside the frame's chrome,
  which is exactly what Photos and Docs stopped doing in #765. They already
  import the frame contract, so the contribution channel is there; adopting it
  is per-app work that touches each app's interaction model and wants its own
  issue rather than a widened design-system pass.

- #496 — **Test infrastructure assurance** (enforcement, signal, coverage).
  Parent backlog for ruleset on `main`, nightly auto-issue + Pages main-only
  guard, floors/`minimumTests` ratchet, `requireAssertions`, affected vitest in
  `check:pr`, product journey owners (chat/ENOSPC/restore/multi-writer), matrix
  honesty, Android home-loads, CI latency pins, and hygiene chip-away
  (`toHaveBeenCalled` / fixed sleeps). See [TESTING.md](TESTING.md) Nightly SLA
  + confidence map. Residual hygiene debt (measured 2026-08-14 over
  `**/*.test.{ts,tsx}`): 1,023 `toHaveBeenCalled*` sites, of which 186 are
  bare `toHaveBeenCalled()` — and **all 186 are negated**
  `.not.toHaveBeenCalled()`, where naming arguments would weaken the
  assertion rather than sharpen it. Zero positive bare calls remain. The
  chip-away therefore continues against the argument-bearing forms and the
  remaining fixed sleeps, per file.
- #212 — Testing strategy ([TESTING.md](TESTING.md)) follow-up: the three
  per-layer workstreams (`assert.*` → `expect`, coverage-floor ratchet, desktop
  renderer logic-extraction) landed under #214; the **desktop Playwright e2e
  journeys** landed under #225 (nightly/on-demand + path-filtered PR via
  `lane-client-e2e.yml`, invoked by `ci.yml`). **Still open:** the Maestro mobile flows (iOS landed;
  Android home-loads under #496 PC1), and remaining pure-logic extraction from
  `packages/client/src/react/**` (the old monolithic `app.ts` was removed in the
  React flip; appearance-prefs, profile view-models, insights formatters, and
  near-duplicate `relativeTime` still need consolidation / floors — #545 D5/B8).

- **Expired `peer_link_tickets` rows are filtered, never purged.** Observed
  while building the hostile-peer lane (#842 W2.3). `hasPending` and `claim`
  both exclude rows by `expires_at`, so the *logical* reclaim is correct and
  tested — the door closes on time and an expired ticket cannot be claimed.
  But nothing physically deletes the row, so an abandoned-ticket workload
  grows the table without bound. This mirrors the pairing `tickets` table
  exactly, which is documented as "short-lived by design", so it is recorded
  as a longevity observation rather than a defect: the two tables should
  either both gain a purge or the design note should say why unbounded growth
  is acceptable. Not pinned — no invariant is currently violated.

## Resolved

- #842 — The `node:sqlite` bundling defect that made
  `apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx` uncollectable is
  fixed at the harness, and the class of failure is now gated. Root cause: the
  externalization plugin in `packages/test-kit/src/vitest.ts` shipped on the
  jsdom preset only, while a `// @vitest-environment jsdom` docblock inside a
  *node* project sends that one file through the same Vite client environment —
  environments are chosen per file, plugins per project, so the file was
  transformed with `noExternal: true` and no way to hand `node:sqlite` back to
  Node. The plugin now ships on both presets, and
  `apps/mobile/src/lib/replica/node-sqlite-driver.jsdom.test.ts` pins the seam
  (remove the plugin from the node preset and that file stops collecting). The
  journey file itself is not restored: it asserted a Tally native cover that
  #831/#832 removed whole pending a ground-up redesign, and it was deleted with
  the interface it covered. It owned no `tests/matrix.json` row, so no floor
  moved with it — what the rebuild owes back is a re-authored pending-restart
  journey against the new cover. `scripts/ci/collection-tripwire.mjs` is the
  backstop: it reads `artifacts/test-results/vitest.json` and fails on any file
  that reports `failed` with zero assertion results, so a suite that errors
  before collecting a single test can no longer read as absent to every
  counting gate (matrix floors, skip budget, quarantine ledger).

- #816 — Removed `react-native-maps`. Nothing had imported it since Places
  moved to the shared `place-map.ts` projection, and #816 rules the phone's map
  stack to be `expo-maps` (iOS) plus `@maplibre/maplibre-react-native` (Android),
  so the old SDK is dead code rather than a pending decision. The JS-side removal
  landed here: the dependency is out of `apps/mobile/package.json` and the
  lockfile, out of `knip.json`'s `ignoreDependencies`, and the
  `RNMapsDefines.h` exclusion is retired from
  `apps/mobile/scripts/native-fingerprint.mjs`. The native half — `pod install`
  to regenerate `Podfile.lock`, then `ci:native-state --write` and committing
  `Podfile.lock` with `native-fingerprints.json` — needs a macOS host, and the
  exact recipe is recorded in the #816 receipt; `ci:native-state --status` names
  the mismatch until it runs.

- #781 — Nightly mobile evidence is now keyed flow × platform.
  `writeFlowVerdict` writes `artifacts/e2e/<slug>-<platform>.json` and
  `recordQualityResult` writes `artifacts/<lane>/<owner-slug>-<platform>.json`
  when `MAESTRO_PLATFORM` is set (`tests/agent-e2e-shared/harness.mjs`), with
  the platform stamped in the JSON and the owner unchanged, so
  `merge-multiple` keeps both platforms and matrix mapping still resolves.
  The report now merges per-owner evidence worst-status-wins and keys trend
  series per platform, so a green platform cannot mask a red one; drift
  budgets read the platform-suffixed history, so cross-platform samples can
  no longer interleave into a false ratchet. Platform-less lanes (pairing,
  desktop, web, the test-kit writer) keep their exact prior paths.
- #778 (with #712 E3) — Closed the band-ownership hole from both ends, so an
  inline app can no longer lose its shelf navigation to a verdict it cannot
  read. On web and desktop #778 deleted the member preference outright
  (`packages/client/src/react/shell/useBandOwner.ts` is gone): a first-party
  app's claim is now honoured on exactly the structural condition the app
  already knows — first-party **and** compact — in
  `packages/client/src/react/shell/routes/inlineAppFrame.tsx`, with no
  hand-back toggle for a member to flip, so Docs claiming unconditionally
  while hiding its compact shelf strip is safe by construction rather than by
  luck. On mobile the latch survives as a member preference but is no longer
  Photos' private copy: #712 E3 moved it to the frame's own
  `apps/mobile/src/kit/band/band-owner.ts` under the same
  `shell.bandOwner.<appId>` key, and the claiming screens read the verdict
  through `useBandOwner(appId)` instead of duplicating it. The originally
  proposed fix — a field on the `InlineFrame` contract — turned out to be
  unnecessary: removing the disagreement was cheaper than reporting it.

- #782 — Fixed the environment-shaped `[G4]` failure in
  `packages/vault/src/wal-shipper.test.ts` (`a failed segment write reports an
  error, moves nothing, and retries the same range`). The test injected its
  write failure with `chmodSync(dir, 0o500)`, and root ignores directory
  permissions, so the write the assertion needed to fail succeeded instead —
  red for every agent session in this container, green on a developer machine,
  and pre-existing rather than a regression from any sharing work. The fault is
  now path-shaped: a regular file sits where the group directory belongs, so
  `mkdir` throws for every uid, root included. The shipper is unchanged, which
  is the point — the defect was in how the test bought its failure, never in
  the code under test.

- #767 (PR #773) — The committed `tests/design-gallery/baselines/mo-advisory-dark.png`
  baseline had drifted against the current `toNativeTheme()` lowering on main
  (the #765 design-source change did not refresh the MO-advisory lane), so
  `check:push`'s gallery gate was red on an untouched tree. Refreshed with the
  documented `bun run design:gallery -- --update` flow inside PR #773; no
  DESIGN.md contract content changed. Recorded here so a binary baseline
  refresh inside a docs PR has a written cause instead of reading as silent
  scope creep.

- #716 — Fixed replica-intent attribution across the gateway's cached vault
  bridge. The bridge deferred vault lookup until an app-worker callback, after
  the originating AsyncLocalStorage scopes had unwound, so connected mobile
  Photos writes could be rejected as belonging to the wrong device/app. Bridge
  construction now captures an existing vault and intent scope and re-enters
  both around deferred callbacks, while deliberately unscoped bridges retain
  dynamic multi-vault resolution. A focused registry regression and the native
  trash/restore journey cover both sides.
- #711 — Closed the enrichment-tier enforcement gap. The vault's per-domain
  `enrich_policy` (`off | local | model`) was written by Settings and read by
  nothing on the execution path, so Photos' "what leaves the device: nothing"
  was copy rather than behaviour — enrichment automations fired and took model
  turns whatever the tier said. Added a manifest `enrich` block (domain,
  capability, lane), a fail-closed gate at the single fire choke point
  (`runFire`), and an owner-plane tier read the guarded automation's own grants
  cannot answer for. `off` refuses the run with a logged reason, `local`
  refuses any model-routed run and seals `ctx.agent` for the ones it allows,
  and an unreadable policy refuses. Also scoped the on-demand queue by
  `capability`, so a face-detection consent no longer hands the same row to
  every enabled enricher, and fixed three enricher drains that filtered on
  `entity_type`/`entity_id` — columns `enrich_request` does not have — and had
  therefore never drained at all.
- #225 — Rebuilt the desktop Playwright e2e suite for the post-#109/#137/#141
  gateway-store architecture (the old `delete-app` suite had silently broken —
  all 8 tests failed — when it kept seeding a `gatewayUrl` settings no longer
  persists). Broadened from 1 journey to **all 14 surface areas, 59 passing
  tests** with SSE streaming in the mock, and wired it into a nightly +
  on-demand workflow (`e2e.yml`) so it can't rot unnoticed again. Adding the
  Cloud → Database coverage surfaced + fixed a row-browser pagination bug
  (`renderRowBrowser` captured the page once, so Next re-fetched offset 0).
- #218 — Fixed the blank-frame flicker on sidebar navigation. The Home,
  Discover, and Settings renders cleared the DOM up front and then awaited IPC
  before painting, so the window sat empty for the round-trips. Split `clear()`
  into a `teardownCurrent()` (cleanup + stale-render-guard bump, no DOM wipe)
  plus the wipe; the three async renders now keep the prior view on screen and
  swap the freshly-built shell in atomically with `root.replaceChildren`.
- #214 — Carried out #212's three deferred per-layer workstreams: converted all
  1,740 `assert.*` calls across the 80 test files to vitest `expect` matchers
  (AST codemod + by-hand conversion of the validator-function forms); extracted
  the first tranche of pure logic out of the `builder.ts` renderer god-file into
  tested `format.ts`/`cron.ts`/`diff.ts` modules and moved the desktop vitest
  project to `jsdom` (12 → 71 desktop tests); grew `agent-runtime` line coverage
  20.8% → 28.6% with real-dependency tests for the codex tool dispatch, tool
  normalization, and model enumeration, then ratcheted every engine floor up
  toward the 80% line / 70% branch target band.

- #210 — Made the oxlint profile intentional (correctness + suspicious + perf, explicit rules) instead of ultracite's maximal-then-suppressed set, added per-package type-aware linting (`oxlint --type-aware`) and brought all `*.test.ts` into both `tsc` typecheck and lint via per-package `tsconfig.test.json`. Fixed every surfaced finding (type-aware + 14 latent test type errors) and three file-relocation regressions the new coverage unmasked: the automation and app-engine handler-runners resolved the relocated worker at the wrong path (handlers couldn't execute), and agent-runtime's CLI smoke-test path + package `bin` pointed at the pre-move location.
- #180 — Removed dead `gatewayUrl` / `gatewayToken` / `appsDir` / `runtimeMode` / `remoteGateway*` fields from the settings `getSettings()` fallback object (leftovers from the retired local/remote form); only `chatModel` is read.
- #179 — Classified OpenClaw's concrete models into capability tiers (smart/balanced/fast) via a one-shot LLM prompt (`openclaw infer model run`), cached on disk keyed by the model-list hash, grouped the chat picker by tier, and wired the picker's Refresh button to force reclassification (`runner-status?refresh=1`).
- #178 — Wired per-runtime chat model enumeration: OpenClaw via `openclaw models list --json`, provider-agnostic capability tiers for claude-code (resolved to CLI aliases at turn time; codex stays on gateway default), surfaced through a new `RunnerStatus.models` field and read from the active gateway's runner-status in the picker.
- #176 — Removed two dead desktop Settings pages ("Where apps run" runtime page that rendered blank with a stale local/remote subtitle, and the unbuilt "Sync & backups" stub) and wired the chat model picker to the gateway's `/models` probe instead of a no-op empty list.
- #171 — Retired the crash-resume journal, dropped the `ctx.invoke` API surface, and consolidated `chat-runner-core` down beside the automation fire spine in one backend-agnostic engine: relocated the agent-turn contract to app-engine, renamed `@centraid/automation-engine` → `@centraid/conversation-engine`, and split its `src/` into `chat/` + `automation/`.
- #162 — Consolidated sibling packages: folded `@centraid/analytics` into app-engine's `insights/` sub-module and renamed `@centraid/automation` → `@centraid/automation-engine`.
