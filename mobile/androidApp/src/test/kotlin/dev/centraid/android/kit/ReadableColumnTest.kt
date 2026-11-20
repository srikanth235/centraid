package dev.centraid.android.kit

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import dev.centraid.android.theme.CentraidTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * THE READABLE COLUMN (ruling 27): on a wide screen a list page's content stands in one centred column no
 * wider than the token; Photos' justified rows (the opt-out) keep the full width; a phone is unchanged.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ReadableColumnTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private class Seen(var left: Float = 0f, var width: Float = 0f, var screen: Float = 0f, var cap: Float = 0f)

    private fun place(readable: Boolean, pushed: Boolean = false): Seen {
        val seen = Seen()
        rule.setContent {
            CentraidTheme(dark = false) {
                val density = LocalDensity.current
                seen.cap = with(density) { KitGeometry.READABLE_WIDTH.toPx() }
                val body: @Composable () -> Unit = { Box(Modifier.fillMaxSize().testTag("body")) }
                if (pushed) {
                    PushedPage(title = "Page", parentTitle = "Home", onBack = {}, readable = readable, content = body)
                } else {
                    AppPlace(app = "notes", title = "Notes", readable = readable, content = body)
                }
            }
        }
        rule.waitForIdle()
        val node = rule.onNodeWithTag("body").fetchSemanticsNode()
        seen.left = node.boundsInRoot.left
        seen.width = node.boundsInRoot.width
        seen.screen = rule.onRoot().fetchSemanticsNode().boundsInRoot.width
        return seen
    }

    private fun capped(pushed: Boolean) {
        val seen = place(readable = true, pushed = pushed)
        assertTrue("width ${seen.width} over the cap ${seen.cap}", seen.width <= seen.cap + 0.5f)
        assertTrue("column should be narrower than the screen", seen.width < seen.screen)
        assertEquals("centred", (seen.screen - seen.width) / 2f, seen.left, 1f)
    }

    private fun full(readable: Boolean, pushed: Boolean) {
        val seen = place(readable = readable, pushed = pushed)
        assertEquals(seen.screen, seen.width, 0.5f)
        assertEquals(0f, seen.left, 0.5f)
    }

    @Test @Config(qualifiers = "w1280dp-h800dp-mdpi", sdk = [34])
    fun anAppRootIsCappedAndCentredOnATablet() = capped(pushed = false)

    @Test @Config(qualifiers = "w1280dp-h800dp-mdpi", sdk = [34])
    fun aPushedPageIsCappedAndCentredOnATablet() = capped(pushed = true)

    @Test @Config(qualifiers = "w1280dp-h800dp-mdpi", sdk = [34])
    fun photosKeepsTheFullWidthOnATablet() = full(readable = false, pushed = false)

    @Test @Config(qualifiers = "w1280dp-h800dp-mdpi", sdk = [34])
    fun aPushedShelfOptsOutToo() = full(readable = false, pushed = true)

    @Test @Config(qualifiers = "w411dp-h891dp-xhdpi", sdk = [34])
    fun aPhoneAppRootIsUnchanged() = full(readable = true, pushed = false)

    @Test @Config(qualifiers = "w411dp-h891dp-xhdpi", sdk = [34])
    fun aPhonePushedPageIsUnchanged() = full(readable = true, pushed = true)
}
