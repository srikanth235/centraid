package dev.centraid.android.kit

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.centraid.design.CentraidCatalog
import dev.centraid.design.CentraidGeometry

/**
 * ONE ICON SET, DRAWN FROM THE EMITTED SILHOUETTES (#1020, wave A).
 *
 * The path data is `packages/design`'s, lowered by
 * `contracts/tools/export-native-catalog.ts` — the same 24x24 silhouettes the
 * web renderer draws. Material's icon set is deliberately NOT used here: a
 * second set is a second product, and the one thing Home's invariant header
 * promises is that eight unlike bodies read as one grid.
 *
 * SINGLE TONE. The hand-off's mark is one stroke in one colour — no duotone, no
 * fill behind the stroke, no badge. A path the data marks `filled` is filled
 * with that same colour instead of stroked, because a few silhouettes (Play,
 * Pause) ARE their fill.
 */
@Composable
public fun CentraidIcon(
    iconKey: String,
    tint: Color,
    modifier: Modifier = Modifier,
    size: Dp = 16.dp,
    strokeWidth: Float = CentraidGeometry.APP_MARK_STROKE.toFloat(),
) {
    // `PathParser` speaks SVG path data directly, so the emitted `d` strings
    // cross unchanged. Remembered because parsing is per-icon work, not
    // per-frame work.
    val paths: List<Pair<Path, Boolean>> = remember(iconKey) {
        CentraidCatalog.icons[iconKey].orEmpty().map { entry ->
            val parsed = PathParser().parsePathString(entry.d).toPath()
            if (entry.evenOdd) parsed.fillType = PathFillType.EvenOdd
            parsed to entry.filled
        }
    }
    val viewBox = CentraidGeometry.APP_MARK_VIEW_BOX.toFloat()
    Canvas(modifier = modifier.size(size)) {
        // The silhouettes are authored at 24; the caller draws at `size`.
        val factor = this.size.minDimension / viewBox
        scale(factor, pivot = Offset.Zero) {
            paths.forEach { (path, filled) ->
                if (filled) {
                    drawPath(path = path, color = tint, style = Fill)
                } else {
                    drawPath(
                        path = path,
                        color = tint,
                        // The stroke is specified in the CALLER's units, so it
                        // is divided back out of the scale — a 1.6pt rule drawn
                        // inside a 0.66x scale would otherwise land at 1.06.
                        // Round caps and joins are the hand-off's, not a
                        // default: a mitred corner at 1.6 on a 16pt mark reads
                        // as a spike.
                        style = Stroke(
                            width = strokeWidth / factor,
                            cap = StrokeCap.Round,
                            join = StrokeJoin.Round,
                        ),
                    )
                }
            }
        }
    }
}
