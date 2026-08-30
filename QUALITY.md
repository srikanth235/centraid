# Quality Tracker

## Open

- **"Free up space" on mobile is a button that can never be pressed.**
  `apps/mobile/src/screens/BackupHealth.custody.tsx` renders the `FREE_UP_ACTION`
  Pressable with a hard-coded `disabled` and `accessibilityState={{ disabled: true }}`,
  above a line reading "Release the copies from the app that holds them —
  Photos re-hashes each device original before deleting it." So the surface
  computes a real offer (`freeUpOffer` reports the releasable count and bytes),
  states a real cause and consequence, renders an affordance for it — and then
  refuses, permanently, pointing the member somewhere else. Not a bug in the
  sense of broken code: the comment beside it (`this surface never deletes a
  device original`) says the refusal is deliberate. It is a **product question**:
  a disabled control with no path to becoming enabled reads as a defect to the
  person looking at it, and the two candidate answers are opposite — either wire
  it to the Photos eviction path it names, or stop drawing a button and make the
  redirect the whole affordance. Found while trying to write #890 W5's
  "device journey proving real eviction", which cannot exist while this holds:
  there is no eviction on the phone to observe. Left unfixed because choosing
  between those two answers is a design decision, not a test-layer one.

- **The comment-density ratchet does not measure what its header claims.**
  `scripts/check-comment-density-ratchet.mjs` says its parser walk "catches
  trailing comments (they lead the NEXT token), JSX comments, and the file-end
  comments carried by the EOF token". `commentRanges()` calls only
  `ts.getLeadingCommentRanges` at each leaf token, and TypeScript classifies a
  comment sharing a line with the preceding token as TRAILING trivia, which that
  function skips by design. So `const a = 1; // note` and `<div>{/* note */}</div>`
  both score zero comment characters while counting toward the denominator.
  Measured across the 4,077 tracked files: **79,832 hidden comment characters,
  0.36% of the tree**; global share 14.55% measured against 14.91% true; 549
  files whose number changes; 529 that would exceed their pin; 101 hiding more
  than 200 characters each. The worst are JSX-heavy components where the
  invisible prose is most of the file — `docs/components/List.tsx` 10.3% → 44.8%,
  `Grid.tsx` 11.8% → 43.8%, `photos/Chrome.tsx` 11.1% → 42.2%. The perverse
  consequence is that unmeasured comments are pure denominator, so *deleting*
  JSX prose raises a `.tsx` file's measured share — #883's sweep hit exactly that
  on `List.tsx`. Two remedies, an order of magnitude apart: fix the scanner and
  clean the ~101 files that carry real hidden prose, or fix the scanner and
  re-seed with a recorded deviation the way the 2026-08-25 seed was recorded.
  That the down-only pin rule makes a measurement *correction* impossible without
  a deviation is a design gap in the ratchet worth settling on its own. Found by
  #883's ceremony against #861's gate; not taken there, because either remedy
  changes a blocking gate well outside that issue's scope.

- **`portable-export.ts` keeps an append-only audit ledger in the State layer.**
  `packages/vault/src/gateway/portable-export.ts` declares itself the
  schema/export completeness audit owner and accumulates one narrative entry per
  issue in its header (#865, #872 twice, #883). AGENTS.md puts append-only
  evidence in receipts and keeps `docs/`-and-code state freely revisable, so this
  header grows one paragraph per schema wave and never sheds one. #883 compressed
  the entries to their MUST-carry facts rather than restructure the convention.
  The durable fix is to keep the invariant ("every registered table rides the
  `SELECT *` walk; here is what would break if it stopped") in the file and move
  the per-issue audit trail to the receipts that already exist.

- **`evaluateReplicaRead` has no production caller on any host.**
  `packages/client/src/replica/query.ts` still exports it, but the store compiles
  the grammar to SQL in `read-plan.ts` and mobile's multi-vault reader composes a
  plan; the function survives only as the oracle the pushdown parity suites
  execute against. That is a legitimate use — an independent implementation is
  what makes a parity proof mean anything — but it is not what the file says it
  is, and a second implementation nobody runs drifts. Whether the proof or the
  function should go is the open decision.

- **An ordered replica page cannot use an index while its refusal guards ride
  the same statement.** `planComposedReplicaRead` puts one
  `max(CASE ... END) OVER ()` column in the select list per order guard, and a
  window function over an unbounded frame must see every row before the first
  one is emitted — so an ordered read materialises the whole entity whatever the
  ORDER BY key is made of. Measured on the 2026-08-29 development container
  against the 50,000-row year-3 corpus
  (`tests/scale/browser-replica-query.fixture.ts`), through `store.read`:
  103 ms for the filtered newest-first page, 174 ms unfiltered. Adding an index
  over the exact ORDER BY expression and changing nothing else moves those to
  103 ms and 171 ms — no effect, because the plan never reaches the index.
  Removing the guards (and, for the filtered read, the `(verdict = 0) ASC` tier
  that leads the sort) moves them to **2.2 ms and 0.4 ms** on the same index.
  So the ~50-400x lives behind the guards, not behind the extraction. A guard
  restructure is the lever, and it is a correctness change, not a storage one:
  a set-wide census answers "does any kept row hold an unorderable value", and
  making it cheap means either a second statement over the same filtered set
  (measured 65 ms) or widening the question to the whole entity (measured 24 ms)
  — a new divergence, since the refusal would then fire on rows the filter
  excluded. Found while auditing #883's D1 clause, and not taken there because
  the clause it disproves is a storage clause.

- **Two surfaces #882 added to the phone are unvirtualized.**
  `apps/mobile/src/apps/notes/NotesPlaces.tsx` and `NotesHistory.tsx` render
  through a `ScrollView` with `.map()` rather than a `FlatList`, and neither is
  pinned by `scripts/accessibility-contract.test.mjs`. Found by the independent
  audit on #882, not a regression of any existing contract (these files are new),
  and the fix is the same shape the Tasks board already uses. Locker's Access
  history was the third; #883 C4 windowed it with Locker's other list surfaces
  and pinned all of them in the contract.
- **The phone's Access history cannot narrow to one item.**
  `lockerAccess` (`apps/mobile/src/apps/locker/locker-gateway.ts`) never sends
  `item_id`, so the phone always reads the newest receipts across every item
  while the browser offers *This item* as a lens (`components/Access.tsx`
  `onNarrow` → `surface-acts.handleNarrowAccess`). The READ is bounded either
  way — `queries/access.ts` clamps `limit` to 20…2,000 and both hosts take the
  200 default — so this is a missing lens, not an unbounded query. Closing it
  wants an entry point that carries an item id (the item screen's *Access*
  verb), which is a route change rather than a list one.
- **Agenda's search field appears to stall while you type.** The input is
  controlled off `state.search`, but `applySearchInput` is a trailing-edge 200ms
  debounce, so the value the field renders only catches up after the pause.
  Pre-existing, found while #882 moved the field out of the More sheet and
  deliberately not changed there — that slice preserved the wiring rather than
  altering behaviour under a band fix. The fix is to let the input hold its own
  immediate value and debounce only the query.
- **CI's Rust toolchain floats, so a clippy release can turn any branch red.**
  `.github/workflows/ci.yml` installs `dtolnay/rust-toolchain` with `toolchain: stable`,
  unpinned, while `packages/tunnel/data-plane/Cargo.toml` declares only `rust-version =
  "1.91"` as an MSRV floor. On 2026-08-27 `stable` reached 1.98 and the new
  `clippy::chunks_exact_to_as_chunks` lint took `static` red on #880's branch against a
  crate that branch never touched — the same file having been green on `main` five hours
  earlier. #880 fixed the one call site; the class is still open. Pinning the toolchain to
  a known version (and moving it deliberately) is the durable fix, but it is a
  governance-gated toolchain config change and deserves its own argument rather than a
  drive-by pin.

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
  `packages/server/src/acp/backends/acp/launch.test.ts` inherits the real
  `process.env` through `planLaunch`, so a host that exports `IS_SANDBOX`
  (this container: `yes`) fails two assertions — the test should stub the
  variable, not trust the host; (2)
  `packages/server/src/serve/gateway-db-lock.integration.test.ts` shells out
  to the `sqlite3` CLI, absent here — a candidate for the new
  `tests/env-red.json` inventory (guard on CLI presence) or a rewrite against
  `node:sqlite`. Both still red in this container at #883's close, and both
  paths are restated here because the packages they used to name
  (`agent-runtime`, `gateway`) no longer exist.

- **A packaged desktop cannot spawn its detached gateway, whatever the CLI
  path resolves to.** #883 repaired both dead branches of
  `resolveGatewayCliPath()` (the exports map did not carry `./package.json`, and
  the monorepo fallback climbed one level short), and package resolution is now
  correct in every installed layout. Verified against a real
  `electron-builder --dir` build, the remaining gap is downstream of resolution:
  `@centraid/server` is packed into `app.asar` and is NOT in
  `app.asar.unpacked`, while `resolveNodeBin()` returns plain `"node"` under
  Electron — and a plain Node process cannot read an asar member (checked: it
  fails `Cannot find module`, while the same path under `ELECTRON_RUN_AS_NODE=1`
  reads fine). A packaged consumer build also has no reason to assume `node` is
  on `PATH` at all. Closing it means either unpacking the server's transitive
  graph or running the daemon on the Electron binary as node, and both change
  which process owns the detached child — the H2/H3 ownership contract — so it
  wants its own measurement rather than a drive-by. Not a regression: the path
  was broken before #883 too, in a different way.

- **A retired entity left an inaccurate coverage comment behind.**
  `packages/vault/src/schema/search.test.ts:401` says the deleted
  `home.asset_item` describe block's coverage survives "by `core.party` … and
  `locker.item` above" — neither entity is searched anywhere in that file. The
  two-direct-column shape it cared about is actually covered by `schedule.task`.
  Harmless (the accurate statement is recorded in the `minimumTests` deviation
  pin next to the number), but the comment should be corrected by whoever next
  edits that file.
- **`google-calendar-invite-send` uses wall-clock `new Date()`** (DTSTAMP)
  and `Math.random()` (MIME boundary) inside the published handler —
  nondeterminism the connector lane's lint doesn't catch; its tests
  deliberately don't assert those bytes.
- **`apps/desktop/tests/e2e` standalone `tsc` has 13 pre-existing errors**
  (missing `window.CentraidApi` augmentation when run outside the harness)
  and `apps/web/tests/e2e/tsconfig.json` likewise; neither is wired to a gate,
  so spec type rot is invisible. Wire or retire the configs.

- **Two raw `<button>`s carry no styling at all.** `AutomationThreadScreen` and
  `RunViewScreen` each render `<button type="button" onClick={onBack}>` with no
  class, against a kit with 32 `<Button>` uses. (`CaptureOverlay` was the third
  until quick capture was retired from this seat.) Eight more raw buttons use a
  local class and four already ride shared ones (`controlsCss.chip`,
  `buttonCss.ghost`); the unstyled two are the unambiguous misses.

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

- **Tasks' home screen cannot mount: its band names an icon the design package
  does not ship.** `apps/mobile/src/apps/tasks/tasks-band.ts:42` names `"Inbox"`
  for the third band destination (and again at `:92` as the More sheet's first
  row), `@centraid/design` ships no `Inbox` icon, and
  `apps/mobile/src/kit/components/icon-resolver.ts` carries no alias for it — so
  `resolveIconName` **throws inside `TasksBand`'s render**, before any Tasks
  content is drawn. Verified against the built design package:
  `isIconName("Inbox") === false`. Nothing cheaper saw it, and the reason is
  instructive: `tasks-band.test.ts` asserts the icon *table* and never that a
  name in it resolves, and the DOM-stub tier never mounts the band at all. Found
  by #890's RNTL promotion, and pinned there as a characterisation test in
  `apps/mobile/src/apps/tasks/TasksHome.test.tsx` (first case, marked
  DELETE-ON-FIX) per the A-pinned doctrine — #890 is chartered to rebuild the
  test layer, not to change the product, and a lane that quietly fixed what it
  found would leave no record that the gap in the cheaper tiers existed. The fix
  is one of: add the glyph, alias it in `icon-resolver.ts`, or name a shipped
  icon; whichever lands should delete the pin in the same change.

- **Accessibility labels on plain `View`s are never published to the tree.**
  `AgendaBand`'s tab group carries `accessibilityRole="tablist"` and
  `AgendaHome`'s `NowLine` carries `accessibilityLabel="Now"`, but neither sets
  `accessible`, so React Native never promotes them to accessibility elements —
  the grouping role and the "Now" marker are absent from the tree a screen
  reader walks, and on the Agenda that line is otherwise just a coloured rule.
  The same shape appears in `DocsBand`, `TasksBand`, `TallyBand`, `LockerBand`
  and `PeopleBand`. Invisible to the DOM-stub tier by construction: the stub
  maps `accessibilityLabel` straight onto `aria-label`, so a stub test sees a
  label that the device does not publish. Found and pinned by #890 in
  `apps/mobile/src/apps/agenda/AgendaHome.test.tsx` (last case, DELETE-ON-FIX).

- **`origin/main` was already red on `test:comment-density` before #890.**
  Verified in a clean worktree at `3e555c8d`:
  `node scripts/check-comment-density-ratchet.mjs` fails there on eighteen files
  no branch had touched — `packages/vault/src/gateway/portable-export.ts`,
  `packages/vault/src/{grant/fulfillment,schema/migrate}.test.ts`, six
  `packages/blueprints/apps/*/pending-projection.ts`-shaped files, three
  `apps/web/tests/e2e/*.spec.ts`, and `apps/mobile/src/kit/share/GrantSheet*`
  among them — plus three unpinned files over the 15% cap. A down-only gate that
  is red on the default branch cannot distinguish a regression from the standing
  state, so every branch inherits the failure and every author must decide
  whether to absorb it. #890 absorbed those eighteen into its pin raise, with the
  reason stated at the number in `tests/comment-density-ratchet.json`, rather
  than leave its own branch red for something it did not cause. That absorption
  is a workaround, not the fix. Two things want settling on their own: how a pin
  file drifts out of agreement with the tree on `main` at all (a `--write` that
  was never run, or a merge that landed while red), and the separate open
  observation above that the scanner under-measures trailing and JSX comments —
  which makes every `.tsx` number in that file wrong in the same direction.

## Resolved

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
