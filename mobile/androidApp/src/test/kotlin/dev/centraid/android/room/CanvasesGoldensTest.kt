package dev.centraid.android.room

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import centraid.core.v1.RoomAutosave
import centraid.core.v1.RoomAutosavePhase
import centraid.core.v1.RoomBlock
import centraid.core.v1.RoomCalendarDay
import centraid.core.v1.RoomCalendarGrid
import centraid.core.v1.RoomCalendarItem
import centraid.core.v1.RoomCalendarItemKind
import centraid.core.v1.RoomCalendarView
import centraid.core.v1.RoomCanvasEvent
import centraid.core.v1.RoomFact
import centraid.core.v1.RoomFactKind
import centraid.core.v1.RoomFacts
import centraid.core.v1.RoomMedia
import centraid.core.v1.RoomMediaKind
import centraid.core.v1.RoomMenu
import centraid.core.v1.RoomMenuItem
import centraid.core.v1.RoomMenuSection
import centraid.core.v1.RoomNoteEditor
import centraid.core.v1.RoomNoteMentionCandidate
import centraid.core.v1.RoomNoteMentionSuggest
import centraid.core.v1.RoomPhotoGrid
import centraid.core.v1.RoomPhotoSection
import centraid.core.v1.RoomPhotoTile
import centraid.core.v1.RoomPhotoTileKind
import centraid.core.v1.RoomPhotoViewer
import centraid.core.v1.RoomPhotoZoom
import centraid.core.v1.RoomThumb
import com.github.takahirom.roborazzi.captureRoboImage
import dev.centraid.android.kit.LocalAppAccentId
import dev.centraid.android.kit.Surface
import dev.centraid.android.theme.CentraidTheme
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w390dp-h844dp-xxhdpi")
class CanvasesGoldensTest {
    @get:Rule
    val rule = createAndroidComposeRule<ComponentActivity>()

    private var dark by mutableStateOf(false)
    private var appAccentId by mutableStateOf("")
    private var generation by mutableIntStateOf(0)
    private var body by mutableStateOf<@Composable () -> Unit>({})

    private fun mountHost() {
        rule.setContent {
            CentraidTheme(dark = dark) {
                CompositionLocalProvider(LocalAppAccentId provides appAccentId) {
                    androidx.compose.runtime.key(generation) { body() }
                }
            }
        }
    }

    private fun captureCanvas(
        name: String,
        accentId: String,
        isDark: Boolean,
        block: RoomBlock,
    ) {
        rule.runOnIdle {
            dark = isDark
            appAccentId = accentId
            generation += 1
            body = {
                Box(
                    Modifier
                        .fillMaxWidth()
                        .background(Surface.page)
                        .padding(vertical = 8.dp)
                        .testTag("golden-root"),
                ) {
                    RoomBlockView(
                        block = block,
                        onTap = {},
                        onChange = {},
                        onCanvas = {},
                    )
                }
            }
        }
        rule.waitForIdle()
        val path = "$BLOCK_GOLDENS_DIR/$name.png"
        File(path).parentFile?.mkdirs()
        rule.onNodeWithTag("golden-root").captureRoboImage(filePath = path)
    }

    @Test
    fun canvasGoldensLightAndDark() {
        mountHost()

        val dayGrid = RoomBlock(calendar_grid = sampleCalendarDay())
        captureCanvas("calendar_day_light", "calendar", isDark = false, block = dayGrid)
        captureCanvas("calendar_day_dark", "calendar", isDark = true, block = dayGrid)

        val weekGrid = RoomBlock(calendar_grid = sampleCalendarWeek())
        captureCanvas("calendar_week_light", "calendar", isDark = false, block = weekGrid)
        captureCanvas("calendar_week_dark", "calendar", isDark = true, block = weekGrid)

        val monthGrid = RoomBlock(calendar_grid = sampleCalendarMonth())
        captureCanvas("calendar_month_light", "calendar", isDark = false, block = monthGrid)
        captureCanvas("calendar_month_dark", "calendar", isDark = true, block = monthGrid)

        val noteEditing = RoomBlock(note_editor = sampleNoteEditing())
        captureCanvas("note_editor_editing_light", "notes", isDark = false, block = noteEditing)
        captureCanvas("note_editor_editing_dark", "notes", isDark = true, block = noteEditing)

        val noteSuggest = RoomBlock(note_editor = sampleNoteWithSuggest())
        captureCanvas("note_editor_suggest_light", "notes", isDark = false, block = noteSuggest)
        captureCanvas("note_editor_suggest_dark", "notes", isDark = true, block = noteSuggest)

        val photoGrid = RoomBlock(photo_grid = samplePhotoGrid())
        captureCanvas("photo_grid_all_light", "photos", isDark = false, block = photoGrid)
        captureCanvas("photo_grid_all_dark", "photos", isDark = true, block = photoGrid)

        val photoViewer = RoomBlock(photo_grid = samplePhotoViewer())
        captureCanvas("photo_viewer_details_light", "photos", isDark = false, block = photoViewer)
        captureCanvas("photo_viewer_details_dark", "photos", isDark = true, block = photoViewer)
    }

    @Test
    fun calendarEmitsPickDayCreateAtAndTaps() {
        val taps = mutableListOf<String>()
        val events = mutableListOf<RoomCanvasEvent>()
        val grid = sampleCalendarMonth()

        rule.setContent {
            CentraidTheme(dark = false) {
                CompositionLocalProvider(LocalAppAccentId provides "calendar") {
                    RoomBlockView(
                        block = RoomBlock(calendar_grid = grid),
                        onTap = { taps.add(it) },
                        onChange = {},
                        onCanvas = { events.add(it) },
                    )
                }
            }
        }
        rule.waitForIdle()

        rule.onNodeWithTag("cal/today").performClick()
        rule.onNodeWithTag("cal/next").performClick()
        assertEquals(listOf("cal/today", "cal/next"), taps)

        rule.onNodeWithTag("calendar-day-2026-11-12").performClick()
        assertEquals("2026-11-12", events.last().calendar_day?.day)

        rule.onNodeWithTag("calendar-day-2026-11-14").performTouchInput { longClick() }
        assertEquals("2026-11-14", events.last().calendar_create?.day)
        assertEquals(9 * 60, events.last().calendar_create?.minute)
    }

    @Test
    fun noteEditorReconcilesAndEmitsEditsAndTriggers() {
        val state = NoteEditorState(initialTitle = "Lisbon", initialBody = "Pack bags", initialRev = 2L)
        val firstEdit = state.onEdit("Lisbon", "Pack bags and charger")
        assertEquals(3L, firstEdit?.third)
        // Stale Rust rev must not overwrite local edit.
        assertFalse(state.onRustUpdate("Lisbon", "Pack bags", rev = 2L))
        assertEquals("Pack bags and charger", state.body)
        // Newer Rust rev adopts remote document.
        assertTrue(state.onRustUpdate("Lisbon trip", "Updated remotely", rev = 4L))
        assertEquals("Lisbon trip", state.title)
        assertEquals("Updated remotely", state.body)

        val taps = mutableListOf<String>()
        val events = mutableListOf<RoomCanvasEvent>()
        val editor = sampleNoteWithSuggest()
        rule.setContent {
            CentraidTheme(dark = false) {
                CompositionLocalProvider(LocalAppAccentId provides "notes") {
                    RoomBlockView(
                        block = RoomBlock(note_editor = editor),
                        onTap = { taps.add(it) },
                        onChange = {},
                        onCanvas = { events.add(it) },
                    )
                }
            }
        }
        rule.waitForIdle()

        rule.onNodeWithTag("suggest/ana").performClick()
        assertEquals(listOf("suggest/ana"), taps)

        rule.onNodeWithTag("note/editor-fmt-bold").performClick()
        assertTrue(events.any { it.note_edit != null && it.note_edit!!.body.contains("**") })

        rule.onNodeWithTag("note/editor-fmt-wiki").performClick()
        assertTrue(events.any { it.note_trigger?.trigger == "[[" })

        rule.onNodeWithTag("note/editor-title").performTextInput("!")
        assertTrue(events.any { it.note_edit?.title?.endsWith("!") == true })
    }

    @Test
    fun photoGridEmitsZoomTilePaginationAndViewerPaging() {
        val taps = mutableListOf<String>()
        val events = mutableListOf<RoomCanvasEvent>()
        val grid = samplePhotoGrid()

        rule.setContent {
            CentraidTheme(dark = false) {
                CompositionLocalProvider(LocalAppAccentId provides "photos") {
                    RoomBlockView(
                        block = RoomBlock(photo_grid = grid),
                        onTap = { taps.add(it) },
                        onChange = {},
                        onCanvas = { events.add(it) },
                    )
                }
            }
        }
        rule.waitForIdle()

        rule.onNodeWithTag("photo/1").performClick()
        rule.onNodeWithTag("photos/next-page").performClick()
        assertEquals(listOf("photo/1", "photos/next-page"), taps)

        rule.onNodeWithTag("kit-segment-months").performClick()
        assertEquals(RoomPhotoZoom.ROOM_PHOTO_ZOOM_MONTHS, events.last().photo_zoom?.zoom)
    }

    @Test
    fun photoViewerPagesAndTogglesDetails() {
        val events = mutableListOf<RoomCanvasEvent>()
        val viewerGrid = samplePhotoViewer(detailsOpen = false)

        rule.setContent {
            CentraidTheme(dark = false) {
                CompositionLocalProvider(LocalAppAccentId provides "photos") {
                    RoomBlockView(
                        block = RoomBlock(photo_grid = viewerGrid),
                        onTap = {},
                        onChange = {},
                        onCanvas = { events.add(it) },
                    )
                }
            }
        }
        rule.waitForIdle()

        rule.onNodeWithTag("photo-viewer-next").performClick()
        assertEquals(2, events.last().photo_page?.index)

        rule.onNodeWithTag("photo-viewer-info").performClick()
        rule.onNodeWithTag("photo-viewer-details").assertIsDisplayed()
        rule.onNodeWithText("Alfama, Lisbon").assertIsDisplayed()
    }

    private fun sampleCalendarDay(): RoomCalendarGrid = RoomCalendarGrid(
        view = RoomCalendarView.ROOM_CALENDAR_VIEW_DAY,
        anchor_day = "2026-11-09",
        now_minute = 10 * 60 + 30,
        prev_selector_id = "cal/prev",
        next_selector_id = "cal/next",
        today_selector_id = "cal/today",
        create_selector_id = "cal/create",
        days = listOf(
            RoomCalendarDay(
                day = "2026-11-09",
                label = "Monday 9 November",
                today = true,
                selected = true,
                in_scope = true,
                items = listOf(
                    RoomCalendarItem(
                        selector_id = "task/overdue",
                        kind = RoomCalendarItemKind.ROOM_CALENDAR_ITEM_KIND_TASK,
                        title = "Renew passport",
                        time_label = "2 days ago",
                        overdue = true,
                        hue_key = "reminders",
                    ),
                    RoomCalendarItem(
                        selector_id = "person/bday",
                        kind = RoomCalendarItemKind.ROOM_CALENDAR_ITEM_KIND_PERSON_DATE,
                        title = "Ana's birthday",
                        all_day = true,
                        hue_key = "people",
                    ),
                    RoomCalendarItem(
                        selector_id = "event/standup",
                        kind = RoomCalendarItemKind.ROOM_CALENDAR_ITEM_KIND_EVENT,
                        title = "Design review",
                        time_label = "09:00 – 10:00",
                        start_minute = 9 * 60,
                        end_minute = 10 * 60,
                        hue_key = "blue",
                    ),
                    RoomCalendarItem(
                        selector_id = "task/dentist",
                        kind = RoomCalendarItemKind.ROOM_CALENDAR_ITEM_KIND_TASK,
                        title = "Call dentist",
                        time_label = "11:00",
                        start_minute = 11 * 60,
                        end_minute = 11 * 60 + 30,
                        done = true,
                        hue_key = "reminders",
                    ),
                    RoomCalendarItem(
                        selector_id = "event/dinner",
                        kind = RoomCalendarItemKind.ROOM_CALENDAR_ITEM_KIND_EVENT,
                        title = "Dinner with Raj",
                        time_label = "13:00 – 14:30",
                        start_minute = 13 * 60,
                        end_minute = 14 * 60 + 30,
                        needs_reply = true,
                        hue_key = "petrol",
                    ),
                ),
            ),
        ),
    )

    private fun sampleCalendarWeek(): RoomCalendarGrid {
        val labels = listOf("Mon 9", "Tue 10", "Wed 11", "Thu 12", "Fri 13", "Sat 14", "Sun 15")
        val days = labels.mapIndexed { idx, label ->
            val dayNum = 9 + idx
            val iso = "2026-11-${dayNum.toString().padStart(2, '0')}"
            val items = when (idx) {
                0 -> listOf(
                    RoomCalendarItem(
                        selector_id = "w/ev1",
                        kind = RoomCalendarItemKind.ROOM_CALENDAR_ITEM_KIND_EVENT,
                        title = "Sync",
                        start_minute = 9 * 60,
                        end_minute = 10 * 60,
                        hue_key = "blue",
                    ),
                )
                2 -> listOf(
                    RoomCalendarItem(
                        selector_id = "w/ev2",
                        kind = RoomCalendarItemKind.ROOM_CALENDAR_ITEM_KIND_EVENT,
                        title = "Dentist",
                        start_minute = 11 * 60,
                        end_minute = 12 * 60,
                        hue_key = "petrol",
                    ),
                    RoomCalendarItem(
                        selector_id = "w/t1",
                        kind = RoomCalendarItemKind.ROOM_CALENDAR_ITEM_KIND_TASK,
                        title = "Pay rent",
                        all_day = true,
                        hue_key = "reminders",
                    ),
                )
                4 -> listOf(
                    RoomCalendarItem(
                        selector_id = "w/ev3",
                        kind = RoomCalendarItemKind.ROOM_CALENDAR_ITEM_KIND_EVENT,
                        title = "Flight",
                        start_minute = 14 * 60,
                        end_minute = 16 * 60,
                        hue_key = "violet",
                    ),
                )
                else -> emptyList()
            }
            RoomCalendarDay(
                day = iso,
                label = label,
                today = idx == 0,
                selected = idx == 2,
                in_scope = true,
                items = items,
            )
        }
        return RoomCalendarGrid(
            view = RoomCalendarView.ROOM_CALENDAR_VIEW_WEEK,
            anchor_day = "2026-11-09",
            now_minute = 10 * 60 + 15,
            prev_selector_id = "cal/prev",
            next_selector_id = "cal/next",
            today_selector_id = "cal/today",
            create_selector_id = "cal/create",
            days = days,
        )
    }

    private fun sampleCalendarMonth(): RoomCalendarGrid {
        val days = (1..28).map { d ->
            val iso = "2026-11-${d.toString().padStart(2, '0')}"
            val items = when (d) {
                9 -> listOf(
                    RoomCalendarItem(selector_id = "m/1", title = "Review", hue_key = "blue"),
                    RoomCalendarItem(selector_id = "m/2", title = "Task", kind = RoomCalendarItemKind.ROOM_CALENDAR_ITEM_KIND_TASK, hue_key = "reminders"),
                )
                12 -> listOf(RoomCalendarItem(selector_id = "m/3", title = "Dinner", hue_key = "petrol"))
                18 -> listOf(
                    RoomCalendarItem(selector_id = "m/4", title = "A", hue_key = "violet"),
                    RoomCalendarItem(selector_id = "m/5", title = "B", hue_key = "mustard"),
                    RoomCalendarItem(selector_id = "m/6", title = "C", hue_key = "blue"),
                )
                else -> emptyList()
            }
            RoomCalendarDay(
                day = iso,
                label = "November $d",
                today = d == 9,
                selected = d == 12,
                in_scope = true,
                more_count = if (d == 18) 2 else 0,
                items = items,
            )
        }
        return RoomCalendarGrid(
            view = RoomCalendarView.ROOM_CALENDAR_VIEW_MONTH,
            anchor_day = "2026-11-09",
            prev_selector_id = "cal/prev",
            next_selector_id = "cal/next",
            today_selector_id = "cal/today",
            create_selector_id = "cal/create",
            days = days,
        )
    }

    private fun sampleNoteEditing(): RoomNoteEditor = RoomNoteEditor(
        selector_id = "note/editor",
        title = "Lisbon trip",
        body = "Flights are booked: out on 12 December.\n\n- [x] Book the flights\n- [ ] Travel insurance\n- [ ] Ask @Ana to water the plants\nSee [[Lisbon itinerary]].",
        rev = 5L,
        base_revision_id = "rev-5",
        autosave = RoomAutosave(
            phase = RoomAutosavePhase.ROOM_AUTOSAVE_PHASE_SAVED,
            label = "Saved just now",
        ),
        assets = listOf(
            RoomMedia(
                selector_id = "asset/boarding",
                kind = RoomMediaKind.ROOM_MEDIA_KIND_SCAN,
                aspect_milli = 2200,
                caption = "Boarding pass scan",
            ),
        ),
    )

    private fun sampleNoteWithSuggest(): RoomNoteEditor = RoomNoteEditor(
        selector_id = "note/editor",
        title = "Lisbon trip",
        body = "Ask @An",
        rev = 6L,
        base_revision_id = "rev-6",
        autosave = RoomAutosave(
            phase = RoomAutosavePhase.ROOM_AUTOSAVE_PHASE_CONFLICT,
            label = "Changed elsewhere",
            refused = true,
            reload_label = "Reload",
            reload_selector_id = "note/reload",
        ),
        suggest = RoomNoteMentionSuggest(
            trigger = "@",
            query = "An",
            candidates = listOf(
                RoomNoteMentionCandidate(selector_id = "suggest/ana", title = "Ana Díaz", noun = "Person"),
                RoomNoteMentionCandidate(selector_id = "suggest/andy", title = "Andy Patel", noun = "Person"),
            ),
        ),
    )

    private fun samplePhotoGrid(): RoomPhotoGrid = RoomPhotoGrid(
        zoom = RoomPhotoZoom.ROOM_PHOTO_ZOOM_ALL,
        next_page_selector_id = "photos/next-page",
        sections = listOf(
            RoomPhotoSection(
                heading = "November 2026",
                tiles = listOf(
                    RoomPhotoTile(
                        selector_id = "photo/1",
                        kind = RoomPhotoTileKind.ROOM_PHOTO_TILE_KIND_PHOTO,
                        thumb = RoomThumb(hue_key = "petrol", alt = "Morning walk"),
                        aspect_milli = 1333,
                        starred = true,
                    ),
                    RoomPhotoTile(
                        selector_id = "photo/2",
                        kind = RoomPhotoTileKind.ROOM_PHOTO_TILE_KIND_VIDEO,
                        thumb = RoomThumb(hue_key = "mustard", alt = "Tram ride"),
                        aspect_milli = 750,
                        duration_label = "0:24",
                    ),
                    RoomPhotoTile(
                        selector_id = "photo/3",
                        kind = RoomPhotoTileKind.ROOM_PHOTO_TILE_KIND_PHOTO,
                        thumb = RoomThumb(hue_key = "violet", alt = "Sunset"),
                        aspect_milli = 1500,
                        selected = true,
                    ),
                    RoomPhotoTile(
                        selector_id = "photo/4",
                        kind = RoomPhotoTileKind.ROOM_PHOTO_TILE_KIND_SCAN,
                        thumb = RoomThumb(hue_key = "blue", alt = "Receipt"),
                        aspect_milli = 1000,
                    ),
                ),
            ),
        ),
    )

    private fun samplePhotoViewer(detailsOpen: Boolean = true): RoomPhotoGrid = RoomPhotoGrid(
        zoom = RoomPhotoZoom.ROOM_PHOTO_ZOOM_ALL,
        viewer = RoomPhotoViewer(
            tile_selector_id = "photo/2",
            index = 1,
            count = 12,
            current = RoomMedia(
                selector_id = "photo/2",
                kind = RoomMediaKind.ROOM_MEDIA_KIND_IMAGE,
                thumb = RoomThumb(hue_key = "petrol", alt = "Alfama viewpoint"),
                aspect_milli = 1500,
                caption = "Morning walk above Alfama · 07:48",
            ),
            menu = RoomMenu(
                selector_id = "photo/menu",
                sections = listOf(
                    RoomMenuSection(
                        items = listOf(
                            RoomMenuItem(selector_id = "photo/slideshow", label = "Slideshow", icon = "Play", enabled = true),
                            RoomMenuItem(selector_id = "photo/album", label = "Add to album", icon = "Folder", enabled = true),
                        ),
                    ),
                ),
            ),
            details_open = detailsOpen,
            details = listOf(
                RoomBlock(
                    facts = RoomFacts(
                        facts = listOf(
                            RoomFact(label = "Taken", value_ = "9 November 2026 · 07:48", kind = RoomFactKind.ROOM_FACT_KIND_DATE),
                            RoomFact(label = "Place", value_ = "Alfama, Lisbon", kind = RoomFactKind.ROOM_FACT_KIND_ADDRESS),
                        ),
                    ),
                ),
            ),
        ),
    )

    private companion object {
        const val BLOCK_GOLDENS_DIR = "src/test/snapshots/blocks"
    }
}
