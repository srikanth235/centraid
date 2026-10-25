package dev.centraid.android.screens

import android.Manifest
import android.os.Build

/*
 * THE PHOTO GRANT (D-1025-S7-75; #1135). Which remedy the banner offers, and its
 * words, are Rust's (`PhotosHomeImportBanner`); performing it is
 * `PerformScreenEffects`' (`CameraRoll`: the system prompt, this app's page in
 * Settings, the selected-photos grant). What is left here is the set of
 * permissions that prompt asks for, and the activity's own launcher uses it too
 * (a vault just made asks once).
 */

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
