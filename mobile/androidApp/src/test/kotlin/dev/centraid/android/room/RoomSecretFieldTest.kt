package dev.centraid.android.room

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import centraid.core.v1.RoomChange
import centraid.core.v1.RoomField
import centraid.core.v1.RoomForm
import centraid.core.v1.RoomSecret
import dev.centraid.android.theme.CentraidTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RoomSecretFieldTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun maskedSecretIsEditableAndHasNoRevealControl() {
        val changes = mutableListOf<RoomChange>()
        val fieldId = "locker/sealed/password"
        rule.setContent {
            CentraidTheme(dark = false) {
                RoomFormBlock(
                    form = RoomForm(
                        fields = listOf(
                            RoomField(
                                selector_id = fieldId,
                                label = "Password",
                                secret = RoomSecret(masked = true),
                            ),
                        ),
                    ),
                    onTap = {},
                    onChange = changes::add,
                )
            }
        }

        val inputTag = "$fieldId-secret-input"
        rule.onNodeWithTag(inputTag).performTextInput("unlocked-secret")
        rule.waitForIdle()

        assertEquals("unlocked-secret", changes.last().text)
        assertEquals(0, rule.onAllNodesWithTag("locker/sealed/reveal").fetchSemanticsNodes().size)
    }

    @Test
    fun maskedDetailWithRevealRemainsStaticUntilRevealAction() {
        val taps = mutableListOf<String>()
        val fieldId = "locker/detail/password"
        val revealId = "locker/detail/password/reveal"
        rule.setContent {
            CentraidTheme(dark = false) {
                RoomFormBlock(
                    form = RoomForm(
                        fields = listOf(
                            RoomField(
                                selector_id = fieldId,
                                label = "Password",
                                secret = RoomSecret(masked = true, reveal_selector_id = revealId),
                            ),
                        ),
                    ),
                    onTap = taps::add,
                    onChange = {},
                )
            }
        }

        assertEquals(0, rule.onAllNodesWithTag("$fieldId-secret-input").fetchSemanticsNodes().size)
        rule.onNodeWithTag(revealId).performClick()
        assertEquals(listOf(revealId), taps)
    }
}
