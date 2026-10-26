package dev.centraid.android

import android.os.Bundle
import android.util.Log
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.core.view.WindowCompat
import androidx.fragment.app.FragmentActivity
import dev.centraid.android.backup.MediaStoreDeleter
import dev.centraid.android.kit.AndroidHealth
import dev.centraid.android.kit.ClipboardDeadline
import dev.centraid.android.screens.RustRoot
import dev.centraid.android.session.AppSession
import dev.centraid.android.theme.CentraidTheme
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidDark
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The composition root (#1020, #1135). It names no screen and no destination: Rust holds every
 * route stack ([RustRoot]), Home is the `home` tab's root and apps are pages pushed over it. What
 * stays here is the activity's: holding the process's one session, the platform doors that need an
 * activity, and the system bars.
 */
// A `FragmentActivity` AND NOT A PLAIN `ComponentActivity` for one reason: Locker's unlock raises
// `BiometricPrompt`, which hosts itself in a fragment of the activity it is given (#1047, D-5).
public class MainActivity : FragmentActivity() {
    /** HEALTH CONNECT (#1129): the reader and the phone's facts Health's screens are stamped with. Read only. */
    private val health: AndroidHealth by lazy { AndroidHealth(this) }

    /**
     * FREE UP SPACE'S HAND ON MEDIASTORE (#1080 A20). A FIELD, NEVER `lazy`: its activity result
     * launcher must be registered before this activity starts.
     */
    private val libraryDeleter: MediaStoreDeleter = MediaStoreDeleter(this)

    private val rust: RustRoot by lazy { RustRoot(health, libraryDeleter) }

    /**
     * THE OS ASKING FOR MEMORY BACK (#1025 S7-13). Every held vault's core is open so a switch is a
     * pointer move; the bound on that is this callback, and Rust's shelf closes every core but the
     * one in front. Every level, the trims a backgrounded process gets included.
     */
    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        val open = AppSession.current.value ?: return
        open.scope.launch { open.screens.memoryWarning() }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // A secret copied before the app was killed is cleared once its deadline has passed.
        ClipboardDeadline.sweep(applicationContext)
        // EDGE TO EDGE: the page ground is the emitted `bg` and reaches the notch; the insets are paid
        // back by `safeDrawingPadding` below, the only place this shell knows a system bar exists.
        enableEdgeToEdge()
        placeDemoVaults()
        // THE DEMO VAULT'S SEED, HANDED TO A DEBUG BUILD AT LAUNCH (#1047 W2):
        // `mobile/scripts/demo-vault.sh android` starts the activity with the public all-`abandon`
        // words' seed as an extra, and the shelf stores it where a real seed lives. A build that is
        // not debuggable never reads the extra.
        val devSeed = if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            intent?.getStringExtra(DEV_SEED_EXTRA)?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
        } else {
            null
        }
        setContent {
            // THE MEMBER'S APPEARANCE (R-CHROME-7) is Rust's: Home's header key flips it.
            val phoneDark = isSystemInDarkTheme()
            CentraidTheme(dark = rust.dark(phoneDark)) {
                val scope = rememberCoroutineScope()
                // THE PROCESS'S ONE SESSION, held for as long as this composition lives: opened here or
                // by a background pass that got there first. Not cancellable while it opens, and
                // released in `finally`, so a fast rotation still gives its hold back.
                val session by produceState<AppSession.Open?>(null) {
                    val opened = withContext(NonCancellable) { AppSession.acquire(applicationContext, devSeed) }
                    if (opened == null) return@produceState
                    try {
                        rust.attach(opened, scope)
                        value = opened
                        awaitCancellation()
                    } finally {
                        rust.detach()
                        AppSession.release()
                    }
                }
                // A PHOTOGRAPH'S SCREENS STAND ON `stage` edge to edge, so the ground under the system
                // bars follows and the bars' icons turn light to be read on it.
                val onStage = rust.onStage()
                val view = LocalView.current
                val darkScheme = centraidDark()
                SideEffect {
                    WindowCompat.getInsetsController(window, view).apply {
                        val light = !onStage && !darkScheme
                        isAppearanceLightStatusBars = light
                        isAppearanceLightNavigationBars = light
                    }
                }
                Box(
                    Modifier
                        .fillMaxSize()
                        // EVERY TEST TAG IS A RESOURCE ID (#1128, Q-1128-2), so Maestro's `id:`
                        // selectors see the Compose `testTag`s as they see iOS identifiers.
                        .semantics { testTagsAsResourceId = true }
                        .background(centraidColor(if (onStage) "stage" else "bg"))
                        .safeDrawingPadding(),
                ) {
                    if (session != null) rust.Content(phoneDark = phoneDark)
                }
            }
        }
    }

    /**
     * A PLACED DEMO VAULT (`mobile/scripts/demo-vault.sh`): every `<name>.sqlite3` asset lands as
     * `filesDir/<name>/vault.db`, one directory per vault, which is where the Rust shelf looks
     * (`docs/mobile-offline.md`). A vault is never founded in its place; an empty directory is the
     * ordinary first run. Off the main thread is not needed: it runs once, before the core opens.
     */
    private fun placeDemoVaults() {
        for (name in assets.list("")?.filter { it.endsWith(".sqlite3") }.orEmpty()) {
            val home = java.io.File(filesDir, name.substringBeforeLast('.'))
            val file = java.io.File(home, VAULT_FILE)
            if (file.exists()) continue
            runCatching {
                home.mkdirs()
                assets.open(name).use { source -> file.outputStream().use { sink -> source.copyTo(sink) } }
            }.onFailure { Log.w("Centraid", "could not place $name: ${it.message}") }
        }
    }

    private companion object {
        /** The launch extra a debug build reads its demo seed from. */
        const val DEV_SEED_EXTRA: String = "dev.centraid.DEV_SEED"

        /** One vault's file in its directory (`vault::files`). */
        const val VAULT_FILE: String = "vault.db"
    }
}
