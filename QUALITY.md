# Quality Tracker

## Open

- **`.mjs` scripts should be TypeScript.** Hundreds of `.mjs` files under
  `scripts/` and `.governance/law/` exist because their call sites say
  `node …`, not because the runtime needs JS: Bun runs `.ts` natively and
  Node ≥ 22.18 strips types by default. A sweep is a rename plus every call
  site (workflows, hooks, `package.json`), collides with the file-size ledger
  and the law estate, and should pick one runner rule (`bun` under `scripts/`,
  Node type-stripping for the law). Its own issue, not a rider.

- **The face-cluster thresholds were tuned for SFace and now serve ArcFace.**
  `faces::PARTY_MAX_DISTANCE` / `faces::CLUSTER_MAX_DISTANCE` in
  `crates/vault/src/commands/enrich.rs` keep 0.3 / 0.22 cosine distance while
  recognition is 512-d ArcFace (`arcface@1`, #1011); conservative (false
  splits, not merges), but untuned. The Photos sample corpus is synthetic
  renders that ArcFace collapses, so tuning needs a small labelled fixture set
  of real photographs.

- **The comment-density ratchet does not measure what its header claims.**
  `scripts/check-comment-density-ratchet.mjs` says its parser walk "catches
  trailing comments (they lead the NEXT token), JSX comments, and the file-end
  comments carried by the EOF token". `commentRanges()` calls only
  `ts.getLeadingCommentRanges` at each leaf token, and TypeScript classifies a
  comment sharing a line with the preceding token as TRAILING trivia, which that
  function skips by design. So `const a = 1; // note` and `<div>{/* note */}</div>`
  both score zero comment characters while counting toward the denominator.
  The perverse consequence is that unmeasured comments are pure denominator, so
  *deleting* JSX prose raises a `.tsx` file's measured share. Two remedies: fix
  the scanner and clean the files that carry real hidden prose, or fix the
  scanner and re-seed with a recorded deviation. That the down-only pin rule
  makes a measurement *correction* impossible without a deviation is a design
  gap in the ratchet worth settling on its own. Found by #883's ceremony
  against #861's gate.

- **`google-calendar-invite-send` uses wall-clock `new Date()`** (DTSTAMP)
  and `Math.random()` (MIME boundary) inside the published handler —
  nondeterminism the connector lane's lint doesn't catch; its tests
  deliberately don't assert those bytes.

## Resolved

- #1005 — **The arrival fixture pinned the whole working tree, so it was red on
  every checkout but the one that recorded it.** `collectReceipts` read every
  tracked receipt out of the working copy and `git rev-parse --abbrev-ref HEAD`
  into `registries.receipts.change.branch`, and `collectManagedTree` and
  `collectDocket` read the checkout too. Answered by neither option the finding
  offered: the record is now a function of exactly the range and the pending
  commit (R-1005-27), and the corpus, the docket and the managed tree are read
  **at the range's head** — so nothing is narrowed and `receipt-per-issue` still
  answers uniqueness across the whole corpus. At the commit hook those reads
  move to the index, so the commit being written is judged on what it stages.
  `arrival.test.mjs` proves it from a detached worktree that is on no branch and
  whose receipts are then dirtied by hand.

- #996 — **`evaluateReplicaRead` had no production caller on any host.** It was
  filed open while `packages/client/src/replica/query.ts` still exported it and
  the store compiled the read grammar to SQL elsewhere, leaving a second
  implementation nobody ran except the pushdown parity oracle. The open decision
  — the proof or the function — was answered by deleting both with the plane
  they belonged to: a seat runs an app handler's own statement over the vault's
  real tables, so there is no grammar to evaluate twice.

- #922 — **Two surfaces #882 added to the phone were unvirtualized.**
  `apps/mobile/src/apps/notes/NotesPlaces.tsx` kept one hand-wired `ScrollView`
  + `.map()` (the More sheet) beside three `SeatList`s, and
  `NotesHistory.tsx` — a note's whole version chain, which grows by one row per
  save and has no bound — was a `ScrollView` + `.map()` throughout. Both now
  draw through `SeatList`, the seat's one virtualised list (#922 E6), with
  `NEWEST_FIRST_ANCHORING` stated at the call site as that primitive requires,
  and `NotesHistory.tsx` joins the pinned files in
  `scripts/accessibility-contract.test.mjs` so a swap back to a bare `.map()`
  cannot pass. The per-file pin already named `NotesPlaces.tsx`, which is why
  its remaining `.map()` had to be found by reading rather than by the gate —
  a pin that matches one tag in a file says nothing about the rest of it.

- #922 — **An ordered replica page could not use an index while its refusal
  guards rode the same statement.** `planComposedReplicaRead` put one
  `max(CASE ... END) OVER ()` column in the select list per order guard, and a
  window function over an unbounded frame must see every row before the first
  one is emitted, so an ordered read materialised the whole entity whatever the
  ORDER BY key was made of; an index over the exact ORDER BY expression changed
  nothing, because the plan never reached it. C3 replaced the aggregate with
  **index seeks**: `censusClass(column)` is a fixed 0-5 ladder, each guard asks
  `class >= N ORDER BY class ASC LIMIT 1` against a `replica_row_cen_*`
  expression index, and `orderGuards` emits classes rather than SQL. Still one
  statement per read; the plan is the difference. On the 50,000-row fixture an
  ordered read taken after a write went **37.9 ms to 1.03 ms**, and a one-row
  write batch went 0.36 ms to 0.55 ms for the extra b-tree. The rule the fix
  now depends on is that the index expression and the probe expression are
  spelled identically — [docs/traps/expression-index-spelling.md](docs/traps/expression-index-spelling.md),
  asserted on the query plan by
  `packages/client/src/replica/order-census.test.ts`.

- #890 — **The mobile upload allowlist accepted percent-encoded traversal,
  backslash traversal, and embedded credentials.** Filed here rather than under
  Open because all three are fixed; the shape of the miss is what is worth
  keeping. `assertGatewayMintedUploadUrl` is the only thing standing between a
  native background PUT and a destination the gateway never authorized, and it
  checked scope with `target.pathname.startsWith(allowedUploadPrefix)`.
  `new URL()` resolves a literal `../` before that test ever runs — which is
  what made the existing traversal case pass and made the check look sound — but
  it leaves `%2e%2e%2f` exactly as written, so
  `…/tmp/blobs/%2e%2e%2f%2e%2e%2fblobs/sha256/<secret>` satisfied the prefix.
  Separately, `URL.origin` omits userinfo, so
  `https://evil:pw@provider.example/…` matched the provider origin and the
  credentials would have ridden to it. **The first fix was itself incomplete**,
  and that is the part most worth remembering: it split path segments on `/`
  alone, so `..%5c..%5c` — which `URL` does not normalise, because it rewrites
  only a *literal* backslash — walked straight through the check that had just
  been written to stop exactly this. An independent audit found it; the tests
  shipped alongside the fix did not. Scope is now checked at every decoding
  depth, on both separators, with a bound on the decoding rounds and a
  distinction between a malformed escape in the URL as minted (refused) and a
  legitimately encoded `%` that simply cannot decode twice (accepted — the first
  fix rejected valid uploads here). Two general lessons: **a normalization the
  parser performs for you hides the cases it does not perform**, and **a fix
  written from a failing case tends to cover that case and its siblings only** —
  the sibling separator was one substitution away and nobody looked.

- #890 — **The five `photos-*.mjs` Maestro flows are linted.** The observation
  described `scripts/lint-e2e-flows.mjs`'s hand-written `FILES` list; #842 W0.4
  replaced it with on-disk discovery over `flows/` and `lib/`, so every flow —
  including the five photos ones, and any flow added later — is linted from the
  moment its file exists. The nonexistent `input-observed` marker
  `photos-search.mjs` carried went with it. #890 adds the second half the entry
  implied: a flow that is linted but that no lane runs is now a hard failure of
  `bun run lint:e2e-wiring`.

- #883 — The #880 residuals register is closed, six of seven. The stored,
  indexed order column is **not** among them — the sort was pushed into SQLite,
  but the ORDER BY still reads `json_extract`, and measurement says it should
  (see the open entry above and D-order in
  [docs/decisions.md](docs/decisions.md#grants-v2--one-authority-plane-883)); the
  `has_unavailable_fields` fallback is on the wire and the replica rig asserts
  pushdown actually engaged, so a tile that silently reverted to a full read now
  says so; the native session produces `stewardLabel`, so the phone can draw the
  commons "waiting for X" sentence its rail already supported; a write admitted
  before bootstrap backfills its projection at first page, at completion and on
  relaunch instead of keeping an empty optimistic row; the three dead web-seat
  sharing exports (`ShareSheet`, `offersCapability`, `PLACEABLE_ITEM_TYPES`) are
  deleted rather than held out of the reachability gate; the multiplex
  shape-changed path re-emits under a bound with a terminal frame; and the wire
  grew a per-mount `error` kind, so one failed projection no longer tears down
  every mount. The vocabulary that last item needed is the thing that had been
  missing — inventing it inside the route was refused at the time, and it landed
  with the SSE slice that owned the protocol.

- #883 — Four ledger items resolved in the schema and sweep passes they
  belonged to. Expired `peer_link_tickets` are physically purged, not merely
  filtered, so an abandoned-ticket workload no longer grows the table without
  bound. `SEALED_PAYLOAD_FIELDS` now DERIVES from `SEALED_COLUMNS` rather than
  restating it, which is the durable fix the entry asked for: the two lists
  cannot disagree, and the derived set was a strict superset of the hand list,
  so nothing lost protection on the way. The composite `<lineId>:<partyId>` write
  marker in `add_receipt_expense` was removed rather than extended — a joined key
  is unaddressable by every `pkColumn` consumer, so it was the defect shape, not
  a missing marker. And the Atlas grant-plane census exclusion is gone: #873 had
  already retired its budget rationale, ruling D4a settled the product question,
  and the census counts the plane again for no statement cost.

- #883 — The component-existence debt is measured, and all three of its lanes
  are empty. `scripts/component-existence-ledger.mjs` is the rule the "design
  gates enforce tokens, not components" entry asked for: it knows which elements
  have kit equivalents and fails on a new instance AND on an uncounted cleanup,
  so the census cannot drift from the tree. The shell's raw `<dialog>`s are one
  `ShellModal` over the single `modal-kit` law and the dialog lane is empty; the
  21 style-less mobile `<Pressable>`s are the kit's `Tappable` and that lane is
  empty too. The button lane went last: every shell segmented strip and tab band
  is `settings-controls.tsx`'s `Segmented` over `.segOption`, every other
  class-less shell button is the kit `Button` (the crash wall's one way out
  included), and the Assistant companion's attachment row — which cannot take
  the kit Button, because a `role="menu"` popover's children need a
  `role="menuitem"` the kit has no slot for — took the lane's other end state and
  named its class. The six hand-rolled blueprint `Chrome.tsx` files adopt the frame
  chrome (231/105/295/378/306/223 lines became 97/106/72/92/122/79, each over
  `_shared/AppChrome`), so the second chrome inside the frame's chrome is gone.

- #883 — The parallel-wave lesson is now a written norm rather than an
  observation. [docs/multi-agent.md](docs/multi-agent.md) G1 states it as this
  umbrella's invariant D7: a slice's exit condition is the repo-wide gate for
  every lane its tree participates in — at minimum root `bun run lint` and the
  whole `test` suite of the package it edits — never the touched-file subset,
  so repo-wide reds surface inside the slice that caused them.

- #883 — The daily rollup now splits each day by outcome and the payload
  carries a typical run duration, so the bars draw their second segment and the
  spend panel its `typical run` row on all three seats. The failure predicate is
  the KPI rollup's, reused; the column's failed slice is failed SPEND, because a
  column's height is spend. No schema change was needed for the duration —
  `turns.ended_at` was already stamped at every completion path and already
  exposed by the `run_summary` view; what was missing was a p50 over it. Both
  figures stay WITHHELD rather than zeroed where the vault cannot speak: an
  archived day contributes its failure count but no failed spend (a digest has
  no failure-cost column), and a window with no finished run carries no duration
  at all.

- #883 — Live-defect sweep across the eight seats. `index.json`'s eight
  template rows now carry the hue their `app.json` and the design registry
  already agreed on. Photos computes a duration ONCE (`apps/photos/format.ts`
  `clock`), so the viewer bar, the tile badge and the info row all say
  `1:05:04` past an hour instead of `65:00`. People's journal query consumes
  the shared `_shared/journal-scheme.ts` walk rather than a second copy of it,
  and a queued People write is an honest landing: `settle()` re-reads the
  roster the outbox projected into and the roster and person rows wear the
  shared pending chip, so an offline add reads as saved-on-this-device rather
  than failed. The web shell's ⌘K listener attaches in a layout effect —
  before paint — closing the window in which a shortcut against a visible
  shell was swallowed. `google-contacts-pull` writes vCard's yearless
  birthday (`--09-05`, not `---09-05`). The Photos collections rail sends
  place names through `readableName` like every other place surface, so a
  coordinate pair is never printed as a name. Tasks' pending notice agrees in
  number ("1 write is"). The retired builder view's dead `CodeLang` export is
  local again and `diff.ts` (`DiffRow`/`lineDiff`, consumed only by its own
  test) is deleted. `to_link` is one helper (`toLinkCount`) shared by the
  dashboard query and the phone's model, absent-never-zero intact. Eight
  comment sites stop calling the conversation ⊃ turn ⊃ item ledger a "chat";
  the `kind: "chat"` union values and UI strings are untouched.

- #880 — A second offline write settles now. The defect was measured in
  `apps/web/tests/e2e/offline-search.spec.ts` (#846): with the gateway severed
  the first `window.centraid.write` resolved `queued`, and every write issued
  after it queued, painted its pending chip and never resolved or rejected —
  following the ORDER, not the row. Root cause was in
  `packages/client/src/replica/shell-session.ts`: the harness severs the
  transport but not `navigator.onLine`, so each write took the drain path and
  installed an admission waiter, and `drainLoop`'s transport-failure branch
  settled only the head it had claimed before scheduling a retry and returning.
  The outbox keeps its order, so the failed head was re-claimed on every retry
  and nothing behind it was ever claimed — its waiters sat forever. The branch
  now settles every registered waiter as `queued`, the same discipline the
  native rail (`apps/mobile/src/lib/replica/native-session.ts`) applies when
  its drain stops early: a durable queue admission is an honest settlement, an
  unresolved promise is not. Durable behaviour is unchanged — the reconnect
  drain still executes each intent exactly once — and
  `shell-session-admission.contract.test.ts` pins both halves in a
  tick-bounded window. Cross-rail, `ReplicaIntent.enqueuedAt` is now stamped in
  `IntentQueue.enqueue` and carried, with `attempts`, through the pending
  overlay, so a seat can say how long a write has been stuck rather than only
  that it is queued.

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
  The debt this entry left open is now paid: #880 re-authored that journey as
  `apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx` against the
  rebuilt Tally cover — a real SQLite process restart, sabotage-verified, with
  the same intent ids either side of the rebuild — and registered it as the
  `origin-pending-restart` row in `tests/matrix.json#appScenarios`.

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
