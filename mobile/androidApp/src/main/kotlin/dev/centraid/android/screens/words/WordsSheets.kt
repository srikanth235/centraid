package dev.centraid.android.screens.words

import android.Manifest
import android.content.pm.PackageManager
import android.view.WindowManager
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.core.v1.Route
import centraid.screen.v1.PairLaptopEvent
import centraid.screen.v1.PairLaptopState
import dev.centraid.android.kit.NoAutofill
import dev.centraid.android.kit.SheetRoom
import dev.centraid.shared.custody.PairLaptopBridge
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * THE CUSTODY DOORS, AT THE ROOT (#1047 E3, E6; #1135). The 24 words' screens
 * (`words.make`, `words.enter`, `words.show`) are Rust's and are pushed like any
 * Rust route ([push], which `MainActivity` points at the Agenda routes' stack);
 * this class keeps the doors that open them (Home's make-vault and restore
 * controls, Locker's "Enter your 24 words" wall, the More sheet's rows) under
 * their old names, and the one sheet that is still a sheet: pair.laptop's, with
 * its camera and the CAMERA grant it asks for at the moment Scan is tapped.
 */
public class WordsSheets {
    public enum class Sheet { PAIR }

    private val pair = PairLaptopBridge()

    /** Push a Rust route onto the activity's stack. Set by `MainActivity`. */
    public var push: (Route) -> Unit = {}

    /** Which sheet is up, if any. */
    public var showing: Sheet? by mutableStateOf(null)
        private set

    /**
     * words.make's MADE sentence, with a count so the same sentence twice is
     * two arrivals: the vault sheet's status line, as `found`'s was.
     */
    public var made: Pair<Int, String> by mutableStateOf(0 to "")
        private set

    private var madeTaken = 0

    /** The MADE sentence not yet shown, once: Home's status line takes it. */
    public fun takeMade(): String? {
        val (count, sentence) = made
        if (count <= madeTaken || sentence.isEmpty()) return null
        madeTaken = count
        return sentence
    }

    /** A vault was made (`WordsMakeState.made_line`, once per make). */
    public fun vaultMade(sentence: String) {
        made = (made.first + 1) to sentence
    }

    private var attached = false
    private var pairLive = false

    public fun attach(session: HomeSession, scope: CoroutineScope) {
        pair.attach(session)
        attached = true
        scope.launch {
            pair.states.collect { state ->
                if (state.phase != PairLaptopState.Phase.PHASE_CLOSED) {
                    pairLive = true
                } else if (pairLive) {
                    pairLive = false
                    if (showing == Sheet.PAIR) showing = null
                }
            }
        }
    }

    /** MAKE A VAULT, THROUGH ITS WORDS: `words.make` decides what this phone needs. */
    public fun makeVault() {
        push(CustodyRoutes.make())
    }

    /** RESTORE ONTO THIS PHONE: a phone already holding a seed restores from it. */
    public fun openRestore() {
        push(CustodyRoutes.restore())
    }

    /** HAND THE WORDS BACK: Locker's wall's `WordsTapped`. */
    public fun openRekey() {
        push(CustodyRoutes.rekey(centraid.core.v1.WordsEnterOrigin.WORDS_ENTER_ORIGIN_LOCKER))
    }

    /** The same re-key from pair.laptop's `WordsTapped`, in pairing's words (#1047 F5). */
    private fun openRekeyForPairing() {
        push(CustodyRoutes.rekey(centraid.core.v1.WordsEnterOrigin.WORDS_ENTER_ORIGIN_PAIRING))
    }

    /** SHOW THE 24 WORDS AGAIN: the More sheet's row. Rust asks the owner check first. */
    public fun openShow() {
        push(CustodyRoutes.show())
    }

    /**
     * PAIR WITH THE LAPTOP: the More sheet's pairing row. [camera] — whether
     * this phone has one to scan with — is the one fact the machine is told.
     */
    public fun openPair(camera: Boolean) {
        if (!attached) return
        pair.open(camera)
        showing = Sheet.PAIR
    }

    /**
     * pair.laptop's events. `WordsTapped` IS AN INTENT: the machine closes the
     * pairing and the shell opens words.enter's re-key in its place — the
     * door Locker's wall has (#1047 E1).
     */
    private fun sendPair(event: PairLaptopEvent) {
        pair.forward(event)
        if (event.words != null) openRekeyForPairing()
    }

    /** THE SHEET WAS SWIPED AWAY (or backed out of): pair.laptop hears `Dismissed`. */
    private fun swipedAway(sheet: Sheet) {
        showing = null
        when (sheet) {
            Sheet.PAIR -> pair.forward(PairLaptopEvent(dismissed = PairLaptopEvent.Dismissed()))
        }
    }

    @Composable
    public fun Sheets() {
        val sheet = showing ?: return
        val pairState by pair.states.collectAsStateWithLifecycle()
        val context = LocalContext.current
        // THE CAMERA, ASKED FOR WHEN SCAN IS TAPPED AND NEVER BEFORE. A
        // refusal leaves the paste field, which is the whole screen without
        // a camera anyway.
        var scanning by remember { mutableStateOf(false) }
        val grant = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) scanning = true
        }
        val scan = {
            if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                scanning = true
            } else {
                grant.launch(Manifest.permission.CAMERA)
            }
        }
        // THE PHOTO PICKER — Scan on a phone with no camera, or the camera
        // screen's photo button: no grant to ask for, the system picker hands
        // back only the one image chosen. Backing out sends nothing.
        val scope = rememberCoroutineScope()
        val photo = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
            if (uri != null) {
                scope.launch {
                    val code = withContext(Dispatchers.Default) { runCatching { readSquare(context, uri) }.getOrNull() }
                    scanned(code)
                }
            }
        }
        val pickPhoto = {
            photo.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        }
        // Not swipeable while the core is pairing.
        val swipeable = pairState.phase != PairLaptopState.Phase.PHASE_PAIRING
        SheetRoom(
            title = "",
            onDismiss = { swipedAway(sheet) },
            swipeable = swipeable,
            secure = false,
            expanded = true,
        ) {
            NoAutofill()
            PairLaptopScreen(pairState, ::sendPair, onScan = scan, onPhoto = pickPhoto)
        }
        if (scanning) {
            PairScanner(
                photoLabel = pairState.photo_label,
                onRead = { payload ->
                    scanning = false
                    scanned(payload)
                },
                onPhoto = {
                    scanning = false
                    pair.forward(PairLaptopEvent(photo = PairLaptopEvent.PhotoTapped()))
                    pickPhoto()
                },
                onCancel = { scanning = false },
            )
        }
    }

    /** A scan's answer — the square's text, or null for a photo with none. */
    private fun scanned(code: String?) {
        pair.forward(
            if (code != null) {
                PairLaptopEvent(scanned = PairLaptopEvent.Scanned(payload = code))
            } else {
                PairLaptopEvent(unread = PairLaptopEvent.PhotoUnread())
            },
        )
    }
}

/**
 * DUTY 1 ON THE ACTIVITY'S WINDOW: screenshots, screen recording and the
 * recents thumbnail are blank while [secure] holds, and the flag is cleared as
 * soon as it does not.
 *
 * **Counted, because two screens may hold it at once**: an unlocked Locker
 * (`LockerLockState.secure`) under a words sheet. The flag is cleared only
 * when the last holder lets go, so a words sheet closing over an open Locker
 * does not unshield the Locker.
 */
@Composable
internal fun SecureWindow(secure: Boolean) {
    val activity = LocalActivity.current ?: return
    DisposableEffect(activity, secure) {
        if (secure) SecureHolds.take(activity.window)
        onDispose {
            if (secure) SecureHolds.release(activity.window)
        }
    }
}

/** Who holds `FLAG_SECURE` on which window. Main thread only, as composition is. */
internal object SecureHolds {
    private val holds = java.util.WeakHashMap<android.view.Window, Int>()

    fun take(window: android.view.Window) {
        val count = holds[window] ?: 0
        holds[window] = count + 1
        if (count == 0) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    fun release(window: android.view.Window) {
        val count = (holds[window] ?: 1) - 1
        if (count <= 0) {
            holds.remove(window)
            window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
        } else {
            holds[window] = count
        }
    }
}
