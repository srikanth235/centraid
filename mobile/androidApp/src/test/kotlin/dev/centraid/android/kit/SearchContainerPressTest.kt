package dev.centraid.android.kit

import androidx.activity.ComponentActivity
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import centraid.core.v1.Route
import centraid.core.v1.SearchContainer
import dev.centraid.android.theme.CentraidTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * A SEARCH CONTAINER IS PRESSED WHERE IT IS FOUND (#1202): the row's id and spoken label sit on a node whose
 * descendants' semantics are cleared, so the press has to be on that node. On the pill inside it, TalkBack could
 * not activate the container and a tap on its id landed beside the pill.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w411dp-h891dp-xhdpi", sdk = [34])
class SearchContainerPressTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    @Test
    fun theContainerNodeCarriesThePressAndHandsItsRoute() {
        val opened = mutableListOf<String>()
        val container = SearchContainer(
            entity = "project",
            id = "p1",
            icon_key = "Folder",
            title = "Orchard",
            kind_label = "Project",
            accessibility_label = "Project, Orchard",
            route = Route(screen = "tasks.project"),
        )
        rule.setContent { CentraidTheme(dark = false) { SearchContainerRow(container) { opened += it.screen } } }
        rule.onNodeWithTag("search-container-project-p1").assertHasClickAction().performClick()
        assertEquals(listOf("tasks.project"), opened)
    }
}
