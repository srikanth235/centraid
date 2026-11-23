package dev.centraid.android.screens.agenda

import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTextReplacement
import centraid.core.v1.TodoQuickAdd
import dev.centraid.android.theme.CentraidTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** QUICK-ADD MUST KEEP THE FIELD'S EDITING SEMANTICS (#1202). */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp-xhdpi", sdk = [34])
class TodoQuickAddAccessibilityTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun stagedTitleRemainsAnEditableLabeledField() {
        rule.setContent {
            CentraidTheme(dark = false) {
                var title by remember { mutableStateOf("AX2211 staged title") }
                TodoQuickAddBar(
                    quickAdd = TodoQuickAdd(
                        shown = true,
                        drawn = true,
                        lands_label = "Add to Inbox",
                        title = title,
                    ),
                    placeholder = "Add a task",
                    verb = "Add",
                    onChange = { title = it },
                    onSubmit = {},
                    testTag = "agenda-quick-add",
                )
            }
        }

        val field = rule.onNodeWithTag("agenda-quick-add")
        field.assert(hasContentDescription("Add to Inbox"))
        field.assert(hasSetTextAction())
        field.assertTextEquals("AX2211 staged title")
        field.performTextReplacement("AX2211 staged title next")
        field.assertTextEquals("AX2211 staged title next")
    }
}
