package dev.centraid.android.screens

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import centraid.screen.v1.MediaPermission
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * THE ONE THING THAT CHANGES A PHOTO GRANT, FOR EACH GRANT (D-1025-S7-75).
 *
 * * **not asked** — "Allow photo access": the system's own prompt.
 * * **denied** — the sentence (`PhotosGridMachine.pausedReason`) AND "Open
 *   Settings", this app's own page there, which is the one place a member can
 *   change an answer Android has stopped asking about. The prompt is offered
 *   beside it, because on Android "denied" is also what a grant nobody has
 *   asked for yet reads as — `checkSelfPermission` cannot tell the two apart —
 *   and once the system has stopped showing its prompt the launcher returns at
 *   once, which leaves Settings as the button that works.
 * * **limited** (Android 14's selected photos) — "Select more photos", parity
 *   with iOS's "Manage selection": asking again with
 *   `READ_MEDIA_VISUAL_USER_SELECTED` in the set is how the system lets a member
 *   edit the selection they granted.
 * * **restricted, granted** — nothing: there is no next move.
 *
 * **THE PROMPT BELONGS TO THE ACTIVITY**, which is why it is launched here and
 * not by the shared runner: `MediaLibrary.requestPermission` on Android reads
 * the grant and cannot ask (`PlatformServices.android.kt`). So the system's
 * dialog is this launcher, and its answer is handed back as [onAnswered] —
 * `PermissionRequested`, whose runner reads the grant fresh and publishes it.
 * The same re-read runs whenever the screen resumes without a full grant,
 * which is what brings a member back from Settings to a banner that knows.
 */
@Composable
internal fun PhotoAccessRemedy(permission: MediaPermission, onAnswered: () -> Unit) {
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { onAnswered() }

    LifecycleResumeEffect(permission) {
        if (permission != MediaPermission.MEDIA_PERMISSION_GRANTED) onAnswered()
        onPauseOrDispose {}
    }

    when (permission) {
        MediaPermission.MEDIA_PERMISSION_NOT_ASKED ->
            BannerLink("Allow photo access") { launcher.launch(mediaPermissions()) }

        MediaPermission.MEDIA_PERMISSION_DENIED -> Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            BannerLink("Open Settings") {
                context.startActivity(
                    Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", context.packageName, null),
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
            BannerLink("Allow photo access") { launcher.launch(mediaPermissions()) }
        }

        MediaPermission.MEDIA_PERMISSION_LIMITED ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                BannerLink("Select more photos") { launcher.launch(mediaPermissions()) }
            }

        MediaPermission.MEDIA_PERMISSION_GRANTED,
        MediaPermission.MEDIA_PERMISSION_RESTRICTED,
        MediaPermission.MEDIA_PERMISSION_UNSPECIFIED,
        -> Unit
    }
}

/**
 * The set to ask for, by platform. Android 14 adds the selected-photos grant,
 * without which the system offers "all or nothing" and a member who wants to
 * share a few photographs has to refuse.
 */
private fun mediaPermissions(): Array<String> = when {
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> arrayOf(
        Manifest.permission.READ_MEDIA_IMAGES,
        Manifest.permission.READ_MEDIA_VIDEO,
        Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
    )
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> arrayOf(
        Manifest.permission.READ_MEDIA_IMAGES,
        Manifest.permission.READ_MEDIA_VIDEO,
    )
    else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
}

/**
 * A BANNER'S VERB IS HOME'S LINK: `link` in the `control` role, the way "All
 * apps" is drawn, and never a Material `Button`, whose container takes the
 * scheme's primary — ink on ink here, a black pill with its words invisible.
 * The SwiftUI banner draws the same verbs the same way.
 */
@Composable
internal fun BannerLink(text: String, onClick: () -> Unit) {
    Text(
        text = text,
        style = centraidType("control"),
        color = centraidColor("link"),
        modifier = Modifier
            .clickable(role = Role.Button, onClick = onClick)
            .padding(vertical = 8.dp),
    )
}
