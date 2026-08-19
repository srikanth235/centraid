# Docs on the phone — foundation notes (issue #821)

The mobile Docs foundation (shell, band, read layer, shelf screens) built to the Binding Layer v12 handoff, Part 2. This file is the handover record: what is dispatched (for the `AWAITING_HANDOFF` wall flip), what is withheld and why, what the sibling document-level agent must build, and the kit gaps.

## Dispatched actions and queries (for the wall flip)

Actions dispatched from this directory (`useDocsWrite` → `session.write("docs", …)`):

- `star`, `unstar` — row menu (DriveList), with Undo (the reverse write).
- `rename` — row menu's Rename… sheet, Undo = rename back.
- `move` — row menu's Move-to submenu (folder or top level), Undo = move back.
- `trash`, `restore` — row menu (a trashed row offers ONLY Restore), each the other's Undo.
- `create-folder` — Folders shelf's New folder composer.
- `rename-folder`, `delete-folder` — one folder's trailing-crumb place menu (FolderView). A delete refused while the folder holds documents surfaces the vault's own reason through `surfaceWriteOutcome`.

The document-level slice landed `upload`, `edit` and `restore-version` (see its own section below). Still UNdispatched: `replace`, `tag`, `untag`.

Queries: the phone dispatches NO named app queries. Reads are consent-shaped replica ENTITY reads (`useReplicaQuery("docs", { entity })`) over: `core.document`, `core.content_item`, `core.tag`, `core.concept`, `core.concept_scheme`, `blob.custody_state`, and (decoration, gracefully denied) `share.circle_grant`, `social.circle`, `social.circle_member`, `share.commons_member_state`, `core.party`. Title search runs through the replica's local FTS (`session.search("docs", { entity: "core.document" })`). The web `drive`/`search`/`history`/`activity` queries stay web-only; the `history`/`activity` reads have no phone-side source yet (see Withholdings).

## Withholdings — absences stated, never mocked

- **Coming due**: the `due` capability is a consent that is OFF with no runner (`blueprints/apps/docs/capabilities.ts` ships the model only), so there is no obligations source anywhere. `DocsDueView` renders the honest absent state — the capability's own record, "Each capability is a separate consent, and this one is off", and a route to `DocsCapabilities`. No obligation, date, or quoted passage is fabricated. The day a real staged- obligations read exists, this screen grows the tentative rows WITH their passages and confirm-or-drop.
- **Search contents**: the phone's replica indexes document TITLES only, so the field promises "Search titles" (the web `SEARCH_PLACEHOLDER` constant itself says mobile "owes a different sentence") and the could-not-look- inside count is the WHOLE active drive, said with the spec's own caption sentence (`captionFor(SEARCH, { searchUnreadable })`).
- **Starred photographs**: one star product-wide, but Docs' replica scope reads document tags only, so the Starred status counts documents and the spec sample's "6 photographs" clause is withheld.
- **Storage bytes**: no gateway storage read on this seat. `DocsStorage` shows custody-state COUNTS (replica facts) plus a "Not swept yet" row, and states that byte totals are withheld (`STORAGE_WITHHELD`).
- **People filter axis**: alive only when rows actually carry `shared_with` audiences. Share reads are decoration: any denial/failure ⇒ `shared_with: null` on every row (unknown, not "not shared") and the axis disappears (`filters.ts` `liveAxes` handles this by construction).
- **Versions / custody prose / counts**: nothing here fabricates a version chain, a backup timestamp, or a count. The `history`/`activity` queries are gateway-side; the sibling must either add a replica source for `core.link` revises edges (the scope IS granted — `core.link` replicates) or state the absence on DocumentVersions.

## What the sibling document-level agent should use

- **`useDocument(documentId)`** (useDocs.ts) — one document off the drive projection, plus honesty state. Reads are list-shaped on this seat; do not re-join entities per screen.
- **`useDocsWrite(navigation)`** — the one write door (parked → Approvals, queued sentence, refusal surfacing). `edit`/`replace`/`restore-version` should go through it; the editor's seven outcomes map onto `NativeWriteResult` plus its own unsaved/no-op bookkeeping.
- **`docRowState` / `purgeDaysLeft` / `bytesOnDevice` / `kindIconName` (docs-projection.ts)** — the row's one-state-slot ladder and kind glyphs; also right for the stage's meta and the facts panel.
- **`DocsScreen`** — wrap every document screen. Pass `hideBand` ONLY from `DocumentViewer` (the stage drops the band, deviation 2 — the shell was built with this opt-out so the stage needs no fork). Stage colors: `colors.stage` / `colors.onStage` / `colors.stageLine` from the theme, never literals.
- **`DocsShelfHeader`** — the back-row + title head (chevron + destination NAME, never "Back"). Return targets per the handoff: document screens go back to All.
- **`DocRow` / `DocGridTile`** — if Versions or Proposed filing need rows.
- **`buildDocMenu`** — extend rather than fork if the stage needs the same verbs; labels live in one place.
- **Copy**: shelf statuses in `docs-copy.ts`; per-document copy is `@centraid/blueprints/apps/docs/document-copy` (STAGE_ACTIONS, PRINT_REFUSALS, STAGE_PROPS, RAIL_NOTES) — all verified DOM-free.
- **`format.ts` (blueprints)** is RN-safe for the functions used here (`typeMeta`, `canRender`, `custodyMeta`, `fmtBytes`…). CAUTION: `decodeDataUri` uses `atob`, and `tintBg`/`fillVar` emit CSS `color-mix` strings — do not use those two on native.

## Kit gaps / frame notes

- **Band-claim roster**: `kit/band/band-owner.ts` `BAND_CLAIMING_APPS` lists only Photos, so frame Settings offers no "hand the band back" row for Docs. The latch itself works (`useBandOwner("docs")`, key `shell.bandOwner.docs`). Adding `{ id: "docs", name: "Docs" }` is a frame-side one-liner this slice may not make (kit is out of bounds).
- **Kind icons**: the shared registry has no dedicated document-kind set; the web app's own `KIND_ICONS` mapping (FileText/Image/Table/Music) is reused verbatim via `kindIconName`, so no new glyphs were inlined.
- **Star tint**: the spec's "teal identity text hue" has no lowered `cTealText` on native (only the fill rung `colors.cTeal`, which is what the row uses). If a text-rung teal lands in `@centraid/design/native`, swap it in `DocRow`.
- **Status line**: outcomes ride the frame's one `postStatus` line (mounted in App.tsx). Standing shelf statuses are rendered as the screen's own foot sentence (mono/faint), since a 6s-decaying global line cannot carry a standing fact.
- **Anchored menus from chips**: several chips share one `AnchoredMenu` host, so the card anchors to the press point (pageX/pageY) — the kit's `useMenuAnchor` ref can only bind one control.

## Document-level slice (sibling agent) — what landed on top

The eleven document screens (`DocumentRead`, `DocumentViewer`, `DocumentEditor`, `DocumentVersions`, `DocumentProperties`, `DocsCapabilities`, `ProposedFiling`, `DocumentNames`, `AddToDocs`, `BulkUpload`, `DocsScan`) plus their pure models (`document-read-model.ts`, `editor-outcome.ts`, `docs-versions.ts`) and hooks (`useVersionChain.ts`, `useDocumentText.ts`, `docs-export.ts`).

### Actions newly dispatched from this directory

- `upload` — AddToDocs' blank-document composer (an empty `data:text/markdown;charset=utf-8,` body — the vault mints empty bytes like any other), and as the settled follow-up of `backupDocument` (`lib/upload/media-producer.ts`) behind BulkUpload and the root Scan cover's Docs destination.
- `edit` — the editor, via raw `session.write` rather than `useDocsWrite`: the seven-outcome posture row IS the outcome surfacing, and a 6-second status line cannot carry a standing outcome. Byte-identical saves are compared BEFORE dispatch and never leave the device.
- `restore-version` — DocumentVersions, through `useDocsWrite`. No Undo: a restore is itself a new version; there is no reverse write.
- Still UNdispatched: `replace` (see withholdings), `tag`, `untag` (no per-document tag editor in this wave; tags render read-only on Properties).

### New replica reads

- `core.link` — the ONE new entity read (`useVersionChain.ts`): the scope is granted and replicates; the revises-edge walk (`docs-versions.ts`) mirrors `queries/history.ts` edge for edge, cycle guard included.
- Text bytes: inline `data:` bodies decode locally (`document-read-model.ts` `decodeTextDataUri` — RN-safe, no `atob`, because format.ts's own `decodeDataUri` is web-only per the caution above); blob-backed bytes fetch off the gateway's `/centraid/_gateway/blobs/{vault}/{content}` route with `authHeader()`, the same route Photos reads originals through.

### Withholdings — absences stated on screen, never mocked

- **Reading view's third clause** — the sample's "only you have opened this" is not printed: nothing in this product records an opening (the README names that boundary), so no surface may claim to know who has. Status is `Version N · edited <ago>` with N from the real chain, and the version clause absent when the chain is unknown.
- **Versions' who/what column** — `you` / `Docs` / `a machine` is a `consent.provenance` fact this replica does not carry. The chain, dates, kinds and sizes are real; the actor column is absent with `VERSIONS_WHO_WITHHELD` under the list. A denied/failed `core.link` read renders `VERSIONS_ABSENT`, never an empty fabricated history. No diff is drawn anywhere — this seat cannot render a real one.
- **Properties' backup time** — "backed up Sunday 21:40" is the gateway's record; no read exists here, so `PROPERTIES_BACKUP_WITHHELD` states it and the status line is derived from the custody fact alone (`custodyStatusLine`).
- **Capabilities' switches** — flipping a consent has no backend (`capabilityOn` reads nothing because nothing exists to read), so NO switch is drawn; `CAPABILITY_SWITCH_WITHHELD` says why, each row reads the shared `DCAPS` record, and the status interpolates the real on-count (zero).
- **ProposedFiling / DocumentNames** — the two capability products render their honest empty states (capability record + route to the consent), with `0 proposals` / `0 links` statuses. No sample proposals, people or passages.
- **PDF on the stage** — this phone has no PDF renderer, so the stage never draws a mocked page: it states the fact with the document's size and custody beside it; Download/Open-elsewhere hands the real file to an app that reads the kind. Images and audio/video render for real (expo-image / expo-video, Photos' own machinery).
- **Scan's "lands as one PDF"** — not promised (`SCAN_PDF_WITHHELD`): multi-page-PDF assembly has no machinery on this seat.
- **`replace`** — withheld this wave: the honest phone door for "a new file becomes the next version" needs the staged-bytes queue wired to a per-document intent (`backupDocument` mints a NEW document via `upload`, not a revision). Building it as a base64 `data_uri` replace would cap it at small files and fork the byte path; the day the durable queue grows a `replace` follow-up, the facts panel and the stage grow the door.

### Choices worth knowing

- **The read fork** is `readSurfaceFor` (pure, tested): text → reading view; renderable media → `navigation.replace` to the stage; the rest → facts panel. One route, exactly as navigation.ts promises.
- **Viewer stepping** — the route carries only `documentId` (navigation.ts is out of bounds), so prev/next step through the active drive in its default changed-newest order via `setParams`; the stage's foot says `N of M in All`.
- **Editor adaptations** — the spec's "Show it in Notifications" points at the phone's real surface: `Show it in Approvals`; "Open the receipt" opens the version history, which is where this seat can actually show the committed chain. The parked/queued/refused distinctions are the spec's, verbatim, with "Ana" genericized to "the owner" (`editor-outcome.ts`, all seven postures unit-tested).
- **BulkUpload** — expo-document-picker (multiple) + the product's one durable queue (`backupDocument`), serial (the drain lock single-files transfers anyway). Rows carry state words, not percentages — the producer reports settlement, not bytes, and a bar nobody fills would be a fabrication. Failures keep their row + Retry; the foot prints the spec's `X of Y landed · Z did not · nothing was discarded` with real counts.
- **DocsScan hands off to the root Scan cover** (`src/screens/Scan.tsx`): it already owns the camera permission, the per-device OCR consent gate (#712 C3) and the `docs` upload producer. A second camera flow inside Docs would be a duplicate to keep honest; the Docs screen states what a scan IS here and opens the cover.
- **Open elsewhere / Download** (`docs-export.ts`) — stages the exact stored bytes in the cache (inline text written directly, blobs downloaded with auth) and hands them to `expo-sharing`. Nothing is converted. The Photos share-call-site invariant is Photos-scoped; a document export carries no place-phrase concern.

## Expected red while the wall stands

`packages/blueprints/src/handler-reachability.test.ts` lists `docs` under `AWAITING_HANDOFF.mobile`; it fails once these action names appear in this directory. EXPECTED — root flips the wall at ship. Do not edit that test from this slice.
