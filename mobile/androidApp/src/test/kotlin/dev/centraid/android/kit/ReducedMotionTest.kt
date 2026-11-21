package dev.centraid.android.kit

import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * REMOVE ANIMATIONS IS HONOURED WHEN THE MEMBER COMES BACK FROM SETTINGS (#1202). The setting is changed in
 * the system's Settings app, which pauses this activity and never recreates it, so the reading
 * [observeReducedMotion] takes must be taken again on resume: read once, the shell kept animating (or
 * kept snapping) until the process died.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34])
class ReducedMotionTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private fun setScale(scale: Float) {
        Settings.Global.putFloat(rule.activity.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, scale)
    }

    private fun leaveAndReturn() {
        val scenario = rule.activityRule.scenario
        scenario.moveToState(Lifecycle.State.STARTED)
        scenario.moveToState(Lifecycle.State.RESUMED)
        rule.waitForIdle()
    }

    @Test
    fun animationsTurnedOffInSettingsAreHonouredOnReturn() {
        setScale(1f)
        var reduced = false
        rule.setContent {
            reduced = observeReducedMotion()
            LocalContext.current
        }
        assertFalse(reduced)
        setScale(0f)
        leaveAndReturn()
        assertTrue("the setting turned off while away is read again on resume", reduced)
    }

    @Test
    fun animationsTurnedBackOnInSettingsAreHonouredOnReturn() {
        setScale(0f)
        var reduced = false
        rule.setContent { reduced = observeReducedMotion() }
        assertTrue(reduced)
        setScale(1f)
        leaveAndReturn()
        assertFalse(reduced)
    }
}
