package dev.centraid.android.a11y

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * THE CANARY (#1202, S4): a suite of checks is worth its passes only if each can fail here. Every case is a control
 * the design rules forbid (behaviour.md § Accessibility), and every one must be refused, by the check that names
 * it; the last is the same screen done right, and must pass all of them.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp-xhdpi", sdk = [34])
class A11yCanaryTest {
    @get:Rule val rule = newRule()
    private val stage = A11yStage()

    private fun findings(content: @androidx.compose.runtime.Composable () -> Unit): List<A11y.Finding> {
        rule.setContent { stage.Host() }
        stage.show(rule, dark = false, fontScale = 1f, content = content)
        return A11y.check(rule, rule.density)
    }

    @Test
    fun aSmallTargetIsRefused() {
        val f = findings { Box(Modifier.size(30.dp).clickable {}) { Text("Tiny") } }
        assertTrue(f.toString(), f.any { it.check == "target" })
    }

    @Test
    fun anUnlabelledControlIsRefused() {
        val f = findings { Box(Modifier.size(60.dp).background(Color.Black).clickable {}) }
        assertTrue(f.toString(), f.any { it.check == "label" })
    }

    @Test
    fun twoControlsThatSayTheSameAreRefused() {
        val f = findings {
            Column {
                Box(Modifier.size(60.dp).clickable {}) { Text("Save") }
                Box(Modifier.size(60.dp).clickable {}) { Text("Save") }
            }
        }
        assertTrue(f.toString(), f.any { it.check == "duplicate" })
    }

    @Test
    fun greyOnGreyTextIsRefused() {
        val f = findings { Box(Modifier.background(Color(0xFFAAAAAA)).size(200.dp, 60.dp)) { Text("Grey on grey", color = Color(0xFFB0B0B0)) } }
        assertTrue(f.toString(), f.any { it.check == "contrast" })
    }

    @Test
    fun aGlyphLostInItsGroundIsRefused() {
        val f = findings {
            Box(Modifier.size(60.dp).background(Color(0xFFAAAAAA)).clickable {}) {
                Box(Modifier.size(20.dp).background(Color(0xFFB0B0B0)))
            }
        }
        assertTrue(f.toString(), f.any { it.check == "label" || it.check == "contrast" })
        assertTrue(f.toString(), f.any { it.check == "contrast" })
    }

    @Test
    fun theSameControlsDoneRightPass() {
        val f = findings {
            Column(Modifier.background(Color.White)) {
                Box(Modifier.size(56.dp).clickable {}) { Text("Save", color = Color.Black) }
                Box(Modifier.size(56.dp).clickable {}) { Text("Cancel", color = Color.Black) }
            }
        }
        assertEquals(emptyList<A11y.Finding>(), f)
    }
}
