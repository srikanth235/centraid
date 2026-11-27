package dev.centraid.android.room

import androidx.activity.ComponentActivity
import android.graphics.BitmapFactory
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import com.github.takahirom.roborazzi.captureRoboImage
import centraid.core.v1.Room
import centraid.core.v1.RoomBlock
import androidx.compose.ui.semantics.SemanticsActions
import dev.centraid.android.theme.CentraidTheme
import java.io.File
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Opt-in review artifact runner for real Rust Room protobuf outputs. Fixtures are emitted by the
 * Rust screen integration tests; this test decodes them with Wire and renders the unchanged Room
 * through [RoomView]. No Room or block is assembled in Kotlin.
 *
 * Run after producing review fixtures with `CENTRAID_REVIEW_CAPTURE=1` on
 * `-Droborazzi.test.record=true :androidApp:testDebugUnitTest --tests '*RustRoomReviewCaptureTest'`. PNGs go to
 * `build/reports/review/light|dark/`. They are Robolectric renderings, not device
 * screenshots or checked-in goldens.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w390dp-h844dp-xxhdpi")
class RustRoomReviewCaptureTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun capturesRustPeopleAndMoneyRoomsInLightAndDark() {
        assumeTrue("Set CENTRAID_REVIEW_CAPTURE=1 to render Rust room fixtures", System.getenv("CENTRAID_REVIEW_CAPTURE") == "1")
        val fixtureDirectory = File("build/review/rooms")
        val manifest = File(fixtureDirectory, "manifest.json")
        assertTrue("Missing Rust Room review manifest: ${manifest.path}", manifest.isFile)
        val manifestJson = JSONObject(manifest.readText(Charsets.UTF_8))
        assertTrue("Unsupported Room fixture manifest version", manifestJson.optInt("schema_version") == 1)
        assertTrue(
            "The Rust fixture exporter must not simulate native owner/save effects",
            !manifestJson.optBoolean("native_os_owner_or_save_effects_simulated", true),
        )
        val entries = manifestJson.optJSONArray("fixtures") ?: error("Room fixture manifest has no fixtures list")
        val fixtures = (0 until entries.length()).map { index ->
            val entry = entries.optJSONObject(index) ?: error("Room fixture entry $index is invalid")
            val name = entry.optString("file")
            require(name.endsWith(".pb") && File(name).name == name) { "Invalid Room fixture filename: $name" }
            assertTrue("Native owner/save must not be represented as performed", !entry.optBoolean("native_owner_or_save_effect_performed", true))
            val file = File(fixtureDirectory, name)
            assertTrue("Missing Rust-generated Room fixture: ${file.path}", file.isFile && file.length() > 0L)
            val room = Room.ADAPTER.decode(file.readBytes())
            assertTrue("Fixture key does not match its manifest: $name", room.key == entry.optString("screen_key"))
            val expectedHue = when {
                name.startsWith("people_") -> "people"
                name.startsWith("money_") -> "money"
                else -> error("Review fixture has no declared app hue family: $name")
            }
            assertEquals("Fixture must carry its Rust-owned app hue: $name", expectedHue, room.hue_key)
            val sourceTest = entry.optString("source_test")
            val scenario = entry.optString("scenario")
            "$name|$sourceTest|$scenario" to room
        }.sortedBy { it.first }
        assertTrue("Room review manifest contains no fixtures", fixtures.isNotEmpty())

        var dark by mutableStateOf(false)
        var room by mutableStateOf(fixtures.first().second)
        rule.setContent {
            CentraidTheme(dark = dark) {
                RoomView(room = room, onTap = {}, onChange = {})
            }
        }
        val outputDirectory = File("build/reports/review")
        outputDirectory.mkdirs()
        File(outputDirectory, "README.txt").writeText(
            "Compose/Robolectric review renderings from Rust Room protobufs. These are not device screenshots.\n" +
                "Fixture producer: ${manifestJson.optString("generated_by")}. Native OS owner/save actions were not exercised.\n",
            Charsets.UTF_8,
        )
        File(outputDirectory, "manifest.json").writeText(manifest.readText(Charsets.UTF_8), Charsets.UTF_8)
        fixtures.forEach { (name, snapshot) ->
            for (isDark in listOf(false, true)) {
                rule.runOnIdle {
                    room = snapshot
                    dark = isDark
                }
                rule.waitForIdle()
                val scheme = if (isDark) "dark" else "light"
                val output = File(outputDirectory, "$scheme/${name.substringBefore('|').removeSuffix(".pb")}.png")
                output.parentFile?.mkdirs()
                rule.onRoot().captureRoboImage(filePath = output.path)
                assertTrue("Robolectric did not write review PNG: ${output.path}", output.isFile && output.length() > 0L)
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(output.path, bounds)
                assertTrue("Review PNG has invalid dimensions: ${output.path}", bounds.outWidth > 0 && bounds.outHeight > 0)
            }
        }
    }

    @Test
    fun capturesCoreBackedGlassOverScrollingRowsAndChecksFooterClearance() {
        assumeTrue("Set CENTRAID_REVIEW_CAPTURE=1 to render Rust room fixtures", System.getenv("CENTRAID_REVIEW_CAPTURE") == "1")
        val directory = File("build/review/rooms")
        val fixture = File(directory, "money_glass_scroll.pb")
        val sidecar = File(directory, "money_glass_scroll.json")
        assertTrue("Missing Core-generated scroll fixture: ${fixture.path}", fixture.isFile && fixture.length() > 0)
        assertTrue("Missing Core-generated scroll fixture metadata: ${sidecar.path}", sidecar.isFile)
        val room = Room.ADAPTER.decode(fixture.readBytes())
        val rows = room.ready?.blocks.orEmpty().flatMap(::rowSelectors)
        assertEquals("The Core fixture should contain forty registered transaction rows", 40, rows.size)
        assertEquals("money", room.hue_key)
        assertTrue("Secure rooms must never be used as a haze source", !room.secure)

        var dark by mutableStateOf(false)
        rule.setContent {
            CentraidTheme(dark = dark) {
                RoomView(room = room, onTap = {}, onChange = {})
            }
        }
        val reportDir = File("build/reports/review/glass-scroll")
        reportDir.mkdirs()
        File(reportDir, "fixture.json").writeText(sidecar.readText(Charsets.UTF_8), Charsets.UTF_8)
        File(reportDir, "README.txt").writeText(
            "Core-generated money_glass_scroll.pb rendered through RoomView. Robolectric verifies source/footer layout and scroll clearance; it does not verify device GPU blur.\n",
            Charsets.UTF_8,
        )

        for (isDark in listOf(false, true)) {
            rule.runOnIdle { dark = isDark }
            rule.waitForIdle()
            val contentBounds = rule.onNodeWithTag("room-scroll-content").fetchSemanticsNode().boundsInRoot
            val footerBounds = rule.onNodeWithTag("room-glass-footer").fetchSemanticsNode().boundsInRoot
            assertTrue("The scrolling source must extend behind the footer", contentBounds.top < footerBounds.top && contentBounds.bottom >= footerBounds.bottom)

            rule.onNodeWithTag(rows[20]).performScrollTo()
            rule.waitForIdle()
            val variant = if (isDark) "dark" else "light"
            val image = File(reportDir, "$variant/money_glass_scroll.png")
            image.parentFile?.mkdirs()
            rule.onRoot().captureRoboImage(filePath = image.path)
            assertTrue("Robolectric did not write scroll glass PNG: ${image.path}", image.isFile && image.length() > 0)
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(image.path, bounds)
            assertTrue("Scroll glass PNG has invalid dimensions: ${image.path}", bounds.outWidth > 0 && bounds.outHeight > 0)

            rule.onNodeWithTag("room-scroll-content").performSemanticsAction(SemanticsActions.ScrollBy) { scrollBy ->
                scrollBy(0f, 100_000f)
            }
            rule.waitForIdle()
            val lastRowBounds = rule.onNodeWithTag(rows.last()).fetchSemanticsNode().boundsInRoot
            val finalFooterBounds = rule.onNodeWithTag("room-glass-footer").fetchSemanticsNode().boundsInRoot
            assertTrue(
                "The final transaction row must scroll entirely above the footer: row=$lastRowBounds footer=$finalFooterBounds",
                lastRowBounds.bottom <= finalFooterBounds.top,
            )
        }
    }

    private fun rowSelectors(block: RoomBlock): List<String> = buildList {
        block.row?.selector_id?.takeIf { it.isNotEmpty() }?.let(::add)
        block.section?.blocks.orEmpty().forEach { addAll(rowSelectors(it)) }
    }
}
