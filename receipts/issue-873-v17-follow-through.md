<!-- One receipt for issue #873; each slice appends its own section. -->

## Checklist

- [x] Delete the pre-v17 Expo Locker UI and rebuild it against the v17 design
- [x] Draw every custodian/origin Locker route the surface inventory lists
- [x] Close the online-only write hole on the native replica session
- [x] Build the Expo Tally cover against the v17 design, and end its handoff suspension
- [x] Own the Receipt surface on the origin seat, where capture lives
- [x] Give the phone's offline expense its missing `tally.expense_payer` shape
- [ ] Autofill native extensions (a later slice)
- [x] Backend doors — access-history query, alias read-back, items-window total, import bridge

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


**Slice: the Tally vault backend.**

The v17 surfaces were drawn against eight commands that did not exist. They
exist now, and the app's founding rule survives all of them: no balance is
stored and none is transmitted.

*The schema.* `packages/vault/src/schema/domains-tally.ts` adds
`tally_expense_payer` (who actually put money down, written for EVERY expense —
the single-payer case as one degenerate row, so both balance folds read one
shape) and `tally_nudge` (a reminder that was PREPARED, never one that was
sent), plus `tally_expense.split_method` / `split_params_json`,
`tally_group.simplify_opt_in` / `archived_at`, a nullable
`tally_expense.group_id` for the group-less 1:1 case, and a
`tally_expense_line_item` that now hangs off the expense with a nullable
`receipt_id` — lines used to hang off the receipt, which made a photograph the
price of itemising. `packages/vault/src/schema/tables.ts` registers both new
tables so they enter the canonical walk, the replica change log and the
portable export; `packages/vault/src/schema/migrate.ts` carries the rung;
`packages/vault/src/schema/atlas.ts` gives each new kind its member-facing name
and blurb, because a table that reaches Atlas unnamed reads as a leak.
`packages/vault/src/gateway/portable-export.ts` was re-audited rather than
assumed, and `tests/schema-export-fingerprint.json` records the re-pin with the
audit written out — the same entry covers the Locker tables below.

*The commands.* `packages/vault/src/commands/tally.ts` keeps the expense write
path; `packages/vault/src/commands/tally-splits.ts` is new and is the reason
that path stayed readable — the server-side re-validation four commands share,
so `add_expense`, `add_receipt_expense`, `edit_expense` and
`reallocate_receipt` cannot disagree about whether splits sum to the amount,
lines sum to the amount, each line's allocations sum to that line, every
participant is in scope, and the payers add up to what was paid. It does NOT
resolve a split: the client resolves shares from its chosen division and sends
them resolved, and `split_method` / `split_params_json` ride along as
provenance so an edit re-opens the way the expense was entered instead of
collapsing every division to exact amounts.
`packages/vault/src/commands/tally-ledger.ts` is the second half of the write
surface — `reallocate_receipt`, `leave_group`, `archive_group`,
`set_group_simplification` and `nudge` — split out under a named file-size
waiver and registered as one unit with `tally.ts`.
`packages/vault/src/commands/tally-ledger.test.ts` is what the vault REFUSES
about the way an expense is ENTERED: an unbalanced split, an out-of-scope
participant, a payer set that does not add up, a re-allocation that leaves the
stated arithmetic unreconciled.
`packages/vault/src/commands/tally-ledger-groups.test.ts` carries the same
proof for the commands that act on the container rather than on one expense —
leaving keeps every ledger row and only drops the membership, archiving is not
settlement, simplification is off until it is opted into, and a nudge records
an intention while stating that nothing was sent.
`packages/vault/src/commands/tally-ledger-test-kit.ts` is the one fixture both
ride: the vault, the owner credential, and the refusal reader that accepts
either half of the contract — `denied` when a precondition caught it before the
handler ran, `failed` when the handler's own arithmetic guard threw and rolled
the invocation back — which a second copy would quietly narrow to one.

*The rail.* `packages/vault/src/share/commons-routing.ts` declares the five new
group/expense commands rather than letting them bypass the #750 conformance
scan — `archive_group` and `set_group_simplification` because both are the
steward's call about the container itself, `leave_group` because it is
`remove_group_member` without the on-ledger guard and an undeclared one would
hand every member an eject verb, `nudge` because it is the owner's own
intention about a person, and `reallocate_receipt` because it rewrites every
member's share of an expense already agreed. `packages/vault/src/share/commons.ts`
and `packages/vault/src/grant/fulfillment-edit.ts` both learned that
`tally_expense.group_id` can be null: a group-less 1:1 expense resolves to NO
container, which makes it a private local write rather than an unrouted shared
one.

*The folds.* `packages/blueprints/src/tally-balance.ts` reads the payer rows, so
a participant's share is owed to each payer for the part they actually put
down, matched off largest-first — pro-rating rounds per share and the rounded
portions then stop adding back to what each payer paid.
`packages/blueprints/src/tally-simplify.ts` is new: the minimal-transfer engine
as a pure function beside that one fold, deriving the proposal at read time and
writing nothing, because a simplification that stored debts would be the app's
first stored balance. `packages/blueprints/src/tally-balance.test.ts` pins the
invariants the whole app rests on — a group's nets sum to zero and the pairwise
view agrees with the per-member view, multi-payer expenses throughout — and
`packages/blueprints/src/tally-simplify.test.ts` pins both halves of a
proposal: that it clears every position, and that its before/after counts (the
whole consent argument) are true.


**Slice: the Locker vault backend.**

Same shape, opposite pressure: every table here can hold a secret, so the
slice is mostly about where a value is allowed to be.

*The schema.* `packages/vault/src/schema/domains-locker.ts` adds five sidecar
tables — `locker_item_field` (owner-defined and template-minted custom fields,
with `value_text` and `value_sealed` kept apart by a CHECK because sealing is
per COLUMN while a field's kind is per ROW), `locker_item_address`,
`locker_item_passkey`, `locker_item_history` — and registers
`locker_item_alias`, which existed in DDL, was resolvable at reveal time, and
was outside the canonical walk, so it never exported and no read could serve it
back. It also adds `locker_item.password_set_at` (stamped only when the value
actually changes, so a retag never makes an old password look fresh),
`locker_item.archived_at` under a CHECK that makes live / archived / trashed
exclusive, and widens the type CHECK from six to fifteen.
`packages/vault/src/schema/tables.ts`, `migrate.ts` and `atlas.ts` carry the
registration, the rung and the five new Atlas kinds.
`packages/vault/src/schema/sealed.ts` declares the three sealed sidecar columns
(`item_field.value_sealed`, `item_history.password`,
`item_passkey.private_key`) and keeps the list tight on purpose: labels,
sections, addresses, match policies and passkey metadata are the browsable half
Locker's whole premise rests on.

*The commands.* `packages/vault/src/commands/locker.ts` keeps the item write
path and hands the shared vocabulary to
`packages/vault/src/commands/locker-shared.ts`.
`packages/vault/src/commands/locker-types.ts` is the nine expansion types as
TEMPLATES rather than columns — the rule for the next type is "add a template".
`packages/vault/src/commands/locker-sidecars.ts` holds the row helpers with the
seal-boundary reasoning for each table in one place.
`packages/vault/src/commands/locker-extras.ts` is the second command pack:
archive, unarchive, duplicate, custom fields and sections, extra addresses, the
passkey slot, and the counts the type rail and the window-end line read. A
custom field is written ONE AT A TIME because `sealedInput` redacts only
TOP-LEVEL command inputs and a list would have carried secrets into the
append-only journal in the clear; addresses go as a whole list because none of
them is a secret. `packages/vault/src/commands/locker-export.ts` is the
plaintext export — a COMMAND and not a query, because a query handler is
read-only by directive and so cannot write the receipt a mass reveal owes, and
because a replica read returns sealed columns as placeholders and so could not
see the plaintext anyway. `packages/vault/src/commands/attachments.ts` gains
`locker.item` as one allow-list entry on the existing content spine, with the
honest boundary written at the line: the bytes are NOT sealed, because the
sealed class is a column class and there is no sealed blob today.

*The evidence.* `packages/vault/src/commands/locker-test-kit.ts` is the shared
fixture, and it is a module rather than a copy for one reason — both suites
decrypt each cell with the AAD that cell must have been sealed under, which is
what proves a duplicate or a history append RESEALED rather than moved a
ciphertext to a cell it no longer belongs to. A drifting second copy of that
helper would quietly stop proving it.
`packages/vault/src/commands/locker-extras.test.ts` covers the alias read-back,
archive, fields and sections, the fifteen types and the addresses;
`packages/vault/src/commands/locker-export.test.ts` covers duplicate, history,
counts, export and what purge takes with it.

*Shared with Tally.* `packages/vault/src/share/commons-routing.ts` also
declares the eight new Locker acts, because every command carrying `item_id`
must be on that list for the #750 conformance scan and a Locker item is
single-vault — the rail refuses them by NAME rather than letting a write land
privately. `packages/vault/src/index.ts` exports the new decide entry point (below).


**Slice: the gateway's sidecar reveal, and the grants that name it.**

A sealed sidecar is a secret that hangs off an item, so the reveal gate had to
stop being keyed on `locker.item` alone without becoming a second permit
economy. `packages/vault/src/gateway/gateway.ts` widens the Locker gate to the
whole `locker` SCHEMA and adds `lockerOwningItemId`: a sidecar reveal resolves
the row's OWNING item from the requested row itself — never from the caller —
and spends that item's permit, so a field, revision or passkey reveal costs
exactly what revealing the item costs and writes the same receipt with the
owning item in its detail. An unresolvable owner (row gone, or its item
trashed) is gated on the requested id, which no permit names, so "row missing"
and "no permit" refuse identically and the sidecars add no existence oracle.
`packages/vault/src/gateway/locker-sidecar-reveal.test.ts` pins every clause of
that, including the trashed-item case.

`packages/blueprints/apps/locker/app.json` carries the grant that makes it
usable: `reveal` on all three sidecar entities, the five sidecar reads, two
content-spine reads for attachments, the ten new acts, attach/detach, and — the
one that mattered most — a `consent.receipt` read whose **rowFilter pins
`object_type` to Locker's own objects**. That filter is the boundary and not a
convenience, because the gateway's structural per-entity guard covers
`consent.provenance` only.
`packages/blueprints/apps/tally/app.json` declares the five new Tally acts and
the export read. `packages/blueprints/manifest.json` and
`packages/blueprints/index.json` regenerate with them, both apps moving
`0.2.0` → `0.3.0`.
`packages/server/src/serve/manifest-scope-denial.sweep.test.ts` re-pins the
bundled scope census 248 → 278 with the twenty named at the number, and adds
`apps/locker` to the list of manifests whose declared rowFilter must reach the
allow decision intact — with the note saying why that one carries more weight
than the other two.


**Slice: the client and server doors — the steward's decide, and the import bridge.**

Two doors the drawn surfaces called and nothing answered.

*Decide.* `packages/vault/src/share/commons-decide.ts` is the steward's answer
to ONE durable member request, beside the member's own `cancelCommonsIntent`.
Approving is not a second write path: it re-enters `executeCommonsCommand`
exactly as the peer sweep does, so the signature, the stale-context judgement,
the ordered op and the fan-out are the same machinery a live member command
goes through — there is no "approved, therefore skip authorization" door.
Declining settles `denied` with the steward's words and appends NO operation,
because a refusal never reached the rail and advancing the grant's sequence for
it would log a command nothing executed.
`packages/vault/src/share/commons-decide.test.ts` drives it over the real
three-vault fixture, so an approval's effect is a genuine `tally_expense` row
on the steward's seat. `packages/vault/src/index.ts` exports it;
`packages/core/src/protocol/routes.ts` and `packages/core/src/protocol/index.ts` name
`gatewayCommonsIntents` plus `commonsIntentCancelPath` /
`commonsIntentDecidePath` so no caller spells the path;
`packages/core/src/protocol/routes.test.ts` pins both.
`packages/server/src/routes/commons-routes.ts` serves the decide route and
`packages/server/src/routes/commons-routes-decide.test.ts` drives it over two
co-hosted vaults and a real shared group. `docs/protocol.md` states the whole
two-answers rule as current state: the member withdraws with `cancel`, the
steward answers with `decide`, a member deciding their own request is refused
by name, a late answer reports `decided: false` with the status that stands,
and the steward's settle is deliberately unconditional over a member's
`cancelled` — the person who owns the commons gets the last word on what was in
their queue.

*Import.* `packages/client/src/react/blueprints/centraid-inline.ts` grows six
optional doors — `decideCommonsIntent`, and the staged-import five
(`stageImport`, `importBatches`, `importRows`, `publishImport`,
`discardImport`). They are optional by contract, so an older host parses this
client shape unchanged and a surface feature-detects; the import transport is
lazy so it never joins the eager shell graph, and it is online-only by
construction — never a replica session, never the pending-write outbox,
because the payload is the file itself and a durable offline queue is exactly
where it must not sit. It takes no `scope` argument because the import plane
answers for whichever vault the gateway has mounted, which is a different axis
from an app's mounted scopes; the missing argument says so instead of accepting
one and ignoring it.
`packages/client/src/react/blueprints/centraid-inline-doors.test.ts` asserts
the transport contract of each — path, body, and that an import body never once
reaches the replica session.
`packages/blueprints/types/centraid.d.ts` restates both contracts on the
ambient client shape (structurally, not by import: the first `import` would
turn the ambient script into a module and every global in it would stop being
global — recorded at the top as a named file-size waiver rather than a silent one).

*The revocation time.* `packages/server/src/serve/vault-plane.ts` attaches
`revokedAt` to a consent refusal that is a revocation, and
`packages/server/src/engine/handlers/vault-bridge.ts` and
`packages/server/src/engine/worker/runner.ts` carry it across the worker
boundary. An app whose grant was revoked cannot read the consent tables to find
out when — losing the grant is exactly what put it there — so the host tells
it, and no caller may invent one.


**Slice: Tally on the web.**

The five new acts get their handlers — `packages/blueprints/apps/tally/actions/reallocate-receipt.ts`, `packages/blueprints/apps/tally/actions/leave-group.ts`, `packages/blueprints/apps/tally/actions/archive-group.ts`, `packages/blueprints/apps/tally/actions/set-group-simplification.ts` and `packages/blueprints/apps/tally/actions/nudge.ts` — beside the two that grew payer and line payloads, `packages/blueprints/apps/tally/actions/add-expense.ts` and `packages/blueprints/apps/tally/actions/edit-expense.ts`.

*The models.* `packages/blueprints/apps/tally/split-model.ts` closes the six divisions and `packages/blueprints/apps/tally/split-model.test.ts` pins each. `packages/blueprints/apps/tally/line-model.ts` is new: the sixth division, and the payload two commands take — ONE module for two surfaces, because *By line* on Add expense and the allocation editor on Receipt are the same object seen twice, and two seats must never disagree about one receipt. Its tie-break on a LINE is position rather than the payer, because a line has nobody out of pocket; `packages/blueprints/apps/tally/line-model.test.ts` pins that difference from `split-model.ts` deliberately. `packages/blueprints/apps/tally/money-text.ts` was lifted out of `packages/blueprints/apps/tally/draft-model.ts` so the line model can read a typed amount without importing the draft — the draft imports the lines, and a module that only knows how to read a number should never be why two files point at each other; `packages/blueprints/apps/tally/draft-model.test.ts`, `packages/blueprints/apps/tally/receipt-model.ts` and `packages/blueprints/apps/tally/receipt-model.test.ts` follow it. `packages/blueprints/apps/tally/contrib-model.ts`, `packages/blueprints/apps/tally/contrib-model.test.ts` and `packages/blueprints/apps/tally/contrib-reads.ts` carry Waiting's sections and whether this host has a decide door at all; `packages/blueprints/apps/tally/entry-facts.ts` and `packages/blueprints/apps/tally/pending-projection.ts` carry the row sentence and the optimistic payer rows a queued expense now projects.

*The reads.* `packages/blueprints/apps/tally/queries/dashboard.ts`, `packages/blueprints/apps/tally/queries/activity.ts`, `packages/blueprints/apps/tally/queries/group.ts`, `packages/blueprints/apps/tally/queries/friend.ts`, `packages/blueprints/apps/tally/queries/history.ts` and `packages/blueprints/apps/tally/queries/search.ts` fold payers, methods and typed lines into what they already answered with. `packages/blueprints/apps/tally/queries/export.ts` is new — one group's ledger as a structured payload, balances excluded by design. `packages/blueprints/apps/tally/ledger-reads.ts` keeps the room's spine and `packages/blueprints/apps/tally/export-read.ts` is deliberately NOT in it: nothing outside the export route wants a group's whole ledger with its revisions, so it is asked when a group is CHOSEN and not before, and until it lands the surface states no counts rather than zero ones. `packages/blueprints/apps/tally/export-file.ts` turns those rows into bytes ON THE DEVICE — a query that returned a CSV would be a query that had decided how a member wants to read them — and `packages/blueprints/apps/tally/export-file.test.ts` pins the negative that matters: nothing in it folds a figure, and `balances_excluded` travels in the JSON so a reader knows the absence was a decision rather than an omission.

*The export range follow-up.* The Range chip used to be decoration: the surface named a month and the file carried the whole ledger anyway. `export-read.ts`'s `rangeSince`, the `since` argument through `packages/blueprints/apps/tally/queries/export.ts`, and the counts the foot reads now describe the RANGE rather than the group — and `packages/blueprints/apps/tally/queries/export.test.ts` pins what `since` excludes, what it keeps, and that the foot follows it.

*The surfaces.* `packages/blueprints/apps/tally/components/AddExpense.tsx` and the new `packages/blueprints/apps/tally/components/AddExpenseTables.tsx` draw the payer set and the typed lines as two small editors rather than burying the six decisions the surface is about under two grids; neither is a MODE — several payers is the ordinary payer chip set with amounts typed beside it, and clearing an amount takes that person back out. `packages/blueprints/apps/tally/components/Receipt.tsx` commits the re-allocation, `packages/blueprints/apps/tally/components/Settle.tsx` carries the simplification proposal and its opt-in, `packages/blueprints/apps/tally/components/Export.tsx` the export window, and `packages/blueprints/apps/tally/components/Waiting.tsx` the steward's decide door where the host has one. `packages/blueprints/apps/tally/components/Expense.tsx`, `packages/blueprints/apps/tally/components/Ledgers.tsx`, `packages/blueprints/apps/tally/components/Lenses.tsx`, `packages/blueprints/apps/tally/components/Panels.tsx`, `packages/blueprints/apps/tally/components/Overlays.tsx`, `packages/blueprints/apps/tally/components/States.tsx`, `packages/blueprints/apps/tally/components/Screens.tsx`, `packages/blueprints/apps/tally/components/Route.tsx`, `packages/blueprints/apps/tally/components/Fields.tsx` and `packages/blueprints/apps/tally/components/ComposeRoutes.tsx` follow, with `packages/blueprints/apps/tally/components/Compose.module.css` and `packages/blueprints/apps/tally/components/Ledger.module.css` for the two new tables' geometry. `packages/blueprints/apps/tally/compose-acts.ts`, `packages/blueprints/apps/tally/compose-state.ts`, `packages/blueprints/apps/tally/compose-copy.ts`, `packages/blueprints/apps/tally/view-copy.ts`, `packages/blueprints/apps/tally/types.ts`, `packages/blueprints/apps/tally/app-root.tsx`, `packages/blueprints/apps/tally/writes.ts` and `packages/blueprints/apps/tally/writes.test.ts` carry the acts, the state, the words and the write builders; `packages/blueprints/apps/tally/states.test.tsx` covers the designed states the new surfaces added.


**Slice: Locker on the web.**

The three surfaces that used to be drawn AGAINST THE ASK now perform.

*Access history.* `packages/blueprints/apps/locker/queries/access.ts` reads the vault's own `consent.receipt` stream under the row-filtered grant, online-only by construction because journal.db is not in the browser replica and a cached answer would be a list of what one device happened to hold. `packages/blueprints/apps/locker/access-model.ts` is the pure projection, and its one rule is that it NAMES acts and never their contents — a reveal row says which COLUMNS were opened, because a receipt has never carried a value. `packages/blueprints/apps/locker/components/Access.tsx` renders it and keeps the rule that governed the placeholder: an audit surface may never invent a row.

*Import.* `packages/blueprints/apps/locker/import-model.ts` is the one place a staging disposition becomes one of §6's three verdicts, so the words on the review screen and the behaviour in the vault are one thing said once — `held` is not "we could not decide", it is the promise that an import never overwrites a secret the vault already holds. `packages/blueprints/apps/locker/components/Import.tsx` draws draft → review → publish over the five optional doors, and a discarded draft writes nothing at all.

*Export.* `packages/blueprints/apps/locker/actions/export.ts` is the data door; `packages/blueprints/apps/locker/export-file.ts` assembles the bytes on the device, because nothing about a file — a dialect, a column order, a name — belongs inside the vault boundary. `packages/blueprints/apps/locker/components/Export.tsx` puts §6's consequence sentence above every control, and the confirm NAMES the consequence rather than asking whether the member is sure.

*The item.* `packages/blueprints/apps/locker/queries/item.ts`, `packages/blueprints/apps/locker/queries/items.ts` and the new `packages/blueprints/apps/locker/queries/item-sidecars.ts` and `packages/blueprints/apps/locker/queries/type-degradation.ts` answer with the fifteen types, the window total, the alias read-back and the five sidecars — with one rule running through all of it: a sealed cell never rides these payloads, so what comes back is the SHAPE of the secret and not the secret. `packages/blueprints/apps/locker/field-model.ts` groups fields into the sections the screen draws and the editor edits; `packages/blueprints/apps/locker/item-copy.ts` is the third part of the §6 verbatim table, the sections the item screen gained. `packages/blueprints/apps/locker/components/ItemSidecars.tsx` and `packages/blueprints/apps/locker/components/EditSidecars.tsx` draw and edit them, split out of `packages/blueprints/apps/locker/components/Item.tsx` and `packages/blueprints/apps/locker/components/Edit.tsx` under the 500-line rule and for a reason that outlives it — six sections of the same shape keep drawing alike when they are held together. A create has no id for a field to hang off, so the sidecar editors appear only on an item that already exists.

The rest of the room follows: `packages/blueprints/apps/locker/components/List.tsx`, `packages/blueprints/apps/locker/components/Rail.tsx` (six rows with counts, ruled — the other nine types are reached from the add form's chip and the `type:` filters), `packages/blueprints/apps/locker/components/Surfaces.tsx`, `packages/blueprints/apps/locker/components/Screens.tsx`, `packages/blueprints/apps/locker/app-root.tsx`, `packages/blueprints/apps/locker/route-acts.ts`, `packages/blueprints/apps/locker/route-copy.ts`, `packages/blueprints/apps/locker/view-copy.ts`, `packages/blueprints/apps/locker/types.ts`, `packages/blueprints/apps/locker/draft.ts`, `packages/blueprints/apps/locker/bag.ts`, `packages/blueprints/apps/locker/format.ts`, `packages/blueprints/apps/locker/permits.ts`, `packages/blueprints/apps/locker/session.ts`, `packages/blueprints/apps/locker/session.test.ts`, `packages/blueprints/apps/locker/pending-projection.ts`, `packages/blueprints/apps/locker/writes.ts` and `packages/blueprints/apps/locker/writes.test.ts`. `packages/blueprints/apps/locker/surface-acts.ts` is new and holds the three surfaces that talk to something other than a query or an action, so each of their three rules is stated once. `packages/blueprints/apps/locker/review-model.ts` and `packages/blueprints/apps/locker/review-model.test.ts` move password age out of the unrunnable checks, now that `password_set_at` exists to answer it.

*The thin acts.* `packages/blueprints/apps/locker/actions/set-field.ts`, `packages/blueprints/apps/locker/actions/remove-field.ts`, `packages/blueprints/apps/locker/actions/set-addresses.ts`, `packages/blueprints/apps/locker/actions/set-passkey.ts`, `packages/blueprints/apps/locker/actions/clear-passkey.ts`, `packages/blueprints/apps/locker/actions/archive-item.ts`, `packages/blueprints/apps/locker/actions/unarchive-item.ts` and `packages/blueprints/apps/locker/actions/duplicate-item.ts`. Three of them state their online-only reason at the line rather than leaving it to be discovered at commit: `set-field` and `set-passkey` because their payload can carry a secret and a secret never enters the durable offline queue, and `export` because a mass reveal must never be queued or replayed. `set-addresses` takes a whole list where `set-field` takes one field, and says why: no address is a secret.

*Evidence.* `packages/blueprints/apps/locker/item-sections.test.tsx` proves the six new sections draw AND that the boundary did not move. `packages/blueprints/apps/locker/queries.test.ts` covers the four reads, asserting every narrowing claim against the RECORDED read requests, so a handler that forgets a `where` cannot pass by having its mock ignore one. `packages/blueprints/apps/locker/route-states.test.tsx` and `packages/blueprints/apps/locker/states.test.tsx` cover the live surfaces, the archive shelf, the six-row rail ruling and the window total. `packages/blueprints/apps/locker/locker-item-type.test.ts` keeps the page-side union in lockstep with the DDL CHECK.


**Slice: the cross-slice integration fixes.**

None of these showed up inside a slice; every one of them appeared where two met.

*The compose-states split.*
`packages/blueprints/apps/tally/compose-states.test.tsx` was one file over the
size limit once the new routes landed. The fixtures and the mount moved to
`packages/blueprints/apps/tally/compose-states-kit.ts` and the new routes to
`packages/blueprints/apps/tally/compose-states-v17.test.tsx`, so both files
compose their routes the same way — `press` finds a control by the label the
previous screen drew, which is what keeps a route reachable only from a test
from counting as a route.

*The pending-overlay pin.*
`packages/blueprints/apps/_shared/pending-overlay.test.ts` expected an expense
projection with no payer rows and went red the moment Tally's
`pending-projection.ts` started emitting them. The projection is right — a
queued expense that projected no payer read as unpaid after a restart — so the
pin moved to the correct shape and now names the payer row's entity and values
rather than only its id.

*Mobile type-widening.* `apps/mobile/src/navigation.ts` restated the six-type
union longhand on `LockerItem`, which would have refused to route an item of
any of the nine new types; it now takes `LockerItemType` from the shared
blueprint, with the comment saying why the union may never be restated there.
`apps/mobile/src/apps/locker/LockerItemsView.tsx`'s filter chips read
`TYPE_ORDER` instead of a list of six kept beside them.

*EntryRow convergence.* The Tally mobile slice hoisted `entryFacts` /
`feedFacts` / `entryMeta` into `entry-facts.ts` and left the web component
holding its own copy, recorded there as a follow-up.
`packages/blueprints/apps/tally/components/EntryRow.tsx` now imports them and
restates nothing, so the two seats cannot say slightly different things about
the same expense.

*The U4 copy rewrite.* `apps/mobile/src/screens/scan-locker.ts`'s
`SCANNED_CARD_NOTE` was a two-sentence string carried by a copy-allowlist seed.
It is one sentence now — "Captured on device by OCR — the source image was
never stored in Locker." — the seed is deleted from
`tests/quality/copy-allowlist.json` and `copyRatchet.maxEntries` falls 30 → 29
with it. The ledger shrank with its subject; no rule was relaxed.
The one place the handoff's own copy could not be rendered verbatim is recorded
instead of absorbed: `docs/design-divergences.md` gains a §-of-its-own for the
v17 verbatim table, holding Tally's leave-a-group confirm at "Settle first."
where §6 says "Settle first if you can." — the repo's copy rule bans "you can"
as filler outright, and the allowlist is tighten-only with no slot for a phrase
the rule refuses.

*Three mobile leftovers the doors made real.*
`apps/mobile/src/apps/locker/LockerReviewView.test.tsx` asserted that the
unrunnable checks carried bracketed gap tags; the surface owes the REASON in
words, so it now asserts each check's `why`.
`apps/mobile/src/apps/locker/LockerAccessScreen.tsx` imported `ACCESS_NOT_SERVED`
— a sentence saying no query serves the access history, which the web slice
deleted along with the gap it named. The phone still does not read that history
(the query is online-only by construction and pointing this seat at it is its
own slice), so the screen keeps its register and now states the shared
`ACCESS_NO_VALUES` rule beside `ACCESS_WHERE` instead: what a receipt records,
that it never carries a value, and where the same receipts are read. No new
string, and no sentence left claiming a gap that closed.
`packages/blueprints/src/locker-online-only.test.ts` extends the online-only
roster to the new secret-bearing acts (`set_field`, `set_passkey`, `export`).

*Three dead exports the branch introduced, deleted rather than ignored.* `knip`
is a `check:push` gate and it was red on branch files: `exportRowCount` and
`TallySurfaceCopy` in `apps/mobile/src/apps/tally/tally-view-model.ts` are a
draft the screen did not take — `TallySurfaceScreen.tsx` composes its foot from
the shared `compose-copy.exportWindow` — so the block is gone and the module
header's third bullet now describes the section that is actually there;
`LOCKER_COLUMN_TYPES`, `isKnownLockerType`, `degradeType` and the now-unused
`LockerItemType` alias in `packages/vault/src/commands/locker-types.ts` were a
second copy of a rule that belongs on the read side, so they are gone and the
module header points at
`packages/blueprints/apps/locker/queries/type-degradation.ts` where it lives;
and `packages/vault/src/commands/locker.ts`'s compat re-export dropped
`LOCKER_TAGS_SCHEME_URI`, which nothing imported through that door.

*Docs.* `docs/apps/locker-scenarios.md` records the custodian seat's four new
scenarios and states, as current state, that the item model is fifteen types
while the rail stays six rows with counts, which paper cuts closed, and how the
sealed sidecars reveal. `docs/decisions.md` carries the two #873 ruling tables
(Tally T-*, Locker L-*) and the two paragraphs beneath them.


**Slice: the quality gates.**

*The T3 canary, extended — and the leak it caught.*
`packages/test-kit/src/year3-vault.ts` seeds a sealed row on each of the three
new sidecar tables, each sealed under its OWN row id, and declares their
sentinels; `tests/quality/user-facing-qualities.test.ts` runs all three through
every enforcement point the canary owns — the masked SQL read, reveal, raw
storage, the FTS tables, the replica snapshot, the backup and the portable
export. Two assertions were rewritten rather than added to: the masked-read
check now fails if any artifact came back with zero rows, because a masked read
that returned nothing satisfied `every` vacuously; and the reveal check now
requires EVERY declared sentinel to come back out of reveal rather than only
`locker.item.password`, because reveal is the one surface a sentinel is allowed
through and a sealed cell nothing can unseal is a data-loss bug wearing a
passing canary.

That extension immediately found a real leak, and the fix is in
`packages/vault/src/schema/sealed.ts`. The canary's draft-band case stages one
row per `SEALED_COLUMNS` entry through the import staging plane and requires
every staged value to be sealed. The three new sidecar columns were in
`SEALED_COLUMNS` and NOT in `SEALED_PAYLOAD_FIELDS`, so a custom field's sealed
value, a previous password and a passkey's private key would have sat in
`sync_import_row.payload_json` in the CLEAR. `SEALED_PAYLOAD_FIELDS` now lists
all three (both the snake_case and camelCase spellings the band accepts). The
reason it was worth fixing rather than waiving is written at the entry: a
sidecar has no importer today, which is exactly why it is listed — the draft
band is a generic persistence boundary, so an importer that learns to carry
these must find the seal already in front of it rather than leave the secret in
a draft row until a publisher shows up. Caught pre-merge, by a gate this change
extended.

*The Atlas census.* `packages/vault/src/schema/atlas-census.ts` counted one
prepared statement per registered table, which is why the first-paint SQL
budget had been raised once per registration (#731 128 → 138, #807 138 → 140)
and why the grant-plane tables were excluded from the census to avoid two more.
`packages/vault/src/schema/atlas-graph.ts` gains `countRowsBatched`: identical
arithmetic — every registered table is still COUNT(*)-scanned and none is
dropped — issued as one compound SELECT per file, batched at 200 to stay well
under SQLite's compound-select ceiling, with a `sqlite_master` pre-check so an
absent table answers 0 exactly as the per-table catch did, and a per-table
fallback so one uncountable table cannot take its batch down.
`packages/vault/src/schema/atlas-census.test.ts` pins the equivalence and the
absent-table case. `tests/experience-budgets/client-query-counts.json` then
falls 140 → **13** — a tighten, not a widen; the measured figure with the new
Tally and Locker registrations on it was 147, and batching takes it to 13 — and
its `approvedDeviation` is now "None outstanding", retiring the chain (#731
128 → 138, #807 138 → 140) that had raised the knob once per registered table.

*The ratchets.* `tests/quality/classification-ratchet.json` re-pins the
fingerprints for `packages/vault/src/schema/sealed.ts` and `tests/matrix.json`
with the deviation note quoted under Decisions below.
`tests/comment-density-ratchet.json` is regenerated: 171 new files pinned, 15
deleted files pruned, 19 pins lowered, and 53 hand-raised — every one of the 53
on a file this branch changed against `origin/main`, listed by cause in the
file's own `approvedDeviation`. `tests/skips.json` re-pins eight skip sites
whose line numbers drifted; the budget stays 25 and no skip was added or
removed.

Together, the vault, gateway, door and wiring slices above close the
checklist's backend doors — access-history query, alias read-back,
items-window total, import bridge — on both apps, ending the
drawn-against-the-ask era those surfaces shipped under.

**Inherited from the base merge, named here for coverage:**
`scripts/test-report/render-briefing.mjs` arrives with a comment-only
one-liner (a blank line inside a JSDoc block) from the merge that based this
branch. `receipts/issue-861-comment-current-state.md` briefly carried this
note in-branch; that receipt is frozen once on the default branch, so it is
restored byte-for-byte and the note lives here instead.

## Out of scope

**Autofill native extensions.** A Safari/iOS credential-provider extension and
its Android autofill service are Xcode/Gradle targets; there is no Xcode in
this environment, so building them here would produce an artifact nobody could
compile or sign. The blueprint's fill path and the Companion candidate list are
in place and unchanged by their absence — the extension is the host that calls
them, not a rewrite of them. A later slice, on a machine that can build it.

**Ruled out rather than deferred** (see [docs/decisions.md](../docs/decisions.md)):
breach checking (network egress from an app excluded from enrichment, and
`compromised` stays a flag with no automatic producer) and "recently used" (a
shelf that publishes reading habits on the one screen where reading is the
sensitive act); on the Tally side, cross-member comments on an expense, payment
rails, and any currency-rate provider — `T-rate` derives from the vault's own
recorded rates and there is no network call.

**Still elsewhere.** The three phone-side surfaces whose door is on another
seat stay drawn as facts plus the sentence naming where the act happens: the
custodian seat performs Import, Export and Access history now, and pointing the
Expo seat at those doors is its own slice. The phone's item screen reveals the
item's own sealed columns only; the sidecar reveal is drawn on the web.
Every other app, and the frame's band geometry.

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

**Integration slice — which of the decisions above the later slices closed.**
The mobile slices' entries stay as written; three of them recorded a state that
has since moved, and the move is the news rather than an edit:

- *"`entry-facts.ts` was hoisted rather than duplicated, and web has not
  converged on it yet"* — the follow-up it named is done.
  `packages/blueprints/apps/tally/components/EntryRow.tsx` reads the hoisted
  module and restates nothing.
- *"Access history is drawn against the ask"* — the query exists.
  The custodian seat renders the list; the origin seat still does not read it
  (the query is online-only by construction), so its screen dropped the
  now-false "no query serves this" line and states the register's own rule
  instead.
- *"The window's foot keeps the honest variant"* — the items read carries a
  `total` now, so the §6 sentence renders where a real total exists and the
  honest variant remains for where one does not. The variant was not deleted;
  it stopped being the only branch.

The two mobile decisions the integration slice CONFIRMED rather than moved are
now rulings in [docs/decisions.md](../docs/decisions.md): Waiting draws no
Approve and no Decline on the phone, and the Home tile stays "spent this month"
rather than becoming a second balance engine.

**Integration slice — the approved deviations, quoted at the knob.**

`tests/quality/classification-ratchet.json`:

> Two #873 fingerprint moves land together. packages/vault/src/schema/sealed.ts declares Locker's three sealed sidecar columns (locker.item_field.value_sealed, locker.item_history.password, locker.item_passkey.private_key) in SEALED_COLUMNS and — the half a reviewer must see — the matching SEALED_PAYLOAD_FIELDS entries, so a draft-band row cannot carry those values in the clear before a publisher exists; the T3 canary now fails when the two lists disagree. tests/matrix.json re-pins for the fifteen owned Expo Locker and Tally origin-seat scenarios the #873 mobile slices registered, plus the tracking-issue state refresh. The governed payload (qualities, demonstratedRed) is unmoved, no quality lost a gate, no gate lost its evidence, and no classification was weakened.

`tests/comment-density-ratchet.json` carries its own note at the file: 53 pins
hand-raised, each on a file this branch changed against `origin/main`, in three
named causes — modules the #872/#873 rebuild replaced whole, the vault and
server modules that grew the sidecar and split surfaces, and the Expo covers'
seat-boundary prose. No cap widened, and every downward move `--write` found
was taken. One allowlist entry is added — `packages/vault/src/share/commons-decide.ts`,
where the surviving prose is the steward-decision security argument itself
(approval re-enters full authorization with no skip door, a decline appends no
ordered op, the member's own seat signs), which no type or test carries and
which leaves the file at 24.4% once the restating half is gone; every other new
file on this branch is under the 15% cap on its own. The remaining ratchets are pure
tightens and need no deviation: `copyRatchet.maxEntries` 30 → 29 (the seed's
string was rewritten), the Atlas first-paint budget 147 → 13 (counts batched),
and `tests/skips.json` re-pinned at the same 25 sites.

- **`add_receipt_expense`'s allocation write-marker is a composite id.** It
  stamps `ctx.wrote("tally.expense_line_allocation", "<lineId>:<partyId>")`,
  which the demo-purge `pkColumn` walk can never address. Harmless today —
  nothing purges by that marker — and recorded in [QUALITY.md](../QUALITY.md)
  rather than fixed here, because the fix is the same shape the payer work
  already took and wants doing once, deliberately, across both.

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
other side of the boundary. (Fixed in the integration slice below.)

**Integration slice — the whole gate loop, once.** The repo's local mirror of
the CI PR gate, run over the assembled tree:

```sh
bun run check:pr        # = bun install --frozen-lockfile && check:push (48 gates)
                        #   && typecheck && lint:types && lint:workflow-pins
                        #   && check:diff-coverage
```

`check:push` finishes **46 of 48 gates green** in 98.1s. Everything this change
touches passes: `format:check`, `lint`, `typecheck:affected`, `knip`,
`test:qualities`, `test:matrix`, `test:ratchet`, `test:comment-density`,
`lint:quality-knobs`, `lint:schema-export`, `check:reachability`,
`check:mobile-native-state`, every design and copy gate. The full `bun run
typecheck` is green over all 25 packages, `bun run lint:types` is green over all
twelve type-aware projects, and `bun run lint:workflow-pins` reports 21 clean
workflows.

`check:diff-coverage` runs the whole instrumented suite: **1,249 files /
15,200 tests, 4 failures**, all four listed below.

Verbatim tail of the gate run:

```
  ✓ lint:quality-knobs            0.2s  (36/48)
  ✓ lint:schema-export            0.2s  (37/48)
  ✓ check:ui-receipt              0.1s  (38/48)
  ✓ test:quarantine               0.1s  (39/48)
  ✓ test:env-red                  0.5s  (40/48)
  ✓ test:accessibility            0.3s  (41/48)
  ✓ test:report:smoke             1.0s  (42/48)
  ✓ check:mobile-native-state    30.1s  (43/48)
  ✓ lockfile:lint                 0.1s  (44/48)
  ✓ security:lifecycle            0.2s  (45/48)
  ✓ security:unsafe-edges         0.1s  (46/48)
  ✓ lint:ci-egress                0.1s  (47/48)
  ✓ test:qualities               66.1s  (48/48)
✗ test:affected
Failed:    @centraid/model-runtime#test
✗ design:gallery
✗ 46/48 gates passed in 98.1s — slowest: test:qualities 66.1s, check:mobile-native-state 30.1s, typecheck:affected 14.5s, check:reachability 9.6s, test:comment-density 9.3s
Failed: test:affected, design:gallery
```

`test:affected` stops at the first failing package, so the affected suites were
also run with `--continue` to see past it: **25 of 29 packages green**, with
`@centraid/vault`, `@centraid/client`, `@centraid/core`, `@centraid/mobile` and
every other branch-touched package fully passing.

**The reds, each verified pre-existing rather than accepted.**

- `@centraid/model-runtime` `automation-handlers/bundle-drift.test.ts` — all six
  published bundles report "committed bundle is stale". The rebuild differs from
  the committed bundle only in MINIFIED VARIABLE NAMES (`v`→`j`, `f`→`I`,
  `N`→`z`), with no semantic difference anywhere in the diff. Verified against
  `origin/main`: none of the six `.js` bundles changed on this branch, none of
  their handler sources changed, and the one bundled module this branch does
  touch (`packages/model-runtime/src/gazetteer.ts`) has **no non-comment line
  changed** — checked by filtering the diff to non-comment lines, which comes
  back empty. A local minifier version that mangles differently from the one
  that built the committed bundles; not a stale bundle, and nothing to re-emit.
- `design:gallery` — `Executable doesn't exist at
  /opt/pw-browsers/chromium_headless_shell-.../chrome-headless-shell`. The
  Playwright browser is not installed in this container. Environment, not tree.
- `apps/desktop` `src/main/ipc-core.test.ts` — `Error: Electron failed to
  install correctly.` The Electron binary is absent here; the file fails to
  COLLECT and the other 313 desktop tests pass.
- `packages/blueprints` `apps/agenda/states.test.tsx` — "offline is the
  reachability verdict, never navigator.onLine". A source-scan tripwire
  (`expect(SOURCE).not.toContain("navigator.onLine")`) reading
  `apps/agenda/app-root.tsx`, where line 582 is a COMMENT that names the
  forbidden signal in order to explain why it is forbidden. Both files are
  untouched by this change set (`git status` lists neither), so the assertion
  reads identical bytes at `HEAD`; the test arrived with
  [#864](https://github.com/srikanth235/centraid/issues/864) and the comment
  with the #868 sweep. Agenda's, not this issue's.
- `packages/server` `src/serve/gateway-db-lock.integration.test.ts` — "SIGKILL
  releases gateway.db immediately and sqlite3 reads during restart recovery".
  Untouched by this change set; a process/filesystem rig red in this container.
- `packages/server` `src/acp/backends/acp/launch.test.ts` (two cases) —
  `expected 'yes' to be '1'` on `plan.env.IS_SANDBOX`. This container exports
  `IS_SANDBOX=yes`, which the test's environment reaches. Neither
  `launch.test.ts` nor `launch.ts` is changed against `origin/main` at all.

**What was NOT accepted as pre-existing, and was fixed instead.** Four reds
landed in branch-touched code and are repaired above rather than reported:
`@centraid/mobile` typecheck (`LockerAccessScreen.tsx` importing the deleted
`ACCESS_NOT_SERVED`), `knip`'s six dead exports in
`apps/mobile/src/apps/tally/tally-view-model.ts` and
`packages/vault/src/commands/locker-types.ts` / `locker.ts`,
`lint:schema-export`'s stale fingerprint after the `SEALED_PAYLOAD_FIELDS` fix,
and `lint:types`' `require-array-sort-compare` in
`packages/blueprints/src/tally-balance.test.ts`. Two of the listed known-reds
from earlier in this issue are gone rather than tolerated: the `app-boot/*` and
`docs-media` suites pass (188 blueprint files, 187 green), and the demo-seed
purged-vs-registered case passes with the whole of `@centraid/vault`.

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
| 2026-08-27 | claude-code | 349e9d30-a980-52b7-98ca-bde72fc76090 |
