package dev.centraid.android.session

import android.content.Context
import android.database.ContentObserver
import android.os.Handler
import android.os.Looper
import android.provider.MediaStore
import centraid.core.v1.DocsDriveEvent
import centraid.core.v1.DocsFollowed
import centraid.core.v1.HomeEvent
import centraid.core.v1.ImportsCameraRollEvent
import centraid.core.v1.ImportsCameraRollState
import centraid.core.v1.ImportsFilesEvent
import centraid.core.v1.ImportsMadeEvent
import centraid.core.v1.Navigation
import centraid.core.v1.PassAsked
import centraid.core.v1.PhotosHomeEvent
import centraid.core.v1.PhotosPermissionChanged
import centraid.core.v1.ScreenEvent
import centraid.core.v1.ShellFact
import centraid.core.v1.ViewState
import dev.centraid.core.Screens
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * THE PHONE IMPORTS' RELAYS (#1135, lane I; `docs/screens.md` "Phone imports").
 *
 * `imports.camera_roll`, `imports.files` and `imports.made` are headless screens, each the root of
 * a hidden tab (`imports-camera-roll`, `imports-files`, `imports-made`) that no tab bar draws. Every
 * decision is theirs; the shell performs their effects ([ShellEffects]) and relays a few things:
 *
 * - **to the camera roll**: `Walk` when the app comes forward, `LibraryChanged` when MediaStore
 *   changes while it is in view, Photos' `CameraRoll` effect as `Requested`; always with the vault
 *   in front's id (the cursor is per vault), which is Home's lockup's;
 * - **from the camera roll**: its grant and its backup progress to every open Photos home (and once
 *   to a home that opens), and `PassAsked{IMPORT_FINISHED}` whenever `imported_total` grows;
 * - **to the followed folders**: `Requested` when the app comes forward, and the Docs drive's picks
 *   and stops (relayed by the drive's pickers); **from** them, the `followed` list to every drive;
 * - **to the made vault's imports**: `Made` once a vault is made (no reminders source on Android),
 *   and its finished line to Home.
 */
internal class ImportsRelay(
    private val context: Context,
    private val screens: Screens,
    private val scope: CoroutineScope,
) {
    private val main = Handler(Looper.getMainLooper())
    private val libraryObserver = object : ContentObserver(main) {
        override fun onChange(selfChange: Boolean) {
            roll(ImportsCameraRollEvent(library_changed = ImportsCameraRollEvent.LibraryChanged()))
        }
    }
    private var observing = false

    /** What each Photos home and Docs drive was last told, so each is told once per change. */
    private val photosTold = mutableMapOf<Long, ImportsCameraRollState>()
    private val drivesTold = mutableMapOf<Long, List<DocsFollowed>>()
    private var importedSeen: Int? = null
    private val madeTold = mutableSetOf<Long>()
    private var madeFinished = mutableSetOf<Long>()

    fun start() {
        scope.launch {
            screens.views.combine(screens.navigation) { views, navigation -> views to navigation }
                .collect { (views, navigation) -> observe(views, navigation) }
        }
    }

    /** The app came forward (or left): walk, follow, and watch the library while it is in view. */
    fun foreground(on: Boolean) {
        if (on) {
            roll(ImportsCameraRollEvent(walk = ImportsCameraRollEvent.Walk()))
            files(ImportsFilesEvent(requested = ImportsFilesEvent.Requested()))
            if (!observing) {
                observing = true
                runCatching {
                    context.contentResolver.registerContentObserver(MediaStore.Files.getContentUri("external"), true, libraryObserver)
                }
            }
        } else if (observing) {
            observing = false
            runCatching { context.contentResolver.unregisterContentObserver(libraryObserver) }
        }
    }

    /** Tell the camera-roll service [event], with the vault in front's id. */
    fun roll(event: ImportsCameraRollEvent) {
        scope.launch {
            val instance = root(CAMERA_ROLL) ?: return@launch
            screens.send(instance, ScreenEvent(imports_camera_roll = event.copy(vault_id = frontVault())))
        }
    }

    /** Tell the followed-folders service [event]. */
    fun files(event: ImportsFilesEvent) {
        scope.launch {
            val instance = root(FILES) ?: return@launch
            screens.send(instance, ScreenEvent(imports_files = event))
        }
    }

    /** Whether [instance] is the made vault's imports service (its `CameraRoll` asks for the grant itself). */
    fun isMade(instance: Long): Boolean = root(MADE) == instance

    private fun root(tab: String): Long? =
        screens.navigation.value?.tabs?.firstOrNull { it.tab == tab }?.entries?.firstOrNull()?.instance

    /** The vault in front: Home's lockup names it. */
    private fun frontVault(): String {
        val home = screens.navigation.value?.tabs?.firstOrNull { it.tab == HOME }?.entries?.firstOrNull()?.instance
            ?: return ""
        return screens.views.value[home]?.home?.bar?.vault?.vault_id.orEmpty()
    }

    private suspend fun observe(views: Map<Long, ViewState>, navigation: Navigation?) {
        navigation ?: return
        // THE ROLL'S GRANT AND PROGRESS, to every Photos home that has not heard them.
        val roll = root(CAMERA_ROLL)?.let { views[it]?.imports_camera_roll }
        if (roll != null) {
            photosTold.keys.retainAll(views.keys)
            for ((instance, view) in views) {
                if (view.photos_home == null) continue
                val last = photosTold[instance]
                if (last?.permission != roll.permission) {
                    screens.send(
                        instance,
                        ScreenEvent(photos_home = PhotosHomeEvent(permission = PhotosPermissionChanged(permission = roll.permission))),
                    )
                }
                if (last?.backup != roll.backup && roll.backup != null) {
                    screens.send(instance, ScreenEvent(photos_home = PhotosHomeEvent(backup = roll.backup)))
                }
                photosTold[instance] = roll
            }
            // A WALK THAT IMPORTED SOMETHING: the pass moves what was just staged.
            val seen = importedSeen
            importedSeen = roll.imported_total
            if (seen != null && roll.imported_total > seen) {
                screens.shellFact(ShellFact(asked = PassAsked(ask = PassAsked.Ask.ASK_IMPORT_FINISHED)))
            }
        }
        // THE FOLDERS FOLLOWED, to every Docs drive.
        val followed = root(FILES)?.let { views[it]?.imports_files }?.followed?.map {
            DocsFollowed(origin_id = it.origin_id, name = it.name, documents = it.documents)
        }
        if (followed != null) {
            drivesTold.keys.retainAll(views.keys)
            for ((instance, view) in views) {
                if (view.docs_drive == null || drivesTold[instance] == followed) continue
                drivesTold[instance] = followed
                screens.send(
                    instance,
                    ScreenEvent(docs_drive = DocsDriveEvent(followed_changed = DocsDriveEvent.FollowedChanged(followed = followed))),
                )
            }
        }
        // A VAULT WAS MADE: what the phone already holds is brought in (R-ONBOARD-8).
        for ((instance, view) in views) {
            val make = view.words_make ?: continue
            if (!make.finished || make.made_line.isEmpty() || !madeTold.add(instance)) continue
            root(MADE)?.let { made ->
                screens.send(made, ScreenEvent(imports_made = ImportsMadeEvent(made = ImportsMadeEvent.Made(reminders = false))))
            }
        }
        // WHAT IT BROUGHT IN, as Home's one status line.
        val madeRoot = root(MADE)
        val made = madeRoot?.let { views[it]?.imports_made }
        if (madeRoot != null && made != null && made.finished && made.summary.isNotEmpty() && madeFinished.add(madeRoot)) {
            val home = navigation.tabs.firstOrNull { it.tab == HOME }?.entries?.firstOrNull()?.instance
            if (home != null) {
                screens.send(home, ScreenEvent(home = HomeEvent(outcome_told = HomeEvent.OutcomeTold(status_line = made.summary))))
            }
        }
    }

    private companion object {
        const val HOME = "home"
        const val CAMERA_ROLL = "imports-camera-roll"
        const val FILES = "imports-files"
        const val MADE = "imports-made"
    }
}
