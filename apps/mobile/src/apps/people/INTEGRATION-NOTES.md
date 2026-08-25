# People mobile (#821, Binding Layer v12 Part 1) — integration notes

For the root agent. What this slice dispatches, what it deliberately withholds and why, what it had to leave out, and the kit gaps it could not fix from inside `apps/mobile/src/apps/people/`.

## Actions dispatched (for the wall flip)

All via `session.write("people", { action, input })` in `people-writes.ts`:

`star-person` · `unstar-person` · `trash-person` · `restore-person` · `add-person` · `edit-person` · `set-cadence` · `log-interaction` · `add-note` · `add-important-date` · `toggle-reminder` · `save-contact-channel` · `delete-contact-channel` · `merge-people`

Not dispatched (handoff exclusions or withheld writes): `undo-person`, `undo-contact-channel` (undo here re-runs the forward pair, the web doctrine), `move-person`, `add-task`, `toggle-task`, `add-relationship`, `add-gift`, `toggle-gift`, `add-debt`, `settle-debt`, `create-list`, `rename-list`, `delete-list`, `add-journal-entry`.

## Replica entities read (no named queries on this surface)

The phone reads the local replica entity-by-entity (`usePeople.ts`) and re-states the web query emitters' joins in `people-model.ts` (each projection names the `queries/*.ts` file it mirrors):

`people.profile` · `core.party` · `core.tag` (target_type core.party) · `core.concept` · `core.concept_scheme` · `people.important_date` · `knowledge.annotation` (core.party and core.activity targets) · `core.link` (core.activity → core.party) · `core.activity` · `social.contact_channel` · `share.party_vault_binding` · `social.circle_member` · `share.circle_grant` · `share.commons_member_state` · `share.commons_invitation`

Every `share.*` (and `social.circle_member`) read is kept OUT of the combined query state: an error or in-flight read degrades the link facts to ABSENT (null → `links_available: false`), never to a false "not linked" — mirrors `queries/_shared.ts` and decisions.md #821 L-read.

## Withheld controls (register these as divergences)

Same set and same causes as the web build (docs/design-divergences.md § People). `Share` and `Revoke` are NO LONGER among them: the grant plane (#825) gave People the write side, and `PersonGrants.tsx` draws the person screen's grant dashboard on this seat — every live grant reaching the party from `GET …/grants?partyId=`, `Revoke` per row behind the shared kit's confirm, `Share` on the section head opening the kit's own sheet. All READ state is still drawn: link rings, vault tags, `Vaults`, pending invites, `linked/to_link` tiles, `Linked/Unlinked` chips, cadence/Never.

| Withheld | Handoff site | Cause |
| --- | --- | --- |
| A subject picker of People's own — anything this person cannot already reach | the sheet's `What` step | People owns no container and the grant plane has no catalog read (subject ids are app-polymorphic), so the sheet is offered exactly the subjects a standing grant already names. With nothing to name, `Share` is absent and the section says a share starts in the app that holds the thing. |
| `Link vault` commit; the trailing `Link` verb on roster rows; the vault composer (§6, §8) | person screen, roster, editor | RETIRED, not withheld: a grant to an unlinked person parks at `awaiting_channel` and mints the invitation itself, so no link ceremony remains for a control to open. `vault labels` (`personal/work/household/shared`) also exist nowhere in the contract. |
| The vault-link screen's two ceremony sentences (§7) | `VaultLink.tsx` | They narrate the retired ceremony ("One approval each, once — then sharing to them is two taps."); drawn now they would promise an act no control performs. |
| Ambient per-screen status sentences (`STATUS.*`) | every screen | The mobile frame's `StatusLine` is quiet until a note is posted — there is no ambient-sentence slot (see kit gaps). Write outcomes + Undo all go through `postStatus`. The search result count renders as the search screen's own closing line instead. |

`PersonLink` (`VaultLink.tsx`) is reachable only by deep link: the two doors the handoff gives it (roster `Link`, person `Link vault`) named the retired ceremony. It renders the link standing read-only, and it is the one surface still drawing the commons-era `shared_with_them` projection — repointing or retiring it belongs with the copy-as-share sweep.

## Departures inside the drawn set (web parity, not new)

- Overdue is `daysSinceContact > cadence` (strictly after the cadence day; cadence 0 = `Never`, excluded outright). Both through the shared `format.ts`, tested in `people-model.test.ts`.
- Overdue meta is NOT gated on `linked` (web departure, kept).
- `Vaults` tile counts linked people; `Starred` yields its tile to `To link` while the link counts are readable (`LINK_TOUCH_TILES`).
- Search draws no link facts and no link chips (the web search query returns none; same person must not read two ways on two screens).
- The roster filter chips are the copy table's five (incl. `Overdue`), and the Touch `Reconnect` tile lands on that chip.
- Undo appears only on true reverse writes: star↔unstar, trash→restore, edit-person back (+cadence back), set-cadence back. Everything else reports and stops (`people-writes.ts`).

## Mobile-only departures (mine — review)

- **Search is a client-side substring over the replica window** (name + role + party notes), not vault FTS5: the native replica session exposes `search` only for entities whose full indexed text is in a shape, and no People search shape exists. Matches the handoff's own stated scope ("case-insensitive substring"); the matched note rides as the snippet. If a People FTS shape lands later, swap `searchRoster` for `session.search`.
- **`Not linked` tag and `Linked vaults` section title** are literals here — both are handoff copy the web build has no surface for yet, and `people-copy.ts` does not carry them. Consider adding to the copy table.
- **Trash rows read `purge_at` off `people.profile`** (deleted rows in the same entity read), rather than a separate trash query.
- **The `dashboard`'s Recent joins are bounded to the roster window** — activities linked to people outside the (unbounded local) profile read are dropped, same as the web's window join.
- **Avatar hue storage**: the editor stores the web's own scheme-relative spelling (see `storedHueValue` in `people-model.ts`) so the two surfaces round-trip one value; the phone resolves it through `colors.c<Key>`. The helper builds/parses the expression without consuming CSS custom properties (the design gate's concern) — it is vault data interchange.

## Kit / frame gaps (root or a kit change owns these)

1. `kit/band/band-owner.ts` `BAND_CLAIMING_APPS` is a hand-maintained roster and still lists only Photos — add `{ id: "people", name: "People" }` so the frame Settings hand-back row exists for People. The latch itself already works (`useBandOwner("people")`).
2. The band capsule width (52) is stated per app (`photos-band.ts`, `people-band.ts` `PEOPLE_BAND_CAPSULE_SIZE`) because apps may not import each other — it belongs in `kit/band-surface.ts` beside the other shared plate numbers.
3. No ambient status-line slot on mobile (see withholdings above) — if the frame ever grows one, People's sentences are ready in `STATUS`.
4. `handler-reachability.test.ts` `AWAITING_HANDOFF.mobile` still lists "people" — EXPECTED to fail now that action names appear in this dir; the wall flip is the root agent's, per instructions. This dir's old wall stub content in `PeopleHome.tsx` is gone.

## Layout / structure

- `PeopleScreen.tsx` (shell: frame + claimed band, pop-not-push, Home capsule) · `PeopleBand.tsx` + `people-band.ts` (3 destinations, no More sheet — sanctioned deviation 2) · `PeopleHome.tsx` (roster/touch/search on one screen via the `destination` param) · `PersonView.tsx` · `LogTouch.tsx` · `PersonEditor.tsx` · `VaultLink.tsx` · `PersonGrants.tsx` (the grant dashboard) · `MergeView.tsx` · `PeopleTrash.tsx` · `PeopleKit.tsx` (one row, one section, ring, star, confirm-free primitives) · `PeopleConfirm.tsx` (the modal confirms: Trash, Merge, and the kit-worded Revoke) · `people-model.ts` (pure projections) · `usePeople.ts` (replica reads) · `people-writes.ts`.
- Tests: `people-model.test.ts` (projection/overdue/tri-state/search/hue), `PeopleKit.test.tsx` (ring solid/dashed/absent, net meta, a11y labels) — both green under `apps/mobile` vitest.

## Gate results (at hand-off)

- `apps/mobile bun run typecheck`: zero errors in this dir (pre-existing errors exist in `src/apps/docs/*` from the sibling slice, not touched).
- `apps/mobile bun run lint` (import boundaries): green.
- `lint:mobile-design`, `lint:hairline`, `lint:logical-insets`, `lint:type-floor`, `check:mobile-native-state`: green.
- `vitest run src/apps/people`: 18/18 green.
