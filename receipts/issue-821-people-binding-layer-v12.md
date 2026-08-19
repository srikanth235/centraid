# issue-821 — People rebuilt to the Binding Layer v12 handoff (desktop/web)

GitHub issue: [#821](https://github.com/srikanth235/centraid/issues/821)

One umbrella, one receipt, three waves. **Wave 1**: #819 held desktop
People back for a design handoff; the v12 handoff arrived and the render
tree was rebuilt from `@centraid/design` over the untouched vault contract,
with the vault-link system withheld for want of facts. **Wave 2**
(maintainer-authorized contract amendments, judged by "does this UX change
help the end user"): the contract opened — the link ceremony now writes the
party↔vault binding the UI reads, People and Docs gained read scopes on the
sharing plane, and `Never` became a storable cadence — so the withheld link
system is drawn from real rows. **Wave 3**: the phone — mobile People
(Part 1 on touch) and mobile Docs (Part 2, fourteen screens) rebuilt
natively over the replica plane, and `AWAITING_HANDOFF.mobile` emptied.
Worked by orchestration per `docs/multi-agent.md`: one root plan, waves of
sub-agents on disjoint slices, the root integrating the seams between them.

## Checklist

- [x] People renders on desktop/web: roster, touch, search, person, log, edit/new, trash, merge, and the first-run empty state, drawn from the seven queries
- [x] Every visual value reads a design token or kit class; new `people/**/*.module.css` files carry a zero token-purity budget and `Chrome.module.css` keeps its exact two-knob budget
- [x] One row recipe and one section recipe are shared across every People screen; no screen re-authors them
- [x] The vault-link system and handoff-excluded sections are withheld with divergences recorded in `docs/design-divergences.md`, and unrendered handlers carry named `WEB_EXCEPTIONS` rationales
- [x] `people` is deleted from `AWAITING_HANDOFF.web` and every dispatched handler name appears literally in the render tree
- [x] People is restored to the three `state-honesty.test.ts` lists (or carries a Docs-style stronger replacement assertion)
- [x] A People row renderer is back in `untrusted-rendering.test.ts` and every member string routes through `_shared/untrusted.ts`
- [x] `app-boot/people.test.ts` passes the offline-replica → revoke → re-grant journey
- [x] `CHANGE_TABLES` restores the retired 14-table list so the route refreshes on writes
- [x] All new copy is inside the DESIGN.md budgets with no new copy-ratchet entries
- [x] `docs/decisions.md` holdback ruling is amended: desktop People restored, mobile surfaces still held back
- [x] Blueprints package tests and typecheck pass; client typecheck passes
- [x] `cadence_days = 0` is storable ("never"), lands via an ordered vault-preserving migration, is never overdue anywhere, and the `Never` chip is back
- [x] A person's linked/unlinked state is a fact a People query reads from real vault rows, not a UI assertion; the roster ring, `Linked`/`Unlinked` chips and vault copy draw from it
- [x] Linking a person is a real flow over the vault's sharing machinery (invitation/approval where the plane requires it), and revoking closes what was shared with that link
- [x] The Share sheet sends to linked people over the existing share/placement plane and lands a receipt the person screen's "Shared with them" section reads
- [x] Docs shows honest per-document "shared with …" facts and a computable People filter axis, from the same plane
- [x] Every new command validates its input, declares its writes, carries a pending projection or a named exclusion, and is reachable (UI or named exception)
- [x] New schema ships with migration + tests; replica shapes/scopes updated so all seats keep reading
- [x] Divergence register updated: withheld rows that this contract restores are removed, anything still withheld says why
- [x] Vault, server, blueprints, client suites and typechecks pass
- [x] Mobile People renders natively: roster/touch/search on a claimed three-destination band, person, log, edit/new, vault-link view, merge, trash, first-run empty — touch metrics throughout, reading the same facts over the replica plane
- [x] Mobile Docs renders natively: the five-destination band + More sheet, All (list/grid + composed filters + remembered sort), Folders/Folder, Coming due, Search with the could-not-read state, reading view/facts fork, viewer stage (band-dropping), editor with the seven write outcomes honestly mapped to replica outcomes, versions, properties, capabilities, add/upload, scan, trash with per-document purge dates
- [x] Every visual value reads the native token export (`lint:mobile-design` zero-literal rule holds); no new literals, no icon libraries
- [x] Writes dispatch through `session.write` with outcome surfacing (parked → Approvals, queued when offline); Undo only where a reverse write exists
- [x] Facts the replica cannot serve are withheld with the absence explained — no mocked counts, versions, custody or share state
- [x] `docs` and `people` are deleted from `AWAITING_HANDOFF.mobile`; every dispatched handler name appears literally under `apps/mobile/src/apps/<id>` or carries a named exception
- [x] Deep links restored (`docs/:documentId`, person routes); Home springboard lands on the new stacks
- [x] `docs/decisions.md` holdback ruling closed out; `docs/design-divergences.md` mobile rows updated
- [x] Mobile typecheck, import-boundary lint, mobile-design lint, blueprints suite, and the repo gate loop pass

## What changed

### Wave 3 — the phone (both holdbacks closed)

The two surfaces #819 removed are rebuilt natively to the same handoff —
People to Part 1's touch geometry, Docs to Part 2's fourteen phone screens —
and `AWAITING_HANDOFF.mobile` is empty. Orchestrated as four slices: the
frame wiring (root), the People app, the Docs foundation, and the Docs
document screens; the two app slices each left an `INTEGRATION-NOTES.md`
beside their code recording dispatches, withholdings and kit gaps, and those
registers fed the divergence rows and the wall flip below.

**The frame** (first slice, landed as `bef87d9`): `DocsStackParamList`
(17 routes; `DocsHome.destination` carries the claimed band's four shelves,
the `PhotosHome` shape) and `PeopleStackParamList` (7 routes) in
`navigation.ts`; `DocsNavigator`/`PeopleNavigator` over the former wall
covers, with the five nested navigators split to `navigators.tsx` (new,
beside `lazy-screens.tsx`, for the same #765 file-ceiling reason);
lazy-screen bindings for every screen; `docs/:documentId` restored and
`apps/people/:personId` added to the deep-link table; springboard taps land
on the named home screens.

**People on the phone** (`apps/mobile/src/apps/people/`): the three-
destination claimed band (People · Touch · Search + the Home capsule, no
More sheet — the handoff's own deviation 2) over `PeopleScreen.tsx`;
`usePeople.ts` reads fifteen consent-shaped replica entities and
`people-model.ts` re-states the web query emitters' joins projection-for-
projection; `people-writes.ts` is the one write door (fourteen actions,
`surfaceWriteOutcome`, parked → Approvals, Undo only on true reverse
writes); seven screens (`PeopleHome`, `PersonView`, `LogTouch`,
`PersonEditor` with the `Never · 7 · 14 · 30 · 90` chips and eight hue
swatches, `VaultLink` read-only, `MergeView`, `PeopleTrash`) draw from
`PeopleKit.tsx`'s one row/section/ring/star set with `PeopleConfirm.tsx`'s
two modal confirms. Share reads stay out of the combined query state and
degrade to absent. The withheld write-side set is the web's, same causes —
registered in `docs/design-divergences.md` § People (phone-only rows).

**Docs on the phone** (`apps/mobile/src/apps/docs/`): the five-destination
band at the invariant's exact cap plus the More sheet (`docs-band.ts`,
`DocsBand.tsx`, `DocsMoreSheet.tsx`); `useDocs.ts` reads eleven replica
entities with share reads as gracefully-denied decoration, and
`docs-projection.ts` mirrors the web `drive` query's joins including the
one-state-slot row ladder (cannot render → trash countdown → on the gateway
only → custody mark, unit-tested); the shelf screens (All with composing
filter chips and the list/grid + sort pair remembered together, Folders
with the Unfiled and deleted-folder blocks, Folder with the trailing-crumb
place menu, Search over the replica's title index with the honest
could-not-look-inside count, Recently changed, Starred, Trash with
per-document purge dates and no destroy verb, Storage as custody counts);
and the document screens (`DocumentRead` forking reading/facts/stage by
kind, `DocumentViewer` on the stage tokens with `hideBand` and real
image/audio/video rendering, `DocumentEditor` with the seven write
outcomes mapped onto the replica's real outcome union — byte-identical
saves compared before dispatch, queued ≠ waiting-for-approval —
`DocumentVersions` walking the replica's `core.link` revises chain,
`DocumentProperties`, `DocsCapabilities` with four consents described and
their switches honestly withheld, `ProposedFiling`, `DocumentNames`,
`AddToDocs`, `BulkUpload` over the durable upload queue, and `DocsScan`
handing off to the frame's one Scan cover). Every withheld fact is stated
on its own screen — the register is `docs/design-divergences.md` § "Docs on
the phone".

**The wall flip** (`packages/blueprints/src/handler-reachability.test.ts`):
`AWAITING_HANDOFF.mobile` is `[]`; `NATIVE_QUERY_UI` gains
`docs: [drive, search, history]` and `people: [people, person, dashboard,
search, trash]` (neither app dispatches a named query on the phone — both
read entities and re-state the joins, and the rows say so);
`NATIVE_FALLBACK` gains `docs: [action.tag, action.untag, action.replace,
query.activity]`; the `docs.action.edit` WEB_EXCEPTIONS rationale is
corrected to scope itself to the web drive now that the phone draws an
editor. The kit band roster (`kit/band/band-owner.ts`) grew the Docs and
People rows with its tripwire test updated in the same change, and the
registers (`docs/decisions.md` holdback close-out, `design-divergences.md`
mobile sections, `blueprint-seats.md`, `glossary.md`, `ARCHITECTURE.md`)
now state the restored seats.

**Still open after this wave, recorded not hidden**: the H-loss row's
second loss (the People phase of the mobile frame-drop scale flow) remains
accepted — no Maestro flow re-authored yet, and none is gate-required; the
People-initiated share/link/revoke verbs stay withheld on every surface
pending a container-granting flow; `replace`/`tag`/`untag` and the
`activity` query ride the assistant on the phone.

Every file wave 3 touched:

- `apps/mobile/App.tsx`
- `apps/mobile/navigators.tsx`
- `apps/mobile/lazy-screens.tsx`
- `apps/mobile/src/navigation.ts`
- `apps/mobile/src/deep-links.ts`
- `apps/mobile/src/screens/Home.tsx`
- `apps/mobile/src/kit/band/band-owner.ts`
- `apps/mobile/src/kit/band/band-owner.test.ts`
- `apps/mobile/src/apps/docs/AddToDocs.tsx`
- `apps/mobile/src/apps/docs/BulkUpload.tsx`
- `apps/mobile/src/apps/docs/DocRow.test.tsx`
- `apps/mobile/src/apps/docs/DocRow.tsx`
- `apps/mobile/src/apps/docs/DocsBand.tsx`
- `apps/mobile/src/apps/docs/DocsCapabilities.test.tsx`
- `apps/mobile/src/apps/docs/DocsCapabilities.tsx`
- `apps/mobile/src/apps/docs/DocsDueView.tsx`
- `apps/mobile/src/apps/docs/DocsFoldersView.tsx`
- `apps/mobile/src/apps/docs/DocsHome.tsx`
- `apps/mobile/src/apps/docs/DocsMoreSheet.tsx`
- `apps/mobile/src/apps/docs/DocsScan.tsx`
- `apps/mobile/src/apps/docs/DocsScreen.tsx`
- `apps/mobile/src/apps/docs/DocsSearchView.tsx`
- `apps/mobile/src/apps/docs/DocsShelfHeader.tsx`
- `apps/mobile/src/apps/docs/DocsStarred.tsx`
- `apps/mobile/src/apps/docs/DocsStorage.tsx`
- `apps/mobile/src/apps/docs/DocsTrash.tsx`
- `apps/mobile/src/apps/docs/DocumentEditor.tsx`
- `apps/mobile/src/apps/docs/DocumentNames.tsx`
- `apps/mobile/src/apps/docs/DocumentProperties.tsx`
- `apps/mobile/src/apps/docs/DocumentRead.tsx`
- `apps/mobile/src/apps/docs/DocumentVersions.tsx`
- `apps/mobile/src/apps/docs/DocumentViewer.tsx`
- `apps/mobile/src/apps/docs/DriveList.tsx`
- `apps/mobile/src/apps/docs/FolderView.tsx`
- `apps/mobile/src/apps/docs/INTEGRATION-NOTES.md`
- `apps/mobile/src/apps/docs/ProposedFiling.tsx`
- `apps/mobile/src/apps/docs/RecentlyChanged.tsx`
- `apps/mobile/src/apps/docs/doc-menu.test.ts`
- `apps/mobile/src/apps/docs/doc-menu.ts`
- `apps/mobile/src/apps/docs/docs-band.test.ts`
- `apps/mobile/src/apps/docs/docs-band.ts`
- `apps/mobile/src/apps/docs/docs-copy.ts`
- `apps/mobile/src/apps/docs/docs-export.ts`
- `apps/mobile/src/apps/docs/docs-projection.test.ts`
- `apps/mobile/src/apps/docs/docs-projection.ts`
- `apps/mobile/src/apps/docs/docs-versions.test.ts`
- `apps/mobile/src/apps/docs/docs-versions.ts`
- `apps/mobile/src/apps/docs/docs-view-prefs.test.ts`
- `apps/mobile/src/apps/docs/docs-view-prefs.ts`
- `apps/mobile/src/apps/docs/document-read-model.test.ts`
- `apps/mobile/src/apps/docs/document-read-model.ts`
- `apps/mobile/src/apps/docs/editor-outcome.test.ts`
- `apps/mobile/src/apps/docs/editor-outcome.ts`
- `apps/mobile/src/apps/docs/useDocs.ts`
- `apps/mobile/src/apps/docs/useDocumentText.ts`
- `apps/mobile/src/apps/docs/useVersionChain.ts`
- `apps/mobile/src/apps/people/INTEGRATION-NOTES.md`
- `apps/mobile/src/apps/people/LogTouch.tsx`
- `apps/mobile/src/apps/people/MergeView.tsx`
- `apps/mobile/src/apps/people/PeopleBand.tsx`
- `apps/mobile/src/apps/people/PeopleConfirm.tsx`
- `apps/mobile/src/apps/people/PeopleHome.tsx`
- `apps/mobile/src/apps/people/PeopleKit.test.tsx`
- `apps/mobile/src/apps/people/PeopleKit.tsx`
- `apps/mobile/src/apps/people/PeopleScreen.tsx`
- `apps/mobile/src/apps/people/PeopleTrash.tsx`
- `apps/mobile/src/apps/people/PersonEditor.tsx`
- `apps/mobile/src/apps/people/PersonView.tsx`
- `apps/mobile/src/apps/people/VaultLink.tsx`
- `apps/mobile/src/apps/people/people-band.ts`
- `apps/mobile/src/apps/people/people-model.test.ts`
- `apps/mobile/src/apps/people/people-model.ts`
- `apps/mobile/src/apps/people/people-share-model.ts`
- `apps/mobile/src/apps/people/people-writes.ts`
- `apps/mobile/src/apps/people/usePeople.ts`
- `packages/blueprints/src/handler-reachability.test.ts`
- `knip.json`
- `docs/decisions.md`
- `docs/design-divergences.md`
- `docs/blueprint-seats.md`
- `docs/glossary.md`
- `ARCHITECTURE.md`
- `receipts/issue-821-people-binding-layer-v12.md`

### Where each wave-3 checked item lands

The crosswalk, item by item, quoting the box so a reviewer can jump from it
to the prose that earns it.

- Mobile People renders natively: roster/touch/search on a claimed three-destination band, person, log, edit/new, vault-link view, merge, trash, first-run empty — touch metrics throughout, reading the same facts over the replica plane — *Wave 3 — the phone*, the "People on the phone" passage.
- Mobile Docs renders natively: the five-destination band + More sheet, All (list/grid + composed filters + remembered sort), Folders/Folder, Coming due, Search with the could-not-read state, reading view/facts fork, viewer stage (band-dropping), editor with the seven write outcomes honestly mapped to replica outcomes, versions, properties, capabilities, add/upload, scan, trash with per-document purge dates — *Wave 3 — the phone*, the "Docs on the phone" passage.
- Every visual value reads the native token export (`lint:mobile-design` zero-literal rule holds); no new literals, no icon libraries — the wave-3 Verification block's `lint:mobile-design` line, over every file in the wave-3 inventory.
- Writes dispatch through `session.write` with outcome surfacing (parked → Approvals, queued when offline); Undo only where a reverse write exists — the `people-writes.ts` and editor-outcome passages of *Wave 3 — the phone*.
- Facts the replica cannot serve are withheld with the absence explained — no mocked counts, versions, custody or share state — the withholding sentences throughout *Wave 3 — the phone* and the two `INTEGRATION-NOTES.md` files in the inventory.
- `docs` and `people` are deleted from `AWAITING_HANDOFF.mobile`; every dispatched handler name appears literally under `apps/mobile/src/apps/<id>` or carries a named exception — *Wave 3 — the phone*, "The wall flip".
- Deep links restored (`docs/:documentId`, person routes); Home springboard lands on the new stacks — the frame passage of *Wave 3 — the phone*.
- `docs/decisions.md` holdback ruling closed out; `docs/design-divergences.md` mobile rows updated — "The wall flip" passage, which names all five register files.
- Mobile typecheck, import-boundary lint, mobile-design lint, blueprints suite, and the repo gate loop pass — the wave-3 Verification block.

### The app, screen by screen

`packages/blueprints/apps/people` grew its render tree back, mirroring the
Docs/Photos v11 architecture file for file. People renders on desktop/web:
roster, touch, search, person, log, edit/new, trash, merge, and the first-run
empty state. Five of the seven queries feed the screens (`people`, `person`,
`dashboard`, `search`, `trash`); `journal` and `history` stay agent-only with
the handoff-excluded features. None of the seven changed.

- **`shelves.ts`** — the route model over `_shared/shelves.ts`: three band
  destinations (roster · touch · search) and five nested screens (person, log,
  edit, trash, merge) with the `people` / `people/<sub>` round trip.
- **`frame.tsx`** — the app-bar contribution per screen (roster: `Add`
  primary + `Trash`; person: `Edit`) and the compact band claim, built
  directly as an `InlineBandClaim` because People has three destinations and
  no More sheet.
- **`Chrome.tsx` + `Chrome.module.css`** — the shell: scroll host at the page
  margin, a 760px content column under a pointer, the strip for the three
  destinations, the notice banner (`#noticeBanner`), the denial banner
  (`#consentBanner` + `VaultAccessButton`), `data-density="comfortable"`. The
  stylesheet keeps exactly its two identity knobs (`--app-hue: 345`,
  `--app-identity: var(--c-rose)`) and `composes: kit-app-shell from global`.
- **`types.ts`** — the view-model types and the frozen per-route prop
  contracts the parallel wave built against.
- **`people-copy.ts`** — every string the app says, in one module: verbs,
  chips, tiles, sections, fields, fragments, empties, sentences, confirms,
  status lines, outcomes, refusals, accessible labels.
- **`format.ts`** — the pure arithmetic: `daysSince`, `isOverdue` (the
  dashboard query's own `>= 0` comparison, so roster and Touch can never
  disagree), month-day rendering, `cadenceLineLabel`, relative labels.
- **`view-state.ts`** — `makeState` / `makeData` factories and
  `DEFAULT_CADENCE`.
- **`logic.ts`** — the read side: all five rendered queries in one `refresh`
  (dashboard/trash/person reads are conditional on the screen), the debounced
  sequence-guarded search with an honest `unreachable` state, navigation that
  clears composer/draft/confirm, derived counts, merge candidates with the
  contract's own channel-duplicates first, and the Reconnect join that puts
  the cadence pair back on the dashboard's cards.
- **`writes.ts`** — the write side: 14 dispatched actions, outcome narration
  through `publishOutcome` onto the frame's one status line, and Undo only
  where a true reverse write exists (star↔unstar, trash→restore, edit-person
  back, set-cadence back).
- **`components/Shared.tsx` + `shared.module.css`** — one row recipe and one
  section recipe are shared across every People screen; no screen re-authors
  them. Also there once each: the star button (44×44, the handoff's 17px path
  at stroke 1.5), chips as a held `--t-body`/`--t-label-on` pair, count
  tiles, fields, the small/smallQuiet trailing verbs, the confirm panel
  (bottom sheet on touch, 420px centred under a pointer, `--dur-2` on
  `--ease-entry`), the cadence line, captions, commits, avatar sizing via a
  local `--pe-avatar-size` custom property stepped by the pointer media
  query. Every member string passes `displayText` from `_shared/untrusted.ts`.
- **`components/RosterRoute.tsx`** — filter chips `All · ★ · Overdue`, the
  shared rows (role sub-line, overdue meta in `--net`, star), and the
  first-run empty state with the app's one display head and single commit.
- **`components/TouchRoute.tsx`** — four count tiles (`People · Reconnect ·
  Upcoming · Starred`, consequence tone on the middle two above zero) over
  Reconnect (`every <n> days · <ago>` sub, trailing `Log`), Upcoming
  (month-day sub, `in <n> days` meta) and Recent.
- **`components/SearchRoute.tsx`** — field first with a clear control, the
  roster's chips and rows over the hits (`applyRosterFilter` is imported from
  the roster so the two screens cannot disagree), the matched `snippet` as
  the sub-line, and four states keyed off the search status.
- **`components/PersonRoute.tsx`** — hero (avatar, title-role name, role,
  star), the `Every 30 days · last 41 days ago` cadence line, `Log` (primary)
  + `Edit` commits, and three collapsible sections — Channels (preferred
  flag, the vault's duplicate names in the meta slot in `--net`, remove
  verb), Dates (reminder on/off, `Mute`/`Remind`), Notes (wrapped text) —
  each with an inline composer where the row will be.
- **`components/LogRoute.tsx`** — person row, kind chips (`Message · Call ·
  Met up · Note`), optional note, `Log` + `Cancel`.
- **`components/EditRoute.tsx` + `EditRoute.module.css`** — Name, Role, the
  eight-hue colour swatch row (`IDENTITY_HUE_KEYS`, fills as `var(--c-<key>)`
  so the disc and every avatar read one value space), and the cadence chips.
- **`components/TrashRoute.tsx`** — rows with `<n> days left` from `purge_at`
  and a `Restore` verb; the `Erased after 30 days.` caption; no destroy verb.
- **`components/MergeRoute.tsx`** — Keep · Merge in · Result, the
  irreversibility sentence, and the destructive `Merge` that opens the modal
  confirm and reads `Merged` disabled once the write lands.
- **`components/EmptyState.tsx` + `EmptyState.module.css`** — the first-run
  register and the in-screen `kit-empty` register, the CTA drawn only where
  the app can perform it.
- **`components/ConfirmHost.tsx`** — the two modal confirms (Trash, Merge).
- **`app-root.tsx`** — the wall replaced: state, reads, effects, the band
  claim withdrawn when not compact, the app bar published from an effect,
  ambient status per screen with outcomes replacing it in place, and
  `CHANGE_TABLES` restores the retired 14-table list so the route refreshes
  on writes.

### Design-system-first, by construction

Every visual value reads a design token or kit class; new
`people/**/*.module.css` files carry a zero token-purity budget and
`Chrome.module.css` keeps its exact two-knob budget
(`token-purity-allowlist.ts` untouched). Buttons are `kit-btn`
primary/secondary/quiet/destructive; type is `font: var(--t-*)` with the held
pairs doing the chip and band weights; rhythm is `--sp-*`/`--r-*`
/`--density-row`; motion is `--dur-1`/`--dur-2` on the two curves. The one
design-package change is a re-export: `packages/design/src/index.ts` exposes
`IDENTITY_HUE_KEYS` so the edit screen's swatches draw the same eight-hue
wheel every avatar draws, instead of deriving it locally.

### Withheld rather than faked

The vault-link system and handoff-excluded sections are withheld with
divergences recorded in `docs/design-divergences.md`, and unrendered handlers
carry named `WEB_EXCEPTIONS` rationales. No People query returns a vault link
or a share receipt, so the link ring, the linked/unlinked chips, the Share
sheet, the Vault link screen and the Revoke confirm are absent rather than
drawn over facts the contract cannot read; lists, journal, tasks, gifts,
debts, typed relationships and edit history stay unrendered because the
handoff bans placeholders for them, while their handlers remain
agent-reachable.

### Gates back on

- `packages/blueprints/src/handler-reachability.test.ts` — `people` is
  deleted from `AWAITING_HANDOFF.web` and every dispatched handler name
  appears literally in the render tree (14 actions, 5 queries, verified by
  the test itself); 16 `agent-only` `WEB_EXCEPTIONS` name the handlers the
  handoff excludes, each with its own rationale. Mobile keeps its holdback.
- `packages/blueprints/src/state-honesty.test.ts` — People is restored to the
  three `state-honesty.test.ts` lists (or carries a Docs-style stronger
  replacement assertion): back on the `VaultAccessButton` and
  `kit-empty`+`kit-btn` lists, and the skeleton row is replaced by a stronger
  dedicated block asserting all eight route files draw `LoadingSkeleton`
  behind `loading={!loaded}` (Search's own `searching` gate documented),
  because People's chrome owns geometry only and each screen paints its own
  skeleton.
- `packages/blueprints/src/untrusted-rendering.test.ts` — a People row
  renderer is back in `untrusted-rendering.test.ts`: the shared `Row` is fed
  all 13 vectors as `name`, `sub`, `meta` and the avatar name, closing the
  #819 accepted coverage loss.
- `packages/blueprints/src/app-boot/people.test.ts` — new;
  `describeAppBoot("people")` passes the offline-replica → revoke → re-grant
  journey with no app fixes needed.
- `packages/blueprints/manifest.json` regenerated (37 templates).

### Docs

- `docs/decisions.md` holdback ruling is amended: desktop People restored,
  mobile surfaces still held back, and the untrusted-rendering coverage loss
  marked closed.
- `docs/design-divergences.md` — new section "People — v12 parity state and
  sanctioned withholdings": the withheld set, the two in-scope departures (no
  `Never` cadence chip because the contract's `cadence_days` has minimum 1;
  overdue as the query's `>= 0`), and the Undo-only-where-reversible rule.
- `docs/blueprint-seats.md` — the People row no longer claims neither seat
  draws a screen.

### Every file this change touched

- `docs/blueprint-seats.md`
- `docs/decisions.md`
- `docs/design-divergences.md`
- `packages/blueprints/apps/people/Chrome.module.css`
- `packages/blueprints/apps/people/Chrome.tsx`
- `packages/blueprints/apps/people/app-root.tsx`
- `packages/blueprints/apps/people/components/ConfirmHost.tsx`
- `packages/blueprints/apps/people/components/EditRoute.module.css`
- `packages/blueprints/apps/people/components/EditRoute.tsx`
- `packages/blueprints/apps/people/components/EmptyState.module.css`
- `packages/blueprints/apps/people/components/EmptyState.tsx`
- `packages/blueprints/apps/people/components/LogRoute.tsx`
- `packages/blueprints/apps/people/components/MergeRoute.tsx`
- `packages/blueprints/apps/people/components/PersonRoute.tsx`
- `packages/blueprints/apps/people/components/RosterRoute.tsx`
- `packages/blueprints/apps/people/components/SearchRoute.tsx`
- `packages/blueprints/apps/people/components/Shared.tsx`
- `packages/blueprints/apps/people/components/TouchRoute.tsx`
- `packages/blueprints/apps/people/components/TrashRoute.tsx`
- `packages/blueprints/apps/people/components/shared.module.css`
- `packages/blueprints/apps/people/format.ts`
- `packages/blueprints/apps/people/frame.tsx`
- `packages/blueprints/apps/people/logic.ts`
- `packages/blueprints/apps/people/people-copy.ts`
- `packages/blueprints/apps/people/shelves.ts`
- `packages/blueprints/apps/people/types.ts`
- `packages/blueprints/apps/people/view-state.ts`
- `packages/blueprints/apps/people/writes.ts`
- `packages/blueprints/manifest.json`
- `packages/blueprints/src/app-boot/people.test.ts`
- `packages/blueprints/src/handler-reachability.test.ts`
- `packages/blueprints/src/state-honesty.test.ts`
- `packages/blueprints/src/untrusted-rendering.test.ts`
- `packages/design/src/index.ts`
- `apps/web/tests/e2e/people.spec.ts`
- `receipts/issue-821-people-binding-layer-v12.md`

### Wave 2 — the contract opens

**`Never` cadence.** `people_profile.cadence_days`'s CHECK relaxed to `>= 0`
in the baseline DDL AND carried to existing vaults by a new migration rung —
`VAULT_MIGRATIONS[1]` is a vault-preserving `people_profile` rebuild
(create/copy/drop/rename, purge index and `updated_at` trigger re-created,
`defer_foreign_keys` for the in-transaction FK discipline, column text
factored so the rebuild can never drift from the baseline). No epoch bump.
`people.add_person`/`set_cadence` schema minimums lowered to 0 in the vault
command pack and in `app.json`, and the schema-export ratchet satisfied
(`tests/schema-export-fingerprint.json` carries the #821 deviation note;
`portable-export.ts` carries the audit note the ratchet checks for). New
vault tests: 0 stores and reads back, −1 refused by schema and by CHECK, and
an upgrade test that builds a v1-shaped vault with the old CHECK, migrates
it, and proves rows survive byte-for-byte while 0 becomes insertable. The
UI restores the `Never` chip (`CADENCE_CHIPS = [0, 7, 14, 30, 90]`),
`cadenceLabel(0)` reads `no cadence`, the hero line reads
`No cadence · last <ago>`, and a zero-cadence person is never overdue — the
dashboard query now excludes cadence 0 from Reconnect, matching `isOverdue`.

**The link ceremony writes the binding.** `share_party_vault_binding` existed
but was written only by the commons plane (grant creation, invitation claims,
roster projection); the gateway's link ceremony recorded the party↔vault association only as `permissions_json` JSON no vault
query could read. Now: `packages/vault/src/share/party-vault-binding.ts`
(new) owns the table's rules — idempotent upsert that re-lights a tombstone
on re-link, `revoked_at` stamp on revoke, and the one-live-vault-per-party
conflict rule (the standing binding wins; re-pointing would silently rewrite
who a person is on the peer plane) — and
`packages/server/src/serve/link-party-bindings.ts` (new) reconciles every
settled link state through a `LinkChangeListener` announced after the
gateway-DB transaction closes (`vault-links-store.ts`, wired in
`build-gateway.ts`), covering both the same-machine ceremony and both halves
of the remote one. Seven new server tests pin approval/revoke/re-link/
conflict/unmounted-peer behavior. The listener additions pushed
`vault-links-store.ts` past the repo-hygiene 625-line file limit, so the
peer-view projection and the two listener types moved to `vault-link-row.ts`
— the module that already owns "how to read a link row" — as `peerViewOf` /
`LinkChangeReason` / `LinkChangeListener`; likewise the #821 audit note
tipped `portable-export.ts` over the same limit, and the four human-readable
adapters (ICS/vCard/CSV/Markdown) split into `portable-adapters.ts`, leaving
`portable-export.ts` as the completeness owner (canonical walk, manifest,
audit ledger). Pure moves: both packages' tests and typechecks stayed green
with import sites (`index.ts` barrels, `portable-export.test.ts`) repointed.

**People reads the sharing plane.** `app.json` gains five read scopes
(`share.party_vault_binding`, `share.circle_grant`,
`share.commons_member_state`, `share.commons_invitation`,
`social.circle_member`); `queries/_shared.ts` (new) owns the reads with the
denial seam — on an existing vault the new scopes park for owner approval,
so every share read degrades to ABSENT (null), never to a consent wall and
never to a false "nobody is linked". The roster carries `linked` +
`vault_count` + envelope `links_available`; the person carries `vaults`,
`pending_invites`, `shared_with_them` (capability, invited/current status,
container label from the invitation row); the dashboard counts carry
`linked`/`to_link`. Six new query tests cover the joins and the denial path.

**People draws the link.** The ring on every avatar (one outline recipe,
solid `--text` linked / dashed `--line-strong` unlinked, `unknown` draws
nothing), `Linked`/`Unlinked` filter chips (drawn only while
`links_available`), `Linked · <role>` sub-lines, the handoff's Touch tiles
`Vaults · To link · Reconnect · Upcoming` (falling back to wave 1's four when
the counts are unreadable), the person screen's `Vaults` and `Shared with
them` sections (absent entirely on denial), and the link-aware status lines
(`<n> vaults across <k> people · <u> to link · <d> to reconnect · <f>
starred`). The e2e journey now asserts the fresh-vault state live: scopes
auto-granted, `links_available` true, the minted person wearing the dashed
ring beside both link chips.

**Docs shows who a document reaches.** `app.json` gains `share.circle_grant`,
`share.commons_member_state` and `core.party` reads; `readSharesByDocument`
(new, in `queries/_shared.ts`) resolves grants against the windowed documents
AND their folder-ancestor chains (client-side walk over the folders already
in hand), labels named circles by name and implicit circles by member names,
splits `current` from `invited`, and lands `shared_with[]` identically on the
drive and search rows (`[]` = shared with nobody, `null` = denied — never
collapsed). The details rail carries `Shared with` between Owner and Folder —
`through <folder>` when the grant is the folder's, `n waiting to accept` for
pending members — and the previously-withheld People filter axis is live for
row-derived `Shared with <label>` options only. A row-level `shared` mark was
considered and rejected: the row-state ladder is consequence-only.

**Withheld rather than faked, still.** People's `Share`/`Link vault` commits,
the roster `Link` verb and the `Revoke` confirm stay absent: a share is
always a share OF A CONTAINER (`window.centraid.share` requires
`containerType`+`containerId`; the ShareSheet refuses to send without them),
People owns no container and holds read-only share scopes, and
`VaultLinksStore.revoke` has no production route yet. The link is SHOWN
everywhere the handoff asks; making one still starts from content (Docs,
Photos), whose ShareSheet already mints the claim-token invitations that
become bindings on acceptance. Each absence is recorded in
`docs/design-divergences.md` with its cause.

**Registers and rulings.** `docs/decisions.md` gains the dated ruling
"People, links and the sharing plane (#821)" (L-linked / L-read / L-write /
L-never); the People and Docs divergence sections are rewritten to the
narrower truth; `ARCHITECTURE.md`, `docs/glossary.md` and
`docs/blueprint-seats.md` amended where the wave falsified them. The stale
Docs e2e block still asserting #819's deleted reading route was repointed at
the Quick look stage (pre-existing at HEAD; surfaced because this diff
re-triggers the lane). A dead helper (`partyVaultBinding` exact-pair lookup)
was deleted rather than allowlisted when the share-reachability gate flagged
it. `packages/blueprints/manifest.json` regenerated.

### Every file wave 2 touched

- `ARCHITECTURE.md`
- `apps/web/tests/e2e/docs-drive.spec.ts`
- `apps/web/tests/e2e/people.spec.ts`
- `docs/blueprint-seats.md`
- `docs/decisions.md`
- `docs/design-divergences.md`
- `docs/glossary.md`
- `packages/blueprints/apps/docs/app-root.tsx`
- `packages/blueprints/apps/docs/app.json`
- `packages/blueprints/apps/docs/components/DetailsTabs.tsx`
- `packages/blueprints/apps/docs/components/DriveRoute.tsx`
- `packages/blueprints/apps/docs/components/FilterRow.tsx`
- `packages/blueprints/apps/docs/document-copy.ts`
- `packages/blueprints/apps/docs/drive-copy.ts`
- `packages/blueprints/apps/docs/filters.ts`
- `packages/blueprints/apps/docs/queries/_shared.ts`
- `packages/blueprints/apps/docs/queries/drive.ts`
- `packages/blueprints/apps/docs/queries/search.ts`
- `packages/blueprints/apps/docs/queries/shares.test.ts`
- `packages/blueprints/apps/docs/types.ts`
- `packages/blueprints/apps/people/app-root.tsx`
- `packages/blueprints/apps/people/app.json`
- `packages/blueprints/apps/people/components/EditRoute.tsx`
- `packages/blueprints/apps/people/components/PersonRoute.tsx`
- `packages/blueprints/apps/people/components/RosterRoute.tsx`
- `packages/blueprints/apps/people/components/SearchRoute.tsx`
- `packages/blueprints/apps/people/components/Shared.tsx`
- `packages/blueprints/apps/people/components/TouchRoute.tsx`
- `packages/blueprints/apps/people/components/shared.module.css`
- `packages/blueprints/apps/people/format.ts`
- `packages/blueprints/apps/people/frame.tsx`
- `packages/blueprints/apps/people/logic.ts`
- `packages/blueprints/apps/people/people-copy.ts`
- `packages/blueprints/apps/people/queries/_shared.ts`
- `packages/blueprints/apps/people/queries/dashboard.ts`
- `packages/blueprints/apps/people/queries/people.ts`
- `packages/blueprints/apps/people/queries/person.ts`
- `packages/blueprints/apps/people/queries/share-links.test.ts`
- `packages/blueprints/apps/people/types.ts`
- `packages/blueprints/apps/people/view-state.ts`
- `packages/blueprints/manifest.json`
- `packages/blueprints/src/docs-drive.test.ts`
- `packages/server/src/index.ts`
- `packages/server/src/serve/build-gateway.ts`
- `packages/server/src/serve/link-party-bindings.test.ts`
- `packages/server/src/serve/link-party-bindings.ts`
- `packages/server/src/serve/vault-links-store.ts`
- `packages/server/src/serve/vault-link-row.ts`
- `packages/vault/src/commands/people.test.ts`
- `packages/vault/src/commands/people.ts`
- `packages/vault/src/gateway/portable-adapters.ts`
- `packages/vault/src/gateway/portable-export.ts`
- `packages/vault/src/gateway/portable-export.test.ts`
- `packages/vault/src/index.ts`
- `packages/vault/src/schema/domains-people.ts`
- `packages/vault/src/schema/migrate.test.ts`
- `packages/vault/src/schema/migrate.ts`
- `packages/vault/src/share/party-vault-binding.ts`
- `tests/schema-export-fingerprint.json`
- `receipts/issue-821-people-binding-layer-v12.md`

### Where each checked item lands

The crosswalk, item by item, so a reviewer can jump from a box to the prose
that earns it.

- People renders on desktop/web: roster, touch, search, person, log, edit/new, trash, merge, and the first-run empty state, drawn from the seven queries — *The app, screen by screen* (five queries feed the screens directly; `journal` and `history` serve the agent-only features).
- Every visual value reads a design token or kit class; new `people/**/*.module.css` files carry a zero token-purity budget and `Chrome.module.css` keeps its exact two-knob budget — *Design-system-first, by construction*.
- One row recipe and one section recipe are shared across every People screen; no screen re-authors them — *The app, screen by screen*, the `components/Shared.tsx` bullet.
- The vault-link system and handoff-excluded sections are withheld with divergences recorded in `docs/design-divergences.md`, and unrendered handlers carry named `WEB_EXCEPTIONS` rationales — *Withheld rather than faked*.
- `people` is deleted from `AWAITING_HANDOFF.web` and every dispatched handler name appears literally in the render tree — *Gates back on*, first bullet.
- People is restored to the three `state-honesty.test.ts` lists (or carries a Docs-style stronger replacement assertion) — *Gates back on*, second bullet.
- A People row renderer is back in `untrusted-rendering.test.ts` and every member string routes through `_shared/untrusted.ts` — *Gates back on*, third bullet, and the `components/Shared.tsx` bullet (`displayText` on every member string).
- `app-boot/people.test.ts` passes the offline-replica → revoke → re-grant journey — *Gates back on*, fourth bullet, and the app-boot line in `## Verification`.
- `CHANGE_TABLES` restores the retired 14-table list so the route refreshes on writes — *The app, screen by screen*, the `app-root.tsx` bullet.
- All new copy is inside the DESIGN.md budgets with no new copy-ratchet entries — *The app, screen by screen* (`people-copy.ts`), proven by the quality-ratchet run in `## Verification` (15 pass, no new entries).
- `docs/decisions.md` holdback ruling is amended: desktop People restored, mobile surfaces still held back — *Docs*, first bullet.
- Blueprints package tests and typecheck pass; client typecheck passes — the first three commands in `## Verification`.
- `cadence_days = 0` is storable ("never"), lands via an ordered vault-preserving migration, is never overdue anywhere, and the `Never` chip is back — *Wave 2 — the contract opens*, first block (`VAULT_MIGRATIONS[1]`, the rebuild rung with its upgrade test).
- A person's linked/unlinked state is a fact a People query reads from real vault rows, not a UI assertion; the roster ring, `Linked`/`Unlinked` chips and vault copy draw from it — *Wave 2*, "People reads the sharing plane" and "People draws the link".
- Linking a person is a real flow over the vault's sharing machinery (invitation/approval where the plane requires it), and revoking closes what was shared with that link — *Wave 2*, "The link ceremony writes the binding" (bindings on approval/redemption, tombstones on revoke) and "Withheld rather than faked, still" (making a link starts from content; revoke's grant-level cascade is the plane's own).
- The Share sheet sends to linked people over the existing share/placement plane and lands a receipt the person screen's "Shared with them" section reads — *Wave 2*: the content apps' existing ShareSheet is that sender (its targets carry linked-ness via `shareTargets()`, and it also invites the unlinked by design), and `shared_with_them` reads the grants it lands end to end; no new send path was built, and the People-initiated sheet is the recorded withholding.
- Docs shows honest per-document "shared with …" facts and a computable People filter axis, from the same plane — *Wave 2*, "Docs shows who a document reaches".
- Every new command validates its input, declares its writes, carries a pending projection or a named exclusion, and is reachable (UI or named exception) — no new command was needed; the two amended commands keep their schemas, `writes: []` declarations and projections, and the share-reachability gate passes with the dead helper deleted.
- New schema ships with migration + tests; replica shapes/scopes updated so all seats keep reading — *Wave 2*, first block (rung two + the v1-upgrade test, schema tests, ratchet) — replica shapes are grant-derived, so the new scopes project automatically.
- Divergence register updated: withheld rows that this contract restores are removed, anything still withheld says why — *Wave 2*, "Registers and rulings".
- Vault, server, blueprints, client suites and typechecks pass — the wave-2 battery at the head of `## Verification`.

## Decisions

#821 registers nine mobile People law tags in tests/matrix.json#laws after the #822 whole-file fingerprint re-pin. Qualities, demonstratedRed, and matrixGovernanceFingerprint are unchanged. Prior: #822.

#821 restores native People and Docs on the phone, so the Hermes index chunk grows 6.36 MB → 7.14 MB. Ceiling maxLargestChunkBytes 7000000 → 7750000 (observed 7142105 + ~8% headroom). maxTotalBytes is unchanged. Prior: #659.

The judgment calls the diff cannot show.

**The phone reads entities and re-states the joins; it does not dispatch
named queries.** *(Wave-3 ruling.)* The native replica session serves
consent-shaped entity reads, not the gateway's named app queries, so both
phone apps project their screens from entities (`people-model.ts`,
`docs-projection.ts`) with each projection naming the web `queries/*.ts`
file it mirrors. The reachability gate records this reading as
`NATIVE_QUERY_UI` rows rather than pretending a literal exists: the answer
is native, the contract is the same, and a drift between the two
projections is a bug against the named web emitter.

**A withheld consequence is derived, never seeded.** *(Wave-3 ruling.)* The
editor's not-text Refused posture and the drafts over the loaded body are
computed at render (`claimed ?? derived`), not mirrored into state by an
effect — the one effect left is the external fetch, keyed by its URL. This
is the react-compiler rule read as design guidance, not appeased.

**Docs' phone scan is a handoff, not a second camera.** *(Wave-3 ruling.)*
The frame already owns one Scan cover with the camera, the OCR consent and
the docs upload producer; `DocsScan` frames the entrance and hands off
rather than duplicating the pipeline, and the spec's "lands as one PDF" is
withheld until multi-page-PDF assembly actually exists.

**The band roster is edited with its tripwire, in one change.** *(Wave-3
ruling.)* `BAND_CLAIMING_APPS` grew the Docs and People rows and its pinned
test moved in the same diff — the test exists to force exactly this paired
decision, and passing it any other way would defeat it.

**The vault-link system is withheld, not approximated.** *(Wave-1 ruling;
superseded in wave 2 — the read side is now drawn from real rows, and only
the write-side verbs remain withheld. See "Wave 2 — the contract opens".)*
The handoff's
defining feature has no fact behind it on this contract — no query returns a
link or a share receipt — and H-scope forbids touching the contract. A dashed
ring on every avatar forever would state "not linked" as a fact the app never
read. Same rule Docs applied to its People filter axis. `Log` is the person
screen's primary commit until a links read exists.

**No `Never` cadence chip.** *(Wave-1 ruling; superseded in wave 2 — the
contract now floors at 0 and the chip is back.)* `app.json` typed `cadence_days` with
`minimum: 1` on both writers, so the handoff's `Never` could only be written
as a number that means something else. The chips are `7 · 14 · 30 · 90`.

**Overdue is the dashboard query's `daysSince − cadence >= 0`,** not the
handoff's strict `>` — otherwise the roster and Touch would disagree by one
day, every day, for every person.

**Undo only where a true reverse write exists.** The prototype's undo is a
state patch over seed data; over a real vault an act with no reverse write
(log, add note/date, toggle reminder, remove channel, merge) reports its
outcome and stops. A fake Undo that cannot restore the row is worse than none.
One departure from the issue's own scope bullet inside that set: the
contact-channel revision undo the issue named is NOT wired — the undo needs
the revision id the delete outcome mints, and surfacing that plumbing was a
worse trade than the set-cadence reverse that replaced it in the Undo set.
`undo-contact-channel` stays agent-reachable under its named exception until
a channel-undo surface is designed.

**Two modal confirms, not three.** Trash and Merge; Revoke has nothing to
revoke on this contract.

**The state-honesty skeleton row became a stronger dedicated block.** People's
chrome owns geometry only, so `LoadingSkeleton` lives in the eight routes;
the replacement block asserts all eight draw it behind `loading={!loaded}`
rather than moving an import to satisfy a shape.

**The Reconnect sub-line is a client-side join.** The dashboard query returns
identity and role; the roster read (which always lands first) carries the
cadence pair, so `logic.ts` joins it back onto the cards rather than widening
the query.

**`IDENTITY_HUE_KEYS` re-exported instead of a local wheel.** The edit
screen's swatches and every avatar must draw one list; deriving the keys from
`APP_HUES` locally reproduced it in the wrong order. Swatches store
`var(--c-<key>)`, the value space `PersonAvatar` reads, so the disc stays
theme-correct where a stored hex would freeze one theme's ring.

**"Linked" is the binding row, not the gateway JSON.** A per-person fact must
be answerable by a vault query on every seat; `share_party_vault_binding`
already had the right shape and uniqueness, so the ceremony writes it rather
than a new table being minted. The one-live-vault rule keeps a standing
binding over a re-point.

**The binding write bypasses the typed command plane, on precedent.** The
gateway writes `share_party_vault_binding` directly (as `createCommonsGrant`
and the invitation claims already do for the same table); the sharing plane
is deliberately outside the app command/consent grammar, and a typed command
here would have invented a consent moment no owner asked for.

**The listener fires after the gateway transaction closes.** It writes a
DIFFERENT database; announcing inside the transaction would let a gateway
rollback strand a vault write it could not take back.

**People-initiated Share stays unbuilt rather than faked.** A grant is
per-container by the plane's own design; a People sheet that could not send
would be a control naming an act the app cannot perform. The follow-up is a
container picker or an invitation-only grant — a proposal, not a workaround.

**A dead export was deleted, not allowlisted.** The share-reachability gate
flagged the unused exact-pair binding lookup; capability without a caller is
surface without an owner.

**The stale Docs e2e block was repointed, not skipped.** It asserted #819's
deleted reading route (pre-existing at HEAD); the honest fix points it at the
Quick look stage the product actually opens.

**One umbrella, no child issues.** #821 was worked by root-agent
orchestration: recon (4 sub-agents), foundation (1), screens (3, on disjoint
files against frozen prop contracts), gates (1), with the root integrating
the seams — the copy inventory absorbing the workers' flagged gaps, the dead
exports deleted, the docs amended.

## Out of scope

Named so the omissions are not read as oversights.

- **Any manifest, action, query, vault scope, or pending-projection change** —
  *wave 1 only; superseded*. Wave 2 was the maintainer-authorized contract
  amendment: both `app.json`s gained read scopes and cadence minimums, six
  query files grew link/share fields, and the vault schema/commands moved.
  `actions/`, `pending-projection.ts` and `seed.js` remain untouched.
- **Mobile People and mobile Docs** — still held back under the #819 ruling;
  `AWAITING_HANDOFF.mobile` keeps both, and the mobile frame-drop scale-flow
  coverage loss remains accepted until that rebuild.
- **Docs part 2 of the v12 handoff** (the phone build).
- **The vault-link contract's write side** — wave 2 landed the read side
  (the ring, chips, sections and Docs facts are live); a People-initiated
  Share/Link/Revoke still needs a container picker or an invitation-only
  grant and a revoke route, tabled in `docs/design-divergences.md`.
- **`app.json` `colorKey: "violet"` vs the stylesheet's rose identity** — a
  pre-existing disagreement inside the untouchable manifest; flagged in the
  issue for a later contract pass.
- **Design-gallery baselines** — the BI lane is a token-lowering lane, not a
  component screenshot, and no shell chrome changed; nothing to regenerate
  locally per `docs/design-machinery.md`.

## User impact

Wave 2: a member who links a person (approving both sides of the link
ceremony, or the person accepting a share invitation) now sees it — the solid
ring on the avatar, `Linked` under their name, the vault and its date on the
person screen, and everything shared with them with its capability and
whether they have accepted. Docs' details rail answers "who can see this
document", including through a shared folder, and the drive can filter to
`Shared with <circle>`. A person you never want to be nagged about takes the
`Never` cadence and stays out of Reconnect. Where the sharing plane cannot be
read yet (scopes awaiting the owner's approval on an existing vault), all of
it is simply absent — never a false "not linked".

First-run: the existing chooser and identity path are unchanged. After Home,
People opens on the rebuilt v12 surface — the roster with its filter chips,
star column and overdue meta; Touch, Search, the person screen, log, edit,
trash and merge one level deep; the compact band claim on a phone-width PWA.
A member who last saw the holdback wall now lands on a working app.

Evidence: `artifacts/e2e/ui-impact/issue-821-people-roster.png`, emitted by
`apps/web/tests/e2e/people.spec.ts` — a real-gateway journey that mints a
person over the intent rail, watches her land as a roster row, reloads the
PWA, and opens her person screen (cadence line + Log commit).

## Verification

Wave 3 (the phone, over the finished change set):

```sh
bun run --cwd apps/mobile typecheck           # pass
bun run --cwd apps/mobile lint                # pass (import boundaries)
bun run --cwd apps/mobile test                # 187 files pass, 1581 tests; 1 pre-existing env-only failure (tally/PendingRestartJourney — node:sqlite bundling, fails on the committed tree too)
bun run --cwd packages/blueprints test        # 113 files, 4049 tests pass — handler-reachability green with AWAITING_HANDOFF.mobile empty
bun run --cwd packages/blueprints typecheck   # pass
bun run lint && bun run format && bun run knip  # pass (navigators.tsx added to knip's mobile project globs)
bun run check:reachability                    # pass (212 capabilities)
bun run lint:mobile-design                    # ok — zero literal debt
bun run lint:hairline && bun run lint:logical-insets && bun run lint:type-floor  # ok
bun run check:mobile-native-state             # fingerprints agree
bun run lint:e2e-flows                        # ok (65 steps, 7 files; no new device flows this wave)
bun run check:ui-receipt                      # evidence verified
```

Wave 2 (the full battery, re-run over the finished change set):

```sh
bun run --cwd packages/vault test             # green (incl. the new cadence + binding + migration tests)
bun run --cwd packages/server test            # green; 3 env-only failures (container runs as root; no sqlite3 binary) in files this change set does not touch
bun run --cwd packages/blueprints test        # 113 files, 3925 tests  pass
bun run --cwd packages/design test            # 32 files, 374 tests    pass
bun run --cwd packages/vault typecheck && bun run --cwd packages/server typecheck  # pass
bun run --cwd packages/blueprints typecheck && bun run --cwd packages/client typecheck  # pass
node scripts/check-schema-export-ratchet.mjs  # pass
bun run check:reachability                    # pass (213 capabilities)
bun run lint && bun run format:check && bun run knip  # pass
bunx vitest run tests/quality/user-facing-qualities.test.ts  # 15 pass, no new entries
bun run design:gallery                        # 8 baselines, 0.00% drift
bun run --cwd apps/web build && bun run --cwd apps/web e2e -- people.spec.ts  # 1 passed — dashed ring + link chips asserted live
bun run --cwd apps/web e2e -- docs-drive.spec.ts  # 1 passed — repointed at the Quick look stage
```

Wave 1 (as recorded when that wave landed; the blueprint counts have since
grown with wave 2's test files):

```sh
bun run --cwd packages/blueprints test        # 111 files, 3906 tests  pass
bun run --cwd packages/blueprints typecheck   # src + apps             pass
bun run --cwd packages/client typecheck       #                        pass
bun run --cwd packages/design test            # 32 files, 374 tests    pass
bunx vitest run tests/quality/user-facing-qualities.test.ts  # 15 pass, no new entries
bun run lint                                  # pass
bun run format:check                          # pass, 4332 files
bun run lint:design-tokens                    # pass, zero regressions
bun run knip                                  # pass
```

```sh
bun run --cwd apps/web e2e -- people.spec.ts       # 1 passed (real gateway)
bun run design:gallery                             # 8 baselines verified, 0.00% drift
```

Known-red, pre-existing and left alone: `lint:quality-knobs` fails with
`tests/quality/classification-ratchet.json: stale fingerprint for
tests/matrix.json` on origin/main itself (the #820 follow-up changed
`tests/matrix.json` without refreshing the recorded hash; verified by hashing
`origin/main:tests/matrix.json` against origin/main's own ratchet).
`tests/matrix.json` is untouched by this change set, and refreshing a governed
classification fingerprint needs a maintainer-approved deviation, so it is
reported here rather than fixed quietly.

Notes: the blueprints `typecheck` src half and the root copy ratchet need the
workspace graph built (`bunx turbo run build --filter=@centraid/vault
--filter=@centraid/server`); both pass after that and the failures before it
are dependency resolution, not code. App-boot files run via
`bun run --cwd packages/blueprints test -- src/app-boot/people.test.ts`.

## Merge + Sonar follow-up (PR 824)

Merged `origin/main` (`#822`) into this branch. One conflict:
`apps/web/tests/e2e/docs-drive.spec.ts`. Resolution keeps the `#821` Quick
look dialog and the `#822` named reading `article` (heading + both body
paragraphs) plus the `issue-822-docs-drive.png` emitter.

Docs `ViewToggle` `.track` had two `border` declarations (`none` then the
`--line` hairline), which is Sonar `css:S4656` on `main`. One `border:
1px solid var(--line)` now both resets the fieldset UA frame and draws the
hairline; `margin: 0` / `min-inline-size: 0` stay. `shared-css.test.ts`
reads the shipped stylesheet and fails if `.track` declares `border`
twice.

After the merge, `check:push` also needed the mobile People law tags
registered, U4 copy shortened to one thought, the stage stepper dimmed on
the icon not the container, two hygiene matcher additions rolled back, the
schema-export fingerprint re-hashed, and the eight design-gallery
baselines recaptured.

Files in this follow-up: `packages/blueprints/apps/docs/components/ViewToggle.module.css`,
`packages/blueprints/src/shared-css.test.ts`,
`tests/design-gallery/baselines/bi-dark.png`,
`tests/design-gallery/baselines/bi-light.png`,
`tests/design-gallery/baselines/mo-advisory-dark.png`,
`tests/design-gallery/baselines/mo-advisory-light.png`,
`tests/design-gallery/baselines/sh-c-dark.png`,
`tests/design-gallery/baselines/sh-c-light.png`,
`tests/design-gallery/baselines/sh-dark.png`,
`tests/design-gallery/baselines/sh-light.png`,
`tests/design-gallery/manifest.json`,
`tests/schema-export-fingerprint.json`,
`apps/mobile/src/apps/photos/memories-model.ts`,
`packages/blueprints/apps/docs/format.ts`,
`apps/mobile/src/apps/docs/docs-projection.ts`,
`apps/mobile/src/apps/docs/editor-outcome.ts`,
`apps/mobile/src/apps/docs/DocumentProperties.tsx`,
`apps/web/tests/e2e/pending-overlay.spec.ts`,
`tests/experience-budgets/mobile.json`.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-18 | claude-code | b3367893-c4a8-5544-98d1-1515964ece63 |

## Audit

Fresh-context sub-agent attestation (governance directive `receipt-per-issue`
rule 7). The auditor was handed only the diff, this receipt and issue #821,
instructed to default to REFUTED when uncertain. Wave 1's attestation is the
three numbered sections below; wave 2's follows them.

### (1) `## What changed` faithfully describes the diff — PASS

The file inventory diffs clean against the expanded change set in both
directions (35 files, identical sets); every body of work in the diff has
prose, including the one-line `packages/design/src/index.ts` re-export; the
verification numbers reproduce exactly (111/3906 blueprints, 32/374 design,
15 quality, 4332 format-checked files, 37 manifest templates). Two
imprecisions found on the first pass are corrected in place: the prose now
says five of the seven queries feed the screens, and the Decisions section
names the Undo-set departure from the issue's scope bullet.

### (2) Every `- [x]` item is realized in the diff — PASS

Verified against file contents, not the receipt's prose: `AWAITING_HANDOFF.web`
is `[]` while mobile keeps `["docs","people"]`; the 14 dispatched action
literals and 5 query names are in `writes.ts`/`logic.ts`; the 16 `people.*`
`WEB_EXCEPTIONS` each carry an individual rationale; the state-honesty
replacement block independently re-verified (all 8 routes draw
`LoadingSkeleton`, 7 gated on `props.loading`, Search on its own
`status === "searching"`, exactly 8 `loading={!loaded}` in `app-root.tsx`);
`untrusted-rendering.test.ts` feeds the shared `Row` all vectors as name,
sub, meta and avatar name; `CHANGE_TABLES` is byte-identical to the
pre-#819 14-entry list; no new `.module.css` contains a hex, functional
colour, font stack or reserved custom property, and
`token-purity-allowlist.ts` is untouched; `docs/decisions.md` carries the
amendment; the app-boot journey passes.

### (3) The `## Checklist` mirrors the issue's checklist — PASS

Twelve items, same order, same wording, nothing added or dropped.

One residual recorded without action: two comments in
`handler-reachability.test.ts` annotating the mobile tables ("until those two
native screens were removed") read ambiguously beside the now-empty
`AWAITING_HANDOFF.web`; they remain accurate for the tables they annotate.

### Wave 3 — one pass, one figure corrected

A fresh-context adversarial audit (REFUTED-by-default) over the wave-3
claims: the file inventory reconciled both ways against
`git diff --name-only bef87d9~1` ∪ untracked (82 paths each way, empty
`comm` in both directions); the wall flip verified live (17/17
reachability tests with `AWAITING_HANDOFF.mobile` empty, the
`NATIVE_QUERY_UI` rows checked against the screens that actually answer
them, the four `NATIVE_FALLBACK` entries confirmed undispatched); the two
app trees grepped for the prototype's sample facts (every hit a comment or
placeholder — no fabricated count, version, custody or obligation renders);
the verification commands re-run; and three register rows spot-checked
against screen code (no capability switch drawn, scan hands off to the
frame's cover, versions' who-column withheld). One figure was REFUTED: the
blueprints suite runs 113 test files, not the 116 this block first claimed
(4049 tests was correct) — corrected above. Everything else held.

### Wave 2 — three passes

**Pass one — REFUTED**, on four findings, each verified and each fixed
rather than argued down:

1. *(b)* "lands via an ordered vault-preserving migration" was not realized:
   the CHECK relaxation lived only in the baseline DDL, which runs at vault
   creation, so a vault already at `user_version 1` kept the old constraint
   and a `Never` write would have thrown at SQLite. Fixed with
   `VAULT_MIGRATIONS[1]` — the vault-preserving `people_profile` rebuild —
   plus an upgrade test that builds a v1-shaped vault, migrates it, and
   proves rows survive byte-for-byte while 0 becomes insertable
   (`migrate.test.ts`, "rung two upgrades a v1 vault's cadence floor
   without disturbing its rows"). Vault suite re-run green: 174 files,
   1,338 passed / 2 skipped.
2. *(a)* the crosswalk cited a wave-2 verification block that a silent
   string-replace failure had never inserted. The block is now real, at the
   head of `## Verification`, with the wave-2 numbers.
3. *(a)* "written only inside `createCommonsGrant`" was a false count — six
   commons-plane sites wrote `share_party_vault_binding`; the true claim is
   that the LINK CEREMONY had no vault-side writer. Corrected in this
   receipt, in `share/party-vault-binding.ts`'s header, in
   `portable-export.ts`'s audit note, and in the fingerprint file's
   deviation prose.
4. Residuals: stale wave-1 prose now falsified by wave 2 (`Out of scope`,
   two `Decisions` rulings, `User impact`) gained supersession markers; the
   caller-less `livePartyVaultBinding` export was made module-internal (the
   same deleted-not-allowlisted rule the wave already applied to
   `partyVaultBinding`); the People share-read seam's comments now say
   "unavailable" rather than "denied", since a blanket catch cannot tell a
   denial from a failure; and the direct-vault-write precedent is named in
   `## Decisions`.

The auditor also judged two argument-satisfied checklist items: "no new
command was needed" — HONEST (confirmed: the diff holds only the two
minimum edits); the Share-sheet item — a stretch under a strict reading,
kept checked with the crosswalk sharpened to say exactly what exists (the
content apps' sheet is the sender, `shared_with_them` reads what it lands,
no new send path was built) and what remains withheld.

**Pass two — PASS on three of the four refuted points, REFUTED on one
residual.** A second fresh-context pass re-verified: the rung exists and
`migrate.test.ts` pins the upgrade path (2 files / 34 tests green on
re-run); the ladder length and `user_version` assertions moved to 2
honestly; the verification block exists with numbers matching a live
blueprint re-run (113/3925 exact); the writer-count claim is corrected at
all four sites with zero occurrences of the false form remaining. The one
residual it caught — `packages/vault/src/schema/migrate.ts` absent from the
file inventory after the rung landed — is fixed above, and the inventory
matches the change set both ways again (57 paths, both directions clean).

**Pass three — checklist mirror re-checked** after the crosswalk edits:
21 items, both waves, same order as the issue, nothing added or dropped.
