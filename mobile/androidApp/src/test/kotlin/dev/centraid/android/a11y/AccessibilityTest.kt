package dev.centraid.android.a11y

import androidx.compose.ui.unit.Density
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * EVERY ROOT AND ITS MAIN SHEET, IN LIGHT AND DARK, AT FONT SCALE 1.0 AND 2.0 (#1202, S4): each is drawn the way the
 * shell draws it and put through [A11y]: 48dp targets, a label on every control, no two controls alike, text at
 * 4.5:1 and controls at 3:1 against the ground they landed on.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp-xhdpi", sdk = [34])
class AccessibilityTest {
    @get:Rule val rule = newRule()
    private val stage = A11yStage()

    private fun sweep(dark: Boolean, fontScale: Float) {
        rule.setContent { stage.Host() }
        val mode = (if (dark) "dark" else "light") + " x" + fontScale
        val findings = mutableListOf<String>()
        for (scene in Scenes.all) {
            try {
                stage.show(rule, dark, fontScale, scene.content)
                A11y.check(rule, Density(rule.density.density, fontScale)).forEach { findings += "${scene.id} ($mode) $it" }
            } catch (e: Throwable) {
                findings += "${scene.id} ($mode) [crash] ${e.javaClass.simpleName}: ${e.message?.take(300)}"
            }
        }
        File("build/a11y").also { it.mkdirs() }.resolve("findings-${mode.replace(' ', '-')}.txt").writeText(findings.joinToString("\n"))
        assertTrue("\n" + findings.joinToString("\n"), findings.isEmpty())
    }

    @Test fun lightScaleOne() = sweep(dark = false, fontScale = 1f)
    @Test fun darkScaleOne() = sweep(dark = true, fontScale = 1f)
    @Test fun lightScaleTwo() = sweep(dark = false, fontScale = 2f)
    @Test fun darkScaleTwo() = sweep(dark = true, fontScale = 2f)
}
