package dev.centraid.android.a11y

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * THE ORDER A SCREEN READER MEETS FOUR FLOWS IN (#1202, S4): the semantics tree's order (what TalkBack starts from)
 * must read each screen the way a sighted member does: the page's name, what it says, then what it offers, the
 * primary act before the way out. TalkBack also sorts by bounds and honours traversal indices, which only a device
 * shows; this holds the tree itself to the order.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp-xhdpi", sdk = [34])
class TraversalTest {
    @get:Rule val rule = newRule()
    private val stage = A11yStage()

    private fun read(scene: Scene): List<String> {
        rule.setContent { stage.Host() }
        stage.show(rule, dark = false, fontScale = 1f, content = scene.content)
        val order = A11y.reading(rule)
        File("build/a11y").also { it.mkdirs() }.resolve("order-${scene.id}.txt").writeText(order.joinToString("\n"))
        return order
    }

    /** [expected] appear in [order] in that order (others may sit between). */
    private fun assertReadsIn(scene: String, order: List<String>, vararg expected: String) {
        var at = -1
        for (want in expected) {
            val next = order.withIndex().firstOrNull { (i, label) -> i > at && label.contains(want) }?.index ?: -1
            assertTrue("$scene: '$want' is not read after position $at. Order was:\n${order.joinToString("\n")}", next > at)
            at = next
        }
    }

    private fun scene(id: String) = Scenes.all.first { it.id == id }

    @Test
    fun homeReadsTitleThenTilesThenBand() {
        val order = read(scene("home"))
        assertReadsIn("home", order, "Centraid", "Backup", "Settings", "Home")
    }

    @Test
    fun settingsReadsTitleThenAppearanceOptions() {
        val order = read(scene("settings"))
        assertReadsIn("settings", order, "Settings", "APPEARANCE", "System", "Light", "Dark")
    }

    @Test
    fun backupReadsTitleThenStatusLine() {
        val order = read(scene("backup"))
        assertReadsIn("backup", order, "Backup", "Backed up")
    }

    @Test
    fun thePairPageReadsTheTitleThenTheStepsThenTheDecision() {
        val order = read(scene("pair.laptop"))
        assertReadsIn("pair.laptop", order, "Pair a backup device", "centraid-gateway pair", "Scan the code", "Pairing code", "Cancel")
    }
}
