package dev.centraid.android.kit

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.centraid.android.R
import kotlin.math.cos
import kotlin.math.sin

/**
 * The bare Centraid mark (#1173): a squared circle of four quarters around an
 * open square heart, from `design/mockups/QuartersIcon.dc.html`. It is the
 * assistant's avatar in Chat and shares its geometry with the app icon.
 *
 * The geometry is the board's, on a 120 grid centred on (60, 60): a circle of
 * radius 34 cut on the diagonals by 5-unit gaps, an open square heart whose
 * corners sit on the cuts. The cuts and the heart are erased rather than drawn
 * in a tile colour, so the mark sits on any surface. The four colours are the
 * brand colours from `design/tokens.toml` (`[brand]`); they do not change in dark.
 */
@Composable
public fun CentraidMark(modifier: Modifier = Modifier, size: Dp = 32.dp) {
    val teal = colorResource(R.color.centraid_brand_teal)
    val orange = colorResource(R.color.centraid_brand_orange)
    val blue = colorResource(R.color.centraid_brand_blue)
    val pink = colorResource(R.color.centraid_brand_pink)
    // Top, right, bottom, left: the angle (degrees) each wedge is centred on.
    val quarters = listOf(teal to -90f, orange to 0f, blue to 90f, pink to 180f)
    Canvas(
        modifier
            .size(size)
            .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
            .clearAndSetSemantics {},
    ) {
        val factor = this.size.minDimension / EXTENT
        scale(factor, factor, pivot = Offset.Zero) {
            translate(-ORIGIN, -ORIGIN) {
                val centre = Offset(CENTRE, CENTRE)
                val oval = Rect(centre, RADIUS)
                for ((color, middle) in quarters) {
                    val wedge =
                        Path().apply {
                            moveTo(centre.x, centre.y)
                            arcTo(oval, middle - 45f, 90f, false)
                            close()
                        }
                    drawPath(wedge, color)
                }
                for (corner in listOf(-135.0, -45.0, 45.0, 135.0)) {
                    val radians = Math.toRadians(corner)
                    drawLine(
                        Color.Black,
                        centre,
                        Offset(
                            centre.x + (RADIUS + 2f) * cos(radians).toFloat(),
                            centre.y + (RADIUS + 2f) * sin(radians).toFloat(),
                        ),
                        strokeWidth = CUT_WIDTH,
                        blendMode = BlendMode.Clear,
                    )
                }
                val half = HEART_SIDE / 2f
                val topLeft = Offset(centre.x - half, centre.y - half)
                val heart = Size(HEART_SIDE, HEART_SIDE)
                drawRect(Color.Black, topLeft, heart, blendMode = BlendMode.Clear)
                drawRect(
                    Color.Black,
                    topLeft,
                    heart,
                    style = Stroke(width = HEART_STROKE, join = StrokeJoin.Round),
                    blendMode = BlendMode.Clear,
                )
            }
        }
    }
}

private const val CENTRE = 60f
private const val RADIUS = 34f
private const val CUT_WIDTH = 5f
private const val HEART_SIDE = 21.2f
private const val HEART_STROKE = 2f
private const val EXTENT = 76f
private const val ORIGIN = 22f
