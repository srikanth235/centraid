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
import centraid.core.v1.HomeSearchData
import centraid.core.v1.HomeSearchEvent
import centraid.core.v1.HomeSearchGroup
import centraid.core.v1.HomeSearchResting
import centraid.core.v1.HomeSearchRow
import centraid.core.v1.HomeSearchState
import centraid.core.v1.Route
import centraid.core.v1.SearchContainer
import centraid.screen.v1.SearchField
import centraid.screen.v1.SectionHead
import dev.centraid.android.kit.CentraidSearchField
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.KitChip
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitLink
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.SearchAskRow
import dev.centraid.android.kit.SearchContainerRow
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.kit.toKit
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidDark
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidCatalog

/**
 * HOME'S SEARCH (R-CHROME-6; #1135): one field over every app, pushed from
 * Home's search key. It is a Rust screen (`crates/screens/src/shell/search.rs`):
 * the kit's field with its scope, and Cancel; the recent searches while the
 * field is empty; then the answer grouped by app — a hue dot, the app's name
 * and its count over rows of kind and title. Every word, the order and where a
 * row opens arrive finished in [HomeSearchState]; a tap sends `committed` (the
 * term becomes a recent search) and then pushes the route the row carried.
 *
 * THE ASK ROW (`data.ask`, with its finished `data.ask_route`) closes the answer and is the
 * empty state's one action: a tap pushes the `chat.ask` page like any row's route. A hit with no
 * page to open is not in the answer at all.
 */
@Composable
internal fun HomeSearchScreen(
    state: HomeSearchState,
    onEvent: (HomeSearchEvent) -> Unit,
    onOpen: (Route) -> Unit,
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
                field = SearchField(open_ = true, term = state.term),
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
                    onEvent(HomeSearchEvent(committed = HomeSearchEvent.Committed()))
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
        // THE CORRECTION IS RUST'S SENTENCE ("Including results for ..."), under the field.
        val corrected = state.data_?.corrected.orEmpty()
        if (corrected.isNotEmpty()) {
            Text(
                corrected,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
                maxLines = 2,
                modifier = Modifier
                    .padding(start = KitGeometry.GUTTER + 12.dp, end = KitGeometry.GUTTER, bottom = 4.dp)
                    .testTag("search-corrected"),
            )
        }
        ReadStateView(
            content = content,
            onRetry = { onEvent(HomeSearchEvent(refreshed = HomeSearchEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty(),
            modifier = Modifier.nestedScroll(dismiss),
            skeleton = { RowSkeleton(label = chrome?.loading.orEmpty()) },
        ) { found ->
            when (found) {
                is HomeSearchResting -> Resting(found) { term ->
                    onEvent(HomeSearchEvent(suggestion = HomeSearchEvent.SuggestionPicked(term = term)))
                }
                is HomeSearchData -> {
                    val empty = found.empty
                    // NOTHING MATCHED: the empty state's one action asks the assistant about the term.
                    val ask = found.ask_route
                    if (empty != null) {
                        EmptyStateView(empty.toKit(), onAction = ask?.let { route -> { onOpen(route) } })
                    } else {
                        Groups(found, onEvent, onOpen)
                    }
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
private fun Groups(
    data: HomeSearchData,
    onEvent: (HomeSearchEvent) -> Unit,
    onOpen: (Route) -> Unit,
) {
    // ACTING ON THE ANSWER remembers the term, then opens the page the row carried.
    val open: (Route?) -> Unit = { route ->
        onEvent(HomeSearchEvent(committed = HomeSearchEvent.Committed()))
        route?.let(onOpen)
    }
    LazyColumn(Modifier.fillMaxSize()) {
        data.groups.forEach { group ->
            item(key = "group-${group.app_id}") { GroupHeader(group) }
            // CONTAINERS FIRST (#1097): the notebook, project, group or folder whose name matched.
            items(group.containers, key = { "container-${it.entity}-${it.id}" }) { container ->
                SearchContainerRow(container) { open(container.route) }
            }
            items(group.rows, key = { "${it.entity}-${it.id}" }) { row ->
                HitRow(row) { open(row.route) }
            }
        }
        item(key = "ask") { SearchAskRow(data.ask, onOpen, route = data.ask_route) }
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
