package dev.centraid.android.kit

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import dev.centraid.android.theme.centraidColor

/**
 * THE SHELL'S STATUS LINE, handed down to whichever place draws it above its
 * band: [AppPlace], [PushedPage] and Home's band. Null where the shell has none.
 */
public val LocalShellLine: ProvidableCompositionLocal<(@Composable () -> Unit)?> = compositionLocalOf { null }

/**
 * THE IMPORT'S STATUS LINE (design/behaviour.md § Status line
 * channel … docked to the bottom of the frame … no floating overlay, no
 * auto-dismiss"): an import's progress and outcome, above the band, on Home
 * and on every app. One fragment, at most one action ([actionLabel], "Open
 * People"), and a close key once the work is done ([closeLabel] empty while it
 * runs). It never clears on a timer: the close key, the action or the member's
 * next move puts it away.
 */
@Composable
public fun ShellBanner(
    sentence: String,
    actionLabel: String,
    closeLabel: String,
    tag: String,
    onAct: () -> Unit,
    onClose: () -> Unit,
    leadingIcon: String = "",
    accentApp: String = "",
) {
    // ENTRY AND SETTLE AT 280MS (design/tokens.toml (motion)).
    AnimatedVisibility(
        visible = sentence.isNotEmpty(),
        enter = motionEnter(slideInVertically(tween(ENTER_MS)) { it } + fadeIn(tween(ENTER_MS))),
        exit = motionExit(fadeOut(tween(CHANGE_MS))),
    ) {
        Column(Modifier.fillMaxWidth().background(centraidColor("bg")).testTag("$tag-banner")) {
            Box(Modifier.fillMaxWidth().height(KitGeometry.HAIRLINE).background(centraidColor("line")))
            // THE ACTION WEARS THE COLOUR OF THE APP IT OPENS ("Open People" is People's).
            CompositionLocalProvider(LocalAppAccentId provides accentApp) {
            ProgressStatusLine(
                sentence = sentence,
                actionLabel = actionLabel,
                onAct = onAct,
                closeLabel = closeLabel,
                onClose = onClose,
                testTag = "$tag-line",
                leadingIcon = leadingIcon,
            )
            }
        }
    }
}

private const val ENTER_MS = 280
private const val CHANGE_MS = 140
