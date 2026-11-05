package dev.centraid.android.kit

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import dev.centraid.android.R
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidDark

/** The assistant's bare mark, with a transparent heart on every surface. */
@Composable
public fun CentraidBrandMark(size: Dp) {
    Image(
        painter = painterResource(R.drawable.centraid_brand_mark),
        contentDescription = null, // decorative: the surrounding Welcome title or Chat speaker names it.
        modifier = Modifier.size(size),
    )
}

/** The Welcome app-icon tile uses the generated icon's 120-unit construction. */
@Composable
public fun CentraidBrandTile(size: Dp) {
    val shape = RoundedCornerShape(size * (27f / 120f))
    Box(
        Modifier.size(size)
            .background(centraidColor(if (centraidDark()) "brandDark_tile" else "brandLight_tile"), shape)
            .border(size * (1.5f / 120f), centraidColor("brandEdge"), shape),
        contentAlignment = Alignment.Center,
    ) {
        // The decorative bare asset occupies the icon's 76-unit inner viewport.
        CentraidBrandMark(size * (76f / 120f))
    }
}
