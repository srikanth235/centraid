package dev.centraid.android.kit

import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import dev.centraid.android.theme.CentraidTheme
import org.junit.runner.RunWith
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** THE EDITOR'S TRAILING KEY CAN OWN A PLATFORM MENU AT ITS ANCHOR. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp-xhdpi", sdk = [34])
class EditorRoomMenuTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun anchoredMenuOpensAndAnswersAtTheTrailingAction() {
        var picked = false
        rule.setContent {
            CentraidTheme(dark = false) {
                val open = remember { mutableStateOf(false) }
                EditorRoom(
                    title = "Note",
                    status = null,
                    onClose = {},
                    onDeparted = {},
                    trailing = RoomAction(
                        iconKey = "MoreHoriz",
                        label = "Note actions",
                        testTag = "notes-menu",
                        onPress = { open.value = true },
                        anchoredMenu = {
                            AnchoredOptionMenu(
                                expanded = open.value,
                                title = "Note actions",
                                options = listOf(SheetOption(key = "earlier", label = "Earlier versions")),
                                onPick = { open.value = false; picked = it == "earlier" },
                                onDismiss = { open.value = false },
                                testTag = "notes-actions-menu",
                            )
                        },
                    ),
                ) {}
            }
        }

        rule.onNodeWithTag("notes-menu").performClick()
        rule.onNodeWithTag("notes-actions-menu-earlier").assertIsDisplayed().performClick()
        rule.runOnIdle { assertTrue(picked) }
    }
}
