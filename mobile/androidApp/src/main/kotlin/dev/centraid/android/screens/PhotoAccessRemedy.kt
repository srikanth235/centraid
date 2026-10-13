package dev.centraid.android.screens

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import centraid.screen.v1.MediaPermission
import centraid.screen.v1.PhotosImportBanner
import dev.centraid.android.kit.KitLink

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
 * WHICH REMEDY, AND ITS WORDS, ARE THE MACHINE'S (`PhotosImportBanner`); this
 * file only launches what the platform needs for it.
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
internal fun PhotoAccessRemedy(banner: PhotosImportBanner, onAnswered: () -> Unit) {
    val context = LocalContext.current
    val launcher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { onAnswered() }

    when (banner.remedy) {
        PhotosImportBanner.Remedy.REMEDY_ASK ->
            KitLink(banner.allow_label, onClick = { launcher.launch(mediaPermissions()) })

        PhotosImportBanner.Remedy.REMEDY_SETTINGS -> Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            KitLink(banner.settings_label, onClick = {
                context.startActivity(
                    Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.fromParts("package", context.packageName, null),
                    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            })
            KitLink(banner.allow_label, onClick = { launcher.launch(mediaPermissions()) })
        }

        PhotosImportBanner.Remedy.REMEDY_MANAGE_SELECTION ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                KitLink(banner.manage_label, onClick = { launcher.launch(mediaPermissions()) })
            }

        PhotosImportBanner.Remedy.REMEDY_UNSPECIFIED -> Unit
    }
}

/**
 * RE-READ THE GRANT WHENEVER THE SCREEN RESUMES WITHOUT A FULL ONE — what
 * brings a member back from Settings to a banner that knows. Composed whether
 * or not the banner draws, so a grant that changed while the banner had
 * nothing to say still reaches the state.
 */
@Composable
internal fun PhotoAccessRefresh(permission: MediaPermission, onAnswered: () -> Unit) {
    LifecycleResumeEffect(permission) {
        if (permission != MediaPermission.MEDIA_PERMISSION_GRANTED) onAnswered()
        onPauseOrDispose {}
    }
}

/**
 * The set to ask for, by platform. Android 14 adds the selected-photos grant,
 * without which the system offers "all or nothing" and a member who wants to
 * share a few photographs has to refuse.
 *
 * **`ACCESS_MEDIA_LOCATION` RIDES WITH IT from Android 10** (#1080, the
 * walker). Without it the platform strips the EXIF location from every
 * original it hands over, so the backup would hold a different file from the
 * one the camera wrote — and a restored library would have lost its places.
 * It is asked for in the same request as the photo grant, so the member is
 * asked once; whether the system words it as a step of its own is a device
 * hand-off, not a claim made here.
 */
internal fun mediaPermissions(): Array<String> = when {
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> arrayOf(
        Manifest.permission.READ_MEDIA_IMAGES,
        Manifest.permission.READ_MEDIA_VIDEO,
        Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED,
        Manifest.permission.ACCESS_MEDIA_LOCATION,
    )
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU -> arrayOf(
        Manifest.permission.READ_MEDIA_IMAGES,
        Manifest.permission.READ_MEDIA_VIDEO,
        Manifest.permission.ACCESS_MEDIA_LOCATION,
    )
    Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q -> arrayOf(
        Manifest.permission.READ_EXTERNAL_STORAGE,
        Manifest.permission.ACCESS_MEDIA_LOCATION,
    )
    else -> arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE)
}
