# Quality Tracker

## Open

- **`wal-shipper` [G4] fails on the current tree.** `packages/vault/src/wal-shipper.test.ts`
  > `[G4] a failed segment write reports an error, moves nothing, and retries
  the same range` fails in a full `bun run test` (the rest of the package is
  green: 1275 passed, 2 skipped). It is not a regression from any recent
  sharing work — `wal-shipper.ts` and its test are byte-identical to their
  state at `e0a8ed51` (#642) and were untouched by #726, #731, #741, #745,
  #749, and #750. Recorded here because a red test nobody has written down
  stops reading as a signal: every agent that has run the vault suite since
  has had to re-derive that it is pre-existing. Whoever picks it up should
  first check whether the failure is environment-shaped before assuming the
  shipper logic is wrong. **It is**: the test injects a write failure with
  `chmodSync(dir, 0o500)`, and root ignores directory permissions, so the
  write it expects to fail succeeds. Every agent session in this container
  runs as root, which is why it reproduces here and not on a developer
  machine. The fix is to inject the failure by a means root cannot bypass,
  not to change the shipper.

- **`react-native-maps` is dead weight and still ships.** Places on the phone
  now draws the shared `place-map.ts` projection through `react-native-svg`
  (see [docs/photos/places.md](docs/photos/places.md)), so nothing imports
  `MapView` any more — but the dependency is still in `apps/mobile/package.json`
  and still in `ios/Podfile.lock`. It is parked in `knip.json`'s
  `ignoreDependencies` **only** because deleting it without regenerating the
  lock leaves `Podfile.lock` pointing at a `node_modules` path that no longer
  exists, which breaks an incremental iOS build. Removing it properly is:
  drop the line from `package.json`, `bun install`, `cd apps/mobile/ios &&
  pod install`, review the native diff, then `bun run --cwd apps/mobile
  ci:native-state --write` and commit `Podfile.lock` +
  `native-fingerprints.json` together. This could not be done where the work
  landed: that host's CocoaPods 1.16.2 aborts under Ruby 4.0.3 with
  `Unicode Normalization not appropriate for ASCII-8BIT`. Until it happens the
  app bundles a native map SDK it never calls.
- **An inline app cannot read the frame's band owner, so a compact pane can
  lose its shelf navigation.** The shell keeps `shell.bandOwner.<appId>` in
  `packages/client/src/react/shell/useBandOwner.ts`, but `InlineFrame`
  (`packages/blueprints/apps/inline-types.ts`) exposes nothing about it. An app
  can claim the band; it cannot ask whether the claim was honoured. Docs hides
  its shelf strip on compact and claims unconditionally, so if the member hands
  the band back to the shell there is no shelf navigation left at all. Photos
  papers over the same hole by keeping a second copy of the preference. The fix
  is one field on the frame contract — the shell already has the verdict, it
  simply does not pass it down — after which Photos' duplicate copy can go.

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

- **Three raw `<button>`s carry no styling at all.** `AutomationThreadScreen`,
  `RunViewScreen` and `CaptureOverlay` each render
  `<button type="button" onClick={onBack}>` with no class, against a kit with 32
  `<Button>` uses. Eight more raw buttons use a local class and four already
  ride shared ones (`controlsCss.chip`, `buttonCss.ghost`); the unstyled three
  are the unambiguous misses.

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
  + confidence map. Residual hygiene debt: ~600 `toHaveBeenCalled*` sites
  (~116 bare `toHaveBeenCalled()` after #545 E1/E2) and remaining fixed
  sleeps; continue per-file chip-away.
- #212 — Testing strategy ([TESTING.md](TESTING.md)) follow-up: the three
  per-layer workstreams (`assert.*` → `expect`, coverage-floor ratchet, desktop
  renderer logic-extraction) landed under #214; the **desktop Playwright e2e
  journeys** landed under #225 (nightly/on-demand + path-filtered PR via
  `lane-client-e2e.yml`, invoked by `ci.yml`). **Still open:** the Maestro mobile flows (iOS landed;
  Android home-loads under #496 PC1), and remaining pure-logic extraction from
  `packages/client/src/react/**` (the old monolithic `app.ts` was removed in the
  React flip; appearance-prefs, profile view-models, insights formatters, and
  near-duplicate `relativeTime` still need consolidation / floors — #545 D5/B8).

## Resolved

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
