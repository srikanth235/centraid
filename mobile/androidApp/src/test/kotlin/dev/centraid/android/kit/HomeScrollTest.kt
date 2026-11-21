package dev.centraid.android.kit

import androidx.activity.ComponentActivity
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import dev.centraid.android.screens.HomeScrollMemory
import dev.centraid.android.screens.rememberHomeScroll
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.GraphicsMode

/** Home keeps its scroll when an app is opened over it and the member comes back (#1202). */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class HomeScrollTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun scrollIsRestoredAfterHomeLeavesAndReturns() {
        HomeScrollMemory.offset = 0
        var shown by mutableStateOf(true)
        var state: ScrollState? = null
        rule.setContent {
            if (shown) {
                val s = rememberHomeScroll()
                state = s
                Column(Modifier.verticalScroll(s)) { Box(Modifier.height(4000.dp)) }
            }
        }
        rule.waitForIdle()
        rule.runOnIdle { runBlocking { state!!.scrollTo(300) } }
        shown = false
        rule.waitForIdle()
        shown = true
        rule.waitForIdle()
        assertEquals(300, state!!.value)
    }
}
