package dev.centraid.android.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.centraid.design.CentraidCatalog
import dev.centraid.design.CentraidGeometry
import dev.centraid.design.NativeAppMark

/**
 * The Binding Layer app mark (#1020, wave A; v0 `kit/components/AppMark.tsx`).
 *
 * A quiet hue wash over the page with the single-tone shared icon stroke on it.
 * Both colours arrive already composited from
 * `contracts/tools/export-native-catalog.ts`, because `color-mix()` exists on
 * neither Compose nor SwiftUI and a blend computed twice is two blends.
 *
 * THE RADIUS IS A SHARE OF THE SIZE, not a token: an identity mark is a rounded
 * square whose silhouette has to hold at 22 and at 44, which no static radius
 * can do. Nothing else — no gradient, no gloss, no shadow, no identity-coloured
 * chrome beyond the chip wash.
 */
@Composable
public fun AppMark(
    appId: String,
    modifier: Modifier = Modifier,
    size: Dp = 32.dp,
    muted: Boolean = false,
    mutedBackground: Color = Color.Transparent,
    mutedInk: Color = Color.Transparent,
) {
    val marks = if (isSystemInDarkTheme()) CentraidCatalog.darkMarks else CentraidCatalog.lightMarks
    val mark: NativeAppMark? = marks[appId]
    val iconKey = CentraidCatalog.byId[appId]?.iconKey ?: return
    // Between 14 and 16 like v0: a mark smaller than 14 loses the silhouette,
    // and one larger than 16 crowds a 22pt chip.
    val iconSize = size.value.times(0.55f).toInt().coerceIn(14, 16).dp
    Box(
        modifier = modifier
            .size(size)
            .background(
                color = when {
                    muted -> mutedBackground
                    mark != null -> Color(mark.chipBackground)
                    else -> Color.Transparent
                },
                shape = RoundedCornerShape(
                    (size.value * CentraidGeometry.ICON_CHIP_RADIUS_RATIO).toFloat().dp,
                ),
            ),
        contentAlignment = Alignment.Center,
    ) {
        CentraidIcon(
            iconKey = iconKey,
            tint = when {
                muted -> mutedInk
                mark != null -> Color(mark.markColor)
                else -> Color.Unspecified
            },
            size = iconSize,
        )
    }
}
