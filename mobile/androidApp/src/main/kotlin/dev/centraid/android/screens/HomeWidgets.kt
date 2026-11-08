package dev.centraid.android.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.dimensionResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import centraid.core.v1.HomeData
import centraid.core.v1.HomeTile
import centraid.core.v1.HomeTileSize
import centraid.core.v1.HomeTileStatus
import centraid.core.v1.Route
import dev.centraid.android.R
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.ContentImage
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.rememberLargestText
import dev.centraid.android.kit.tokenSp
import dev.centraid.android.theme.LocalCentraidTokens
import dev.centraid.design.CentraidCatalog

// HOME AS WIDGETS (#1173; boards `AndroidHome`, `FirstHome`). Rust folds every
// app's tile into widgets (`crates/screens/src/shell/policy.rs`): which widgets,
// in what order, how wide (small is one of four columns, medium two, large all
// four), how tall, and the rows they sit in. This file draws what it sends and
// decides none of it; `HomeView.swift`'s `WidgetGrid` reads the same fields. A
// widget wears the colour of the app it shows (`app_id`); `widget` is its
// identity, because Agenda has two (the day, and what is owed).

private const val COLUMNS = 4
private val GAP = 14.dp

/** A FLOOR, never a height: a fixed height slices bodies at large text sizes. */
private val ROW = 74.dp
private val PAD = 12.dp

private fun floorOf(rows: Int): Dp = ROW * rows + GAP * (rows - 1).coerceAtLeast(0)

/**
 * ONE ROW OF THE GRID: each widget as wide as its columns, and the row as tall
 * as its tallest widget or its floor. A lone widget keeps its columns instead of
 * stretching over the rest.
 */
@Composable
private fun WidgetRow(spans: List<Int>, floor: Dp, content: @Composable () -> Unit) {
    Layout(content = content, modifier = Modifier.fillMaxWidth()) { measurables, constraints ->
        val gap = GAP.roundToPx()
        val total = constraints.maxWidth
        val unit = (total - gap * (COLUMNS - 1)) / COLUMNS
        fun widthOf(span: Int) = unit * span + gap * (span - 1)
        val first = measurables.mapIndexed { i, m ->
            m.measure(Constraints(minWidth = widthOf(spans[i]), maxWidth = widthOf(spans[i])))
        }
        val tall = maxOf(floor.roundToPx(), first.maxOfOrNull { it.height } ?: 0)
        val placeables = measurables.mapIndexed { i, m ->
            m.measure(
                Constraints(
                    minWidth = widthOf(spans[i]),
                    maxWidth = widthOf(spans[i]),
                    minHeight = tall,
                    maxHeight = tall,
                ),
            )
        }
        layout(total, tall) {
            var x = 0
            placeables.forEachIndexed { i, p ->
                p.place(x, 0)
                x += widthOf(spans[i]) + gap
            }
        }
    }
}

/**
 * THE WIDGET GRID, in the rows Rust packed (`grid_rows`). One packer, in Rust:
 * the iOS grid reads the same rows.
 */
@Composable
internal fun WidgetGrid(data: HomeData, loading: String, onOpen: (Route) -> Unit) {
    val byWidget = data.tiles.associateBy { it.widget }
    // AT THE LARGEST TEXT a widget has no room to share a row: each takes the whole width.
    val largest = rememberLargestText()
    Column(
        Modifier.fillMaxWidth().testTag("home-grid"),
        verticalArrangement = Arrangement.spacedBy(GAP),
    ) {
        val rows = data.grid_rows.map { row -> row.widgets.mapNotNull { byWidget[it] } }.filter { it.isNotEmpty() }
        // One widget a row at the largest text; Rust's rows otherwise.
        for (tiles in if (largest) rows.flatten().map { listOf(it) } else rows) {
            WidgetRow(
                spans = tiles.map { if (largest) COLUMNS else spanOf(it) },
                floor = floorOf(tiles.minOf { it.height }.coerceAtLeast(1)),
            ) {
                for (tile in tiles) WidgetCard(tile, loading, onOpen)
            }
        }
    }
}

private fun spanOf(tile: HomeTile): Int = when (tile.size) {
    HomeTileSize.HOME_TILE_SIZE_SMALL -> 1
    HomeTileSize.HOME_TILE_SIZE_MEDIUM -> 2
    else -> COLUMNS
}

/**
 * One widget: a card in the app's colour, pressed to open the app. The card is
 * white on the light page and the dark card in dark, with no border; only
 * floating glass casts a shadow.
 */
@Composable
private fun WidgetCard(tile: HomeTile, loading: String, onOpen: (Route) -> Unit) {
    val radius = dimensionResource(R.dimen.centraid_radius_card) *
        if (tile.height > 1 || tile.size == HomeTileSize.HOME_TILE_SIZE_LARGE) 1.375f else 1.125f
    val shape = RoundedCornerShape(radius)
    val photos = tile.body?.photos
    Box(
        Modifier
            .clip(shape)
            .background(Surface.card)
            // A WIDGET WITH NO ROUTE (still reading, or could not be) is not a control.
            .clickable(enabled = tile.route != null) { tile.route?.let(onOpen) }
            // Keyed on the widget: Agenda's two are `home-tile-agenda` and
            // `home-tile-reminders`. The label carries the live count; the id does not.
            .testTag("home-tile-${tile.widget}")
            .semantics { contentDescription = tile.accessibility_label },
    ) {
        if (photos != null && tile.status != HomeTileStatus.HOME_TILE_STATUS_LOADING) {
            PhotoWidget(tile)
        } else {
            WidgetBody(tile, loading, Modifier.padding(PAD))
        }
    }
}

@Composable
private fun meta(): Color = Surface.meta

@Composable
private fun ink(): Color = Surface.ink

/** The app's own text size rungs: meta (13) for lines, strong at the same size. */
@Composable
private fun WText(
    text: String,
    color: Color,
    modifier: Modifier = Modifier,
    strong: Boolean = false,
    size: androidx.compose.ui.unit.TextUnit = tokenSp(R.dimen.centraid_text_meta),
    maxLines: Int = 1,
    align: TextAlign? = null,
) {
    Text(
        text,
        color = color,
        fontSize = size,
        fontWeight = if (strong) FontWeight.SemiBold else FontWeight.Normal,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
        textAlign = align,
        modifier = modifier,
    )
}

/**
 * What a widget says, by what it holds and how big it is. Something to show is
 * the app's own face; nothing yet is the app's name and what to do.
 */
@Composable
private fun WidgetBody(tile: HomeTile, loading: String, modifier: Modifier) {
    val body = tile.body
    when {
        tile.status == HomeTileStatus.HOME_TILE_STATUS_LOADING -> Skeleton(loading, modifier)
        tile.status != HomeTileStatus.HOME_TILE_STATUS_CONTENT || body == null ->
            // A SMALL SLOT HOLDS A GLANCE, NOT A SENTENCE: Health's one word under its mark.
            if (tile.size == HomeTileSize.HOME_TILE_SIZE_SMALL) Glance(tile, "", tile.empty_copy, modifier) else Invitation(tile, modifier)
        body.agenda != null -> AgendaWidget(tile, body.agenda!!, modifier)
        body.reminders != null -> RemindersWidget(tile, body.reminders!!, modifier)
        body.money != null -> Glance(tile, body.money!!.amounts.firstOrNull().orEmpty(), body.money!!.caption, modifier)
        body.health != null -> Glance(tile, body.health!!.figure, body.health!!.caption, modifier)
        body.people != null -> Glance(tile, body.people!!.figure, body.people!!.caption, modifier)
        body.locker != null -> Glance(tile, body.locker!!.state_label, tile.name, modifier)
        body.notes != null -> LineWidget(tile, body.notes!!.title, body.notes!!.edited, modifier, next = body.notes!!.next_title)
        body.docs != null -> LineWidget(
            tile,
            body.docs!!.rows.firstOrNull()?.name.orEmpty(),
            body.docs!!.rows.firstOrNull()?.size.orEmpty(),
            modifier,
        )
    }
}

/**
 * THE CALENDAR: the weekday in caps and the date, today's events (a bar in the
 * app's colour, the title, the span), and the foot.
 */
@Composable
private fun AgendaWidget(tile: HomeTile, day: centraid.core.v1.HomeTileBody.Agenda, modifier: Modifier) {
    Column(modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        WText(day.weekday.uppercase(), appAccent(tile.app_id).text, strong = true, size = tokenSp(R.dimen.centraid_text_badge))
        Text(
            day.day,
            color = ink(),
            fontSize = tokenSp(R.dimen.centraid_text_section),
            fontWeight = FontWeight.SemiBold,
        )
        day.events.forEach { event ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(
                    Modifier
                        .width(3.dp)
                        .heightIn(min = 30.dp)
                        .clip(CircleShape)
                        .background(appAccent(tile.app_id).fill),
                )
                Column {
                    WText(event.title, ink(), strong = true)
                    WText(event.span, meta())
                }
            }
        }
        Spacer(Modifier.weight(1f))
        WText(day.foot, meta())
    }
}

/** WHAT IS OWED TODAY: the name and how many, the first titles behind a ring, the caption. */
@Composable
private fun RemindersWidget(tile: HomeTile, owed: centraid.core.v1.HomeTileBody.Reminders, modifier: Modifier) {
    Column(modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            WText(tile.name, appAccent(tile.app_id).text, strong = true, modifier = Modifier.weight(1f))
            Text(
                (tile.count?.let { if (it.capped) "${it.value_}+" else "${it.value_}" } ?: "0"),
                color = appAccent(tile.app_id).text,
                fontSize = tokenSp(R.dimen.centraid_text_section),
                fontWeight = FontWeight.Bold,
            )
        }
        owed.titles.forEach { title ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Box(Modifier.size(12.dp).border(1.4.dp, meta(), CircleShape))
                WText(title, ink())
            }
        }
        Spacer(Modifier.weight(1f))
        WText(owed.caption, meta())
    }
}

/** A GLANCE (small): the app's mark in its colour, a figure and a word. */
@Composable
private fun Glance(tile: HomeTile, figure: String, caption: String, modifier: Modifier) {
    Column(
        modifier.fillMaxSize(),
        verticalArrangement = Arrangement.spacedBy(2.dp, Alignment.CenterVertically),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CentraidCatalog.byId[tile.app_id]?.let { app ->
            CentraidIcon(iconKey = widgetIcon(tile.app_id, app.iconKey), tint = appAccent(tile.app_id).text, size = 22.dp)
        }
        if (figure.isNotEmpty()) WText(figure, ink(), strong = true)
        WText(caption, meta(), maxLines = 2, align = TextAlign.Center)
    }
}

/**
 * A LINE (medium, one row): the app's name in its colour, what is newest, a word about it. AT THE
 * LARGEST TEXT the word about it is dropped first and the titles wrap to two lines, so no line is
 * cut mid-word.
 */
@Composable
private fun LineWidget(tile: HomeTile, title: String, line: String, modifier: Modifier, next: String = "") {
    val largest = rememberLargestText()
    val titleLines = if (largest) 2 else 1
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        WText(tile.name, appAccent(tile.app_id).text, strong = true)
        WText(title, ink(), maxLines = titleLines)
        // THE NOTE AFTER IT (Notes): a new vault's two starter notes both show.
        if (next.isNotEmpty()) WText(next, ink(), maxLines = titleLines)
        if (line.isNotEmpty() && !largest) WText(line, meta())
    }
}

/** NOTHING TO SHOW YET (or nothing readable): the app's mark and name, and what to DO. */
@Composable
private fun Invitation(tile: HomeTile, modifier: Modifier) {
    Column(modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            CentraidCatalog.byId[tile.app_id]?.let { app ->
                CentraidIcon(iconKey = widgetIcon(tile.app_id, app.iconKey), tint = appAccent(tile.app_id).text, size = 16.dp)
            }
            WText(tile.name, appAccent(tile.app_id).text, strong = true)
        }
        Spacer(Modifier.weight(1f))
        WText(tile.empty_copy, Surface.body, maxLines = 3)
    }
}

/** STATIC BARS, NEVER A SPINNER: a read in flight holds its slot, and the bars stand where the lines will. */
@Composable
private fun Skeleton(loading: String, modifier: Modifier) {
    Column(
        modifier.fillMaxWidth().semantics { contentDescription = loading },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        listOf(0.8f, 0.55f).forEach { fraction ->
            Box(
                Modifier
                    .fillMaxWidth(fraction)
                    .height(10.dp)
                    .clip(RoundedCornerShape((LocalCentraidTokens.current.radii["sm"] ?: 0).dp))
                    .background(Surface.line),
            )
        }
    }
}

/**
 * PHOTOS (large, or a tall medium with something to show): the newest four as one
 * big photograph and three beside it, bled to the card's edge, with the app's name
 * over the foot. A cell with no bytes on this phone is drawn grey.
 */
@Composable
private fun PhotoWidget(tile: HomeTile) {
    val photos = tile.body?.photos ?: return
    val cells = photos.cells
    @Composable
    fun cell(index: Int, modifier: Modifier) {
        Box(modifier.background(Surface.line)) {
            val path = cells.getOrNull(index)?.thumbnail_path
            if (!path.isNullOrEmpty()) ContentImage(path = path)
        }
    }
    Box(Modifier.fillMaxWidth().heightIn(min = floorOf(2))) {
        Row(Modifier.matchParentSize(), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            cell(0, Modifier.weight(1f).fillMaxHeight())
            Column(Modifier.weight(1f).fillMaxHeight(), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                cell(1, Modifier.weight(1f).fillMaxWidth())
                cell(2, Modifier.weight(1f).fillMaxWidth())
            }
            cell(3, Modifier.weight(1f).fillMaxHeight())
        }
        Column(Modifier.align(Alignment.BottomStart).padding(PAD)) {
            WText(tile.name, Color.White, strong = true)
            if (photos.absent_line.isNotEmpty()) WText(photos.absent_line, Color.White)
        }
    }
}

/** THE MARK A WIDGET DRAWS: the app's own, except People's, which the board draws as the person. */
private fun widgetIcon(appId: String, appIcon: String): String = if (appId == "people") "User" else appIcon
