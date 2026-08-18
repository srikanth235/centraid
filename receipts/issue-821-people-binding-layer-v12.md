# issue-821 — People rebuilt to the Binding Layer v12 handoff (desktop/web)

GitHub issue: [#821](https://github.com/srikanth235/centraid/issues/821)

One umbrella, one receipt. #819 held desktop People back for a design handoff;
the v12 handoff arrived and this change restores the surface: a render tree
drawn entirely from `@centraid/design` over the untouched vault contract.
Worked by orchestration per `docs/multi-agent.md` — one root plan, three
implementation waves of sub-agents on disjoint slices, the root integrating
the seams between them.

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

## What changed

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

## Decisions

The judgment calls the diff cannot show.

**The vault-link system is withheld, not approximated.** The handoff's
defining feature has no fact behind it on this contract — no query returns a
link or a share receipt — and H-scope forbids touching the contract. A dashed
ring on every avatar forever would state "not linked" as a fact the app never
read. Same rule Docs applied to its People filter axis. `Log` is the person
screen's primary commit until a links read exists.

**No `Never` cadence chip.** `app.json` types `cadence_days` with
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

**One umbrella, no child issues.** #821 was worked by root-agent
orchestration: recon (4 sub-agents), foundation (1), screens (3, on disjoint
files against frozen prop contracts), gates (1), with the root integrating
the seams — the copy inventory absorbing the workers' flagged gaps, the dead
exports deleted, the docs amended.

## Out of scope

Named so the omissions are not read as oversights.

- **Any manifest, action, query, vault scope, or pending-projection change.**
  The vault contract was out of bounds; `app.json`, `actions/`, `queries/`,
  `pending-projection.ts` and `seed.js` are untouched.
- **Mobile People and mobile Docs** — still held back under the #819 ruling;
  `AWAITING_HANDOFF.mobile` keeps both, and the mobile frame-drop scale-flow
  coverage loss remains accepted until that rebuild.
- **Docs part 2 of the v12 handoff** (the phone build).
- **The vault-link contract** — a future proposal adds the links read and
  restores the ring, Share sheet and Vault link screen with it; the withheld
  set is tabled in `docs/design-divergences.md`.
- **`app.json` `colorKey: "violet"` vs the stylesheet's rose identity** — a
  pre-existing disagreement inside the untouchable manifest; flagged in the
  issue for a later contract pass.
- **Design-gallery baselines** — the BI lane is a token-lowering lane, not a
  component screenshot, and no shell chrome changed; nothing to regenerate
  locally per `docs/design-machinery.md`.

## User impact

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

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-18 | claude-code | b3367893-c4a8-5544-98d1-1515964ece63 |

## Audit

Fresh-context sub-agent attestation (governance directive `receipt-per-issue`
rule 7). The auditor was handed only the diff, this receipt and issue #821,
instructed to default to REFUTED when uncertain.

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
