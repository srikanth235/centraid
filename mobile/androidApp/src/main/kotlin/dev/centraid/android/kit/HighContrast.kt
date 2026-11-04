package dev.centraid.android.kit

import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext

/**
 * The Secure setting behind Settings > Accessibility > High contrast text. It has no public
 * constant, but the setting itself has shipped since API 21 and a device without it reads 0.
 */
private const val HIGH_TEXT_CONTRAST: String = "high_text_contrast_enabled"

/**
 * HIGH-CONTRAST TEXT, AS ANDROID SPELLS IT, and the nearest thing Android has to what iOS calls
 * Reduce Transparency and Increase Contrast. Android has no "reduce transparency" setting and
 * Compose reads no contrast level, so this is the one signal the band listens to: on, the plates
 * take their hairline edge back and the strip under them the page colour ([bandGround],
 * [bandStrip]). The plates are opaque either way, so there is no translucency to turn off.
 */
public fun highTextContrast(context: Context): Boolean =
    Settings.Secure.getInt(context.contentResolver, HIGH_TEXT_CONTRAST, 0) == 1

/** [highTextContrast] for the composition's own context, kept current while the screen is up. */
@Composable
public fun rememberHighTextContrast(): Boolean {
    val context = LocalContext.current
    var on by remember(context) { mutableStateOf(highTextContrast(context)) }
    DisposableEffect(context) {
        val observer = object : ContentObserver(Handler(Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                on = highTextContrast(context)
            }
        }
        context.contentResolver.registerContentObserver(
            Settings.Secure.getUriFor(HIGH_TEXT_CONTRAST),
            false,
            observer,
        )
        onDispose { context.contentResolver.unregisterContentObserver(observer) }
    }
    return on
}
