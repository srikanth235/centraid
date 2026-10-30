package dev.centraid.android.kit

import android.content.Context
import android.provider.Settings
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext

/**
 * REDUCED MOTION, AS ANDROID SPELLS IT: animations off set the animator scale to
 * zero. The one reading every screen that moves anything shares (the photo
 * stage's settle, the first-launch deck), so none keeps a copy of the setting's
 * name; a screen that honours it drops the movement and keeps the change.
 */
public fun reducedMotion(context: Context): Boolean =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f

/** [reducedMotion] for the composition's own context, read once per entry. */
@Composable
public fun rememberReducedMotion(): Boolean {
    val context = LocalContext.current
    return remember(context) { reducedMotion(context) }
}
