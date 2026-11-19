package dev.centraid.android.kit

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * WHETHER TEXT IS AT A SIZE WHERE LAYOUTS REFLOW (#1173, the LargeText board): a font scale of 1.3
 * and every scale above it, up to the root's cap (`CentraidTheme`). The point where a card that
 * shared a row with another no longer has room for its words.
 */
@Composable
public fun rememberLargestText(): Boolean = LocalDensity.current.fontScale >= LARGEST_TEXT_SCALE

private const val LARGEST_TEXT_SCALE: Float = 1.3f

/** The largest scale a fixed grid draws at: the Android counterpart of iOS's `xxxLarge` hold (#1202). */
private const val GRID_TEXT_SCALE: Float = 1.3f

/**
 * A FIXED GRID HOLDS ITS TEXT AT THE LARGEST NORMAL SIZE (#1202, owner ruling 17): a grid whose
 * columns, gutter or row height are fixed by the hour or the weekday (the calendar's week strip,
 * hour grid and month) stops growing with the system font scale, so seven days fit; the lists
 * around it keep scaling. Content passes through unchanged at and under the held scale.
 */
@Composable
public fun HoldGridText(content: @Composable () -> Unit) {
    val density = LocalDensity.current
    if (density.fontScale <= GRID_TEXT_SCALE) {
        content()
    } else {
        CompositionLocalProvider(LocalDensity provides Density(density.density, GRID_TEXT_SCALE)) { content() }
    }
}

/**
 * CARDS IN [columns] COLUMNS, ONE COLUMN AT THE LARGEST TEXT. Every card of a row has the row's
 * height. The cards are drawn by [card], in order; an odd count leaves the last row's second slot
 * empty. Use this for any grid of cards (a count tile, a category card) so each reflows alike.
 */
@Composable
public fun <T> KitCardGrid(
    items: List<T>,
    modifier: Modifier = Modifier,
    columns: Int = 2,
    gap: Dp = 10.dp,
    card: @Composable (T) -> Unit,
) {
    val across = if (rememberLargestText()) 1 else columns.coerceAtLeast(1)
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(gap)) {
        items.chunked(across).forEach { chunk ->
            Row(
                Modifier.fillMaxWidth().height(IntrinsicSize.Min),
                horizontalArrangement = Arrangement.spacedBy(gap),
            ) {
                chunk.forEach { item ->
                    Column(Modifier.weight(1f).fillMaxWidth()) { card(item) }
                }
                repeat(across - chunk.size) { Column(Modifier.weight(1f)) {} }
            }
        }
    }
}
