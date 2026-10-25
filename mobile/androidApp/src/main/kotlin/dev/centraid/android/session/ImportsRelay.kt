package dev.centraid.android.session

import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import centraid.core.v1.ImportsCameraRollEvent
import centraid.core.v1.ImportsMadeEvent
import centraid.core.v1.ScreenEvent
import dev.centraid.core.Screens
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * WHAT THE SHELL TELLS THE PHONE IMPORTS (#1135; `docs/screens.md` "Phone imports").
 *
 * `imports.camera_roll`, `imports.files` and `imports.made` are headless screens, each the root of
 * a hidden tab (`imports-camera-roll`, `imports-files`, `imports-made`) the band leaves out. They
 * talk to Photos, Docs and the pass service by name, so the shell relays nothing between screens;
 * it performs their effects ([ShellEffects]) and tells them two facts only it can know:
 *
 * - **MediaStore changed** while the app is in view: `LibraryChanged`, a nudge to walk, to the
 *   camera roll (it takes the vault in front);
 * - **a vault was just made** (words.make finished with its made line): `Made`, with no reminders
 *   source on Android.
 */
internal class ImportsRelay(
    private val context: Context,
    private val screens: Screens,
    private val scope: CoroutineScope,
) {
    private val main = Handler(Looper.getMainLooper())
    private val libraryObserver = object : ContentObserver(main) {
        override fun onChange(selfChange: Boolean) {
            send(CAMERA_ROLL, ScreenEvent(imports_camera_roll = ImportsCameraRollEvent(library_changed = ImportsCameraRollEvent.LibraryChanged())))
        }
    }
    private var observing = false

    /** The words.make instances whose made vault was already told. */
    private val madeTold = mutableSetOf<Long>()

    fun start() {
        scope.launch {
            screens.views.collect { views ->
                for ((instance, view) in views) {
                    val make = view.words_make ?: continue
                    if (!make.finished || make.made_line.isEmpty() || !madeTold.add(instance)) continue
                    send(MADE, ScreenEvent(imports_made = ImportsMadeEvent(made = ImportsMadeEvent.Made(reminders = false))))
                }
            }
        }
    }

    /** The app came forward or left: MediaStore is watched while it is in view, and only then. */
    fun foreground(on: Boolean) {
        if (on && !observing) {
            observing = true
            runCatching {
                context.contentResolver.registerContentObserver(MediaStore.Files.getContentUri("external"), true, libraryObserver)
            }
        } else if (!on && observing) {
            observing = false
            runCatching { context.contentResolver.unregisterContentObserver(libraryObserver) }
        }
    }

    private fun send(tab: String, event: ScreenEvent) {
        scope.launch {
            val root = screens.navigation.value?.tabs?.firstOrNull { it.tab == tab }?.entries?.firstOrNull()?.instance
                ?: return@launch
            screens.send(root, event)
        }
    }

    private companion object {
        const val CAMERA_ROLL = "imports-camera-roll"
        const val MADE = "imports-made"
    }
}
