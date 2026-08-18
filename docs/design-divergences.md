# Design divergences — Docs, People and Photos

This is the shared register of sanctioned per-app divergences from the design briefs. It exists so a reviewer does not "fix" an honest withholding or a deliberate copy/control choice. Change a row here only when the current decision changes; implementation history belongs in the linked issue and receipt.

## Docs — parity state and sanctioned withholdings

Docs is aligned to the v9 design system: the flat `NavKind` is a shelf model, the app bar and compact band are frame contributions, and copy/state rules live in pure tables. This section records what the shipped app draws and what it refuses to draw because it cannot read the fact behind it.

If a change would alter one of these rows, update the current decision and its contract/test together; do not silently change a component.

Related: [the Photos section below](#photos--sanctioned-design-divergences), [DESIGN.md](../DESIGN.md) (the binding rulebook), [design machinery](design-machinery.md) (lowering ownership), [blueprint seats](blueprint-seats.md) (what a seat may read), and [glossary](glossary.md).

### Current surface

- **The shelf model.** `apps/docs/shelves.ts`: `DSHELVES` (All · Folders · Recently changed · Starred · Trash), the off-strip destinations (Search, Storage, Add, Scan, What Docs may read), one folder as a sub-state of Folders, and the `docs` / `docs/<sub>` route round trip. The structure is shared with Photos (`apps/_shared/shelves.ts`) so the two routes inside one frame cannot drift.
- **The frame contribution.** `apps/docs/frame.tsx`: the app bar's title/count/primary verb per shelf, the band claim (All · Folders · Search · More), and the one status line. The shape is shared with Photos (`apps/_shared/app-frame.tsx`).
- **The state rules.** `apps/docs/view-state.ts` over `apps/_shared/view-state-kit.ts`: nothing is empty until a read has landed; a shelf is never silently swapped (a gone folder falls back to **Folders** and says so); offline is read, never invented.
- **The copy tables.** `view-copy.ts` / `drive-copy.ts` / `document-copy.ts`: shelf titles and units, captions, the five empty variants (only the first-run drive takes a display serif), the row state slot's at-most-one-mark ladder, the More sheet's rows, the offline banner and the action status line.
- **The drive family**: breadcrumb, filter row, row/grid bodies, the loading window, the trash ask panel, the reading route, the editor's write outcomes, and the one-rail-three-tabs details with the versions route.
- **The place is named once.** The app bar carries the shelf's title and count (`frame.tsx`) and the breadcrumb carries the trail; the drive draws no display-serif page title of its own. The reading register still leads where a document is the screen — the reading view and the first-run empty state.
- **The Folders shelf** is the navigation model; there is no folder-tree rail or sidebar `SmartNav`. It opens with the drive's own block sequence — breadcrumb (carrying the place menu) → set → caption — and draws its rows from the drive's ACTUAL stylesheets (`Chrome.module.css` `.listwrap`/`.listHead`, `List.module.css` `.row`/`.badge`/`.rowMain`/`.rowTitle`/`.cell`/`.rowEnd`, `DriveRoute.module.css` `.caption`), not from a lookalike re-authored per screen. Its two column heads sort, because the drive's heads are its sort control and a head that looked identical and did nothing would move the divergence one layer down. What is local to `FoldersRoute.module.css` is only the two column widths and the one row that is not a folder.
  - **The place menu lives in `drive-copy.ts`, not in a route.** It was defined inside `DriveRoute.tsx` while the drive was the only screen opening with a crumb row; the moment Folders opened with one it had to be moved rather than copied. At a desk it is the ONLY door to the seven off-strip destinations, and standing on Folders used to shut all seven.
  - **No prose on a folder row.** Unfiled printed _"N never put anywhere. Not an error, and not a folder"_ in the cell where every other row prints a number — a sentence on a row (§4.1 forbids it) and a column meaning two things depending on which row you read. The number stayed; the sentence is in the caption (`foldersCaption`).
  - **Unfiled wears no glyph**, where a folder wears `I.folder`. The mark would contradict the caption's own sentence one line below.
  - **`List`/`Grid` works here**, so `showsViewToggle` no longer delegates to `showsDrive`. That delegation answered the narrower question — "does this paint the _document_ row set" — and it was the wrong one: a folder row has a name, a count and a way in, so both arrangements say something true about it, and a strip that offered the pair on four tabs and withdrew it on the fifth changed the furniture under the member for a reason only the code knew. The card is the drive's own (`Grid.module.css`); what differs is the preview, and only because a folder has no bytes to show — it takes the **app's identity hue**, never one of the six `--kind-*` colours, since a folder is not a file kind. `FOLDER_ICON_LG` is deliberately outside `KIND_ICONS_LG` for the same reason.
  - **Unfiled is a card that does not open**: no overlay, no folder mark, an empty preview. Same rule as its row.
  - **The folder mark keeps the drive's own box.** This file briefly released the badge's height, on the reading that a 34px target beside one 19px line was what held the folder row open at 67px. It was not: `List.module.css` `.row` was spending `--density-pad` on its vertical rhythm, and both screens were 67px for the same reason (see _A row is a height, not a padding_ below). The row rung fixed it in one place, so a folder's mark and a document's mark are the same square in the same column again.

### A row is a height, not a padding

`List.module.css` `.row` read `padding: var(--density-pad) 14px`, and the comment above it said the vertical rhythm came off the density tier rather than a hardcoded pixel. It did not. **`--density-pad` is the tier's CONTENT pad** — the inset a panel puts around what it holds — and `--density-row` is the tier's row rung, which is what a row reads. Spent as a row's vertical padding it added 32px above and below a 34px mark and set every record in the drive to **67px**, with the head band at 41px behind it.

The handoff's own doc row is `min-height:40px` with `padding:0 12px` and no vertical pad anywhere (`docRowsBlock`), and its head band is a flat `height:32px`. Docs now reads `min-height: var(--density-row)` (44px at comfortable) with `padding: 0 14px`, and the band is 32px. A drive is a set you scan: at 67px a laptop showed nine records where the same window now shows fifteen, and the set's own box came down from 577px to 386px for the same eight documents.

Two things this is NOT:

- **Not a per-screen fix.** Folders draws its rows from this same rule, so it came along without a line of its own — which is the whole reason that shelf was moved onto the drive's stylesheets. A local override on either screen would have left the other one loose.
- **Not the handoff's literal 40.** The rung is 44, the tier's `row` value, because the number a row reads is the token and not a measurement taken off a prototype. The handoff's own metrics table says the same (`density.comfortable.row = 44`); its 40 is a hand-written literal in one block.

The **compact form factor keeps a pad**, `min-height: 52px` and 8px block, because there the three trailing columns fold into a snippet line under the title and the row is genuinely two lines. Same split the handoff makes, and for the same reason: the height is set by what the row holds, not by the surface.

Tasks and Notes already read `--density-row` for their rows. Docs' list was the one list in the app answering the density tier with the wrong token.

### The screens the shelf model names

Every destination in `shelves.ts` is now drawn. On the compact form factor they are reached through the band's More sheet; at a desk they are reached through the **breadcrumb's trailing menu** (`components/DriveRoute.tsx` `PLACE_MENU`) — the strip holds six tabs and is not growing to fourteen, so that menu is the pointer surface's only door and every entry in it goes somewhere.

| Screen | Where | What it can and cannot say |
| --- | --- | --- |
| **`capabilities`** — four consents | `components/CapabilitiesRoute.tsx` | States each capability's offer in full — what it reads, where it runs, what leaves the device, what it writes beside the document, how to undo it — and draws the consent moment before it is asked. `capabilityOn` still answers **off** (no consent record to read) and nothing runs behind it, so each `Turn on` is present and unpressable with the reason. Four other surfaces say "switched off"; this is the destination they were pointing at. |
| **`filing`** / **`names`** | `components/BoundaryRoute.tsx` | The two capability-gated shelves, each stating its own offer and its own refusal. |
| **`locker`** — the boundary | `components/BoundaryRoute.tsx` | Where a document ends and a credential begins. Has no live state by definition — it is a statement about what Docs will never do. |
| **`newdoc`** — the ways in | `components/NewDocRoute.tsx` | Upload and New folder fire; drag, paste and drag-out are described with the surfaces they exist on, because "this works at your desk" is useful to know from a phone. The bar's per-shelf verb (`primaryLabel` + `onPrimary`) is the fast path. |
| **`scan`** | `components/ScanRoute.tsx` | Says plainly that this seat cannot drive a camera, then names the three doors a scan does arrive through. Not a dead end. |
| **`storage`** | `components/StorageRoute.tsx` | Counts the total and the on-this-device-only split from facts the drive already reads (`custody_state`). The gateway figure, the backup figure and "what could be released" need the blob custody rollup this projection does not read, so each says **not counted yet** rather than zero — §4.5's own rule. |
| **`readonly`** — the placed-in-a-space panel | `components/SeatStates.tsx` | Driven by the scope's own `canWrite` (`_shared/scope-kit.ts`), read and never inferred from a failed write. Stated once above the route rather than discovered one refusing button at a time. |
| **`permission`** — the denial | `components/SeatStates.tsx` panel + `Chrome.tsx` banner with `VaultAccessButton` | The panel says what is true (every document still in the vault), what Docs can see (nothing), and that an open unsaved edit is still on this device. The banner keeps the direct way to the grant that `src/state-honesty.test.ts` asserts. |
| **`bulk`** — the upload queue | `components/UploadQueue.tsx`, `AppState.uploadQueue` | Per file, with each failure naming its own rule. Four states rather than a percentage: this path stages a whole file then commits it, so a determinate bar would be a fraction nobody measured. A clean run clears itself; a run with a refusal stays until dismissed, because it is the only account of which file did not land. |

**Still withheld, and why:**

| Withheld | Why |
| --- | --- |
| **`behind`** — "this device is N hours behind the library" | Needs the replica's lag (`this copy → 09:12` / `the library → last change 12:04`). An inline app cannot read it, and a panel asserting a lag it had not measured is exactly the untrue-copy bug the state rules exist to close. |
| **`picker`** — Docs answering another app | Not a Docs gap: the host contract (`apps/inline-types.ts`) has no invocation channel, so no app can ask Docs for a document and no member could reach this screen. It lands with that protocol, not before. |
| The stage's **page filmstrip** and **zoom chip** | Both step through the pages of one document. A PDF renders in an `<iframe>` that owns its own paging and zoom and exposes neither, so a second set of controls over it could not drive it — two controls for one job, one of them fake. |
| **`due`** — the Coming due shelf | Removed outright, not withheld. It was a whole destination — a strip tab, a band tab, a route and a panel — whose only content was the sentence "the capability behind this is switched off". A place a member can go to and be told nothing is there is worse than no place: it spends a tab, a route and a screen to say what the `capabilities` screen already says in one row, beside the three other consents. **The `due` capability itself survives** (`capabilities.ts`): what it writes is an Agenda event, and Agenda owns that record — Docs lost a second window onto somebody else's data, not the offer. |
| The More sheet's **Kind and sort** | §1.5's own "two menus" — it would restate the column heads and the filter pills. |
| The row set's **Kind column** | The filename already ends in it and the leading-edge mark already draws it. See below. |
| **Any order control on the compact form factor** | The toolbar row that carried a cycling sort button is deleted (below), and the heads and their `≡` menu are pointer-only. The compact surface opens on `changed`, newest first, and cannot currently be reordered. This is a gap, not a principle: the order belongs in the More sheet or the place menu, and lands with whichever the compact band work reaches first. |
| **The tag axis** | `AppState.tag` and its predicate survive in `logic.ts`, but the chip rail that set them went with the toolbar row and nothing else writes it. Tags belong with the other filters — a pill in `components/FilterRow.tsx` beside Type, Modified and Source — not in a second filtering row of their own. |

**The row set is the handoff's less one head:** Name · Owner · Size · Changed, with the named-orders menu in the head's trailing cell.

- **No Kind column** — the one head removed from the handoff's `docRowsBlock` set. The kind is on the row twice before that cell is reached: the glyph at the leading edge, and the extension the member typed at the end of the title. `Lease agreement.pdf` followed by `PDF` is the filename read back, and 96px is a wide thing to spend saying it — nearly a fifth of the row's trailing width on a laptop, taken from the Name column, which is the one column with something to say. The FACT is not gone: the mark carries it at a glance, the Type pill filters on it, and **Kind survives as a named order** in the `≡` menu (`SORT_OPTIONS`) with its comparator in `logic.ts` — a set ordered by kind reads as a run of like marks down the leading edge, which is how the grouping is seen anyway. It goes from the compact fold-in line for the same reason, and there it counts double: the title it would repeat is on the line directly above.

- **The heads ARE the sort control** (`components/List.tsx` `ListHead`). Pressing one sorts by it; pressing the active one reverses it; the arrow rides the active column. The drive opens on `changed`, newest first — `updated_at`, the date the row prints, so the order can never disagree with the column it claims to be sorting. The toolbar button that read "Date ↓" three regions above the columns it ordered is gone entirely; nothing states the order except the column that holds it.
- **The `≡` menu names both directions** of the one order that has two useful ones (`drive-copy.ts` `SORT_OPTIONS`). It is not a second sort control: every entry resolves to a (key, direction) pair the heads also produce, and the active one carries a dot, so the menu reports the state as well as setting it.
- **Owner prints `you` on every row, and that is the true answer here.** The drive query projects one vault and reads no per-document owner, so every document in the set is the member's own. The column, its disc, its head and its comparator are in place for the day a shared space puts somebody else's documents in the same set; until then the comparator is a deliberate no-op rather than a head that cannot be pressed.
- **Selection is a MODE**, entered by the app bar's `Select` and left by `Done`, which clears what was ticked (`AppState.selecting`). Leaving a shelf leaves the mode. The verb is contributed only where a row set exists — Folders lists labels, not documents, so it does not carry it.

**The People filter axis is lit on one half of itself, and that split is the sharpest example of the rule.** §4.2 names four filter properties; `apps/docs/filters.ts` ships four axes, and the People one offers only what the rows can answer.

- **Shared-with is live and DERIVED FROM THE ROWS** ([#821](https://github.com/srikanth235/centraid/issues/821)). The drive projection carries `shared_with`, so `liveOptions(axis, rows)` mints one `Shared with <label>` option per audience the set actually names, alphabetically, and the axis disappears when nothing is shared. The options are **not listed in `drive-copy.ts`**: the audiences are the owner's own circles and change with the vault, so a fixed list would be pills matching whatever this vault happens to lack. `DFILTERS`' people row therefore carries `options: []` with `live: true`, which is not a contradiction — it is the axis saying its options come from somewhere else.
- **Owned-by and Names stay dark, and are no longer offered as option strings at all.** This drive projects one vault, so "Owned by you" would select every row; nothing reads the people a document mentions. Both were previously carried as dormant fixture strings in `DFILTERS`; those are deleted, because a copy table holding options no predicate can compute is a list waiting to be rendered by accident.

`liveOptions()` still renders no pill whose predicate cannot be computed, "because a pill that silently matches nothing is worse than a pill that is not there: the member reads the empty result as a fact about their drive." A row whose `shared_with` is `null` — the share reads were denied — contributes no option and matches none: unknown is not a share, and it is not the absence of one either.

**`shared_with` is the one projection column with a three-valued reading**, and every consumer honours it: `[]` means read and shared with nobody, `null` means the share reads were denied, and the two must never collapse into each other. Every surface below draws nothing on `null` rather than drawing an emptiness.

**The details rail gains a `Shared with` fact, between Owner and Folder** (`components/DetailsTabs.tsx`, `document-copy.ts` `SHARED_WITH_KEY` / `sharedWithNote`). It sits there because it answers the same question Owner does — who can reach this — and before Folder, which answers where it sits. The row is **absent, never negative**: a document nobody has shared says nothing, and so does one whose share reads were denied, because "Not shared" would be the rail asserting the one fact a wrong answer costs the most. When the grant names a folder above the document rather than the document itself, the note says `through <folder>` — a member who shared a folder did not share this document, and a rail that said they did would send them hunting for a share they never made. Members who have not accepted yet are counted (`n waiting to accept`) rather than silently included in the audience.

**A row-level `shared` mark was considered and rejected.** The row state slot's ladder (`view-copy.ts`) is **consequence-only** — it says what is happening TO a document that a member may need to act on (trashed with a countdown, a failed decode, bytes not here). A share is a standing fact about a document, not a consequence, and putting it in that slot would either displace a countdown or need a second slot beside it, which is the two-marks-per-row ambiguity the at-most-one ladder exists to forbid. The fact is carried instead by the details rail's `Shared with` row and by the People filter axis.

### Compact band ownership

The web frame honours a first-party app's compact band claim whenever the surface is compact. There is no per-app grid-icon hand-back control: the app's shelves remain reachable instead of silently switching to a different host launcher. `InlineFrame` carries the contribution, while the frame owns the decision to ignore it on desktop or for non-first-party apps.

**The strip stands down only where the band stood up.** Docs reads two signals and needs both: `compact`, the shell's form factor (`InlineAppProps`, the same signal the frame gates the band on), and `narrow`, its own pane under 860px. `narrow` alone had dropped the strip on a pane the shell did not consider compact — no strip, no band, six shelves reachable from nowhere. A layout signal may remove a navigation only where it knows the replacement rendered.

### Search is a shelf, and the topbar is gone

Docs took Photos as its base here. `photos/Chrome.tsx` retired "the in-pane search field — search is a SHELF now"; Docs has done the same, and the row that held the field went with it.

- **The way in is the app bar**, beside `Select` — `frame.tsx`'s `SearchBarButton`, the same control Photos contributes, dropped on the compact form factor where the band carries its own Search tab. Both land on the `SEARCH` shelf.
- **The field is the shelf's first block** (`components/SearchField.tsx`), which is where the handoff's docs `search` scene puts it (`fieldBlock('right of way', 'Search titles and contents', true)` — 34px, capped at 520px, with an underlined `Clear` beside it). It is not chrome, so it is not drawn above the shelves that are not searches.
- **The four states are the shared ones** (`_shared/SearchScaffold.tsx`, the module Photos renders): resting with the handoff's five literal example chips, a determinate `searching` line, the miss, and `unreachable`. `state.searchStatus` is READ from what the round trip did — a throw used to fall through to an empty result set, which made "the gateway could not be asked" and "nothing matches" the same sentence on screen.
- **One handoff sentence is deliberately not copied.** Its miss body ends "One letter short of a phrase in two of your documents"; that is a near-miss claim needing an edit-distance pass nobody runs, so it is dropped and the rest kept verbatim.
- **The query does not follow the member off the shelf.** `currentRows` answers with flat FTS matches whenever `state.search` is set, on whatever shelf is open, so leaving Search clears it — when the field was chrome this could not happen, because the member could always see the query they had left behind.
- **The Search shelf is not the drive with a field on top.** `onDrive` excludes it while resting, so the bar does not count the whole library as results and the view toggle does not offer to arrange rows that are not there.

**The topbar row is replaced by the handoff's toolbar row.** `kit-app-topbar` was a 66px band with a border-bottom — a header, carrying a title and count the frame's app bar already says. What the handoff draws above the shelf strip is `barRow`: `min-height: C.h` (34px), controls only, no rule. It carries the grid/list pair at its trailing edge, and it **renders only when it carries something** — Photos' own rule (`toolbarCarriesSomething`), since an empty band is chrome.

The pair itself is `components/ViewToggle.tsx`, and it follows the handoff literally on two points our previous control got wrong:

- **Words, not icons.** `densBtns: [['list','List'],['grid','Grid']]` — "List" and "Grid" at `--section` (`--t-small-strong`). Two glyph squares are a convention a member has to already know.
- **The segmented shape, not `.kit-seg`.** `.kit-seg` is the settings-form control (2.1rem segments inside 0.2rem of padding, ~40px overall), taller than the row it sits in. The track is the system's own `segTrack`/`segItem` recipe, which is also what `photos/components/Toolbar.module.css` `.stepper`/`.rung` uses: `--bg-sunken` track at `--h-control`, items at `--h-segmented`, and the held one RAISED onto `--bg-elev` with `--line-sel` — a surface and a hairline, never a fill.

### The row's kind mark

The handoff draws a **line glyph per kind** at the leading edge of a document row (`docRowsBlock`'s `paths: DXI[k.icon]`), on no ground, and colours every one of them in the app's own hue (`hueText('teal')`) rather than a colour per kind. Docs drew a tinted square with `DOC` / `PDF` / `XLS` stamped in it — a filename extension in a badge, repeating the Kind column that then stood two fields to the right (that column is gone as well now — see above).

- Four glyphs cover the kinds (`icons.ts` `KIND_ICONS`, keyed off `typeMeta`'s `glyph`): page, picture, table, plays. `FileText` and `Table` were added to the shared registry for it — `Archive` is a box and `Grid` is four detached squares, and neither reads as a document or a sheet at 18px.
- **`--c-teal-text`, not `--accent-text`.** The shell's accent on this host is the neutral ink, which painted the glyphs white; the solved hue rung is what the handoff means and what clears contrast on paper.
- **A KIND mark, for every kind, with no exception for pictures — a step past the handoff.** The row, the card and the rail each used to fork: a real thumbnail where the bytes were an image or a video poster, the kind's glyph everywhere else. The handoff forks the same way in the grid (`docGridBlock` tones the preview for `img`). We do not, on the drive's own instruction: a leading edge that is a column of ink marks with photographs cut into it stops reading as a column of marks, and a grid whose tiles are half frames and half glyphs reads as two grids. The document itself is one double click away on the stage, at the size a picture is worth looking at.
- **So the mark has no ground at all in a row** (`.badge` is `background: none`, no radius). The tint was the other branch's — it kept a pale photograph from reading as a hole. `--kind-*` still tints the card and hero grounds, where a colour has room to mean something.
- **Every surface now wears the same mark.** The grid card's thumb and the details rail's hero were the last two places `DOC` / `PDF` / `XLS` survived; they draw `KIND_ICONS_LG` (the same four shapes at 30/1.35) in `--c-teal-text`. A drive that says "page" one way in a list and another way in a grid is two drives.
- **Four shapes across eight kinds is the handoff's own arithmetic**, not a simplification of it: `DKIND` gives `pdf`, `md`, `txt` and `word` the same page glyph and `sheet`/`deck` the same table, keeping a distinct mark only for a picture and for time-based media. The exact format is what the filename's extension says, at the end of the title on the same line.
- **The kind is resolved from the media type FIRST and the filename second** (`format.ts` `KIND_BY_EXTENSION`). Not belt-and-braces: an Office file is a ZIP container, so a gateway that types bytes by sniffing them stores `application/octet-stream` for every `.xlsx`, `.docx` and `.pptx` — and the drive called them all "File" and drew the page glyph on each, which is exactly the sameness a per-kind mark exists to break. A stored type is what the vault knows; an extension is what the member typed, and it only ever answers a question the type left open.

### One shape per verb, everywhere

`icons.ts` carries four glyph tables — `MENU_ICONS` (15/1.6), `ACTION_ICONS` (15/1.7), `BULK_ICONS` (16/1.7), `PLACE_ICONS` (15/1.6) and `STAGE_ICONS` (18/1.75). **They differ only in size, which is a fact about the region, never about the verb**: `move` is a folder in the row menu, the selection bar, the details rail and the place menu alike. A glyph that means one thing in a menu and another in a drawer teaches nothing the second time it is seen.

The row menu, the selection bar and the stage carried glyphs from the start; the details rail, the trash row, the version list, the upload queue, the folder editors, the offline banner and the empty states carried **bare words**, so the same verb looked like two different things depending on which region a member met it in, and those regions could only be scanned by reading them. `Shared.tsx` `ActionBtn` is now the one component for a glyphed `kit-btn`, taking the mark from `ACTION_ICONS` **by verb name**.

- **A glyph goes on verbs, not on everything.** `Done`, `Close` and a tab take none: a mark beside every word is the same as a mark beside none, because nothing stands out. The selection bar's `Done` already followed this rule — leaving a selection undoes the thing that raised the bar, it is not one of the five verbs.
- **The word and its shape live together in the copy table.** `EmptyCopy.actionIcon` / `action2Icon` (`view-copy.ts`) and `Act.icon` (`Blocks.tsx`) carry the glyph next to the label, rather than a component matching a display string — a copy edit would otherwise silently drop the mark.
- **The details rail's star lost its `★` character.** It drew a filled/hollow star glyph beside the word while every other verb in that rail drew nothing. It now takes the same line star as the row menu, the bar and the stage; whether it is on is `aria-pressed` and the word, which is where a state belongs.
- **`Act.icon` is optional**, because those panels also carry verbs that are CONSENTS ("Turn it on") rather than actions on a document, and there is no honest shape for those in a table keyed by what the drive does to a file.

### The place menu is a menu, not a list of seven words

The trailing crumb's `⌄` used to open seven bare labels in one undifferentiated column. It now draws like the row menu it sits beside — **every row with its glyph** (`PLACE_ICONS`, at the row menu's own 15/1.6, so the app's two popovers draw at one weight) and **rules between the groups**, because the seven are three answers to three different questions: how do I put something in (Add, Scan) · what is this drive costing me (Storage) · what may this app read (the four boundary screens). The grouping is data on `PLACE_MENU` (`drive-copy.ts` `PlaceMenuItem.group`), not markup in the component.

### Selection is a gesture, not a mode

The handoff is explicit, on `dtapRow`: _"A single click SELECTS and raises the action bar; a double click opens. Drive's behaviour, and the reason the bar can be a bar rather than a mode you enter."_

- **The row body picks; the name still opens.** One click anywhere on a row or card selects it; a double click opens. The title button keeps its single-click open, which is the handoff's own row (its `openCss` column carries `open: dopenRow` while the box carries `pick: dtapRow`), so the two gestures never compete: the words open the document, the space around them picks it. The grid card has no "space around the name" — the card _is_ the name — so its whole surface picks, exactly as the handoff wires `open: dtapRow` there.
- **The boxes appear once something is picked** (`showBox: !!sel`), never before. `Select` survives in the app bar as the announced, keyboard-reachable way in; what neither route does any more is stand an empty box on every row of a drive nobody is selecting on.

### The selection bar and the row menu

**The selection bar lives in the toolbar row, not in a region of its own.** The handoff's toolbar is one slot with two mutually exclusive states — `barNormal: !sel, selOn: !!sel` — so picking something SWAPS what that row carries: the List/Grid pair while nothing is picked, the count and the verbs while something is. Docs drew it instead as a floating accent pill below the shelf strip, which put two bars on screen at once, left the drive's own arrangement controls sitting above a row that had taken the drive over, and pushed every shelf down by a bar's height the moment a member clicked a row. `ChromeSlots.bulkBar` and `Chrome.module.css` `.bulk` are gone; `slots.toolbar` takes `bulkBar ?? viewToggle`, and the row stamps `data-selecting` so its `aria-label` follows what it is currently for rather than always saying "View".

The count is set in the handoff's own two rungs — the **number** in `--t-title` with tabular figures, the word "selected" in `--t-body` at the soft ink (`selCountStyle` / `selCountLabelStyle`). One mono rung for the whole phrase read as a status line rather than as the thing that had just happened, which is the work the pill used to be doing.

Both bars carry the handoff's glyphs (`icons.ts` `BULK_ICONS` / `MENU_ICONS`). `Info`, `Tag` and `OpenExternal` were added to the shared registry for it.

The bar draws `selDefs` — Star / Move / Download / Trash, swapping to Restore in trash — as outlined buttons, **glyph always, label when the pane is wide enough**, which is the handoff's `labelCss: selLabels ? '' : 'display:none'` with the word moved into `title`. The labels are visually hidden rather than `display: none`, so what a screen reader announces does not change with the width of the pane. Every button is an outline, Trash included: a destructive verb takes the danger ink and the arm-then-confirm gesture, never a fill.

Four of the handoff's entries are **withheld because they would be dead ends**:

| Withheld | Where | Why |
| --- | --- | --- |
| `Tag` | selection bar | No bulk tag flow exists. `Details` tags one document at a time (`Tags.tsx`). |
| `Download`, on a multi-selection | selection bar | A browser downloads one file per gesture. The button stands down above one pick rather than fetching the first row and calling it "the download". |
| `Place in a space` | row menu | Docs shares **folders** (`ShareSheet`); a per-document placement has no flow behind it. |
| `Delete forever` | row menu, in trash | The platform has no destroy verb (`frame.tsx` `NO_PRIMARY`) — destruction happens only on the schedule a purge date announces. |

`Star` on a mixed selection **adds** rather than toggling per row: one press of one button has to mean one thing, and a per-row toggle would leave a mixed set exactly as mixed as it found it. The label reads the selection (`selectionAllStarred`), so the word and the write cannot disagree.

### Deleted from the chrome, and why

Three controls the handoff does not draw are gone from `Chrome.tsx`:

- **The toolbar row** (tag chips + compact sort button). It restated what the screen says better elsewhere — the filter pills narrow the set, the column heads order it — and it was the last occupant of the row whose display-serif title had already been deleted for restating the app bar. Consequences are in the withheld table above.
- **The hamburger.** It opened `.side`, which this seat renders `display: none` at every width ("navigation belongs to the host stem"), so it had been a control that did nothing since the strip took over the shelves. Verified in the browser: the drawer's computed display is `none` before and after the press.
- **The inline Ask button** (`data-ask-mount`, and the `kitAsk` descriptor that filled it). The shell carries its own Ask in the corner of the same window; two entry points to one assistant, one of them inside the app's own topbar, is the duplication §1.5 rejects.

**The frame's settings gear is gone from every inline app**, not just Docs (`routes/InlineAppRoute.tsx`). Photos had already opted out — "owns its toolbar and follows the handoff without the generic shell settings sheet" — and every bundled app now draws its bar to a handoff that has no frame control in it, so the frame contributes nothing to the bar at all. **What the gear opened has no other door**: rename, delete, reveal-in-folder, per-app automations, the enrichment settings link and the appearance knobs are unreachable until one is designed. `AppSettingsController.tsx` and `inlineAppFlows.ts` are kept unmounted for that; `appSettingsData.ts` still runs, because knob values are pushed to the inline root on mount whether or not anything can edit them.

`components/Toolbar.tsx` is deleted with the row. The **topbar** row went too, with search (see above). **`components/Sidebar.tsx` is now unreachable, and was already** — folder rename / share / delete and the storage footprint live there behind a `display: none`, and only the footprint has another home (the `storage` route). Those folder verbs need a door before they can be said to exist.

### The stage

`components/QuickLook.tsx` (+ `QuickLookStage`, `QuickLookInfo`, `QuickLookText`) is §7's `docsStage` — the product's one theater ground, Docs' second tenant after the Photos lightbox, and **the only viewer Docs has**. Opening a row of any kind lands here.

- **The shared stage roles, not a private near-black.** `--stage` / `--on-stage` / `--on-stage-soft` / `--stage-line` / `--stage-sunken`, which are the handoff's own `{bg:'#0B0B0B', ink:'#EDEDEC', line:'#2A2A29', sunken:'#1A1A19'}` exactly. This file used to mix `hsl(var(--app-hue) 25% 4%)` with `--text-inv` and a dozen `color-mix()` rungs — one app's fork of a surface the product already owns.
- **Geometry from the Photos lightbox**, because both stand on the same ground: 56px bar, 34px close at the leading edge, heading over a mono meta line, non-flexing spacer, outlined `--h-control` actions, 44px nav circles inset 12px, a 320px trailing panel, a 32px status line, and a 56px bottom bar on the phone.
- **The action set is described once and laid out twice** (`acts` / `bottomActs`): Star · Download · Print · Place… · Properties in the bar; Place… · Star · Properties · Download · Trash in the phone's bottom row.
- **Text renders on paper ON the stage.** §1.8's rule is about the SHEET — "text renders on paper, capped at a 34em measure" — and `QuickLookText` keeps it literally: `--bg` paper, the reading register, a `--stage-line` edge so the sheet reads as a sheet against near-black.

**§6.1's reading ROUTE is deleted** (`components/Reading.tsx`, `Reading.module.css`, `state.readingId`, `nav.openReading`/`closeReading`, and `document-copy.ts`'s `READ_OFF` / `THIS_DOCUMENT` / `MACHINE_SUMMARY_EYEBROW`). Opening a text document used to leave the drive for a screen of its own, which made text the one kind a member could not step through with the arrows, could not see the properties of without going somewhere else, and had to back out of rather than close. Its verbs were never only there: Version history and Details are on the row menu and the rail; the capability panel is the `capabilities` route.

**Withheld from §7, and why:**

| Withheld | Why |
| --- | --- |
| The page filmstrip, the zoom chip | Both walk the PAGES of one document. Neither this seat nor the frame a PDF renders in exposes a page model — the browser's own viewer owns paging and zoom inside that frame, and a second set of controls over it could not drive it. |
| `Who this document names`, `Where it is` (properties) | No read on this seat returns the people a document mentions. Since [#821](https://github.com/srikanth235/centraid/issues/821) the drive projection DOES carry the shares a document sits inside, and that fact is drawn — in the details rail's `Shared with` row (above), which is the one place it lands. The stage's own `Where it is` stays withheld: it is a second window onto the same fact in a viewer that already has a properties panel two clicks from the rail, and the stage has no folder read to pair it with. |
| `A refused write` (properties) | The stage has no write that can be refused. |
| `Versions`, `Contents` (facts) | The drive row carries no version count and no read date; a panel that guessed at either would be inventing provenance. |
| `Keep this on my device` (status action) | There is no fetch-the-original verb on this seat to put behind it. |

**Print is real, and its refusals are on the control.** Docs prints what Docs lays out: a picture on a sheet, and text in the reading register (`print.ts`, into an own-origin `about:blank` frame built with DOM calls, never an HTML string). A PDF is laid out by the browser's own viewer, which carries its own print control; sound and moving pictures have no sheet. Both say so via `title` on a disabled button (§6) rather than firing and apologising. The picture's src is **passed in** from the element the stage is already showing — off the gateway origin that is an authorized `blob:` URL, and the print sheet is a different document outside the shell's watch.

### Two platform fixes the stage forced

Both were pre-existing and both made the viewer paint a blank white rectangle off the gateway origin:

- **`inline-blob-images.ts` now authorizes `iframe` / `video` / `audio`, not only `<img>` and CSS backgrounds.** Those were every blob surface the photos grid had; they are not every blob surface the product has. Un-authorized, a relative `/centraid/_vault/blobs/<id>` reference resolves to the SPA's own index.html.
- **`frame-src` admits `blob:`** (`serve/web-ui-server.ts`), and the PDF frame **drops `sandbox`**. A sandboxed frame cannot instantiate a plugin document, and the browser's PDF viewer is one — `sandbox=""` did not harden the preview, it silently replaced it. What bounds the frame is the CONTENT TYPE: the branch runs only when `media_type` is `application/pdf`, the bytes arrive carrying that same value, and the browser never sniffs a typed PDF back into HTML. The CSP token is the same trust `img-src`, `media-src` and `object-src` already place in identical URLs.

### No in-place editing, for any kind

`components/Editor.tsx`, `Editor.module.css`, `state.editingId`, `nav.openEditor`/`closeEditor`, `versions.ts`'s `editDocument`, the rail's `Edit` button and §6.3's seven-outcome table (`DSAVE`) are **deleted**. Docs holds, versions and files a document; it does not open one to type into.

A new version still arrives — as a whole **file**, through `Replace file…`, which is the same staged-bytes door an upload comes through and feeds the same version chain History reads. One write path instead of two. Renaming a document is untouched: a title is metadata, not the file, and the stage's properties panel edits it in place on the handoff's dashed rule.

### Deferred follow-up tiers

Mobile priorities are the details sheet (custody/folder/tags/facts), tags/filing, and search snippets.

### Binding cut-scope — do NOT build

The current scope has no folder-tree rail, standalone Activity screen, duplicates shelf, or **destroy verb**. The platform destroys only on the schedule a purge date announces, so Trash has no "Empty trash" primary (`frame.tsx` `NO_PRIMARY`). Recent means recently _changed_; the product does not record when a document was opened.

### Known duplication left in place

- **The drive's write outcomes do not use the frame's status line.** `logic.ts` narrates trash / restore / rename / move through the kit's own `statusLine()` DOM host, while save-to-my-vault and share decisions go through `publishOutcome` to the frame's one line. Photos routes _everything_ through one sink (`apps/photos/outcomes.ts` → `setStatusSink` → `publishOutcome`). Docs wants the same module; `view-copy.ts` `actionStatus()` already carries the copy for it.
- **`components/ShelfStrip.tsx` and `components/MoreSheet.tsx` are near-duplicates of Photos'.** They were left per-app deliberately: their CSS modules genuinely diverge (the mono-numeric token trio and the `.tabCount` Photos has no counts for; Docs' `meta`/`footer` rows against Photos' bare `count`; and the strip's inline padding, where Docs insets by `calc(--content-margin - --sp-3)` so the first tab's LABEL lands on the margin the rows below align to, while Photos still insets by the margin itself and pushes its first label 12px right of everything under it), and the repo's shared-component pattern is one shared component with one shared CSS module (`apps/_shared/SearchScaffold.tsx`). Merging them changes rendered output on one surface or the other and needs the gallery baselines regenerated — a separate PR, not a drive-by.

## People — v12 parity state and sanctioned withholdings

People is rebuilt to the Binding Layer **v12** handoff ([#821](https://github.com/srikanth235/centraid/issues/821)) on the inline desktop/web surface, and — wave 3 of the same issue — natively on the phone (`apps/mobile/src/apps/people/`, the holdback closed out in [decisions.md](decisions.md#surfaces-held-back-for-a-design-handoff)). One row recipe and one section recipe draw every screen on each seat (`apps/people/components/Shared.tsx` + `shared.module.css` on web; `PeopleKit.tsx` on the phone); nothing below introduces a token. Everything in this section binds BOTH seats unless a row names one; the phone-only rows are at the end.

**The vault link is now drawn, from real rows** ([#821](https://github.com/srikanth235/centraid/issues/821) wave 2). The contract was amended rather than worked around: the link ceremony writes `share_party_vault_binding` at approval and at ticket redemption, People holds **read** on `share.party_vault_binding`, `share.circle_grant`, `share.commons_member_state`, `share.commons_invitation` and `social.circle_member`, and the queries carry `linked` / `vault_count` per roster row, `vaults` / `pending_invites` / `shared_with_them` per person, and `linked` / `to_link` on the dashboard counts. So the avatar link ring (solid where linked, dashed where not, drawing **nothing** on `unknown`), the `Linked` / `Unlinked` chips, the `Linked · role` sub-line, the person screen's `Vaults` and `Shared with them` sections, the `Vaults · To link · Reconnect · Upcoming` tiles and the vault-counting status lines are all present. The rulings behind that amendment are [decisions.md § People, links and the sharing plane](decisions.md#people-links-and-the-sharing-plane-821).

**Every share read degrades to ABSENT, never to empty.** People's `share.*` scopes may be parked on an existing vault, so each read answers `null` on denial and each surface then draws nothing rather than a zero: the two link chips are removed from the rail (`filterChips(linksAvailable)`), the tiles fall back to the wave-1 `People · Reconnect · Upcoming · Starred` set, the roster's sub-line is the role again, and the two person sections are absent. "Nobody is linked" and "we cannot see" are different sentences, and only one of them is ever true at a time.

**Still withheld, and why.** What remains is a WRITE-side set, and it has one cause: a share is always a share **of a container**, and People owns none.

| Withheld | Handoff site | Why |
| --- | --- | --- |
| The `Share` and `Link vault` commits, and the Share sheet from People | person screen, §6 | `window.centraid.share` structurally requires a container — the host contract types `containerType` + `containerId`, and `_shared/ShareSheet.tsx` refuses to send without `itemType`/`itemIds`. People holds no container of its own, so the control could only open a sheet that cannot send. **The link is SHOWN everywhere; it cannot yet be MADE from here.** `Log` stays the primary commit, `Edit` the secondary. |
| The roster row's trailing `Link` verb | roster rows | Same cause, one row down. |
| `Revoke` on a vault row or a shared item, and the handoff's third modal confirm | person screen | People's `share.*` scopes are all `read` — nothing in `app.json` grants it a write on the sharing plane — and `VaultLinksStore.revoke` has no production route behind it either. A `Revoke` would name an act this app cannot perform, twice over. Two modal confirms remain: Trash and Merge. |

**Excluded by the handoff itself, and kept unrendered**: lists, journal, tasks, gifts, debts, typed relationships, edit history. The queries return this data and the handlers stay agent-reachable (named `WEB_EXCEPTIONS` in `src/handler-reachability.test.ts`); the handoff bans placeholders for them and none are drawn.

**Departures inside the drawn set:**

- **The `Never` cadence chip is RESTORED, because the contract now holds it.** `cadence_days` floors at 0 in the vault schema (`CHECK (cadence_days >= 0)`) and both `add-person` and `set-cadence` type it with a minimum of 0, so the chip writes the number it names and a person on zero is simply never overdue. The chips are the handoff's own `Never · 7 · 14 · 30 · 90`, and such a person reads `No cadence · last <ago>`. This supersedes the previous row here, which withheld the chip on the grounds that a minimum of 1 made "never" unrepresentable — the fix was to widen the contract, not to write a stand-in number.
- **Overdue is `daysSince − cadence ≥ 0`**, the dashboard query's own arithmetic, not the handoff's strict `>` — the roster and Touch must not disagree by one day, every day. Cadence 0 is excluded from Reconnect outright rather than being caught by that `≥`.
- **Overdue meta is NOT gated on `linked`.** The handoff shows the reconnect meta only on a linked row. Hiding overdue for the unlinked would hide the app's whole point — most people a member tracks will never have a vault — so the meta follows the cadence, and only the link facts follow the link.
- **The `Vaults` tile counts LINKED PEOPLE**, which is the same number as live bindings: the sharing plane keeps at most one live binding per party (a standing binding wins any conflict, and a superseded one carries `revoked_at`). Counting people is the reading a member can check by eye against the roster.
- **`Starred` yields its tile to `To link`** whenever the link counts are readable. Four tiles is the handoff's cap, `To link` is the one that asks for something, and the star already has its own chip on the roster; nothing is lost, one press moves.
- **The search screen draws no link facts at all.** Its query returns none, and decorating results with facts the browse rows carry but the search rows do not would make the same person read two different ways on two screens.

**Undo is offered only where a true reverse write exists** — star↔unstar, trash→restore, edit-person back, set-cadence back. The handoff's "every non-destructive act reports with Undo" assumes a prototype whose undo is a state patch; over a real contract, an act with no reverse write (log a touch, add a note or date, toggle a reminder, remove a channel, merge) reports its outcome on the status line and stops. A fake Undo that could not restore the row is the defect this register exists to prevent.

**Phone-only rows (Part 1 on touch, #821 wave 3).** The withheld write-side set above applies unchanged — same controls, same one cause — plus:

- **The vault-link screen is reachable only by deep link.** The two doors the handoff gives `PersonLink` (the roster `Link` verb, the person screen's `Link vault` commit) are the withheld writes, so the screen renders the link standing read-only with no door drawn to it. The two ceremony sentences ("One approval each, once…") are withheld with the composer they narrate — drawn without it they promise an act no control performs.
- **No ambient status sentences.** The mobile frame's one `StatusLine` is quiet until an outcome is posted; there is no standing-sentence slot, so the per-screen `STATUS.*` sentences are not drawn and the search count renders as the search screen's own closing line. Write outcomes + Undo all ride `postStatus`.
- **Search is a client-side substring over the replica window** (name + role + party notes), not vault FTS — no People search shape exists in the native replica session. The handoff's own stated scope is "case-insensitive substring", so nothing narrows; the matched note rides as the snippet. If a People FTS shape lands, `searchRoster` swaps for `session.search`.
- **The phone reads replica entities, not named queries** — `people-model.ts` re-states the web query emitters' joins projection-for-projection (each names the `queries/*.ts` file it mirrors), trash rows read `purge_at` off the same profile entity, and the dashboard's Recent join is bounded to the roster window exactly as the web's is. `NATIVE_QUERY_UI` in `handler-reachability.test.ts` records this reading.
- **The avatar hue round-trips the web's stored spelling** (`storedHueValue`): one vault value, resolved through the native theme's own hue rungs — never a parsed CSS expression.

## Docs on the phone — v12 Part 2 parity state and sanctioned withholdings

Docs is rebuilt natively on the phone to the handoff's Part 2 ([#821](https://github.com/srikanth235/centraid/issues/821) wave 3; `apps/mobile/src/apps/docs/`), the second holdback closed out. The claimed band carries the invariant's exact cap — `All · Folders · Coming due · Search · More`, More a sheet — the stage drops the band (the shell's one opt-out), and the document row keeps ONE state slot with the fixed precedence (cannot render → trash countdown → on the gateway only → custody mark), unit-tested. Every withheld fact below is stated on its own screen, never mocked; the causes live in `INTEGRATION-NOTES.md` beside the code and the actions the phone defers to the assistant are named `NATIVE_FALLBACK` rows (`tag`, `untag`, `replace`, the `activity` query).

| Withheld | Handoff site | Why |
| --- | --- | --- |
| Coming due's obligations, dates and quoted passages | §4 | The `due` capability is a consent that is OFF with no runner behind it — there is no staged-obligations source anywhere, and a date without its passage is the guess the handoff itself refuses. The screen states the consent's own record and routes to Capabilities. |
| Searching inside contents; the honest could-not-read count | §5 | The phone's replica indexes titles only, so the field promises what it searches and the could-not-look-inside count is the whole active drive, in the spec's own caption sentence. |
| The editor's `Show it in Notifications`; `Open the receipt` | §9 | The phone's real surfaces are Approvals and the version history; the postures say so. Queued ≠ waiting-for-approval survives intact off the replica's own outcome union, and a byte-identical save is compared BEFORE dispatch so a no-op writes nothing. |
| Versions' who-column; any diff | §10 | The version chain is real (the replica's `core.link` revises edges, cycle-guarded); the author of each rung is provenance the replica does not carry, and no diff renderer exists — so neither is drawn. A denied link read renders the absence, not an empty history. |
| Properties' backup timestamp; `only you have opened this` | §§6, 11 | No backup fact reaches this seat, and nothing records an opening — the second is the handoff's own boundary ("what I read is more sensitive than what I changed"). |
| Capability switches; Proposed filing and named-people rows | §12 | Four consents are described verbatim, all Off — but no consent record exists on this seat to write, so a switch would be a control naming nothing. The two capability-product screens render their honest zero-count empties. |
| Starred photographs in the Starred count | More sheet | One star product-wide, but Docs' replica scope reads document tags only; the count says documents. |
| Storage byte totals | Storage | No gateway storage read on this seat; custody-state counts are replica facts and are what the screen shows. |
| Scan's `lands as one PDF` | §14 | No multi-page-PDF assembly exists; `DocsScan` hands off to the frame's one Scan cover (camera + OCR consent + the docs upload producer) rather than promising a second, imaginary pipeline. |
| PDF pages on the stage | §8 | No PDF renderer exists on this seat; images, audio and video render for real (expo-image/expo-video) and a PDF gets the cannot-open-here state with its facts. |
| The People filter axis, when share facts are unreadable | §1 | Share reads are decoration with graceful denial — `shared_with: null` means UNKNOWN, so the axis disappears rather than reading "not shared". Same absent-never-empty doctrine as People's. |

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
