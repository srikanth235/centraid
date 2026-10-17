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
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import centraid.screen.v1.ImportSource
import dev.centraid.android.theme.centraidColor
import dev.centraid.design.copy.AgendaCopy
import dev.centraid.design.copy.PeopleCopy

/**
 * IMPORT WHERE THE PHONE ALREADY HOLDS THE DATA (`EmptyState.import_source`,
 * `AgendaHomeData.import_source`). ONE DOOR, KEYED BY SOURCE: the shell's
 * importers — permission asked at the tap, the phone's store read, the shared
 * importer run on the member's vault — behind one handler. Null when no vault
 * is open, and then the empty state draws its own action.
 *
 * The door is only ever called with a source [importLabel] names: a screen
 * reads the label first, and an empty label is "this shell cannot read that".
 */
public val LocalPhoneImport: ProvidableCompositionLocal<((ImportSource) -> Unit)?> = staticCompositionLocalOf { null }

/**
 * THE IMPORT'S VERB FOR [source], or "" WHERE ANDROID HAS NOTHING TO READ:
 * Contacts and Calendar are the phone's own stores; Android has no system
 * reminders, so a Reminders source draws the app's own action instead.
 */
public fun importLabel(source: ImportSource): String = when (source) {
    ImportSource.IMPORT_SOURCE_CONTACTS -> PeopleCopy.IMPORT_CONTACTS
    ImportSource.IMPORT_SOURCE_CALENDAR -> AgendaCopy.IMPORT_CALENDAR
    else -> ""
}

/**
 * THE SHELL'S STATUS LINE, handed down to whichever place draws it above its
 * band: [AppPlace], [PushedPage] and Home's band. Null where the shell has none.
 */
public val LocalShellLine: ProvidableCompositionLocal<(@Composable () -> Unit)?> = compositionLocalOf { null }

/**
 * THE IMPORT'S STATUS LINE (DESIGN.md: "`StatusLine` is the one feedback
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
) {
    // ENTRY AND SETTLE AT 280MS (DESIGN.md's one motion grammar).
    AnimatedVisibility(
        visible = sentence.isNotEmpty(),
        enter = slideInVertically(tween(ENTER_MS)) { it } + fadeIn(tween(ENTER_MS)),
        exit = fadeOut(tween(CHANGE_MS)),
    ) {
        Column(Modifier.fillMaxWidth().background(centraidColor("bg")).testTag("$tag-banner")) {
            Box(Modifier.fillMaxWidth().height(KitGeometry.HAIRLINE).background(centraidColor("line")))
            ProgressStatusLine(
                sentence = sentence,
                actionLabel = actionLabel,
                onAct = onAct,
                closeLabel = closeLabel,
                onClose = onClose,
                testTag = "$tag-line",
            )
        }
    }
}

private const val ENTER_MS = 280
private const val CHANGE_MS = 140
