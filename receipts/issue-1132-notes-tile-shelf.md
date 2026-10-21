# Issue #1132 — Home's Notes tile is a shelf of notebooks

## What changed

- `mobile/shared/.../shell/HomeNotesTile.kt` (new): the tile reads `notes.library` and `notes.notebooks` through the app-query arm, in the device's zone, and folds them into a shelf — up to three notebooks that hold notes, in the member's order, each with its count, and the newest note's title at the foot; a vault with nothing filed draws its newest notes instead. The count is the library's (live notes, journal entries left out, `capped` when more exist). No notes is `EMPTY` with a stated zero. It imports nothing from `apps.notes` (`PerAppLayoutSpec`).
- `HomeReads.kt`, `HomeRuntime.kt`: Notes leaves the page reads; Home re-reads the tile on notes, notebooks and filing changes.
- `NotesRouting.tile`: a tile drawing its shelf opens the Notes place (`Destination.NotesLibrary`), an empty one a new note; `NotesTarget` is deleted. `Navigation.kt` and Android's `NotesRoutes.kt` follow.
- `SpringboardPolicy`: Notes is a small (half-width) tile, so the six smalls pair.
- `screen.proto` `TileBody.Notes`: `excerpt` (3) reserved, `notebooks` (5) and `recent` (6) added. The five Home screen contracts (`contracts/screens/home/*.textproto` and `.bin`) are regenerated.
- iOS `HomeView.swift` and Android `HomeScreen.kt` draw the shelf.
- Specs: `HomeNotesTileSpec` (new, 8 cases), and `AppRoutingSpec`, `ChangeStreamSpec`, `HomeMachineSpec`, `HomeReadsSpec`, `NotesAppSpec`, `ScreenQueryRuntimeSpec` updated.

## Verification

```sh
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home cargo xtask gate --profile mobile-jvm
```

Outcome: every step green (`:shared:jvmTest` with the new and updated specs, and the generated-tree diff check), but the run went over its 420 s budget while the machine was at a load average near 300 from three other sessions' builds. The gate is re-run on the combined branch before the PR.

iOS: built for the simulator with this change in the tree (the same build #1130's receipt records); the shelf itself was not checked on screen in this pass.

**Not verified:** the Android view is not compiled (no Android SDK here).
