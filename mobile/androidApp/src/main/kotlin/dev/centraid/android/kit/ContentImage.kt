package dev.centraid.android.kit

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale

/**
 * A PHOTOGRAPH FROM THE VAULT'S OWN FILE STORE (#1020, D-1020-DC1).
 *
 * The core answers a byte-door request with a PATH — a file inside this app's
 * own storage — rather than with bytes, so decoding and caching stay the
 * platform's and the core never buffers a photograph so a view can buffer it
 * again. This is the composable that opens one.
 *
 * **Decoded once per path, remembered against it.** A Compose body recomposes
 * freely, and `BitmapFactory.decodeFile` decodes the whole file every call — a
 * four-cell mosaic re-decoding four PNGs on each recomposition is four decodes
 * per frame. `remember(path)` is the right key: the path is what was opened, so
 * two assets over one sha share a file and share one decode.
 *
 * **A path that will not open draws nothing**, never a broken-image glyph: the
 * cell keeps its ground and the tile already says how many photographs there
 * are.
 */
@Composable
public fun ContentImage(path: String) {
    val bitmap: ImageBitmap? = remember(path) {
        runCatching { android.graphics.BitmapFactory.decodeFile(path)?.asImageBitmap() }
            .getOrNull()
    }
    if (bitmap != null) {
        Image(
            bitmap = bitmap,
            // The mosaic is decoration over a count a screen reader already
            // reads ("19 photographs"); four unlabelled images announced one by
            // one would be four rows of nothing.
            contentDescription = null, // decorative
            modifier = Modifier.fillMaxSize(),
            // CROP AND FILL, never fit. A mosaic cell is a fixed rectangle and
            // a fitted photograph would letterbox inside it — four cells with
            // four different grounds read as a broken grid.
            contentScale = ContentScale.Crop,
        )
    }
}
