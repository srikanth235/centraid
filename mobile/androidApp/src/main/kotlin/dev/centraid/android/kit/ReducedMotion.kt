package dev.centraid.android.kit

import android.content.Context
import android.provider.Settings
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.snap
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.compositionLocalOf
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

/**
 * [reducedMotion] as the whole tree reads it: [CentraidTheme] provides it once (#1185), so every
 * animation in the kit and the screens asks one local through [motion] and none reads the setting
 * itself. Off outside the theme.
 */
public val LocalReducedMotion: ProvidableCompositionLocal<Boolean> = compositionLocalOf { false }

/** [reducedMotion] in force: the setting as [CentraidTheme] read it on entry. */
@Composable
@ReadOnlyComposable
public fun rememberReducedMotion(): Boolean = LocalReducedMotion.current

/** [reducedMotion] for the composition's own context, read once per entry. */
@Composable
internal fun observeReducedMotion(): Boolean {
    val context = LocalContext.current
    return remember(context) { reducedMotion(context) }
}

/**
 * THE ONE WAY THE SHELL ANIMATES: [spec] for a member who allows motion, a [snap] (the change lands
 * at once) for one who turned animations off. Every `animate*AsState`, `Animatable.animateTo` and
 * `Crossfade` takes its spec through this; `AnimatedVisibility` takes [motionEnter] and
 * [motionExit]. The iOS twin is `kitAnimation` in `Surface.swift`.
 */
@Composable
@ReadOnlyComposable
public fun <T> motion(spec: FiniteAnimationSpec<T>): FiniteAnimationSpec<T> =
    if (rememberReducedMotion()) snap() else spec

/** [enter] when motion is allowed, no transition when it is not. */
@Composable
@ReadOnlyComposable
public fun motionEnter(enter: EnterTransition): EnterTransition =
    if (rememberReducedMotion()) EnterTransition.None else enter

/** [exit] when motion is allowed, no transition when it is not. */
@Composable
@ReadOnlyComposable
public fun motionExit(exit: ExitTransition): ExitTransition =
    if (rememberReducedMotion()) ExitTransition.None else exit
