# Design divergences — Docs and Photos

This is the shared register of sanctioned per-app divergences from the v9 design briefs. It exists so a reviewer does not "fix" an honest withholding or a deliberate copy/control choice. Change a row here only when the current decision changes; implementation history belongs in the linked issue and receipt.

## Docs — parity state and sanctioned withholdings

Docs is aligned to the v9 design system: the flat `NavKind` is a shelf model, the app bar and compact band are frame contributions, and copy/state rules live in pure tables. This section records what the shipped app draws and what it refuses to draw because it cannot read the fact behind it.

If a change would alter one of these rows, update the current decision and its contract/test together; do not silently change a component.

Related: [the Photos section below](#photos--sanctioned-design-divergences), [DESIGN.md](../DESIGN.md) (the binding rulebook), [design machinery](design-machinery.md) (lowering ownership), [blueprint seats](blueprint-seats.md) (what a seat may read), and [glossary](glossary.md).

### Current surface

- **The shelf model.** `apps/docs/shelves.ts`: `DSHELVES` (All · Folders · Recently changed · Starred · Coming due · Trash), the off-strip destinations (Search, Storage, Add, Scan, What Docs may read), one folder as a sub-state of Folders, and the `docs` / `docs/<sub>` route round trip. The structure is shared with Photos (`apps/_shared/shelves.ts`) so the two routes inside one frame cannot drift.
- **The frame contribution.** `apps/docs/frame.tsx`: the app bar's title/count/primary verb per shelf, the band claim (All · Folders · Coming due · Search · More), and the one status line. The shape is shared with Photos (`apps/_shared/app-frame.tsx`).
- **The state rules.** `apps/docs/view-state.ts` over `apps/_shared/view-state-kit.ts`: nothing is empty until a read has landed; a shelf is never silently swapped (a gone folder falls back to **Folders** and says so); offline is read, never invented.
- **The copy tables.** `view-copy.ts` / `drive-copy.ts` / `document-copy.ts`: shelf titles and units, captions, the five empty variants (only the first-run drive takes a display serif), the row state slot's at-most-one-mark ladder, the More sheet's rows, the offline banner and the action status line.
- **The drive family**: breadcrumb, filter row, row/grid bodies, the loading window, the trash ask panel, the reading route, the editor's write outcomes, and the one-rail-three-tabs details with the versions route.
- **The Folders shelf** is the navigation model; there is no folder-tree rail or sidebar `SmartNav`.

### Withholdings — screens the shelf model names but the app does not draw

Every one of these has a route segment in `shelves.ts` (so the app can _describe_ the destination) and no screen. The More sheet gates them with `live: false` and does not draw a row for a place it cannot open: **a control that goes nowhere is worse than no control.**

| Withheld | Where the withholding is enforced | Why |
| --- | --- | --- |
| **`capabilities`** — "What Docs may read", four consents | `capabilities.ts` (`DCAPS` + `capabilityOn`, which answers `off` while there is no consent record to read), `view-copy.ts` `MORE_ROWS` | The four capabilities have no consent surface behind them yet. `capabilityOn` answers **off** rather than defaulting to on, so nothing downstream can claim a capability it does not have. |
| **`due`** — the Coming due shelf | `components/DueRoute.tsx` | The shelf exists because the band claims it, and it draws the one true thing about itself: the capability that would populate it is switched off, so it is "empty for a reason rather than because nothing is due". Its two spec actions land with `capabilities`. |
| **`scan`** — where documents are born on a phone | route segment only | No capture path on this surface. |
| **`storage`** — what the drive weighs | route segment + `Storage` widget in the rail | The full screen needs custody numbers this seat does not read; the widget says only what it can count. |
| **`newdoc`** — the four ways in | route segment only; "+ New" is still the sidebar dropdown | The bar's filled verb per shelf is named by `primaryLabel`, but `onPrimary` is deliberately **not** contributed while the app's own "+ New" exists — two filled controls would be two answers to one question. |
| **`behind`** — "This device is 3 hours behind the library" | not drawn at all | The panel needs the replica's lag (`this copy → 09:12` / `the library → last change 12:04`). An inline app cannot read it — same class of gap as reachability below. A panel that asserted a lag it had not measured is exactly the untrue-copy bug the state rules exist to close. |
| **`readonly`** — the viewer-seat panel | not drawn at all | Deferred with the capability-gated tier (below). |
| **`permission`** — the denial screen | `Chrome.tsx` banner with `VaultAccessButton` | Docs renders a denied read as a banner inside its own shell (asserted by `src/state-honesty.test.ts`), not as the designed screen Photos draws. The requirement the test is really enforcing is unchanged: a denied read always offers a direct way to the grant, never a dead end. |

**The People filter axis is withheld for the same reason, and it is the sharpest example.** §4.2 names four filter properties; `apps/docs/filters.ts` ships three. "Owned by you / Owned by Ana / Names Tom Pemberton / Shared with Family" needs owners, shares and the `names` capability's cross-app links — none of which this drive projection reads. `liveOptions()` renders no pill whose predicate cannot be computed, "because a pill that silently matches nothing is worse than a pill that is not there: the member reads the empty result as a fact about their drive."

### Compact band ownership

The web frame honours a first-party app's compact band claim whenever the surface is compact. There is no per-app grid-icon hand-back control: the app's shelves remain reachable instead of silently switching to a different host launcher. `InlineFrame` carries the contribution, while the frame owns the decision to ignore it on desktop or for non-first-party apps.

### Deferred follow-up tiers

The remaining follow-up tiers are viewer/viewerMedia, storage/newdoc/bulk, the capability-gated set (capabilities/due/filing/names/picker/locker/readonly), and mobile details/band/tags followed by scan.

Mobile priorities are the details sheet (custody/folder/tags/facts), band alignment (All/Folders/Search/More), tags/filing, and search snippets. Scan capture, editor, due, capabilities, names, and picker remain follow-ups.

### Binding cut-scope — do NOT build

The current scope has no folder-tree rail, standalone Activity screen, duplicates shelf, or **destroy verb**. The platform destroys only on the schedule a purge date announces, so Trash has no "Empty trash" primary (`frame.tsx` `NO_PRIMARY`). Recent means recently _changed_; the product does not record when a document was opened.

### Known duplication left in place

- **The drive's write outcomes do not use the frame's status line.** `logic.ts` narrates trash / restore / rename / move through the kit's own `statusLine()` DOM host, while save-to-my-vault and share decisions go through `publishOutcome` to the frame's one line. Photos routes _everything_ through one sink (`apps/photos/outcomes.ts` → `setStatusSink` → `publishOutcome`). Docs wants the same module; `view-copy.ts` `actionStatus()` already carries the copy for it.
- **`components/ShelfStrip.tsx` and `components/MoreSheet.tsx` are near-duplicates of Photos'.** They were left per-app deliberately: their CSS modules genuinely diverge (`--content-margin` vs `--sp-4` padding, the mono-numeric token trio, Docs' `meta`/`footer` rows against Photos' bare `count`), and the repo's shared-component pattern is one shared component with one shared CSS module (`apps/_shared/SearchScaffold.tsx`). Merging them changes rendered output on one surface or the other and needs the gallery baselines regenerated — a separate PR, not a drive-by.

## Photos — sanctioned design divergences

Photos is the pattern-setter for the v9 design system. The rows below are deliberate product and rendering choices, not drift. Change them only with a current decision and the corresponding contract/test update.

### Copy

| Divergence | Decision | Enforcement / reason |
| --- | --- | --- |
| Photos copy says **gateway** or **library**, not "vault". | Keep. | `packages/blueprints/src/photos-vocabulary.test.ts`; Photos can mount several scopes, so "this vault" is ambiguous (#599, S6). |
| Storage omits figures, backup controls, failing verdicts, and offload-cause splits. | Keep. | `Storage.tsx` and `STORAGE_COPY` render only values present in `blob.custody_rollup`; invented numbers are not acceptable. |
| Search miss says `Nothing in captions, people, places, things or album names.` | Keep. | `SEARCH_COPY.miss`; the desktop projection has a tag entity that mobile does not, so copy follows available truth. |
| Pending faces show a live count only after the count has loaded. | Keep. | `peoplePendingNote()` refuses stale or default counts. |
| Import copy counts photographs and reports deduplication outcomes. | Keep. | `components/Import.tsx`; "asset" is schema vocabulary, not member vocabulary. |
| The permission screen has two fact rows rather than the brief's three. | Keep until the denied read carries a library count. | `PERMISSION_COPY`; a prior count would be stale after permission loss. |

The brief's `sharing` screen is represented by the vault sharing plane, and its `system` appendix is documentation rather than a product screen.

### Mobile and controls

- The mobile band is `Library · Collections · Search · More`; collections group Albums, Places, People, Memories, and Duplicates within the five-destination cap.
- The More sheet has one row and no tile-size control. Tile size is a member preference adjusted by pinch or the pointer surface's four-segment control.
- The frame Home capsule sits at the leading edge outside the app tab group, which mirrors correctly under RTL.
- The Library grain control (`Years · Months · All`) is permanent and the grid skeleton uses packed final geometry.
- Tile size is `XS · S · M · L`, while mobile keeps its separate timeline-grain control. Album and People grids state column counts rather than card widths.

### Surface controls

- Photos does not expose the generic shell App settings sheet. Its toolbar owns the controls shown in the handoff, and Photos ships no app-local appearance knobs; the web shell therefore withholds that entry point for `app.id === "photos"`. Other app types keep their management surface.
- The compact Photos band is stable. The web frame always honours Photos' first-party claim on compact surfaces, so there is no grid-icon hand-back control that swaps its shelves for the host launcher.
- Selection replaces the compact band. While Photos selection is active, its five-action bar takes the foot and the claimed navigation band withdraws; normal browsing restores the band and its leading Home capsule. There is no capture launcher over any surface: quick capture is retired from the web and desktop seats entirely, so the handoff's floating action button has nothing left to represent. Capture remains a mobile origin act (`apps/mobile` Capture and Scan), which is where it was actually used.

### Colour roles and verified geometry

`--seam` is ink for expiring and in-flight states: purge countdowns, pending backup verdicts, and queued-copy rows. `--net-wash` is not used for Photos panels; offline, refused-write, and permission states remain border-and-ink because they are expected or explanatory states, not destructive controls. Revisit only if Photos adds a genuinely destructive or egress panel.

The packed tile geometry, overlay slots, skeleton, viewer stack, scrub rails, filmstrip, info rail, Memories strip, and mono-direction rules are metric-perfect against the v9 brief. Changes require a failing contract or an updated design decision before implementation.

## Copy-budget divergences (#805)

Sanctioned departures from the [DESIGN.md § Copy](../DESIGN.md) budgets, kept by the #805 audit rather than fixed quietly. Change a row only when the decision behind it changes.

| Divergence | Decision | Enforcement / reason |
| --- | --- | --- |
| The desktop crash-loop notification (`apps/desktop/src/main/gateway-monitor.ts`, "…Use Settings → Gateway to restart it manually.") runs three sentences. | Keep until the notification path is verified live. | [receipts/issue-660-desktop-onboarding-scenarios.md](../receipts/issue-660-desktop-onboarding-scenarios.md) records the hold: the advice can fire while the startup error screen is showing, where Settings is unreachable. Rewording without live verification risks pointing at a dead control. |
| Docs `DRIVE_EMPTY` and `folderEmpty` render two actions against the empty-state budget's "at most one action". | Keep. | Removing the second action is an affordance change, not a copy change; the copy itself is in budget. Revisit with a design decision, not a copy sweep. |
