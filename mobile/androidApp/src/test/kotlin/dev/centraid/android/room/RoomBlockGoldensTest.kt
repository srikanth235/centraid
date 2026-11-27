package dev.centraid.android.room

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import centraid.core.v1.Room
import centraid.core.v1.RoomAction
import centraid.core.v1.RoomAttachments
import centraid.core.v1.RoomAutosave
import centraid.core.v1.RoomAutosavePhase
import centraid.core.v1.RoomBack
import centraid.core.v1.RoomBand
import centraid.core.v1.RoomBlock
import centraid.core.v1.RoomCalendarGrid
import centraid.core.v1.RoomChart
import centraid.core.v1.RoomCheck
import centraid.core.v1.RoomCheckState
import centraid.core.v1.RoomChip
import centraid.core.v1.RoomChoice
import centraid.core.v1.RoomChoiceStyle
import centraid.core.v1.RoomConfirm
import centraid.core.v1.RoomConfirmClass
import centraid.core.v1.RoomEarlierVersions
import centraid.core.v1.RoomEmpty
import centraid.core.v1.RoomExplicitSave
import centraid.core.v1.RoomFact
import centraid.core.v1.RoomFactKind
import centraid.core.v1.RoomFacts
import centraid.core.v1.RoomField
import centraid.core.v1.RoomFigure
import centraid.core.v1.RoomFilterMenu
import centraid.core.v1.RoomForm
import centraid.core.v1.RoomGlance
import centraid.core.v1.RoomGlyph
import centraid.core.v1.RoomHeader
import centraid.core.v1.RoomHero
import centraid.core.v1.RoomKey
import centraid.core.v1.RoomKeyRole
import centraid.core.v1.RoomKind
import centraid.core.v1.RoomLinkSpan
import centraid.core.v1.RoomLinked
import centraid.core.v1.RoomMark
import centraid.core.v1.RoomMedia
import centraid.core.v1.RoomMediaKind
import centraid.core.v1.RoomMentionedIn
import centraid.core.v1.RoomMenu
import centraid.core.v1.RoomMenuItem
import centraid.core.v1.RoomMenuSection
import centraid.core.v1.RoomNoteEditor
import centraid.core.v1.RoomOption
import centraid.core.v1.RoomOrigin
import centraid.core.v1.RoomPhotoGrid
import centraid.core.v1.RoomProgress
import centraid.core.v1.RoomProse
import centraid.core.v1.RoomReady
import centraid.core.v1.RoomRow
import centraid.core.v1.RoomSays
import centraid.core.v1.RoomSaysField
import centraid.core.v1.RoomSaysSource
import centraid.core.v1.RoomSearch
import centraid.core.v1.RoomSection
import centraid.core.v1.RoomSelection
import centraid.core.v1.RoomStatusLine
import centraid.core.v1.RoomTab
import centraid.core.v1.RoomText
import centraid.core.v1.RoomTextKind
import centraid.core.v1.RoomTile
import centraid.core.v1.RoomTiles
import centraid.core.v1.RoomToggle
import centraid.core.v1.RoomTone
import centraid.core.v1.RoomTrash
import centraid.core.v1.RoomTrashRow
import centraid.core.v1.RoomWall
import com.github.takahirom.roborazzi.captureRoboImage
import dev.centraid.android.kit.Surface
import dev.centraid.android.theme.CentraidTheme
import java.io.File
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w390dp-h844dp-xxhdpi")
class RoomBlockGoldensTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private var dark by mutableStateOf(false)
    private var generation by mutableIntStateOf(0)
    private var body by mutableStateOf<@Composable () -> Unit>({})

    private fun mountHost() {
        rule.setContent {
            CentraidTheme(dark = dark) {
                androidx.compose.runtime.key(generation) { body() }
            }
        }
    }

    private fun captureBlock(name: String, isDark: Boolean = false, content: @Composable () -> Unit) {
        rule.runOnIdle {
            dark = isDark
            generation += 1
            body = {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .background(Surface.page)
                        .padding(vertical = 8.dp)
                        .testTag("golden-root"),
                ) {
                    content()
                }
            }
        }
        rule.waitForIdle()
        val path = "$BLOCK_GOLDENS_DIR/$name.png"
        File(path).parentFile?.mkdirs()
        rule.onNodeWithTag("golden-root").captureRoboImage(filePath = path)
    }

    private fun captureScreen(name: String, isDark: Boolean = false, content: @Composable () -> Unit) {
        rule.runOnIdle {
            dark = isDark
            generation += 1
            body = content
        }
        rule.waitForIdle()
        val path = "$SCREEN_RENDERS_DIR/$name.png"
        File(path).parentFile?.mkdirs()
        rule.onRoot().captureRoboImage(filePath = path)
    }

    @Test
    fun allBlocksAndSlotsMatchGoldens() {
        mountHost()

        captureBlock("hero_person") {
            RoomBlockView(
                RoomBlock(
                    hero = RoomHero(
                        title = "Ada Lovelace",
                        noun = "Friend · London",
                        mark = RoomMark(glyph = RoomGlyph(icon = "User")),
                        lines = listOf("Every 14 days · last touch 12 days ago"),
                        chips = listOf(RoomChip(label = "Starred", tone = RoomTone.ROOM_TONE_ACCENT)),
                        primary = RoomAction(selector_id = "hero/catchup", label = "Log catch-up", enabled = true),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("section_rows") {
            RoomBlockView(
                RoomBlock(
                    section = RoomSection(
                        selector_id = "section/notes",
                        heading = "Pinned",
                        count_label = "2",
                        trailing = RoomAction(selector_id = "section/all", label = "Show all", enabled = true),
                        blocks = listOf(
                            RoomBlock(row = RoomRow(selector_id = "row/1", title = "Packing list", meta = "Edited today", trailing = "4")),
                            RoomBlock(row = RoomRow(selector_id = "row/2", title = "Lease notes", meta = "Edited 2 days ago")),
                        ),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("row_default") {
            RoomBlockView(
                RoomBlock(
                    row = RoomRow(
                        selector_id = "row/txn",
                        title = "Groceries",
                        meta = "Today · Everyday",
                        trailing = "$42.50",
                        trailing_tone = RoomTone.ROOM_TONE_NET,
                        chips = listOf(RoomChip(label = "Pending", tone = RoomTone.ROOM_TONE_WARNING)),
                        mark = RoomMark(glyph = RoomGlyph(icon = "CreditCard")),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("row_check_states") {
            Column {
                listOf(
                    RoomCheckState.ROOM_CHECK_STATE_OFF to "Buy milk",
                    RoomCheckState.ROOM_CHECK_STATE_ON to "Renew passport",
                    RoomCheckState.ROOM_CHECK_STATE_MIXED to "Skipped errand",
                    RoomCheckState.ROOM_CHECK_STATE_PARTIAL to "Draft report",
                ).forEachIndexed { idx, (state, title) ->
                    RoomRowBlock(
                        RoomRow(
                            selector_id = "row/check/$idx",
                            title = title,
                            mark = RoomMark(check = RoomCheck(selector_id = "check/$idx", state = state)),
                            dimmed = state == RoomCheckState.ROOM_CHECK_STATE_ON,
                        ),
                        onTap = {},
                        hairline = idx < 3,
                    )
                }
            }
        }

        captureBlock("facts_contact_and_sealed") {
            RoomBlockView(
                RoomBlock(
                    facts = RoomFacts(
                        facts = listOf(
                            RoomFact(label = "Email", value_ = "ada@analytical.example", kind = RoomFactKind.ROOM_FACT_KIND_EMAIL, copy_selector_id = "fact/copy"),
                            RoomFact(label = "Password", value_ = "secret", kind = RoomFactKind.ROOM_FACT_KIND_SECRET, sealed_ = true, reveal_selector_id = "fact/reveal"),
                            RoomFact(label = "Website", value_ = "example.org", kind = RoomFactKind.ROOM_FACT_KIND_LINK, open_selector_id = "fact/open"),
                        ),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("form_explicit") {
            RoomBlockView(
                RoomBlock(
                    form = RoomForm(
                        fields = listOf(
                            RoomField(
                                selector_id = "field/title",
                                label = "Title",
                                hint = "Reminder title",
                                text = RoomText(
                                    kind = RoomTextKind.ROOM_TEXT_KIND_LINE,
                                    value_ = "Renew passport",
                                    rev = 1L,
                                    chips = listOf(RoomChip(label = "Tomorrow 9:00", remove_selector_id = "chip/date")),
                                ),
                            ),
                            RoomField(
                                selector_id = "field/flag",
                                label = "Flagged",
                                toggle = RoomToggle(on = true),
                            ),
                        ),
                        explicit = RoomExplicitSave(
                            save_label = "Save",
                            save_selector_id = "form/save",
                            cancel_label = "Cancel",
                            cancel_selector_id = "form/cancel",
                            save_enabled = true,
                            dirty = true,
                        ),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("form_autosave") {
            RoomBlockView(
                RoomBlock(
                    form = RoomForm(
                        fields = listOf(
                            RoomField(
                                selector_id = "field/body",
                                label = "Notes",
                                text = RoomText(kind = RoomTextKind.ROOM_TEXT_KIND_PARAGRAPH, value_ = "Quiet local-first notes.", rev = 2L),
                            ),
                        ),
                        autosave = RoomAutosave(phase = RoomAutosavePhase.ROOM_AUTOSAVE_PHASE_SAVED, label = "Saved"),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("choice_segmented") {
            RoomBlockView(
                RoomBlock(
                    choice = RoomChoice(
                        selector_id = "choice/appearance",
                        label = "Appearance",
                        style = RoomChoiceStyle.ROOM_CHOICE_STYLE_SEGMENTED,
                        options = listOf(
                            RoomOption(id = "system", label = "System", selected = true),
                            RoomOption(id = "light", label = "Light", selected = false),
                            RoomOption(id = "dark", label = "Dark", selected = false),
                        ),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("choice_chips") {
            RoomBlockView(
                RoomBlock(
                    choice = RoomChoice(
                        selector_id = "choice/tags",
                        label = "Tags",
                        style = RoomChoiceStyle.ROOM_CHOICE_STYLE_CHIPS,
                        multiple = true,
                        options = listOf(
                            RoomOption(id = "work", label = "Work", selected = true),
                            RoomOption(id = "travel", label = "Travel", selected = false),
                            RoomOption(id = "home", label = "Home", selected = true),
                        ),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("choice_list") {
            RoomBlockView(
                RoomBlock(
                    choice = RoomChoice(
                        selector_id = "choice/units",
                        label = "Units",
                        style = RoomChoiceStyle.ROOM_CHOICE_STYLE_LIST,
                        options = listOf(
                            RoomOption(id = "metric", label = "Metric", selected = true),
                            RoomOption(id = "imperial", label = "Imperial", selected = false),
                        ),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("figure_month") {
            RoomBlockView(
                RoomBlock(
                    figure = RoomFigure(
                        selector_id = "figure/spent",
                        label = "Spent in November",
                        value_ = "$1,240.00",
                        caption = "Planned $1,800 · Left $560",
                        tone = RoomTone.ROOM_TONE_NEUTRAL,
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("prose_links") {
            RoomBlockView(
                RoomBlock(
                    prose = RoomProse(
                        text = "Met with Ada Lovelace to review the Analytical Engine notes.",
                        spans = listOf(RoomLinkSpan(start = 9, end = 21, selector_id = "link/ada")),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("media_video") {
            RoomBlockView(
                RoomBlock(
                    media = RoomMedia(
                        selector_id = "media/clip",
                        kind = RoomMediaKind.ROOM_MEDIA_KIND_VIDEO,
                        aspect_milli = 1600,
                        caption = "Walk by the river",
                        duration_label = "0:42",
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("progress_determinate") {
            RoomBlockView(
                RoomBlock(
                    progress = RoomProgress(
                        label = "Backing up photos",
                        done = 410L,
                        total = 1282L,
                        count_label = "410 of 1,282",
                        cancel = RoomAction(selector_id = "progress/cancel", label = "Cancel", enabled = true),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("empty_action") {
            RoomBlockView(
                RoomBlock(
                    empty = RoomEmpty(
                        glyph = RoomGlyph(icon = "Backup"),
                        title = "No backup devices",
                        body = "Pair a backup device to keep an encrypted copy.",
                        action = RoomAction(selector_id = "empty/pair", label = "Pair device", enabled = true),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("wall_locked") {
            RoomBlockView(
                RoomBlock(
                    wall = RoomWall(
                        title = "Locker is locked",
                        body = "Confirm it is you to view saved logins and secrets.",
                        unlock = RoomAction(selector_id = "wall/unlock", label = "Unlock Locker", enabled = true),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("tiles_home") {
            RoomBlockView(
                RoomBlock(
                    tiles = RoomTiles(
                        tiles = listOf(
                            RoomTile(selector_id = "tile/backup", label = "Backup", subtitle = "Backed up 2m ago", glyph = RoomGlyph(icon = "Backup")),
                            RoomTile(selector_id = "tile/settings", label = "Settings", subtitle = "", glyph = RoomGlyph(icon = "Settings")),
                        ),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("glance_today") {
            RoomBlockView(
                RoomBlock(
                    glance = RoomGlance(
                        selector_id = "glance/today",
                        title = "Today",
                        lines = listOf("Lunch with Ana · 11:15", "Pay electricity bill"),
                        glyph = RoomGlyph(icon = "Calendar"),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("trash_list") {
            RoomBlockView(
                RoomBlock(
                    trash = RoomTrash(
                        heading = "Trash · 2",
                        retention = "30 days, then erased",
                        rows = listOf(
                            RoomTrashRow(
                                selector_id = "trash/1",
                                title = "Old draft",
                                meta = "Deleted 2 Nov · Erased 2 Dec",
                                restore_selector_id = "trash/1/restore",
                                purge_selector_id = "trash/1/purge",
                            ),
                        ),
                        empty_trash = RoomAction(selector_id = "trash/empty", label = "Empty trash", enabled = true, destructive = true),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("confirm_outlined") {
            RoomBlockView(
                RoomBlock(
                    confirm = RoomConfirm(
                        class_ = RoomConfirmClass.ROOM_CONFIRM_CLASS_OUTLINED,
                        title = "Delete this photo forever?",
                        warning = "This photo isn't backed up yet. No backup device can bring it back.",
                        body = "It leaves this vault for good. This cannot be undone.",
                        confirm_label = "Delete forever",
                        confirm_selector_id = "confirm/ok",
                        cancel_label = "Cancel",
                        cancel_selector_id = "confirm/cancel",
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("menu_sections") {
            RoomBlockView(
                RoomBlock(
                    menu = RoomMenu(
                        selector_id = "menu/more",
                        sections = listOf(
                            RoomMenuSection(
                                heading = "Tools",
                                items = listOf(
                                    RoomMenuItem(selector_id = "m/import", label = "Import", icon = "Download", enabled = true),
                                    RoomMenuItem(selector_id = "m/trash", label = "Trash", secondary = "30 days, then erased", icon = "Trash", destructive = true, enabled = true),
                                ),
                            ),
                        ),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("attachments_footer") {
            RoomBlockView(
                RoomBlock(
                    attachments = RoomAttachments(
                        heading = "Attachments",
                        items = listOf(RoomRow(selector_id = "att/1", title = "Receipt.pdf", meta = "240 KB")),
                        add = RoomMenu(selector_id = "att/add"),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("linked_footer") {
            RoomBlockView(
                RoomBlock(
                    linked = RoomLinked(
                        heading = "Linked",
                        items = listOf(RoomRow(selector_id = "lnk/1", title = "Ada Lovelace", meta = "Person")),
                        add = RoomAction(selector_id = "lnk/add", label = "Link", enabled = true),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("mentioned_in_footer") {
            RoomBlockView(
                RoomBlock(
                    mentioned_in = RoomMentionedIn(
                        heading = "Mentioned in",
                        items = listOf(RoomRow(selector_id = "men/1", title = "Meeting notes", meta = "Note")),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("says_phone") {
            RoomBlockView(
                RoomBlock(
                    says = RoomSays(
                        source = RoomSaysSource.ROOM_SAYS_SOURCE_PHONE,
                        heading = "Phone says",
                        take_label = "Use phone's",
                        fields = listOf(
                            RoomSaysField(
                                label = "Email",
                                stated = "ada@lovelace.example",
                                mine = "ada@analytical.example",
                                take_selector_id = "says/take/email",
                            ),
                        ),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("earlier_versions_footer") {
            RoomBlockView(
                RoomBlock(
                    earlier_versions = RoomEarlierVersions(
                        summary = "Earlier versions",
                        count = 3,
                        selector_id = "earlier/open",
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("origin_footer") {
            RoomBlockView(
                RoomBlock(
                    origin = RoomOrigin(line = "From Contacts, 3 Nov", selector_id = "origin/open"),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("slot_header") {
            RoomHeaderSlot(
                kind = RoomKind.ROOM_KIND_APP_PLACE,
                header = RoomHeader(
                    title = "Notes",
                    subtitle = "Work · 12 notes",
                    subtitle_clear_selector_id = "header/clear",
                    filter = RoomFilterMenu(filtering = true, clear_selector_id = "filter/clear"),
                    keys = listOf(RoomKey(selector_id = "header/add", role = RoomKeyRole.ROOM_KEY_ROLE_ADD, icon = "Plus", label = "New note", enabled = true)),
                ),
                onTap = {},
            )
        }

        captureBlock("slot_band") {
            RoomBandSlot(
                band = RoomBand(
                    home_selector_id = "band/home",
                    search_selector_id = "band/search",
                    tabs = listOf(
                        RoomTab(selector_id = "tab/all", label = "Notes", icon = "FileText", selected = true),
                        RoomTab(selector_id = "tab/notebooks", label = "Notebooks", icon = "Book", selected = false),
                    ),
                    more_selector_id = "band/more",
                ),
                onTap = {},
            )
        }

        captureBlock("slot_status_line") {
            RoomStatusLineSlot(
                line = RoomStatusLine(
                    sentence = "Note moved to trash",
                    action_label = "Undo",
                    action_selector_id = "status/undo",
                ),
                onTap = {},
            )
        }

        captureBlock("slot_search") {
            RoomSearchSlot(
                search = RoomSearch(
                    open_ = true,
                    selector_id = "search/input",
                    term = "sunsreen",
                    placeholder = "Search notes",
                    corrected = "Including results for “sunscreen”",
                    close_selector_id = "search/close",
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureBlock("slot_selection") {
            RoomSelectionSlot(
                selection = RoomSelection(
                    on = true,
                    label = "3 selected",
                    count = 3,
                    select_all_selector_id = "sel/all",
                    done_selector_id = "sel/done",
                    actions = listOf(
                        RoomMenuItem(selector_id = "sel/trash", label = "Trash", icon = "Trash", destructive = true, enabled = true),
                    ),
                ),
                onTap = {},
            )
        }

        captureBlock("canvas_placeholders") {
            Column {
                RoomBlockView(RoomBlock(calendar_grid = RoomCalendarGrid(anchor_day = "2026-11-26")), {}, {})
                RoomBlockView(RoomBlock(photo_grid = RoomPhotoGrid()), {}, {})
                RoomBlockView(RoomBlock(note_editor = RoomNoteEditor(title = "Draft")), {}, {})
                RoomBlockView(RoomBlock(chart = RoomChart(summary = "Spending trend")), {}, {})
            }
        }

        captureBlock("tiles_home_dark", isDark = true) {
            RoomBlockView(
                RoomBlock(
                    tiles = RoomTiles(
                        tiles = listOf(
                            RoomTile(selector_id = "tile/backup", label = "Backup", subtitle = "Backed up 2m ago", glyph = RoomGlyph(icon = "Backup")),
                            RoomTile(selector_id = "tile/settings", label = "Settings", subtitle = "", glyph = RoomGlyph(icon = "Settings")),
                        ),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        // Full-screen room renders go to the gitignored build output directory.
        captureScreen("room_home") {
            RoomView(
                room = Room(
                    kind = RoomKind.ROOM_KIND_HOME,
                    key = "home",
                    header_ = RoomHeader(title = "Centraid"),
                    band = RoomBand(
                        tabs = listOf(
                            RoomTab(selector_id = "tab/home", label = "Home", icon = "Home", selected = true),
                            RoomTab(selector_id = "tab/backup", label = "Backup", icon = "Backup", selected = false),
                        ),
                    ),
                    ready = RoomReady(
                        blocks = listOf(
                            RoomBlock(
                                tiles = RoomTiles(
                                    tiles = listOf(
                                        RoomTile(selector_id = "tile/backup", label = "Backup", subtitle = "Backed up", glyph = RoomGlyph(icon = "Backup")),
                                        RoomTile(selector_id = "tile/settings", label = "Settings", glyph = RoomGlyph(icon = "Settings")),
                                    ),
                                ),
                            ),
                        ),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }

        captureScreen("room_pushed_settings") {
            RoomView(
                room = Room(
                    kind = RoomKind.ROOM_KIND_SYSTEM_PLACE,
                    key = "settings",
                    header_ = RoomHeader(
                        title = "Settings",
                        back = RoomBack(label = "Home", selector_id = "back"),
                    ),
                    ready = RoomReady(
                        blocks = listOf(
                            RoomBlock(
                                section = RoomSection(
                                    selector_id = "section/appearance",
                                    heading = "Appearance",
                                    blocks = listOf(
                                        RoomBlock(
                                            choice = RoomChoice(
                                                selector_id = "choice/appearance",
                                                style = RoomChoiceStyle.ROOM_CHOICE_STYLE_SEGMENTED,
                                                options = listOf(
                                                    RoomOption(id = "system", label = "System", selected = true),
                                                    RoomOption(id = "light", label = "Light", selected = false),
                                                    RoomOption(id = "dark", label = "Dark", selected = false),
                                                ),
                                            ),
                                        ),
                                    ),
                                ),
                            ),
                        ),
                    ),
                ),
                onTap = {},
                onChange = {},
            )
        }
    }

    private companion object {
        const val BLOCK_GOLDENS_DIR = "src/test/snapshots/blocks"
        const val SCREEN_RENDERS_DIR = "build/outputs/roborazzi/screens"
    }
}
