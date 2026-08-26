<!-- One receipt for issue #873; each slice appends its own section. -->

## Checklist

- [x] Delete the pre-v17 Expo Locker UI and rebuild it against the v17 design
- [x] Draw every custodian/origin Locker route the surface inventory lists
- [x] Close the online-only write hole on the native replica session
- [x] Build the Expo Tally cover against the v17 design, and end its handoff suspension
- [x] Own the Receipt surface on the origin seat, where capture lives
- [x] Give the phone's offline expense its missing `tally.expense_payer` shape
- [ ] Autofill native extensions (a later slice)
- [ ] Backend doors — access-history query, alias read-back, items-window total, import bridge (other slices)

## What changed

**Slice: the Expo Locker cover, rebuilt (v17).**

*Deleted whole* — `apps/mobile/src/apps/locker/LockerHome.styles.ts`,
`LockerHome.types.ts`, `LockerHome.views.tsx`, `LockerItemRow.tsx`,
`LockerUnlockScreen.tsx`, and the old body of `LockerHome.tsx`.
`locker-device-auth.ts` and `locker-device-auth.test.ts` are infrastructure and
stayed.

*The boundary.* `apps/mobile/src/apps/locker/locker-store.ts` is the seat's one
memory-only vault — a module store read through
`apps/mobile/src/apps/locker/useLockerVault.ts` with `useSyncExternalStore`,
not a React context, so no remount can reconstruct a session the boundary
ended. It composes the shared rules rather than restating them: the session
machine and the enumerated `SecretBag`/`wipeSecretState` from
`apps/locker/session.ts`, the permit arithmetic from `apps/locker/permits.ts`.
It boots locked, locks the moment the window is hidden, slides its five-minute
window on any touch, and conceals a revealed value the second its permit runs
out. `apps/mobile/src/apps/locker/locker-gateway.ts` is the only door — RPC to
the app's own query handlers, never the replica, for anything touching a secret
or a session. `apps/mobile/src/apps/locker/locker-clipboard.ts` is the
compare-then-clear wipe over `expo-clipboard`, taking its seconds and its two
sentences from the blueprint's `clipboard.ts`.

*The frame and the band.* `apps/mobile/src/apps/locker/LockerScreen.tsx` wraps
every surface and asks `shelves.suppressesNavigation` once: while locked, at
setup or when denied it renders `apps/mobile/src/apps/locker/LockerWall.tsx`
and withdraws both the children and the band. The band itself is
`apps/mobile/src/apps/locker/locker-band.ts` +
`apps/mobile/src/apps/locker/LockerBand.tsx` (Items · Review · Generate ·
Search · More, ids and labels from the shared shelves), with
`apps/mobile/src/apps/locker/LockerMoreSheet.tsx` behind the fifth slot.
`{ id: "locker" }` joins `BAND_CLAIMING_APPS` in
`apps/mobile/src/kit/band/band-owner.ts`, and
`apps/mobile/src/kit/band/band-owner.test.ts` names it.

*The surfaces.* `apps/mobile/src/apps/locker/LockerHome.tsx` hosts the four
band places — `apps/mobile/src/apps/locker/LockerItemsView.tsx`,
`apps/mobile/src/apps/locker/LockerReviewView.tsx`,
`apps/mobile/src/apps/locker/LockerGenView.tsx`,
`apps/mobile/src/apps/locker/LockerSearchView.tsx` — over the shared row recipe
in `apps/mobile/src/apps/locker/LockerRow.tsx` and the state notices in
`apps/mobile/src/apps/locker/LockerNotice.tsx`. Pushed routes:
`apps/mobile/src/apps/locker/LockerItemScreen.tsx` (field rows from
`apps/mobile/src/apps/locker/LockerFields.tsx`, the full-stop gate from
`apps/mobile/src/apps/locker/LockerPermitGate.tsx`),
`apps/mobile/src/apps/locker/LockerEditScreen.tsx`,
`apps/mobile/src/apps/locker/LockerTrashScreen.tsx`,
`apps/mobile/src/apps/locker/LockerAccessScreen.tsx` and
`apps/mobile/src/apps/locker/LockerSurfaceScreen.tsx`, which draws Import,
Export and Companion as facts plus the sentence naming where the act happens.
`apps/mobile/src/apps/locker/locker-view-model.ts` resolves which designed
state a surface is in and holds the elsewhere-surface tables;
`apps/mobile/src/apps/locker/locker-seat-copy.ts` holds the words that are true
on a phone and nowhere else.

*The camera.* `apps/mobile/src/apps/locker/otpauth.ts` is the pure otpauth
grammar and `apps/mobile/src/apps/locker/LockerScanSheet.tsx` the origin-only
scanner, following the frame's existing `expo-camera` pattern. The seed is
handed straight to the form and never written to this device.

*The writes.* `apps/mobile/src/apps/locker/locker-writes.ts` issues every
Locker write through the shared builders, so `onlineOnly` travels with the
payload rather than being decided at the call site.

*The online-only door (the security fix).*
`apps/mobile/src/lib/replica/native-session.ts` gained
`NativeWriteInput.onlineOnly` and a `postAction` transport that posts the
action straight to the app's handler before any id is minted, any projection is
built or any queue is touched — and fails rather than falling back.
`apps/mobile/src/screens/Scan.tsx`'s Locker destination moved into
`apps/mobile/src/screens/scan-locker.ts` and now carries the flag, so a scanned
card number can no longer reach the durable SQLite outbox.
`apps/mobile/src/lib/replica/locker-online-only.test.ts` pins all three claims.

*Shared-layer hoists (one computation).*
`packages/blueprints/apps/locker/item-fields.ts` is new — the sealed/metadata
field sets and the fixed dot run, lifted out of
`packages/blueprints/apps/locker/components/Item.tsx` and consumed by it, by
`packages/blueprints/apps/locker/components/Fields.tsx`, by
`packages/blueprints/apps/locker/components/Edit.tsx` and by the phone.
`packages/blueprints/apps/locker/clipboard.ts` gained `copiedSecretCopy` /
`copiedMetadataCopy` so both seats say the copy outcome once.
`packages/blueprints/apps/locker/types.ts` declares `AuthPayload.credentialId`,
which the auth query already returned.

*Frame registration.* `apps/mobile/src/navigation.ts` declares
`LockerStackParamList` longhand; `apps/mobile/navigators.tsx` gained
`LockerNavigator`; `apps/mobile/lazy-screens.tsx` registers the five new
screens; `apps/mobile/App.tsx` mounts the navigator;
`apps/mobile/src/deep-links.ts` routes `locker` and `locker/item/:itemId`;
`apps/mobile/src/screens/Home.tsx` names the nested screen on the tile tap.

*Evidence.* Pure tables and models beside their subjects —
`apps/mobile/src/apps/locker/locker-band.test.ts`,
`apps/mobile/src/apps/locker/locker-view-model.test.ts`,
`apps/mobile/src/apps/locker/otpauth.test.ts` and
`apps/mobile/src/apps/locker/locker-store.test.ts`, which asserts the wipe over
`SECRET_BEARING_KEYS` itself so a new secret-bearing field cannot be added
without it noticing. Designed states rendered through the shared React Native
stub — `apps/mobile/src/apps/locker/LockerWall.test.tsx` (first run, lock,
denied), `apps/mobile/src/apps/locker/LockerItemsView.test.tsx` (loading, day
one, no match, offline, pending, window end, the device offer),
`apps/mobile/src/apps/locker/LockerFields.test.tsx` (sealed run, revealed
countdown, the permit gate's four sentences and its refusal) and
`apps/mobile/src/apps/locker/LockerReviewView.test.tsx` (both registers and all
clear).

*Ledgers and docs.* `tests/agent-e2e-mobile/flows/locker-gate.mjs` and
`tests/agent-e2e-mobile/flows/locker-gate.md` follow the v17 copy;
`tests/matrix.json` gains nine owned origin-seat scenarios and
`docs/apps/locker-scenarios.md` mirrors them;
`packages/blueprints/src/handler-reachability.test.ts` drops `query.search` and
`query.trash` from Locker's native fallback (the phone names both now) and says
why the seven item writes stay; `docs/mobile-offline.md` states the online-only
write door; `tests/quality/copy-allowlist.json` drops the seed for the deleted
`LockerUnlockScreen.tsx` and lowers `maxEntries` 31 → 30.


**Slice: the Expo Tally cover, built (v17, origin seat).**

*New, under `apps/mobile/src/apps/tally/`* — the band triple
`apps/mobile/src/apps/tally/tally-band.ts`,
`apps/mobile/src/apps/tally/TallyBand.tsx`,
`apps/mobile/src/apps/tally/TallyMoreSheet.tsx`; the read plane
`apps/mobile/src/apps/tally/tally-gateway.ts`,
`apps/mobile/src/apps/tally/tally-store.ts`,
`apps/mobile/src/apps/tally/useTallyVault.ts`; the write door
`apps/mobile/src/apps/tally/tally-writes.ts`; the pure seat tables
`apps/mobile/src/apps/tally/tally-view-model.ts` and
`apps/mobile/src/apps/tally/tally-seat-copy.ts`; the §5 component recipes
`apps/mobile/src/apps/tally/TallyParts.tsx`,
`apps/mobile/src/apps/tally/TallyEntryRow.tsx`,
`apps/mobile/src/apps/tally/TallyChips.tsx`,
`apps/mobile/src/apps/tally/TallyNotice.tsx`,
`apps/mobile/src/apps/tally/TallyAskSheet.tsx`; the frame
`apps/mobile/src/apps/tally/TallyScreen.tsx` and its denied gate
`apps/mobile/src/apps/tally/TallyGate.tsx`; the four band places
`apps/mobile/src/apps/tally/TallyHome.tsx` (rewritten from the empty cover),
`apps/mobile/src/apps/tally/BalancesView.tsx`,
`apps/mobile/src/apps/tally/ActivityView.tsx`,
`apps/mobile/src/apps/tally/GroupsView.tsx`,
`apps/mobile/src/apps/tally/WaitingView.tsx`; the pushed surfaces
`apps/mobile/src/apps/tally/TallyGroupScreen.tsx`,
`apps/mobile/src/apps/tally/TallyFriendScreen.tsx`,
`apps/mobile/src/apps/tally/TallyExpenseScreen.tsx`,
`apps/mobile/src/apps/tally/TallyAddScreen.tsx`,
`apps/mobile/src/apps/tally/TallyReceiptScreen.tsx`,
`apps/mobile/src/apps/tally/TallySettleScreen.tsx`,
`apps/mobile/src/apps/tally/TallyRecurringScreen.tsx`,
`apps/mobile/src/apps/tally/TallySpendingScreen.tsx`,
`apps/mobile/src/apps/tally/TallyTrashScreen.tsx`,
`apps/mobile/src/apps/tally/TallySearchScreen.tsx`,
`apps/mobile/src/apps/tally/TallySurfaceScreen.tsx`; and the five suites
`apps/mobile/src/apps/tally/tally-band.test.ts`,
`apps/mobile/src/apps/tally/tally-view-model.test.ts`,
`apps/mobile/src/apps/tally/tally-store.test.ts`,
`apps/mobile/src/apps/tally/BalancesView.test.tsx` and
`apps/mobile/src/apps/tally/WaitingView.test.tsx`.

*Registration.* `apps/mobile/src/navigation.ts` gains `TallyStackParamList`
(longhand union, no mapped types), `TallyScreenProps<T>` and
`TallyShellNavigation`, and `Tally` becomes a `NavigatorScreenParams` stack;
`apps/mobile/navigators.tsx` gains `TallyNavigator` over twelve routes;
`apps/mobile/lazy-screens.tsx` lazily loads eleven new screens;
`apps/mobile/App.tsx` mounts the navigator in place of the empty cover;
`apps/mobile/src/deep-links.ts` maps `apps/tally`, `apps/tally/group/:groupId`,
`apps/tally/friend/:partyId` and `apps/tally/expense/:expenseId`;
`apps/mobile/src/screens/Home.tsx` and `apps/mobile/src/lib/notifications.tsx`
address the cover by screen now that it is a stack;
`apps/mobile/src/kit/band/band-owner.ts` adds Tally to `BAND_CLAIMING_APPS` and
`apps/mobile/src/kit/band/band-owner.test.ts` pins the roster.

*The origin seat's own half of Receipt.* `apps/mobile/src/screens/scan-tally.ts`
is new — the reviewed capture's payload as a table, the way `scan-locker.ts` is
— and `apps/mobile/src/screens/Scan.tsx` calls it instead of folding the
allocations inline.

*The missing offline shape.*
`apps/mobile/src/lib/replica/multi-vault-reader.test.ts` gains the
`tally.expense_payer` entity on the journey's Tally shape, so the optimistic
payer rows the pending projection emits have somewhere to land and a queued
expense no longer reads as unpaid after a restart.

*Hoisted, shared.* `packages/blueprints/apps/tally/entry-facts.ts` is a new
pure module holding `entryFacts`, `feedFacts` and `entryMeta` — the expense
row's one sentence — because `components/EntryRow.tsx` is a web component and a
native seat cannot reach the narrowings beside it.

*Ledgers and docs.* `tests/agent-e2e-mobile/flows/tally-derived.mjs` and
`tests/agent-e2e-mobile/flows/tally-derived.md` are the origin-seat journey;
`tests/agent-e2e-mobile/run-home-apps-suite.mjs` and
`tests/agent-e2e-mobile/flows/home-apps-budget.md` take it as the seventh
member and carry the twelfth minute's arithmetic; `tests/matrix.json` gains six
owned Tally scenarios, hands the origin seat its journey and raises the suite
budget; `docs/apps/tally-scenarios.md` mirrors them and records the seat and
read-plane facts; `docs/mobile-offline.md` states how Tally splits the plane —
ordinary queued writes, gateway-derived reads, one withheld verb;
`packages/blueprints/src/handler-reachability.test.ts` empties
`AWAITING_HANDOFF.mobile` and rewrites `NATIVE_FALLBACK.tally`.

## Out of scope

Autofill native extensions. The backend doors this interface is drawn against
but cannot yet call: the access-history query, the connector-alias read-back,
the items-window total count (which is why the window's foot says what it is
showing rather than the design's `300 of 312`), and the import client bridge.
Desktop and web Locker, every other app, and the frame's band geometry.

## Decisions

**Tally slice.**

- **Reads are the gateway's, writes are the replica's.** `queries/dashboard.ts`
  holds the app's one balance engine, so folding balances out of replica rows on
  the phone would be a second derivation of "who owes whom". Reads therefore go
  through `appQuery`; writes go through `session.write`, project optimistically
  and queue. That is what "record-only and fully offline-capable" means on this
  seat, and the offline notice names the one exception.
- **`materialize-recurring-expense` is withheld offline, not offered and
  refused.** Its occurrence id is minted by the canonical recurrence engine and
  the pending projection excludes it by construction, so Due next swaps the verb
  for Skip — which does project — and states §6's due-occurrence line.
- **Waiting draws no Approve and no Decline.** The gateway has a per-intent
  decide door (`commonsIntentDecidePath`), but no mobile transport reaches it
  and nothing on this device reads another member's commons intents;
  `TALLY_CONTRIB_DOORS.decide` is `false`, the surface says whose writes it is
  showing, and a steward-only act hands over to the shell's Approvals inbox.
- **The window's foot has an honest variant.** §6's `60 of 194` needs a
  denominator the activity, group and friend payloads do not carry, so
  `tallyWindowFoot` renders the §6 sentence where a real total exists and
  `windowFootNoTotal` where none does. The exact wording returns with no edit
  the day a query serves a total.
- **`NATIVE_FALLBACK.tally` grew while `AWAITING_HANDOFF.mobile` emptied.**
  Every Tally write is dispatched from `tally-writes.ts`, but the action names
  are literals in the SHARED `apps/tally/writes.ts` builders — where the
  one-computation rule wants them — so the reachability scan cannot see them.
  Every QUERY left the list (the phone's gateway door names all seven), and
  `add-receipt-expense` left it too (the capture flow names it in
  `lib/upload/media-producer.ts`).
- **`entry-facts.ts` was hoisted rather than duplicated, and web has not
  converged on it yet.** U1 owns `components/EntryRow.tsx`; the new module is
  additive and the web component should be pointed at it in a follow-up.
- **The Home tile still says "spent this month", not a net balance.**
  SURFACES.md wants a net there, but `useSpringboardTiles` fills tiles from
  replica rows OFFLINE and never asks a query — deriving a net there would be
  the second balance engine this app forbids. Recorded rather than guessed at.

- **The four band places share one route.** `LockerHome` takes a `destination`
  param the way `TasksHome` does; Item, Add/edit, Trash, Access history and the
  three elsewhere-surfaces are pushed. A band tap therefore swaps what is drawn
  instead of growing the stack, and the design's back-row table — every route
  above the root returns to the list — falls out of it.
- **The gates are not routes.** `LockerScreen.tsx` asks
  `suppressesNavigation` once and renders the wall in place of its children, so
  ten surfaces cannot each forget to check. There is no "locked Items".
- **The device-credential enrolment offer sits on the list, not the lock
  wall.** Enrolling needs an open session, and the lock wall is the screen that
  asks for one. Revoking and unlocking-with-it stay on the wall beside the
  facts table, as the surface inventory places them.
- **Import, Export and Companion lead to a screen rather than nowhere.**
  SURFACES.md puts their doors on other seats. A greyed row teaches that Import
  is broken; a screen that states the surface and where the act happens teaches
  that it is elsewhere. The where-sentence is this seat's own copy, per the
  seat-doctrine rule that words follow facts.
- **The window's foot keeps the honest variant.** `windowEndCopy` already says
  what it is showing and that older items exist beyond it, because the items
  payload carries `truncated` and `window` and no total. Restoring the design's
  `300 of 312` is a backend change, not a UI one.
- **Access history is drawn against the ask.** The receipts are written and no
  query serves them; the screen says so in the shared table's own line rather
  than rendering an empty list that would read as "nothing has happened".
- **`Scan.tsx`'s Locker branch moved to `scan-locker.ts`.** The online-only
  flag pushed the screen one line over the 625-line limit; extracting the
  destination's payload (the pattern `scan-consent.ts` and `scan-ui.tsx`
  already set on this screen) gave the rule a testable home instead of a
  waiver.
- **The copy allowlist shrank by one.** The entry excused a string in
  `LockerUnlockScreen.tsx`, a file this change deletes — the ledger shrinking
  with its subject, not a rule being relaxed. `copyRatchet.maxEntries` falls
  31 → 30 with it; no other entry changes.

## Verification

```sh
bun run --cwd apps/mobile typecheck
bun run --cwd apps/mobile test
bun run --cwd apps/mobile lint
bun run lint:mobile-design
bun run lint:hairline && bun run lint:logical-insets && bun run lint:type-floor
node scripts/lint-e2e-flows.mjs
bun run test:matrix
cd packages/blueprints && bunx vitest run apps/locker/ src/locker-online-only.test.ts src/handler-reachability.test.ts src/one-computation.test.ts src/untrusted-rendering.test.ts
```

Tally slice, same gates:

```sh
bun run --cwd apps/mobile typecheck && bun run --cwd apps/mobile lint
bunx vitest run --root apps/mobile src/apps/tally src/lib/replica/multi-vault-reader.test.ts
bun run lint:mobile-design && bun run lint:hairline
bun run lint:logical-insets && bun run lint:type-floor
node scripts/lint-e2e-flows.mjs && bun run test:matrix
bunx vitest run --root packages/blueprints src/handler-reachability.test.ts
```

Checklist crosswalk, item by item. *Delete the pre-v17 Expo Locker UI and
rebuild it against the v17 design* — the five deleted files and the twenty-one
new ones are listed above, and `LockerHome.tsx` is a different file end to end.
*Draw every custodian/origin Locker route the surface inventory lists* — first
run, lock, items, item, add/edit, generator, review, search, access history and
trash are drawn as routes; import, export and companion are drawn as surfaces
naming the seat that performs them, which is what the inventory's seat column
asks for. *Close the online-only write hole on the native replica session* —
`NativeWriteInput.onlineOnly` plus `postAction` in `native-session.ts`, the
scanner's card write routed through it, and `locker-online-only.test.ts`
proving the write leaves no intent and fails rather than queueing.

`apps/mobile` typecheck is clean and every Locker suite passes (11 files, 69
tests over `src/apps/locker`, `src/lib/replica/locker-online-only.test.ts` and
`src/kit/band`); the blueprint run is 17 files / 402 tests green. The full
`apps/mobile` suite is 1728/1729 with the single failure
(`multi-vault-reader.test.ts`, `No offline shape for tally/tally.expense_payer`)
belonging to the concurrent Tally slice's `pending-projection.ts`, not to this
one. Deleted UI is proved gone by the deletions above; the rebuilt boundary,
the band tables, the designed states, the gates, the reveal countdown, the
permit gate, the review registers, the online-only write door and the otpauth
grammar are proved by the nine matrix rows this change registers.

Tally checklist crosswalk. *Build the Expo Tally cover against the v17 design,
and end its handoff suspension* — the thirty new files under
`apps/mobile/src/apps/tally/` draw every origin-seat route of the surface
inventory's Tally table, and `AWAITING_HANDOFF.mobile` is now empty with
`handler-reachability.test.ts` green over the whole manifest. *Own the Receipt
surface on the origin seat, where capture lives* — `TallyReceiptScreen.tsx`
carries the capture verb no other seat has, allocates through the shared
`receipt-model.ts` and commits `reallocate-receipt`, and `scan-tally.ts` builds
the origin capture's `add-receipt-expense` payload. *Give the phone's offline
expense its missing `tally.expense_payer` shape* — the entity is on the journey
shape in `multi-vault-reader.test.ts`, which now passes.

`apps/mobile` is 215 files / 1790 tests green (was 1741 with one red before this
slice); the five new Tally suites are 48 tests over the band tables, the seat
model, the read plane, Balances and Waiting. Every design gate is green
(`lint:mobile-design`, `lint:hairline`, `lint:logical-insets`,
`lint:type-floor`), as are `lint:e2e-flows`, `test:matrix` and the reachability
gate. NOT fixed here and reported instead:
`packages/blueprints/apps/_shared/pending-overlay.test.ts` expects an expense
projection without payer rows and is red against the concurrent backend slice's
`pending-projection.ts` — the same defect family as the shape above, on the
other side of the boundary.

## Audit

REFUTED — pending, and defaulted to REFUTED because it is uncertain, which is
what the directive asks for. No fresh-context sub-agent has yet been handed the
diff, this receipt and `gh issue view 873`. This receipt covers one slice of an
umbrella issue and the root agent owns both the integration and the audit; the
verdict flips to PASS only when that adversarial read has actually run. Nobody
should read the current value as a finding against the work — it is the absence
of a finding either way.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-26 | claude-code | 349e9d30-a980-52b7-98ca-bde72fc76090 |
