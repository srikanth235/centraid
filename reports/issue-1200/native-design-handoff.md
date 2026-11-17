# Native redesign handoff — #1200

Root accepted the representative light/dark direction after reviewing DocsIndex, FirstHome, HomeWidgets, People, Person and PersonEditor. The records and Photos artwork on these boards are illustrative; runtime data and real media remain the core's. This is source translation guidance, not a claim of completed shell verification.

## Shared visual rules

Use the existing generated roles: card radius 16, page margin 18, coarse targets 44, local Instrument Sans. App roots use kit title 34; detail bars use the native inline title; content uses section 20, row 16, meta 13, group 12 and badge 11. The existing native display role is 27 and can strengthen Home's vault name without clipping or preventing large-text reflow. The accepted Home invitation glyph block is recorded as `[native.geometry] homeInvitationGlyphSize = 36`, lowering to `CentraidGeometry.homeInvitationGlyphSize` on iOS and `CentraidGeometry.HOME_INVITATION_GLYPH_SIZE` on Android. No palette, type or radius values change.

Paper content has no cast shadow. App identity belongs to glyph blocks, dates, counts and content markers; state red/amber/green continues to mean actual state. Cards use `Surface.card`, lists `Surface.plainPage`, secondary words `Surface.meta`. Use generated `AppAccent.fill` beneath a white glyph and `AppAccent.text` for identity on paper. Selected choice chips use neutral fill/ink. Floating chrome remains platform-native: iOS glass, Android solid tonal plates.

## Exact source translation

| Area | iOS | Android | Accepted behavior and appearance |
| --- | --- | --- | --- |
| Home grid | `Sources/HomeWidgets.swift`: `WidgetCard`, `WidgetBody`, invitation/glance/agenda/reminders/`PhotoWidget` | `screens/HomeWidgets.kt`: corresponding composables | Empty invitations form an open catalogue: saturated app glyph block, ink name, existing empty copy, no enclosing tinted/bordered card. Populated widgets use white paper and exact radius16, stronger current date/count, real Photos cells with opaque ink caption. Remove radius multipliers and the paused blanket app-tint surface. |
| Vault lockup | `Sources/VaultHeader.swift` | `kit/VaultHeader.kt` | Preserve the actual active-vault initial, hue, name and picker semantics. Never substitute the company logo. Backup status is a separate target of at least44, with search/settings/current appearance controls remaining separate and reachable. |
| Paper/type/glyphs | `Sources/Kit/Surface.swift`, `AppAccent.swift` | `kit/Surface.kt`, `AppAccent.kt` | Reuse `KitTile`, generated type/surfaces and card16. No view-local palette. Bordered cards retain a real border role, not a barely visible tint edge. |
| Directory/form rows | `Sources/Kit/Rows.swift` | `kit/Rows.kt` | Plain directories use flowing rows, grouped hairlines, app-tinted avatars and existing metadata. Avoid an individual bordered card around every person. Field groups remain one paper surface. |
| Room frame | `Sources/Kit/Rooms.swift`, `KitHeader.swift`, `StatusLineView.swift`, `Sheets.swift` | `kit/Rooms.kt`, `Rows.kt`, `Sheets.kt` | Native title/back/actions, full content scroll, one status dock, existing search/band/selection. No content/header title duplication. Detail has one More menu retaining existing Edit and all actions. Editor is full-screen autosave; Done closes and Saved remains in its status host. |
| Read state | `Sources/Kit/ReadStates.swift` | `kit/ReadState.kt` | Existing skeleton/empty/failed/denied/pending distinctions, actions and selectors remain. Empty glyph takes app identity; no local aggregate empty state. |
| Representative People | `Sources/People/{PeopleHomeView,PeoplePersonView,PeopleEditorView}.swift` | `screens/people/{PeopleHomeScreen,PeoplePersonScreen,PeopleEditorScreen}.kt` | Translate reviewed directory, inline detail, complete scroll depth and full-screen editor through shared kit primitives. Preserve phone-origin/conflict lines, attachments, linked records, Earlier versions, provenance, Trash and Undo. |

Paths above are relative to `mobile/iosApp/` and `mobile/androidApp/src/main/kotlin/dev/centraid/android/` respectively.

## Seven rooms, all nine apps

- HomeRoom keeps runtime vault lockup, all nine destinations, shell band and status. `HomeData.gridRows`, tile size/height/order/route/accessibility label remain Rust-supplied. Do not infer an all-empty page or repack/reorder tiles in the view. Natural text reflow may enlarge measured rows; fixed mockup geometry is not new runtime policy.
- AppPlace keeps top-row app title, scope beneath it, funnel/creation keys and current app band. Apply shared paper/type/glyph language across Calendar, Reminders, People, Notes, Docs, Photos, Money, Health and Locker, preserving every place and current depth.
- PushedPage uses native inline title/back and one trailing action. Keep content scrollable, with status outside its scroll region.
- EditorRoom remains full-screen autosave, no band; Done closes, status stays inside the room. Do not turn editors into modal sheets.
- SheetRoom remains native platform sheet, row groups and at most one ink action. iOS26 uses the system sheet ground; Android retains its native modal bottom sheet.
- SystemPlace keeps its existing section/row hierarchy, Home band at roots and named back at children. Apply shared typography and surfaces without adding brand decoration to state.
- StageRoom keeps actual full-bleed media and its floating controls/close gesture. The ordinary Photos viewer remains a light pushed page; only slideshow is a stage.

Review every root with populated and empty data, loading/refused/pending where supplied; include Locker locked/unlocked, Photos absent/present media, search open/closed, detail/editor, light/dark and largest text. Keep all selectors, actions, native controls, reduced-motion/transparency/high-contrast behavior and real state semantics. No hard-coded board sample data, new routes, new creation promises or unverified rearrangement hint.

Root owns build scheduling and final visual/functional evidence. Source implementers do not run generators or native builds independently.
