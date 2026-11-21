package dev.centraid.android.a11y

import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import dev.centraid.android.theme.centraidColor
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.test.junit4.AndroidComposeTestRule
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.Density
import dev.centraid.android.theme.CentraidTheme

/**
 * ONE ACTIVITY, MANY SCREENS: the stage swaps what it draws and the appearance (light or dark, the system font
 * scale) without a new activity, and the real theme reads them as the shell's root does (`CentraidTheme` caps
 * the scale itself), so each screen is drawn the way `MainActivity` would draw it.
 */
internal class A11yStage {
    private var dark by mutableStateOf(false)
    private var scale by mutableStateOf(1f)
    private var generation by mutableIntStateOf(0)
    private var body by mutableStateOf<@Composable () -> Unit>({})

    @Composable
    fun Host() {
        val base = LocalDensity.current
        CompositionLocalProvider(LocalDensity provides Density(base.density, scale)) {
            CentraidTheme(dark = dark) {
                // THE WINDOW'S OWN GROUND (the theme's `windowBackground`), under whatever a screen does not paint.
                Box(Modifier.fillMaxSize().background(centraidColor("bg"))) { key(generation) { body() } }
            }
        }
    }

    fun show(rule: AndroidComposeTestRule<*, *>, dark: Boolean, fontScale: Float, content: @Composable () -> Unit) {
        rule.runOnIdle {
            this.dark = dark
            this.scale = fontScale
            this.generation++
            this.body = content
        }
        rule.waitForIdle()
    }
}

internal fun newRule() = createAndroidComposeRule<ComponentActivity>()
