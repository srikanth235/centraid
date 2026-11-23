package dev.centraid.android.kit

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.centraid.android.R

/**
 * The bare Centraid mark (#1173): four interlocking rounded rooms in a 3×3
 * courtyard around an open square heart, from `design/mockups/CourtyardIcon.dc.html`.
 * It is the assistant's avatar in Chat and shares its geometry with the app icon.
 *
 * The geometry is the board's, on a 120 grid centred on (60, 60): an 84×84
 * courtyard (`[18..102]`) of four 54×24 rounded rooms (`rx = 8`) separated by
 * 6-unit gaps around an open 24×24 square heart (`[48..72]`). Gaps and heart
 * are empty space, so the mark sits cleanly on any surface. The four colours
 * are the brand colours from `design/tokens.toml` (`[brand]`); they do not
 * change in dark.
 */
@Composable
public fun CentraidMark(modifier: Modifier = Modifier, size: Dp = 32.dp) {
    val teal = colorResource(R.color.centraid_brand_teal)
    val violet = colorResource(R.color.centraid_brand_violet)
    val gold = colorResource(R.color.centraid_brand_gold)
    val rose = colorResource(R.color.centraid_brand_rose)
    // Four interlocking rooms clockwise from the top, in 120-grid coordinates.
    val rooms =
        listOf(
            Triple(teal, Offset(18f, 18f), Size(54f, 24f)),
            Triple(violet, Offset(78f, 18f), Size(24f, 54f)),
            Triple(gold, Offset(48f, 78f), Size(54f, 24f)),
            Triple(rose, Offset(18f, 48f), Size(24f, 54f)),
        )
    Canvas(modifier.size(size).clearAndSetSemantics {}) {
        val factor = this.size.minDimension / EXTENT
        val radius = CornerRadius(ROOM_RADIUS, ROOM_RADIUS)
        scale(factor, factor, pivot = Offset.Zero) {
            translate(-ORIGIN, -ORIGIN) {
                for ((color, topLeft, roomSize) in rooms) {
                    drawRoundRect(
                        color = color,
                        topLeft = topLeft,
                        size = roomSize,
                        cornerRadius = radius,
                    )
                }
            }
        }
    }
}

private const val ROOM_RADIUS = 8f
private const val EXTENT = 92f
private const val ORIGIN = 14f
