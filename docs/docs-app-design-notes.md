# Docs — parity state and sanctioned withholdings

Docs was rebased onto the v9 design system in issue #765: the flat `NavKind` became a shelf model, the app bar and the compact band became frame contributions, and the copy and state rules moved out of render functions into pure tables. This file is the honest register of where the shipped app stands against the v9 Docs brief — what landed, what is deliberately deferred, and what the app **refuses to draw because it cannot read the fact behind it**.

It exists so the next agent does not "fix" a withholding. If you are about to make the repo match the brief on one of these lines, read the row first — and if you still think the brief is right, change the decision in the open (an issue, a receipt, this file), never quietly in a component.

Related: [docs/photos-design-notes.md](photos-design-notes.md) (the same register for Photos), [DESIGN.md](../DESIGN.md) (the binding rulebook), [docs/design-machinery.md](design-machinery.md) (lowering ownership), [docs/blueprint-seats.md](blueprint-seats.md) (what a seat may read), [docs/glossary.md](glossary.md).

## What shipped this arc

- **The shelf model.** `apps/docs/shelves.ts`: `DSHELVES` (All · Folders · Recently changed · Starred · Coming due · Trash), the off-strip destinations (Search, Storage, Add, Scan, What Docs may read), one folder as a sub-state of Folders, and the `docs` / `docs/<sub>` route round trip. The structure is shared with Photos (`apps/_shared/shelves.ts`) so the two routes inside one frame cannot drift.
- **The frame contribution.** `apps/docs/frame.tsx`: the app bar's title/count/primary verb per shelf, the band claim (All · Folders · Coming due · Search · More), and the one status line. The shape is shared with Photos (`apps/_shared/app-frame.tsx`).
- **The state rules.** `apps/docs/view-state.ts` over `apps/_shared/view-state-kit.ts`: nothing is empty until a read has landed; a shelf is never silently swapped (a gone folder falls back to **Folders** and says so); offline is read, never invented.
- **The copy tables.** `view-copy.ts` / `drive-copy.ts` / `document-copy.ts`: shelf titles and units, captions, the five empty variants (only the first-run drive takes a display serif), the row state slot's at-most-one-mark ladder, the More sheet's rows, the offline banner and the action status line.
- **The drive family**: breadcrumb, filter row, row/grid bodies, the loading window, the trash ask panel, the reading route, the editor's write outcomes, and the one-rail-three-tabs details with the versions route.
- **The Folders shelf** replaced the folder-tree rail; the shelf strip replaced the sidebar's `SmartNav`.

## Withholdings — screens the shelf model names but the app does not draw

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

## The band-owner gap in the frame contract

**On the compact form factor, Docs can lose shelf navigation entirely — and cannot detect it.**

- The shell owns the real answer: `packages/client/src/react/shell/useBandOwner.ts` keeps `shell.bandOwner.<appId>` in the client `Store`, and a member who hands the band back to the host makes the shell ignore that app's `claimBand`.
- `InlineFrame` (`packages/blueprints/apps/inline-types.ts`) carries the app bar, the status line and the band claim — and **nothing about who currently owns the band**. `claimBand` has no return value and no callback.
- Docs hides its shelf strip on the compact form factor (the band carries the same destinations there, and drawing both would put Trash in a strip that scrolls out of sight) and claims the band unconditionally. If the claim is not honoured, the strip is gone and the band shows the frame's destinations: **there is no way to reach Folders, Coming due or Trash on that surface.**
- Photos papers over the same gap with a second copy of the preference in its own store (`apps/photos/member-prefs.ts` `bandOwner`), gating its claim on a record the shell never reads. Two records for one member preference is the divergence [docs/config-ownership.md](config-ownership.md) exists to prevent.

The fix is a frame-contract change, not an app change: `InlineFrame` should hand the app the band owner the way `data-gateway-status` is meant to hand it reachability, and both apps should read that one record. Until then, Docs' strip should be gated on the same signal the claim is — not on the form factor alone.

## Deferred follow-up tiers (verbatim from the parity plan)

> E–G (FOLLOW-UP PRs): stage viewer/viewerMedia, storage/newdoc/bulk, capability-gated set (capabilities/due/filing/names/picker/locker/readonly), mobile details/band/tags then scan.

The mobile priorities behind that last clause, also verbatim:

> 1. Details sheet (custody/folder/tags/facts) 2. Band alignment (All/Folders/Search/More — no Coming due until capability ships) 3. Tags/filing surface 4. Search snippet line on rows. Follow-up: scan capture, editor, due, capabilities, names, picker.

## Binding cut-scope — do NOT build

From the same plan, settled: no folder-tree rail; no standalone Activity screen; no duplicates shelf; **no destroy verb** — the platform destroys only on the schedule a purge date announces, so a trash cannot be emptied, and Trash's app bar therefore carries no primary at all rather than an "Empty trash" that would refuse (`frame.tsx` `NO_PRIMARY`); and no "recently opened" — Recent is recently _changed_, because nothing records when a document was opened.

## Known duplication left in place

- **The drive's write outcomes do not use the frame's status line.** `logic.ts` narrates trash / restore / rename / move through the kit's own `statusLine()` DOM host, while save-to-my-vault and share decisions go through `publishOutcome` to the frame's one line. Photos routes _everything_ through one sink (`apps/photos/outcomes.ts` → `setStatusSink` → `publishOutcome`). Docs wants the same module; `view-copy.ts` `actionStatus()` already carries the copy for it.
- **`components/ShelfStrip.tsx` and `components/MoreSheet.tsx` are near-duplicates of Photos'.** They were left per-app deliberately: their CSS modules genuinely diverge (`--content-margin` vs `--sp-4` padding, the mono-numeric token trio, Docs' `meta`/`footer` rows against Photos' bare `count`), and the repo's shared-component pattern is one shared component with one shared CSS module (`apps/_shared/SearchScaffold.tsx`). Merging them changes rendered output on one surface or the other and needs the gallery baselines regenerated — a separate PR, not a drive-by.
