package dev.centraid.android.a11y

import androidx.compose.runtime.Composable
import centraid.core.v1.EmptyState
import centraid.core.v1.HomeBackupLine
import centraid.core.v1.HomeBar
import centraid.core.v1.HomeData
import centraid.core.v1.HomeSpringboard
import centraid.core.v1.HomeState
import centraid.core.v1.HomeTile
import centraid.core.v1.HomeTileSize
import centraid.core.v1.HomeTileStatus
import centraid.core.v1.HomeTone
import centraid.core.v1.HomeVault
import centraid.core.v1.HomeVaultState
import centraid.core.v1.LockerBandTab
import centraid.core.v1.LockerHomeChrome
import centraid.core.v1.LockerHomeState
import centraid.core.v1.LockerWall
import centraid.core.v1.NotesBandTab
import centraid.core.v1.NotesHomeChrome
import centraid.core.v1.NotesHomeState
import centraid.core.v1.NotesLibraryData
import centraid.core.v1.NotesLibrarySection
import centraid.core.v1.NotesMoreRow
import centraid.core.v1.NotesNoteRow
import centraid.core.v1.NotesPlace
import centraid.core.v1.NotesSectionHead
import centraid.core.v1.NotesSheet
import centraid.core.v1.NotesSearchState
import centraid.core.v1.PageState
import centraid.core.v1.PairLaptopState
import centraid.core.v1.Route
import centraid.core.v1.ShellBand
import centraid.core.v1.ShellBandTab
import dev.centraid.android.screens.HomeScreen
import dev.centraid.android.screens.notes.NotesHomeScreen
import dev.centraid.android.screens.locker.LockerHomeScreen
import dev.centraid.android.screens.pairing.PairLaptopPage

/** One screen of the suite: where it is, what it draws, and the words a reader should meet in order (if the flow is checked). */
internal class Scene(val id: String, val app: String, val content: @Composable () -> Unit)

private fun route(screen: String) = Route(screen = screen)

/** Every root, and every root's main sheet, from representative wire state (what Rust sends, filled in by hand). */
internal object Scenes {
    val shellBand = ShellBand(
        tabs = listOf(
            ShellBandTab(tab = "home", label = "Home", spoken = "Home", icon_key = "Home", selected = true),
            ShellBandTab(tab = "chat", label = "Chat", spoken = "Chat", icon_key = "Chat"),
            ShellBandTab(tab = "backup", label = "Backup", spoken = "Backup", icon_key = "Backup"),
        ),
    )

    private val apps = listOf(
        "calendar" to "Calendar", "reminders" to "Reminders", "photos" to "Photos", "money" to "Money",
        "health" to "Health", "people" to "People", "locker" to "Locker", "notes" to "Notes", "docs" to "Docs",
    )

    val home = HomeState(
        bar = HomeBar(
            vault = HomeVault(vault_id = "v1", name = "Home vault", state = HomeVaultState.HOME_VAULT_STATE_ONLINE, initial = "H"),
            backup = HomeBackupLine(status = "Backed up today", tone = HomeTone.HOME_TONE_QUIET, route = route("backup.home")),
            search_route = route("home.search"),
            settings_route = route("settings"),
        ),
        data_ = HomeData(
            springboard = HomeSpringboard.HOME_SPRINGBOARD_CONTENT,
            tiles = apps.map { (id, name) ->
                HomeTile(
                    app_id = id, name = name, status = HomeTileStatus.HOME_TILE_STATUS_EMPTY,
                    size = HomeTileSize.HOME_TILE_SIZE_SMALL, empty_copy = "Nothing here yet", route = route("$id.home"),
                    count_label = "0 items",
                )
            },
        ),
        scheme = centraid.core.v1.HomeScheme.HOME_SCHEME_LIGHT,
        page = PageState(),
    ).labelled()

    val notes = NotesHomeState(
        place = NotesPlace.NOTES_PLACE_NOTES,
        title = "Notes",
        band = listOf(
            NotesBandTab(key = "notes", label = "Notes", icon_key = "Notes", current = true),
            NotesBandTab(key = "notebooks", label = "Notebooks", icon_key = "Folder"),
            NotesBandTab(key = "journal", label = "Journal", icon_key = "Book"),
        ),
        chrome = NotesHomeChrome(),
        library = NotesLibraryData(
            count_label = "3 notes",
            sections = listOf(
                NotesLibrarySection(
                    head = NotesSectionHead(title = "Recent", count = 3),
                    rows = listOf(
                        NotesNoteRow(note_id = "n1", title = "Groceries", snippet = "Milk, eggs, bread", meta = "Edited today", route = route("notes.editor")),
                        NotesNoteRow(note_id = "n2", title = "Trip plan", snippet = "Book the train", meta = "Edited yesterday", pinned = true, route = route("notes.editor")),
                        NotesNoteRow(note_id = "n3", title = "Ideas", snippet = "A garden shed", meta = "Edited 3 March", route = route("notes.editor")),
                    ),
                ),
            ),
        ),
        search = NotesSearchState(),
        new_note = route("notes.editor"),
        page = PageState(),
    ).labelled()

    val notesMore = notes.copy(
        sheet = NotesSheet.NOTES_SHEET_MORE,
        more_rows = listOf(
            NotesMoreRow(key = "trash", label = "Trash", icon_key = "Trash", route = route("trash"), meta = "2 notes"),
            NotesMoreRow(key = "export", label = "Export", icon_key = "Export", route = route("transfer")),
        ),
    ).labelled()

    val pairWaiting = PairLaptopState(
        phase = PairLaptopState.Phase.PHASE_WAITING,
        title = "Pair a laptop",
        body = "Run this on the laptop, then scan or paste the code.",
        command = "centraid-gateway pair",
        scan_label = "Scan the code",
        payload_label = "Pairing code",
        primary_label = "Pair",
        primary_enabled = true,
        secondary_label = "Cancel",
    ).labelled()

    val lockerWall = LockerHomeState(
        wall = LockerWall(phase = LockerWall.Phase.PHASE_LOCKED, title = "Locker is locked", body = "Unlock with your fingerprint.", unlock_label = "Unlock", unlock_icon = "Lock", words_label = "Use the 24 words"),
        chrome = LockerHomeChrome(title = "Locker"),
        band = listOf(
            LockerBandTab(key = "items", label = "Items", icon_key = "Lock", current = true),
            LockerBandTab(key = "review", label = "Review", icon_key = "Check"),
        ),
        band_locked = true,
        page = PageState(),
    ).labelled()

    val all: List<Scene> = listOf(
        Scene("home", "home") { HomeScreen(home, shellBand, {}, {}, {}) },
        Scene("notes", "notes") { NotesHomeScreen(notes, {}, {}, {}) },
        Scene("notes.more", "notes") { NotesHomeScreen(notesMore, {}, {}, {}) },
        Scene("pair.laptop", "backup") { PairLaptopPage(pairWaiting, {}, {}) },
        Scene("locker.wall", "locker") { LockerHomeScreen(lockerWall, {}, {}, {}, {}, {}) },
    ) + ScenesApps.all
}
