package dev.centraid.android.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.screen.v1.HomeSearchData
import centraid.screen.v1.HomeSearchEvent
import centraid.screen.v1.HomeSearchGroup
import centraid.screen.v1.HomeSearchResting
import centraid.screen.v1.HomeSearchRow
import centraid.screen.v1.HomeSearchState
import centraid.screen.v1.SectionHead
import dev.centraid.android.kit.CentraidSearchField
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.KitChip
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidDark
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidCatalog
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.RowRoutes
import dev.centraid.shared.shell.HomeSearchBridge
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope

/**
 * HOME'S SEARCH (R-CHROME-6): one field over every app but Locker, pushed from
 * Home's search bar. Not an app's routes — Home is not an app — but the same
 * seam, so the activity's list holds it like any other.
 *
 * **`Opened` IS SENT AT THE PUSH ([open]), NEVER ON COMPOSITION**: coming
 * back from a row the member opened re-composes this route, and that must find
 * the results they left rather than a fresh field.
 *
 * A row opens where its reference opens ([RowRoutes], the table iOS's chat
 * cards route by), and the back from it lands here.
 */
public class HomeSearchRoutes : AppRoutes {
    private val bridge = HomeSearchBridge()

    /** The bar's words: the search's own placeholder, so the two cannot differ. */
    public val placeholder: String get() = bridge.host.state.value.chrome?.placeholder.orEmpty()

    /** Home's bar was tapped: a fresh field, then the push. */
    public fun open(): Destination {
        bridge.forward(HomeSearchEvent(opened = HomeSearchEvent.Opened()))
        return Destination.HomeSearch
    }

    override fun handles(destination: Destination): Boolean = destination == Destination.HomeSearch

    override fun attach(session: HomeSession, scope: CoroutineScope) {
        bridge.attach(session)
    }

    @Composable
    override fun Routes(destination: Destination, nav: RouteNav) {
        val state by bridge.host.state.collectAsStateWithLifecycle()
        HomeSearchScreen(
            state = state,
            onEvent = { bridge.forward(it) },
            onOpen = { row, among ->
                bridge.forward(HomeSearchEvent(row = HomeSearchEvent.RowPicked(row = row)))
                val target = row.target ?: return@HomeSearchScreen
                RowRoutes.destination(target, parent = state.chrome?.title.orEmpty(), neighbours = among)
                    ?.let { nav.go(nav.stack.push(it)) }
            },
            onCancel = {
                bridge.forward(HomeSearchEvent(cancelled = HomeSearchEvent.Cancelled()))
                nav.pop()
            },
        )
    }
}

/**
 * THE PAGE: the kit's field with its scope, and Cancel; the recent searches
 * while the field is empty; then the answer grouped by app — a hue dot, the
 * app's name and its count over rows of kind and title. Every word, the order
 * and where a row opens arrive finished in [HomeSearchState].
 */
@Composable
internal fun HomeSearchScreen(
    state: HomeSearchState,
    onEvent: (HomeSearchEvent) -> Unit,
    onOpen: (HomeSearchRow, List<String>) -> Unit,
    onCancel: () -> Unit,
) {
    val chrome = state.chrome
    val keyboard = LocalSoftwareKeyboardController.current
    // THE SCROLL PUTS THE KEYBOARD AWAY, as iOS's does.
    val dismiss = object : NestedScrollConnection {
        override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
            if (source == NestedScrollSource.UserInput && available.y != 0f) keyboard?.hide()
            return Offset.Zero
        }
    }
    Column(Modifier.fillMaxSize().background(centraidColor("bg"))) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            CentraidSearchField(
                field = state.field_ ?: centraid.screen.v1.SearchField(open_ = true),
                placeholder = chrome?.placeholder.orEmpty(),
                onTerm = { term -> onEvent(HomeSearchEvent(term = HomeSearchEvent.TermChanged(term = term))) },
                onClose = {},
                modifier = Modifier.weight(1f),
                closeLabel = chrome?.close_label.orEmpty(),
                testTag = "home-search",
                scope = chrome?.scope_label.orEmpty(),
                closes = false,
                onSubmit = {
                    keyboard?.hide()
                    onEvent(HomeSearchEvent(submitted = HomeSearchEvent.Submitted()))
                },
            )
            KitLink(
                label = chrome?.cancel.orEmpty(),
                onClick = onCancel,
                modifier = Modifier.testTag("home-search-cancel").padding(end = 8.dp),
            )
        }
        val resting = state.resting
        val content = screenContentOf(state.loading, state.failure, resting ?: state.data_, state.denied)
        ReadStateView(
            content = content,
            onRetry = { onEvent(HomeSearchEvent(refreshed = HomeSearchEvent.Refreshed())) },
            modifier = Modifier.nestedScroll(dismiss),
            skeleton = { RowSkeleton(label = chrome?.loading.orEmpty()) },
        ) { found ->
            when (found) {
                is HomeSearchResting -> Resting(found) { term ->
                    onEvent(HomeSearchEvent(suggestion = HomeSearchEvent.SuggestionPicked(term = term)))
                }
                is HomeSearchData -> {
                    val empty = found.empty
                    if (empty != null) EmptyStateView(empty, onAction = null) else Groups(found, onOpen)
                }
            }
        }
    }
}

@Composable
private fun Resting(resting: HomeSearchResting, onPick: (String) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        Text(
            resting.note,
            style = centraidType("small"),
            color = centraidColor("textSoft"),
            modifier = Modifier.padding(horizontal = KitGeometry.GUTTER),
        )
        if (resting.suggestions.isNotEmpty()) {
            SectionHeader(SectionHead(title = resting.suggestions_label))
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = KitGeometry.GUTTER),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                resting.suggestions.forEach { term ->
                    KitChip(
                        label = term,
                        selected = false,
                        onClick = { onPick(term) },
                        modifier = Modifier.testTag("home-search-recent-$term"),
                    )
                }
            }
        }
    }
}

@Composable
private fun Groups(data: HomeSearchData, onOpen: (HomeSearchRow, List<String>) -> Unit) {
    LazyColumn(Modifier.fillMaxSize()) {
        data.groups.forEach { group ->
            item(key = "group-${group.app_id}") { GroupHeader(group) }
            items(group.rows, key = { "${it.entity}-${it.id}" }) { row ->
                val among = group.rows.mapNotNull { it.target?.id }
                HitRow(row) { onOpen(row, among) }
            }
        }
        item { Spacer(Modifier.height(16.dp)) }
    }
}

/** One app's head: its hue dot, its name in the section micro-label, its count. */
@Composable
private fun GroupHeader(group: HomeSearchGroup) {
    val marks = if (centraidDark()) CentraidCatalog.darkMarks else CentraidCatalog.lightMarks
    val hue = marks[group.app_id]?.hue?.let { Color(it) } ?: centraidColor("textFaint")
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = KitGeometry.GUTTER, end = KitGeometry.GUTTER, top = 20.dp, bottom = 4.dp)
            .testTag("home-search-group-${group.app_id}")
            .clearAndSetSemantics {
                contentDescription = group.accessibility_label
                heading()
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(8.dp).background(hue, CircleShape))
        Text(
            group.label,
            style = centraidType("smallStrong"),
            color = centraidColor("textSoft"),
            modifier = Modifier.padding(start = 8.dp).weight(1f),
        )
        Text(group.count.toString(), style = centraidType("smallStrong"), color = centraidColor("textFaint"))
    }
}

/** One hit: the kind in a soft fixed column, then the title on one line. */
@Composable
private fun HitRow(row: HomeSearchRow, onTap: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .clickable(onClick = onTap)
            .testTag("home-search-row-${row.entity}-${row.id}")
            .clearAndSetSemantics {
                contentDescription = row.accessibility_label
                role = Role.Button
            },
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = KitGeometry.ROW_MIN)
                .padding(horizontal = KitGeometry.GUTTER),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                row.kind_label,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
                maxLines = 1,
                modifier = Modifier.width(KIND_COLUMN),
            )
            Text(
                row.title,
                style = centraidType("body"),
                color = centraidColor("text"),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(start = 8.dp),
            )
        }
        Box(
            Modifier
                .padding(start = KitGeometry.GUTTER)
                .fillMaxWidth()
                .height(KitGeometry.HAIRLINE)
                .background(centraidColor("line")),
        )
    }
}

/** The kind column: "Document" at the small rung, so titles align. */
private val KIND_COLUMN = 88.dp
