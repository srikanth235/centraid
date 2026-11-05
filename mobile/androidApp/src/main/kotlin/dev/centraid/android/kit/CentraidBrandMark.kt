package dev.centraid.android.kit

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import dev.centraid.android.R

/** The assistant's bare mark, with a transparent heart on every surface. */
@Composable
public fun CentraidBrandMark(size: Dp) {
    Image(
        painter = painterResource(R.drawable.centraid_brand_mark),
        contentDescription = null, // decorative: the surrounding Welcome title or Chat speaker names it.
        modifier = Modifier.size(size),
    )
}
