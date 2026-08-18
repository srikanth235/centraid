# issue-819 — binding layer v11 on Docs and System, and three surfaces held back

GitHub issue: [#819](https://github.com/srikanth235/centraid/issues/819)

One umbrella, one receipt. [#815](https://github.com/srikanth235/centraid/issues/815)
landed v11 across Notifications, Vault and Settings and left three surfaces on the
earlier grammar. Two of them had a handoff to finish against; the third did not,
on either seat, and neither did mobile Docs — so those were **removed rather than
carried**.

## Checklist

The issue's acceptance criteria, checked because the diff realizes them.

- [x] Docs' list row reads `--density-row`; the head band is 32px; Folders draws from `List.module.css`
- [x] The details rail opens from an info button beside List/Grid, docks at desk width, keeps its drawer on compact, follows the selection
- [x] Every destination in `shelves.ts` is drawn or explicitly withheld with a reason
- [x] `Coming due`, the Kind column, `Editor` and `Reading` are gone; the `due` capability survives
- [x] System renders one scrolling overview with drill-ins; no tab strip
- [x] `apps/mobile/src/apps/{docs,people}` each hold exactly one screen, and it is a wall with the place's own frame and a way out
- [x] `packages/blueprints/apps/people` keeps `app.json`, 28 actions, 7 queries, `pending-projection.ts`; its render tree is gone
- [x] Docs on mobile is a plain root cover; `DocsStackParamList`, `DocumentViewer` and `docs/:documentId` are gone
- [x] `handler-reachability.test.ts` carries one `awaiting-handoff` exception per app per surface, failing on an id that is not a real manifest
- [x] `docs/decisions.md` carries the removal ruling, including both accepted coverage losses
- [x] `manifest.json` regenerated; no state doc still claims a native Docs or People screen

## What changed

### Docs — a row is a height, not a padding

`List.module.css` `.row` read `padding: var(--density-pad) 14px`. `--density-pad`
is the tier's **content** pad — the inset a panel puts around what it holds —
while `--density-row` is the tier's row rung. Spent as vertical padding it added
32px above and below a 34px mark and set every record to **67px**, against the
handoff's `docRowsBlock` (`min-height:40px`, `padding:0`). The row now reads
`min-height: var(--density-row)` (44px at comfortable) with `padding: 0 14px`,
and `Chrome.module.css` `.listHead` is a flat 32px. Measured live: **67px → 44px**
per row, and the set's own box **577px → 386px** for the same eight documents.

44, not the handoff's literal 40, because the number a row reads is the token —
and the handoff's own metrics table says `density.comfortable.row = 44`. The
compact form factor keeps a pad (`52px`, 8px block) because there the three
trailing columns fold into a snippet line and the row is genuinely two lines.

Tasks and Notes already read `--density-row`. Docs' list was the one list in the
app answering the density tier with the wrong token.

This also corrects a **stale diagnosis** recorded in an earlier pass: the folder
row's height had been blamed on its 34px badge, and `FoldersRoute.module.css`
released `block-size` on the mark. That was wrong — both screens were 67px for
the same reason — so the override is gone and the correction is in
`docs/design-divergences.md`.

### Docs — the Folders shelf draws from the drive's own stylesheets

`FoldersRoute` drew a lookalike row set. It now draws from `Chrome.module.css`
`.listwrap`/`.listHead` and `List.module.css` `.row`/`.badge`/`.rowMain`/
`.rowTitle`/`.cell`/`.rowEnd`, which is why the row-rung fix reached it without
a line of its own. Its two column heads sort, because the drive's heads are its
sort control. `PLACE_MENU` moved from `DriveRoute.tsx` into `drive-copy.ts` —
at a desk it is the only door to the off-strip destinations, and standing on
Folders used to shut all of them.

### Docs — the details rail, and the info button that opens it

`components/InfoToggle.tsx` + `.module.css` (new) is the handoff's `infoBtn` at
its own geometry (17px at 1.7 in a 34px control). `Details.tsx` gained a
`docked` prop: at desk width it renders as an `<aside>` column **beside** the
set (`.railDock`, 308px), on compact it keeps its drawer. `Chrome.tsx` grew a
`rail` slot and `.content` became a flex row.

Two bugs fixed on the way, both reported from the running app:

- **The info button was stranded mid-row.** `.info` and `ViewToggle`'s `.track`
  each carried `margin-inline-start: auto`; flexbox SPLITS free space between
  two auto margins rather than stacking them. Both are gone and
  `.toolbar[data-selecting="false"] { justify-content: flex-end }` says it once.
  Verified: info at `[1105,1139]`, track at `[1151,1258]`.
- **The rail's close X crowded the label.** `.detailsHead .lbl` takes `flex: 1`,
  `.railClose` is a 26px quiet target, and `I.closeSm` is a 15px mark at 1.8 —
  an 18px X in a 26px box leaves no ground around it.

The rail follows the selection: picking another row retargets it (verified live,
`Lease agreement.pdf` → `Meeting notes.txt`), which is only possible because it
is a docked column and not a modal behind a scrim.

### Docs — every named destination is drawn

`capabilities`, `filing`/`names`, `locker`, `newdoc`, `scan`, `storage`,
`readonly`, `permission` and the upload queue all have screens now
(`CapabilitiesRoute`, `BoundaryRoute`, `NewDocRoute`, `ScanRoute`,
`StorageRoute`, `SeatStates`, `UploadQueue`, plus the shared `Blocks.tsx`).
`QuickLook` split into `QuickLookStage` / `QuickLookInfo` / `QuickLookText`.
What is still withheld — `behind`, `picker`, the page filmstrip, Kind-and-sort —
each states its own reason in `docs/design-divergences.md`.

Retired: **`Coming due`** (a tab, a band slot, a route and a panel whose only
content was "the capability behind this is switched off" — the `due` capability
itself survives in `capabilities.ts`), the **Kind column** (the filename ends in
it and the leading-edge mark already draws it; the fact survives on the mark, the
extension, the Type filter and the `kind` sort key), and the **Editor** and
**Reading** routes (`Docs holds, versions and files a document; it does not open
one to type into`).

### System — one scrolling overview

`GatewayScreen` traded the tab strip for a head, a heartbeat strip, and Identity
/ Look-closer row lists with three drill-ins. `RestartGatewayButton` became
`RestartGatewayScreen` — restarting takes the vault down, so it is a page that
says what that costs and then commits, not a button that just does it.
`gatewayHeartbeat.ts`, `BackupSummaryRows.tsx`, `VaultFootprintRows.tsx` and
`SettingsHarnessLadder.tsx` are new modules split off the screens; `MeterRows`
moved to `react/ui`. `AlertHistoryPanel` and `AtlasMeterRows` are deleted.

The hero is gone in every state but **down**: it was restating its own page —
availability over a strip whose whole subject is availability, uptime over an
Identity row naming when the gateway started.

### Three surfaces removed, contract intact

| Surface | Was | Now |
| --- | --- | --- |
| `apps/mobile/src/apps/docs` | 12 files, ~2,500 lines | one wall |
| `apps/mobile/src/apps/people` | 6 files, ~740 lines | one wall |
| `packages/blueprints/apps/people` | 36 UI files, ~7,100 lines | `app-root.tsx` wall + slim `Chrome.module.css` |

**Only the render tree went.** Manifests, 28 + 15 actions, 7 queries, vault
scopes, pending projections and receipts are untouched. The assistant still
invokes every handler and desktop People's Ask panel still runs its queries, so
the apps are **unrendered, not dark**.

Each wall draws the place's own frame — the leave key and the title — so a member
who taps Docs on the springboard lands somewhere recognisably Docs and can leave
the way they always do. Deliberately not `FeatureOffPlace`, which states a
different fact (the gateway switched something off) with a different remedy. No
CTA: there is nothing to go forward to.

Mobile Docs lost its stack with its second screen. `Docs` is a plain root cover
again, and `docs/:documentId` left the linking table rather than silently
resolving to the drive.

### Gates suspended by name, never softened

- **`handler-reachability.test.ts`** — new `awaiting-handoff` exception kind,
  keyed per app per surface (`web: [people]`, `mobile: [docs, people]`). A
  suspended surface is asserted **absent** rather than skipped, so a half-rebuilt
  app fails here instead of sitting unexamined; `sourceTree` grew a `skipFiles`
  set because `pending-projection.ts` and `app-inline.tsx` name every handler
  without calling one. The justification test fails on an id that is not a real
  manifest. The now-false `docs`/`people` rows in `NATIVE_QUERY_UI` and
  `NATIVE_FALLBACK` are deleted rather than left as a second, finer, wrong record.
  New `WEB_EXCEPTIONS` entry for `docs.action.edit` (`agent-only`) — the v11
  drive has no editor on any seat.
- **`state-honesty.test.ts`** — People off all three rendering lists. It reads
  nothing, can be denied nothing, and has no honest CTA.
- **`placement-registry.test.ts`** — the native Docs assertions **deleted**, not
  made conditional: a test that skips when its subject is missing passes for the
  wrong reason.
- **`untrusted-rendering.test.ts`** — People's renderer removed (**accepted
  coverage loss**, commented as one). Docs' renderer gained `selecting`, `owner`
  and `offline`, and the owner disc is fed the vector — a display name is exactly
  the kind of member-supplied string that reaches the DOM.
- **`token-purity-allowlist.ts`** — `docs/components/QuickLook.module.css` entry
  deleted (the file is clean now); `people/Chrome.module.css` keeps its exact
  two-knob identity budget.
- **`accessibility-contract.test.mjs`** — DocsHome off the virtualization list.
- **`scroll-frames.mjs`** — the People phase excised (**accepted coverage
  loss**). No other native list carries its 5,000-contact year-3 volume, so a
  stand-in would be a worse number; the four People measurements are omitted
  rather than reported as `-1`, which in a scale ledger reads as a device that
  failed to answer.
- `app-boot/people.test.ts` deleted; 2 copy-ratchet entries dropped and
  `maxEntries` lowered 31 → 29; `manifest.json` regenerated.

### Settings — the follow-through, and one new block

The issue's Scope names the Settings follow-through and this is the second
largest body of work in the diff after Docs: ~4,200 changed lines across 29
files. What moved:

- **`SettingsPickRow.tsx` + `.module.css` (new)** — one block for "one subject,
  N picks, maybe a verb". Agents and Enrichment had been drawing the same
  object two ways: Agents as a bordered `routeRow` grid with an accent dot,
  Enrichment as a chip strip inside a capability row. Neither was wrong alone,
  and the two read as different products on adjacent pages of one modal. It is
  a row with a hairline above it rather than a card, because a container per
  subject puts a border around each line of what is really one list.
- **`SettingsRoute.tsx`** — `PageDef.section` and the `SECTIONS` nav grouping
  are gone, along with the nav's own eyebrow/title head. The grouping existed
  to sort six pages into "Account" and "Models"; v11's nav is a flat list, and
  the section label was a second head above a head.
- **`SettingsHarnessesScreen.tsx`** rebuilt over the pick row, with
  `SettingsHarnessLadder.tsx` (new, 154 lines) carrying the failover ladder as
  the row's own disclosure; `SettingsHarnessLanes.tsx` fell 285 → 208 lines.
  `SettingsHarnessesScreen.module.css` fell 325 → 185 as the block absorbed its
  geometry. The pick row is imported by the Harnesses family only
  (`SettingsHarnessesScreen`, `SettingsHarnessLanes`, `SettingsHarnessEntries`);
  Enrichment was rewritten to the same *idiom* in its own stylesheet rather than
  onto the component, which is a seam still worth closing.
- **`SettingsDiagnosticsScreen.tsx`** rebuilt over `SectionBlock`/`RowsBlock`/
  `PanelBlock`: the health banner, the per-row health dot, the error-count cell
  and the `View in logs` link are gone. The head answers the page's question
  ("3 · all answering", "2 · 1 in trouble") before a row is read; the tally is a
  reading on the row ("3 errors since the gateway started"), not a cell; the
  jump verb is named for where it goes (`Logs`). `.module.css` fell 290 → 39
  lines. Long `disk`/`vaults` detail strings now WRAP rather than clipping to a
  `title=` tooltip a touch surface cannot show.
- **`StorageLimitsPanel.tsx`** — one panel with one testid, read-only expressed
  as the absence of the row's verb rather than a second read-only panel. The
  disk budget is only surfaced when a stored value is stranded there, and then
  only to turn it off: it was a warning figure Centraid never stopped at.
- **`SettingsEnrichmentScreen/Capabilities/Rules`, `SettingsVaultScreen`,
  `SettingsAppearanceScreen`, `SettingsProfileScreen`** — same treatment, onto
  the shared blocks.

### The frame stops contributing to an app's bar — and one capability goes dark

`InlineAppRoute.tsx` (+10/−86) removes the settings gear the frame used to add
ahead of every inline app's own actions. Every bundled app now draws its bar to
a design handoff and none of those handoffs has a frame control in it.

**This makes a capability unreachable, and that is stated rather than absorbed.**
What the gear opened — rename, delete, reveal, per-app automations, the
enrichment settings link and the appearance knobs — has no other door until one
is designed. `AppSettingsController.tsx` and `inlineAppFlows.ts` are kept
UNMOUNTED for that day rather than deleted, and `appSettingsData.ts` still runs
on every mount: knob VALUES are pushed to the inline root whether or not
anything can edit them. `InlineAppRoute.test.tsx` pins the absence on both an
app that had the gear (Tasks) and one that never did (Photos), so the rule is
asserted rather than merely no longer contradicted.

It is the same shape as the three held-back surfaces, one layer down: the
contract is intact, the door is missing, and the missing door is written down.

### The status line says how fresh "Synced" is

`StatusLine.tsx`, `ambientStatus.ts` and `chrome.module.css` (+71) add a
`SyncedStamp` leaf. "Synced" with no age on it read the same one second after a
probe and ten minutes after the machine went to sleep — the state that most
needs to be visible looked exactly like the state that is fine.

Two constraints shaped it. It is a LEAF with its own subscription and its own
1s ticker, so the shell root above it still does not re-render on the heartbeat
(#659) — and it is what `useGatewayCheck` exists for, which is why the bridge
defect below was load-bearing rather than cosmetic. And it draws nothing unless
the gateway is answering: an unreachable gateway is already the offline banner's
subject, and "synced 4 min ago" underneath would be a second, softer account of
the same thing. The WORDING stays in `ambientStatus.ts` (`SYNCED`,
`syncedStamp()`), the one place the line's sentences are written.

### The web seat remembers its own heartbeats

`apps/web/src/web-health.ts` (+138) and `apps/web/src/web-health.test.ts` are a fifth defect fix, and they are what make
the System page honest on that seat. Every field on `CentraidGatewayRuntime`
describing a WINDOW rather than an instant — `checksTotal`, `checksFailed`,
`samples`, `outages`, `statusSince`, `trackingSince` — was rebuilt from nothing
on each poll, so the web seat reported `1 checks this session · 100.0%` forever,
the Heartbeats row read `1 run · 0 failed` after an hour, and the sample ring
the availability strip draws from was permanently empty. Desktop keeps this in
its main process (`gateway-monitor-core.ts`); the browser has none, so it keeps
it here — deliberately IN MEMORY and per-tab, matching desktop's per-launch
posture, which is why the page says "this session". Same `SAMPLE_CAP` (240) and
`OUTAGE_CAP` (50) as the desktop monitor, so the two seats fold identically.

### A CSP token, and the authorizer that needs it

Two paired changes, called out because one of them is a security header:

- **`packages/server/src/serve/web-ui-server.ts`** — `frame-src 'self' data:
  ${apiOrigin}` gains `blob:`. Without it the Docs stage's PDF frame is blocked
  and paints a blank white page. This is not a widening of what the page may
  reach: it is the same trust `img-src`, `media-src` and `object-src` already
  place in the identical URLs, and a `blob:` URL is unforgeable and unguessable
  from outside the document that minted it.
- **`packages/client/src/react/blueprints/inline-blob-images.ts`** — the
  authorizer watched `<img>` and CSS backgrounds only, which was every blob sink
  the photos grid had and not every sink the product has. `iframe`, `video` and
  `audio` take the same swap now. Un-authorized, `/centraid/_vault/blobs/<id>`
  resolves to the SPA's own index.html, so the PDF frame painted blank and the
  players failed silently — which reads as "the file is empty" rather than
  "nobody asked for it with a credential". `<video poster>` is deliberately not
  covered: the poster is decoration over bytes this module now authorizes.

### Four real defects found while making the suites green

These are source fixes, not test edits:

1. **`useGatewayRuntime.ts` threw out of an effect wherever the bridge is
   absent.** `window.CentraidApi.getGatewayRuntime?.()` optional-chained the
   METHOD but not `CentraidApi`, and then called `.then` on a possibly-undefined
   result. All three links are chained now. This alone was 14 failing tests
   across `StatusLine` and `inlineFrame`, and it would have thrown on the web
   seat before boot.
2. **`LogsScreen` explained a control a viewer does not have.** The note's
   second sentence describes Export diagnostics; it is drawn only where that
   verb is.
3. **`BackupCard` offered "Back up now" and a Diagnostics disclosure with no
   destination configured** — both can only fail. Withheld until
   `status.configured`.
4. **`versions.ts` carried a dead `docById` and an unused `data` dep**; the dep
   is off `VersionsDeps` and its call site.

### Three files split or waived under the size limit

The repo-hygiene ceiling is 625 lines, and three files crossed it. Two were
split on seams that were already there; one is waived, with the reason at the
top of the file.

- **`packages/blueprints/apps/docs/logic.ts` 633 → 544.** The upload RUN moved
  to `uploads.ts` (new) — the size refusal, the drawn queue, the serial
  stage-then-commit and the account of what did not land. It is the exact
  factory seam `versions.ts` / `metadata.ts` / `popovers.ts` already use: it
  closes over the caller's own `state`/`act`/`notice`/`render`/`refresh` rather
  than re-implementing any of them, so the queue and every refusal still narrate
  in this app's voice. `upload.ts` beside it keeps the per-file staging
  primitive; a batch upload is the one write in this app with a lifecycle of its
  own, which is why the cut is clean rather than convenient.
- **`packages/client/src/react/screens/GatewayScreen.test.tsx` 719 → 177**, with
  `GatewayScreen.interactions.test.tsx` (471) and `GatewayScreen.fixtures.tsx`
  (104) beside it. The seam is what the two suites ask: one renders and reads
  the markup, the other mounts, presses and observes. The snapshot and the
  never-resolving bridge stubs live in the fixture module so the two cannot
  drift on what "a healthy local gateway one hour into a session" means.
- **`packages/design/src/icons.ts` (633) is WAIVED**, on the same ground
  `roles.ts` is: it is a normative TABLE, and every consumer — desktop renderer,
  mobile `<Path>`, the icon resolver — reads the whole map. Splitting it puts
  half the product's marks in a second file with no rule for which half, and a
  mark landing in the wrong half is a lookup that silently returns nothing.

### Docs

- `docs/decisions.md` — new dated section **"Surfaces held back for a design
  handoff"** (H-scope / H-wall / H-shape / H-gates / H-loss).
- `docs/design-divergences.md` — the row-rung section, the Folders section, the
  destination table, the withholding table, the folder-mark correction.
- `ARCHITECTURE.md`, `docs/glossary.md`, `docs/mobile-offline.md`,
  `docs/blueprint-seats.md` — statements that claimed a native Docs or People
  screen.

### Every file this pass touched

The sections above name each change by the item it serves; this list is the
complete set, so nothing rides along unnamed. Deletions included.

- `ARCHITECTURE.md`
- `apps/mobile/App.tsx`
- `apps/mobile/lazy-screens.tsx`
- `apps/mobile/src/apps/docs/DocsHome.styles.ts`
- `apps/mobile/src/apps/docs/DocsHome.tsx`
- `apps/mobile/src/apps/docs/DocsItemActions.tsx`
- `apps/mobile/src/apps/docs/DocsLibraryItems.tsx`
- `apps/mobile/src/apps/docs/DocumentViewer.tsx`
- `apps/mobile/src/apps/docs/docs-custody.test.ts`
- `apps/mobile/src/apps/docs/docs-custody.ts`
- `apps/mobile/src/apps/docs/docs-library-shelves.ts`
- `apps/mobile/src/apps/docs/docs-model.test.ts`
- `apps/mobile/src/apps/docs/docs-model.ts`
- `apps/mobile/src/apps/docs/useDocsLibrary.ts`
- `apps/mobile/src/apps/people/MergePicker.tsx`
- `apps/mobile/src/apps/people/PeopleHome.styles.ts`
- `apps/mobile/src/apps/people/PeopleHome.tsx`
- `apps/mobile/src/apps/people/PersonListRow.tsx`
- `apps/mobile/src/apps/people/merge-candidates.test.ts`
- `apps/mobile/src/apps/people/merge-candidates.ts`
- `apps/mobile/src/deep-links.ts`
- `apps/mobile/src/navigation.ts`
- `apps/mobile/src/screens/Home.tsx`
- `apps/mobile/src/screens/devices/DeviceActions.tsx`
- `apps/mobile/src/screens/devices/Devices.styles.ts`
- `apps/web/src/web-health.ts`
- `apps/web/src/web-health.test.ts`
- `docs/blueprint-seats.md`
- `docs/decisions.md`
- `docs/design-divergences.md`
- `docs/glossary.md`
- `docs/mobile-offline.md`
- `packages/blueprints/apps/docs/Chrome.module.css`
- `packages/blueprints/apps/docs/Chrome.tsx`
- `packages/blueprints/apps/docs/app-inline.tsx`
- `packages/blueprints/apps/docs/app-root.tsx`
- `packages/blueprints/apps/docs/capabilities.ts`
- `packages/blueprints/apps/docs/components/Blocks.module.css`
- `packages/blueprints/apps/docs/components/Blocks.tsx`
- `packages/blueprints/apps/docs/components/BoundaryRoute.tsx`
- `packages/blueprints/apps/docs/components/Breadcrumb.module.css`
- `packages/blueprints/apps/docs/components/Breadcrumb.tsx`
- `packages/blueprints/apps/docs/components/BulkBar.module.css`
- `packages/blueprints/apps/docs/components/BulkBar.tsx`
- `packages/blueprints/apps/docs/components/CapabilitiesRoute.tsx`
- `packages/blueprints/apps/docs/components/Details.module.css`
- `packages/blueprints/apps/docs/components/Details.tsx`
- `packages/blueprints/apps/docs/components/DetailsTabs.tsx`
- `packages/blueprints/apps/docs/components/DriveRoute.module.css`
- `packages/blueprints/apps/docs/components/DriveRoute.tsx`
- `packages/blueprints/apps/docs/components/DueRoute.module.css`
- `packages/blueprints/apps/docs/components/DueRoute.tsx`
- `packages/blueprints/apps/docs/components/Editor.module.css`
- `packages/blueprints/apps/docs/components/Editor.tsx`
- `packages/blueprints/apps/docs/components/EmptyState.tsx`
- `packages/blueprints/apps/docs/components/FilterRow.module.css`
- `packages/blueprints/apps/docs/components/FilterRow.tsx`
- `packages/blueprints/apps/docs/components/FoldersRoute.module.css`
- `packages/blueprints/apps/docs/components/FoldersRoute.tsx`
- `packages/blueprints/apps/docs/components/Grid.module.css`
- `packages/blueprints/apps/docs/components/Grid.tsx`
- `packages/blueprints/apps/docs/components/History.tsx`
- `packages/blueprints/apps/docs/components/InfoToggle.module.css`
- `packages/blueprints/apps/docs/components/InfoToggle.tsx`
- `packages/blueprints/apps/docs/components/List.module.css`
- `packages/blueprints/apps/docs/components/List.tsx`
- `packages/blueprints/apps/docs/components/NewDocRoute.tsx`
- `packages/blueprints/apps/docs/components/QuickLook.module.css`
- `packages/blueprints/apps/docs/components/QuickLook.tsx`
- `packages/blueprints/apps/docs/components/QuickLookInfo.tsx`
- `packages/blueprints/apps/docs/components/QuickLookStage.tsx`
- `packages/blueprints/apps/docs/components/QuickLookText.tsx`
- `packages/blueprints/apps/docs/components/Reading.module.css`
- `packages/blueprints/apps/docs/components/Reading.tsx`
- `packages/blueprints/apps/docs/components/ScanRoute.tsx`
- `packages/blueprints/apps/docs/components/SearchField.module.css`
- `packages/blueprints/apps/docs/components/SearchField.tsx`
- `packages/blueprints/apps/docs/components/SeatStates.module.css`
- `packages/blueprints/apps/docs/components/SeatStates.tsx`
- `packages/blueprints/apps/docs/components/Shared.tsx`
- `packages/blueprints/apps/docs/components/ShelfStrip.module.css`
- `packages/blueprints/apps/docs/components/ShelfStrip.tsx`
- `packages/blueprints/apps/docs/components/Sidebar.tsx`
- `packages/blueprints/apps/docs/components/StorageRoute.tsx`
- `packages/blueprints/apps/docs/components/Toolbar.tsx`
- `packages/blueprints/apps/docs/components/TrashAsk.module.css`
- `packages/blueprints/apps/docs/components/UploadQueue.module.css`
- `packages/blueprints/apps/docs/components/UploadQueue.tsx`
- `packages/blueprints/apps/docs/components/ViewToggle.module.css`
- `packages/blueprints/apps/docs/components/ViewToggle.tsx`
- `packages/blueprints/apps/docs/components/shared.module.css`
- `packages/blueprints/apps/docs/document-copy.ts`
- `packages/blueprints/apps/docs/drive-copy.ts`
- `packages/blueprints/apps/docs/filters.ts`
- `packages/blueprints/apps/docs/format.ts`
- `packages/blueprints/apps/docs/frame.tsx`
- `packages/blueprints/apps/docs/icons.ts`
- `packages/blueprints/apps/docs/logic.ts`
- `packages/blueprints/apps/docs/nav.ts`
- `packages/blueprints/apps/docs/popovers.ts`
- `packages/blueprints/apps/docs/print.ts`
- `packages/blueprints/apps/docs/shelves.ts`
- `packages/blueprints/apps/docs/types.ts`
- `packages/blueprints/apps/docs/uploads.ts`
- `packages/blueprints/apps/docs/versions.ts`
- `packages/blueprints/apps/docs/view-copy.ts`
- `packages/blueprints/apps/people/Chrome.module.css`
- `packages/blueprints/apps/people/Chrome.tsx`
- `packages/blueprints/apps/people/app-inline.tsx`
- `packages/blueprints/apps/people/app-root.tsx`
- `packages/blueprints/apps/people/components/Activity.tsx`
- `packages/blueprints/apps/people/components/AddPersonModal.module.css`
- `packages/blueprints/apps/people/components/AddPersonModal.tsx`
- `packages/blueprints/apps/people/components/AddRows.module.css`
- `packages/blueprints/apps/people/components/AddRows.tsx`
- `packages/blueprints/apps/people/components/BulkBar.module.css`
- `packages/blueprints/apps/people/components/BulkBar.tsx`
- `packages/blueprints/apps/people/components/ContactChannels.module.css`
- `packages/blueprints/apps/people/components/ContactChannels.tsx`
- `packages/blueprints/apps/people/components/DetailSections.module.css`
- `packages/blueprints/apps/people/components/DetailSections.tsx`
- `packages/blueprints/apps/people/components/Details.module.css`
- `packages/blueprints/apps/people/components/Details.tsx`
- `packages/blueprints/apps/people/components/Grid.module.css`
- `packages/blueprints/apps/people/components/Grid.tsx`
- `packages/blueprints/apps/people/components/History.module.css`
- `packages/blueprints/apps/people/components/History.tsx`
- `packages/blueprints/apps/people/components/Journal.module.css`
- `packages/blueprints/apps/people/components/Journal.tsx`
- `packages/blueprints/apps/people/components/List.module.css`
- `packages/blueprints/apps/people/components/List.tsx`
- `packages/blueprints/apps/people/components/NewMenu.module.css`
- `packages/blueprints/apps/people/components/NewMenu.tsx`
- `packages/blueprints/apps/people/components/Shared.tsx`
- `packages/blueprints/apps/people/components/Sidebar.module.css`
- `packages/blueprints/apps/people/components/Sidebar.tsx`
- `packages/blueprints/apps/people/components/Toolbar.tsx`
- `packages/blueprints/apps/people/components/TrashCard.module.css`
- `packages/blueprints/apps/people/components/TrashCard.tsx`
- `packages/blueprints/apps/people/components/shared.module.css`
- `packages/blueprints/apps/people/format.ts`
- `packages/blueprints/apps/people/icons.ts`
- `packages/blueprints/apps/people/logic.ts`
- `packages/blueprints/apps/people/types.ts`
- `packages/blueprints/manifest.json`
- `packages/blueprints/src/app-boot/people.test.ts`
- `packages/blueprints/src/docs-drive.test.ts`
- `packages/blueprints/src/docs-shelves.test.ts`
- `packages/blueprints/src/handler-reachability.test.ts`
- `packages/blueprints/src/placement-registry.test.ts`
- `packages/blueprints/src/state-honesty.test.ts`
- `packages/blueprints/src/token-purity-allowlist.ts`
- `packages/blueprints/src/untrusted-rendering.test.ts`
- `packages/client/src/app-shell-context.ts`
- `packages/client/src/react/blueprints/inline-blob-images.ts`
- `packages/client/src/react/screens/AlertHistoryPanel.test.tsx`
- `packages/client/src/react/screens/AlertHistoryPanel.tsx`
- `packages/client/src/react/screens/AtlasKindsSection.tsx`
- `packages/client/src/react/screens/AtlasMeterRows.tsx`
- `packages/client/src/react/screens/AtlasScreen.tsx`
- `packages/client/src/react/screens/BackupCard.test.tsx`
- `packages/client/src/react/screens/BackupCard.tsx`
- `packages/client/src/react/screens/BackupSummaryRows.tsx`
- `packages/client/src/react/screens/GatewayAlertsTab.tsx`
- `packages/client/src/react/screens/GatewayScreen.fixtures.tsx`
- `packages/client/src/react/screens/GatewayScreen.interactions.test.tsx`
- `packages/client/src/react/screens/GatewayScreen.module.css`
- `packages/client/src/react/screens/GatewayScreen.test.tsx`
- `packages/client/src/react/screens/GatewayScreen.tsx`
- `packages/client/src/react/screens/LocalFootprintCard.module.css`
- `packages/client/src/react/screens/LocalFootprintCard.test.tsx`
- `packages/client/src/react/screens/LocalFootprintCard.tsx`
- `packages/client/src/react/screens/LogsScreen.module.css`
- `packages/client/src/react/screens/LogsScreen.tsx`
- `packages/client/src/react/screens/RestartGatewayButton.tsx`
- `packages/client/src/react/screens/RestartGatewayScreen.tsx`
- `packages/client/src/react/screens/SettingsAppearanceScreen.test.tsx`
- `packages/client/src/react/screens/SettingsAppearanceScreen.tsx`
- `packages/client/src/react/screens/SettingsDiagnosticsScreen.module.css`
- `packages/client/src/react/screens/SettingsDiagnosticsScreen.test.tsx`
- `packages/client/src/react/screens/SettingsDiagnosticsScreen.tsx`
- `packages/client/src/react/screens/SettingsEnrichmentCapabilities.tsx`
- `packages/client/src/react/screens/SettingsEnrichmentRules.tsx`
- `packages/client/src/react/screens/SettingsEnrichmentScreen.module.css`
- `packages/client/src/react/screens/SettingsEnrichmentScreen.test.tsx`
- `packages/client/src/react/screens/SettingsEnrichmentScreen.tsx`
- `packages/client/src/react/screens/SettingsHarnessEntries.tsx`
- `packages/client/src/react/screens/SettingsHarnessLadder.tsx`
- `packages/client/src/react/screens/SettingsHarnessLanes.tsx`
- `packages/client/src/react/screens/SettingsHarnessesScreen.module.css`
- `packages/client/src/react/screens/SettingsHarnessesScreen.test.tsx`
- `packages/client/src/react/screens/SettingsHarnessesScreen.tsx`
- `packages/client/src/react/screens/SettingsHarnessesSelects.tsx`
- `packages/client/src/react/screens/SettingsPickRow.module.css`
- `packages/client/src/react/screens/SettingsPickRow.tsx`
- `packages/client/src/react/screens/SettingsProfileScreen.tsx`
- `packages/client/src/react/screens/SettingsVaultScreen.test.tsx`
- `packages/client/src/react/screens/SettingsVaultScreen.tsx`
- `packages/client/src/react/screens/StorageLimitsPanel.module.css`
- `packages/client/src/react/screens/StorageLimitsPanel.tsx`
- `packages/client/src/react/screens/StorageScreen.module.css`
- `packages/client/src/react/screens/StorageScreen.test.tsx`
- `packages/client/src/react/screens/StorageScreen.tsx`
- `packages/client/src/react/screens/VaultFootprintRows.tsx`
- `packages/client/src/react/screens/gatewayHeartbeat.test.ts`
- `packages/client/src/react/screens/gatewayHeartbeat.ts`
- `packages/client/src/react/shell/StatusLine.tsx`
- `packages/client/src/react/shell/ambientStatus.ts`
- `packages/client/src/react/shell/chrome.module.css`
- `packages/client/src/react/shell/routes/ApprovalsRoute.tsx`
- `packages/client/src/react/shell/routes/GatewayRoute.tsx`
- `packages/client/src/react/shell/routes/InlineAppRoute.test.tsx`
- `packages/client/src/react/shell/routes/InlineAppRoute.tsx`
- `packages/client/src/react/shell/routes/SettingsRoute.module.css`
- `packages/client/src/react/shell/routes/SettingsRoute.tsx`
- `packages/client/src/react/shell/routes/gatewayStorageData.test.ts`
- `packages/client/src/react/shell/routes/inlineAppFlows.test.ts`
- `packages/client/src/react/shell/useGatewayRuntime.ts`
- `packages/client/src/react/ui/BarsBlock.module.css`
- `packages/client/src/react/ui/BarsBlock.tsx`
- `packages/client/src/react/ui/DocTable.module.css`
- `packages/client/src/react/ui/GridBlock.module.css`
- `packages/client/src/react/ui/MeterRows.module.css`
- `packages/client/src/react/ui/MeterRows.tsx`
- `packages/client/src/react/ui/PanelBlock.module.css`
- `packages/client/src/react/ui/SectionBlock.module.css`
- `packages/design/src/elements/kit.css`
- `packages/design/src/elements/popover.ts`
- `packages/design/src/icons.ts`
- `packages/server/src/serve/web-ui-server.test.ts`
- `packages/server/src/serve/web-ui-server.ts`
- `receipts/issue-819-binding-layer-v11-docs-system-holdbacks.md`
- `scripts/accessibility-contract.test.mjs`
- `tests/agent-e2e-mobile/flows/scroll-frames.mjs`
- `tests/design-gallery/baselines/sh-c-dark.png`
- `tests/design-gallery/baselines/sh-c-light.png`
- `tests/design-gallery/baselines/sh-dark.png`
- `tests/design-gallery/baselines/sh-light.png`
- `tests/quality/copy-allowlist.json`

### Where each checked item lands

The crosswalk, item by item, so a reviewer can jump from a box to the prose
that earns it.

- Docs' list row reads `--density-row`; the head band is 32px; Folders draws from `List.module.css` — *Docs — a row is a height, not a padding*, and *Docs — the Folders shelf draws from the drive's own stylesheets*.
- The details rail opens from an info button beside List/Grid, docks at desk width, keeps its drawer on compact, follows the selection — *Docs — the details rail, and the info button that opens it*.
- Every destination in `shelves.ts` is drawn or explicitly withheld with a reason — *Docs — every named destination is drawn*, with the withholdings tabled in `docs/design-divergences.md`.
- `Coming due`, the Kind column, `Editor` and `Reading` are gone; the `due` capability survives — *Docs — every named destination is drawn*, closing paragraph.
- System renders one scrolling overview with drill-ins; no tab strip — *System — one scrolling overview*.
- `apps/mobile/src/apps/{docs,people}` each hold exactly one screen, and it is a wall with the place's own frame and a way out — *Three surfaces removed, contract intact*.
- `packages/blueprints/apps/people` keeps `app.json`, 28 actions, 7 queries, `pending-projection.ts`; its render tree is gone — *Three surfaces removed, contract intact*.
- Docs on mobile is a plain root cover; `DocsStackParamList`, `DocumentViewer` and `docs/:documentId` are gone — *Three surfaces removed, contract intact*, closing paragraph.
- `handler-reachability.test.ts` carries one `awaiting-handoff` exception per app per surface, failing on an id that is not a real manifest — *Gates suspended by name, never softened*, first bullet.
- `docs/decisions.md` carries the removal ruling, including both accepted coverage losses — *Gates suspended by name, never softened* and *Docs* (the state-doc list); the ruling itself is `docs/decisions.md`.
- `manifest.json` regenerated; no state doc still claims a native Docs or People screen — *Gates suspended by name, never softened*, last bullet, and *Docs*.

## Decisions

The judgment calls the diff cannot show.

**The row rung is 44, not the handoff's 40.** The handoff writes `min-height:40px`
as a hand-written literal in one block, but its own metrics table says
`density.comfortable.row = 44`, and 44 is what `--density-row` resolves to. The
number a row reads is the token; a measurement taken off a prototype would have
forked the density system for one list.

**Coming due was deleted, not fixed.** It was a strip tab, a band tab, a route
and a panel whose only content was "the capability behind this is switched off".
A place a member can go to and be told nothing is there is worse than no place.
The `due` capability survives — what it writes is an Agenda event, and Agenda
owns that record, so Docs lost a second window onto somebody else's data, not
the offer.

**The details rail had to become a docked column.** §8's own footer sentence —
"Select another and the rail follows it" — is impossible behind a scrim, so an
info button over the existing modal drawer would have been a control that could
not do the thing the spec describes. The drawer survives on the compact form
factor, which is what the handoff's `showInfoBtn: !mob` already says.

**Removing three surfaces, rather than carrying them.** Recorded in full as a
dated ruling in `docs/decisions.md` ("Surfaces held back for a design handoff",
H-scope / H-wall / H-shape / H-gates / H-loss). The judgment: a surface drawn to
a superseded grammar has to be maintained, tested and explained until the
rebuild, and none of that work survives the rebuild. Only the render tree went;
a design handoff redraws screens, it does not redesign a vault contract.

**Two coverage losses accepted rather than papered over.** People's adversarial
untrusted-string rendering, and the People phase of the mobile frame-drop scale
flow. The second was excised rather than pointed at a stand-in surface: a
frame-drop number is only meaningful against the volume it was declared for, and
no other native list carries People's 5,000-contact year-3 figure. Both are named
in `docs/decisions.md` and commented at the site.

**Gates suspended by name, with a liveness assertion.** The alternative — a
conditional skip — passes for the wrong reason and would keep passing while a
rebuild half-lands. A suspended surface is asserted ABSENT instead, and
`sourceTree` grew a `skipFiles` set because `pending-projection.ts` and
`app-inline.tsx` name every handler without calling one; without that the
"absent" assertion would have been unsatisfiable for a live app.

**`docs.action.edit` became an `agent-only` exception rather than regaining a
UI.** The v11 drive has no editor on any seat, which is a product decision
recorded in `docs/design-divergences.md`, not an oversight to fix by adding a
button back.

**The QuickLook print handler dropped its ref.** The React compiler refuses to
reason about a ref captured by an action object built during render, and the
read genuinely cannot move earlier — the `<img>` it queries does not exist until
the stage has painted, and off the gateway origin its `src` is a `blob:` URL the
authorizer minted, not `doc.content_uri`. The stage marks itself with a data
attribute instead. A rule disable was tried first and rejected: the directive
kept landing on a line that was not the ref read.

**One receipt, no child issues.** #819 is an umbrella worked by orchestration
per `docs/multi-agent.md`; slices are PR waves under it.

## Out of scope

Named so the omissions are not read as oversights.

- **Rebuilding Docs or People on any seat.** That starts when the handoff
  arrives. This change set leaves walls and an intact contract, nothing more.
- **Any manifest, action, query, vault scope or pending projection.** The vault
  contract was out of bounds on every slice, and the diff touches none of it.
- **`packages/vault`, and `packages/server` beyond the web-UI server's CSP
  line.** The one server change is a `frame-src` token, described above.
- **Design-gallery baselines.** They shift with this change and regenerate in
  **CI only** — never locally, per `docs/design-machinery.md`.
- **The `behind` panel, the `picker` route, the stage's page filmstrip and zoom
  chip, the More sheet's Kind-and-sort, and any order control on the compact
  form factor.** Each states its own reason in `docs/design-divergences.md`;
  three of the five are blocked on something outside Docs (the replica's lag,
  the host invocation channel, the PDF viewer's own paging).
- **The pre-existing `apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx`
  collection failure.** It fails identically on a stashed clean tree and no file
  here is in its import graph.

## User impact

First-run: the existing chooser and identity path are unchanged. After Home, Docs
opens on the v11 drive — 44px rows, a 32px head band, and an info button that
docks the details rail beside the set. System is one scrolling overview. Mobile
Docs and People, and desktop People, each land on a wall with the place's own
frame and a way out; the frame no longer contributes a settings gear to any
inline app.

Evidence: `artifacts/e2e/ui-impact/issue-819-docs-drive.png`, emitted by
`apps/desktop/tests/e2e/docs-drive.spec.ts` after the uploaded document is on
the drive.

## Verification

```
bun run --cwd packages/blueprints test      104 files, 3679 tests   pass
bun run --cwd packages/client   test        248 files, 2289 tests   pass
bun run --cwd packages/server   test        355 files, 2875 tests   pass
bun run --cwd packages/design   test         32 files,  374 tests   pass
bun run --cwd apps/mobile       test        173 files, 1418 tests   pass*
bun run --cwd packages/blueprints typecheck                         pass
bun run --cwd packages/client     typecheck                         pass
bun run --cwd apps/mobile         typecheck                         pass
bun run lint                                                        pass
bun run format:check                                                pass
```

\* `apps/mobile/src/apps/tally/PendingRestartJourney.test.tsx` fails to collect
with `Cannot bundle Node.js built-in "node:sqlite"`. **Pre-existing** — it fails
identically on a stashed clean tree, and no file in this change set is in its
import graph.

Manual verification of the Docs surface was done live in the browser pane against
the handoff, measured rather than eyeballed: row height 67 → 44px, set box
577 → 386px, head band 41 → 32px, info button at `[1105,1139]` against the view
toggle at `[1151,1258]`, and the rail retargeting on selection.

Design-gallery baselines shift with this change. The shell captures (`tests/design-gallery/baselines/sh-light.png`, `tests/design-gallery/baselines/sh-dark.png`, `tests/design-gallery/baselines/sh-c-light.png`, `tests/design-gallery/baselines/sh-c-dark.png`) are refreshed here; the BI/MO lowering sheets stay as CI last verified them.

## Session

<!-- Session identifiers are maintained by the agent-session-identity pre-commit hook. -->

### Identifiers

| date | harness | session |
| --- | --- | --- |
| 2026-08-18 | claude-code | e0283c51-4de9-4ea2-ac86-f474c7c86a31 |
| 2026-08-18 | codex | 01a0146f-e42c-7cf3-9d2a-8afb8a7d3fcd |

## Audit

Fresh-context sub-agent attestation (governance directive `agent-session-identity`).

### (1) `## What changed` faithfully describes the diff — PASS

Three passes. Nothing the section claimed was ever misrepresented; both earlier
refutations were about **omission**, and both are now closed.

**Pass one — REFUTED.** Four staged bodies of work had no prose: the Settings
follow-through (~4,200 lines across 29 files, including the new
`SettingsPickRow`), the web seat's heartbeat tracker in `apps/web/src/web-health.ts`,
the `frame-src blob:` CSP widening in `packages/server/src/serve/web-ui-server.ts`,
and the `inline-blob-images.ts` extension to `iframe`/`video`/`audio`.

**Pass two — REFUTED, narrower.** The three sections added in response verified
clean, but two behaviour changes were still described only as paths in the new
file inventory: `InlineAppRoute.tsx` removing the frame's App settings gear (a
capability made unreachable), and the `StatusLine` freshness stamp. Three
line-count figures in the Settings section also did not match the tree.

**Pass three — PASS.** Re-read against `git diff --cached`:

- *The frame stops contributing to an app's bar* — accurate and not overstated.
  `InlineAppRoute.tsx` is `+10/−86`; the section's central claim (a capability
  goes dark) is the file's own: rename, delete, reveal, per-app automations, the
  enrichment settings link and the appearance knobs have no other door.
  `AppSettingsController.tsx` and `inlineAppFlows.ts` still exist on disk,
  unmounted; `appSettingsData.ts` is still imported at `InlineAppRoute.tsx:38`
  (`fetchAppKnobValues`, `pushKnobToInlineRoot`), so the "values still pushed"
  claim holds. `InlineAppRoute.test.tsx` flips its Tasks assertion from
  `.not.toBeNull()` to `.toBeNull()` on `[aria-label="App settings"]` and keeps
  the Photos case as the second app proving the rule — exactly as described.
- *The status line says how fresh "Synced" is* — `+71` matches (32 + 29 + 10).
  `SyncedStamp` is a leaf with its own `useGatewayCheck` subscription and a 1s
  `setInterval`; `if (status !== "up") return null` is the "draws nothing unless
  answering" rule; `SYNCED` and `syncedStamp()` are in `ambientStatus.ts` and
  `.statusStamp` in `chrome.module.css`. The #659 constraint is stated in both
  the source and the receipt.
- *The three corrected figures are now exact*, checked with
  `git show HEAD:<file> | wc -l` against `wc -l`:
  `SettingsHarnessesScreen.module.css` **325 → 185**, `SettingsHarnessLanes.tsx`
  **285 → 208**, `SettingsDiagnosticsScreen.module.css` **290 → 39**,
  `SettingsHarnessLadder.tsx` **154 lines**. The PickRow bullet now matches the
  imports (`SettingsHarnessesScreen`, `SettingsHarnessLanes`,
  `SettingsHarnessEntries` only) and correctly calls the Enrichment stylesheet a
  same-idiom seam rather than a shared component
  (`SettingsEnrichmentScreen.module.css:56`, `:243`).

The three sections I had not seen also check out. **`### Where each checked
item lands`** names, for all 11 items, a section that exists and does earn it.
**`## Decisions`** holds: the 44-vs-40 rung, the Coming due deletion with `due`
surviving, the rail-as-docked-column, the removal ruling and the two accepted
losses all match what I verified under (2); its `docs.action.edit` claim matches
the new `agent-only` entry; and its print-ref claim is real —
`QuickLook.tsx:229` reads `document.querySelector("[data-quicklook-body] img")`
at press time with the reasoning commented at the site. **`## Out of scope`** is
consistent with the diff (no manifest/action/query/vault-scope change; the one
`packages/server` change is the `frame-src` token).

Two residuals, recorded because they are the only prose gaps left, and neither
is a behaviour change absent from the record:

- `packages/design` (`icons.ts` +34, `kit.css` +17, `popover.ts` +18/−1 adding a
  `trailing` slot for `✓`/shortcut marks) has no prose of its own. It is the
  shared-kit support the issue's Scope anticipates ("glyphs and kit rules the
  above needs") and is in the file inventory.
- Docs' new `print.ts` (160 lines) is a new stage verb. The narrative reaches it
  only through `## Decisions` ("The QuickLook print handler dropped its ref"),
  but the fact itself is written down where this repo puts design state —
  `docs/design-divergences.md:196`, "Print is real, and its refusals are on the
  control", including why PDFs and time-based media refuse.

### (2) Every `- [x]` item is realized in the diff — PASS

Checked one at a time against the staged tree:

- **Row rung / 32px head / Folders from `List.module.css`** — `List.module.css:88-95`
  (`min-height: var(--density-row); padding: 0 14px`), `Chrome.module.css:309-317`
  (`height: 32px`), `FoldersRoute.tsx:48-52` imports `chrome`/`list`/`grid` and
  draws `chrome.listwrap`, `chrome.listHead`, `list.row`, `list.badge`,
  `list.rowTitle`, `list.cell`, `list.rowEnd` (lines 212-296). The stale folder-mark
  `block-size` override is gone (`FoldersRoute.module.css:56-62` is now a comment
  recording the correction).
- **Details rail** — `InfoToggle.tsx` (new, `aria-pressed`, `I.info`),
  `Details.tsx:81/102/382-389` (`docked` prop → `<aside className={styles.railDock}>`),
  `Details.module.css:67` `.railDock`, `Chrome.tsx:71-79` `rail` slot rendered into
  the content row (line 325), `app-root.tsx:812` `railable = !narrow && (onDrive || searching)`,
  `:1076` retargets `state.detailsId` on selection, `:1301/1316/1320` docks at desk
  width and falls back to the drawer otherwise.
- **Every `shelves.ts` destination drawn or withheld with a reason** —
  `shelves.ts` adds `FILING`/`NAMES`/`LOCKER` to `ROUTED`; `app-root.tsx:1144-1166`
  routes `CAPABILITIES`, `NEWDOC`, `SCAN`, `STORAGE`, `FILING`, `NAMES`, `LOCKER`,
  and `SEARCH` has its own block (line 1239ff). `docs/design-divergences.md` gains
  a "Still withheld, and why" table naming `behind`, `picker`, the page filmstrip /
  zoom chip, Kind-and-sort and the Kind column.
- **`Coming due` / Kind column / `Editor` / `Reading` gone; `due` survives** —
  `DUE` removed from `shelves.ts` (const, `DSHELVES`, `BAND_DESTINATIONS`, `NON_DRIVE`);
  `DueRoute.tsx(+css)`, `Editor.tsx(+css)`, `Reading.tsx(+css)` deleted; the only
  residual "Coming due" strings are two explanatory comments. `List.tsx:202-206`
  carries "NO KIND COLUMN". `capabilities.ts` keeps the `due` entry with a comment.
- **System: one scrolling overview, no tab strip** — `GatewayScreen.tsx:58`
  "ONE SCROLLING OVERVIEW, NO TAB STRIP"; the `tab === "overview" ? … : …` strip
  and its `setTab` buttons are deleted; `TabId` gains `restart`, `DrillId =
  Exclude<TabId, "overview">`, and drill-ins are routes via `onOpenTab`
  (`app-shell-context.ts` `tab?: … | "restart"`).
- **Mobile `docs`/`people` hold exactly one screen, a wall with a way out** —
  `ls apps/mobile/src/apps/docs` → `DocsHome.tsx` only; `…/people` → `PeopleHome.tsx`
  only. `DocsHome.tsx` renders `TopSafeArea` + `HomeKey variant="leave"` +
  `PlaceHeader title="Docs"` + `EmptyBlock`, with the "deliberately NOT
  `FeatureOffPlace`" note.
- **People blueprint keeps its contract** — `ls` shows `app.json`,
  `pending-projection.ts`, `actions/` (**28** files), `queries/` (**7** files),
  `seed.js` retained; only the render tree (`Chrome.tsx`, `components/*`,
  `format.ts`, `icons.ts`, `logic.ts`, `types.ts`) is deleted.
- **Mobile Docs is a plain root cover** — `navigation.ts` deletes
  `DocsStackParamList` and the generic `DocsScreenProps<T>`, sets `Docs: undefined`
  on `RootStackParamList`; `DocumentViewer.tsx` deleted; `deep-links.ts` replaces
  the `Docs: { screens: { … "docs/:documentId" } }` block with `Docs: "docs"`.
- **`handler-reachability.test.ts`** — `ExceptionKind` gains `"awaiting-handoff"`;
  `AWAITING_HANDOFF = { web: ["people"], mobile: ["docs", "people"] }` (per app per
  surface); a suspended surface is asserted **absent** (`webUnexpected()` searches
  the rendered tree for handler literals); the justification test does
  `expect(appIds.has(id), id).toBe(true)` against real manifest ids. `docs`/`people`
  rows deleted from `NATIVE_QUERY_UI`/`NATIVE_FALLBACK`; new `docs.action.edit`
  `agent-only` entry.
- **`docs/decisions.md`** — new dated section "Surfaces held back for a design
  handoff" with H-scope / H-wall / H-shape / H-gates / H-loss; **H-loss** names both
  accepted losses (People's untrusted-string rendering; the People phase of the
  mobile frame-drop scale flow).
- **`manifest.json` regenerated; no state doc claims a native Docs/People screen** —
  manifest drops `Chrome.tsx` and all `components/*` from the people entry;
  `ARCHITECTURE.md`, `docs/glossary.md`, `docs/mobile-offline.md`,
  `docs/blueprint-seats.md` are each amended, and a grep for lingering native
  Docs/People claims across `docs/*.md`, `ARCHITECTURE.md`, `README.md` returns
  nothing.

Also spot-checked the receipt's other gate claims and all held: `state-honesty.test.ts`
(People off all three lists), `placement-registry.test.ts` (native Docs assertions
deleted, not conditional), `untrusted-rendering.test.ts` (People renderer removed
with the loss commented; Docs renderer gained `selecting`/`owner`/`offline`),
`token-purity-allowlist.ts` (QuickLook entry gone, people entry kept),
`accessibility-contract.test.mjs` (DocsHome off the virtualization list),
`scroll-frames.mjs` (People phase excised, table row reads "NOT MEASURED"),
`copy-allowlist.json` (exactly 2 entries dropped, `maxEntries` 31 → 29),
`app-boot/people.test.ts` deleted.

### (3) The `## Checklist` mirrors the issue's checklist — PASS

All 11 acceptance criteria from `gh issue view 819` appear in the receipt's
`## Checklist`, in the same order, with no item added or dropped.

On the first pass four items carried trims. Two were substantive and have since
been restored, so the checklist now reads:

- AC 6 — "…each hold exactly one screen, and it is a wall with **the place's own
  frame** and a way out".
- AC 7 — "…keeps `app.json`, 28 actions, 7 queries, `pending-projection.ts`;
  **its render tree is gone**".

Two cosmetic trims remain and change no assertion: AC 1 drops ", not a copy" and
AC 3 drops "in `docs/design-divergences.md`" (the divergences file is named in
the crosswalk and in `## What changed` instead). AC 2, 4, 5, 8, 9, 10 and 11 are
verbatim or near-verbatim.

## PR #820 CI follow-up

The first `ci` run on `3529890` failed `static` (`@centraid/client` typecheck on
the new gateway-storage / inline-app-flow tests), `gates` (hygiene +1
`toBeTruthy` / +5 `toHaveBeenCalled*`), `design-gallery` (four Linux `sh-*`
shots past 1%), and `client-e2e / web-e2e` (Docs list button renamed to
`Select ${title}`; People journey still clicked `New` against the holdback
wall). Desktop e2e carries the same two journeys.

Files in this follow-up:

- `packages/client/src/react/shell/routes/gatewayStorageData.test.ts`
- `packages/client/src/react/shell/routes/inlineAppFlows.test.ts`
- `packages/client/src/react/screens/SettingsHarnessesScreen.test.tsx`
- `tests/hygiene-budgets.json` (`toBeTruthyFalsy` 379 → 378)
- `tests/design-gallery/baselines/sh-light.png`
- `tests/design-gallery/baselines/sh-c-light.png`
- `tests/design-gallery/baselines/sh-dark.png`
- `tests/design-gallery/baselines/sh-c-dark.png`
- `apps/web/tests/e2e/docs-drive.spec.ts`
- `apps/desktop/tests/e2e/docs-drive.spec.ts`
- `apps/web/tests/e2e/pending-overlay.spec.ts`
- `apps/desktop/tests/e2e/pending-overlay.spec.ts`
- `apps/desktop/tests/e2e/SCENARIOS.md`
- `tests/matrix.json` (`desktop-pending-overlay`, `web-pending-overlay` names)
