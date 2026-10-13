package dev.centraid.android.screens.words

import android.Manifest
import android.content.pm.PackageManager
import android.view.WindowManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.compose.LocalActivity
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.screen.v1.PairLaptopEvent
import centraid.screen.v1.PairLaptopState
import centraid.screen.v1.VaultWordsEvent
import centraid.screen.v1.VaultWordsState
import centraid.screen.v1.WordsEntryEvent
import centraid.screen.v1.WordsEntryState
import centraid.screen.v1.WordsShowEvent
import centraid.screen.v1.WordsShowState
import dev.centraid.android.kit.NoAutofill
import dev.centraid.android.kit.SheetRoom
import dev.centraid.shared.custody.PairLaptopBridge
import dev.centraid.shared.custody.VaultWordsBridge
import dev.centraid.shared.custody.WordsEntryBridge
import dev.centraid.shared.custody.WordsShowBridge
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * THE CUSTODY SCREENS, AT THE ROOT (#1047 E3, E6). One sheet over whatever is
 * drawn — Home's make-vault and restore doors, Locker's "Enter your 24 words"
 * wall, and the More sheet's two custody rows (words.show and pair.laptop) —
 * so it is the activity's and not an app's route.
 *
 * It holds the four bridges for the activity's life and decides only which
 * sheet is up: a door opens one, and the machine's `PHASE_CLOSED` (seen after
 * an open in this sitting) takes it down. `RestoreTapped` is an INTENT the
 * make machine ignores: the shell closes words.make and opens words.enter for
 * the restore the state's `restore_purpose` names in its place (iOS
 * `ShellModel.sendVaultWords`).
 *
 * The platform halves are here too: words.show's owner check and its
 * `Dismissed` on leaving the foreground, and pair.laptop's camera and the
 * CAMERA grant it asks for at the moment Scan is tapped.
 */
public class WordsSheets(
    /** words.enter closed: the Locker gate re-reads `keyed` (a re-key may have landed). */
    private val onEnterClosed: () -> Unit,
) {
    public enum class Sheet { MAKE, ENTER, SHOW, PAIR }

    private val make = VaultWordsBridge()
    private val enter = WordsEntryBridge()
    private val show = WordsShowBridge()
    private val pair = PairLaptopBridge()

    /**
     * words.show's owner check is up. Its prompt may stop this activity (the
     * device credential on API 29 and below is an activity of its own), and
     * that is not the member leaving: `Dismissed` waits for the answer.
     */
    private var verifying = false

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

    private var attached = false
    private var makeLive = false
    private var enterLive = false
    private var showLive = false
    private var pairLive = false

    public fun attach(session: HomeSession, scope: CoroutineScope) {
        make.attach(session)
        enter.attach(session)
        show.attach(session)
        pair.attach(session)
        attached = true
        // A VAULT WAS MADE: its own signal, once per make — the closed state
        // that carries the sentence is followed at once by the dismissal, and
        // a state collector can be conflated past it.
        scope.launch { make.made.collect { sentence -> made = (made.first + 1) to sentence } }
        scope.launch {
            make.states.collect { state ->
                if (state.phase != VaultWordsState.Phase.PHASE_CLOSED) {
                    makeLive = true
                    if (makePending && showing == null && asksMember(state.phase)) {
                        makePending = false
                        showing = Sheet.MAKE
                    }
                } else if (makeLive) {
                    makeLive = false
                    makePending = false
                    if (showing == Sheet.MAKE) showing = null
                }
            }
        }
        scope.launch {
            enter.states.collect { state ->
                if (state.phase != WordsEntryState.Phase.PHASE_CLOSED) {
                    enterLive = true
                } else if (enterLive) {
                    enterLive = false
                    if (showing == Sheet.ENTER) showing = null
                    // THE GATE RE-READS `keyed` ON ITS NEXT EVENT: a re-key that
                    // just landed turns "Enter your 24 words" into "Unlock with …".
                    onEnterClosed()
                }
            }
        }
        scope.launch {
            show.states.collect { state ->
                if (state.phase != WordsShowState.Phase.PHASE_CLOSED) {
                    showLive = true
                } else if (showLive) {
                    showLive = false
                    if (showing == Sheet.SHOW) showing = null
                }
            }
        }
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

    /**
     * MAKE A VAULT, THROUGH ITS WORDS: what the make-vault control does now.
     *
     * THE SHEET RISES ONLY WHEN THE MEMBER HAS SOMETHING TO DO. A first vault
     * on a synced store is minted, kept unshown and made with no question
     * (R-ONBOARD-10), so a sheet raised at the tap drew "Making your vault"
     * for a moment and fell again before Home — a flicker. The states
     * collector raises it at a phase that asks the member ([asksMember]); a
     * make that never asks lands on Home with no sheet (iOS
     * `ShellModel.makeVault`).
     */
    public fun makeVault() {
        if (!attached) return
        makePending = true
        make.open()
    }

    /** A make is under way and its sheet is not up yet. */
    private var makePending = false

    /** words.make's phases that need the member: a name, the key, a failure, a restore. */
    private fun asksMember(phase: VaultWordsState.Phase): Boolean = when (phase) {
        VaultWordsState.Phase.PHASE_CHOOSE,
        VaultWordsState.Phase.PHASE_SHOW,
        VaultWordsState.Phase.PHASE_FAILED,
        VaultWordsState.Phase.PHASE_RESTORE_FIRST,
        -> true
        else -> false
    }

    /** RESTORE ONTO THIS PHONE (PURPOSE_RESTORE). */
    public fun openRestore() {
        if (!attached) return
        enter.openRestore()
        showing = Sheet.ENTER
    }

    /** HAND THE WORDS BACK (PURPOSE_REKEY): Locker's wall's `WordsTapped`. */
    public fun openRekey() {
        if (!attached) return
        enter.openRekey()
        showing = Sheet.ENTER
    }

    /** The same re-key from pair.laptop's `WordsTapped`, in pairing's words (#1047 F5). */
    private fun openRekeyForPairing() {
        if (!attached) return
        enter.openRekeyForPairing()
        showing = Sheet.ENTER
    }

    /** SHOW THE 24 WORDS AGAIN: the More sheet's `WordsCopy.SHOW_AGAIN_ROW`. */
    public fun openShow() {
        if (!attached) return
        showRequested = true
        show.open()
    }

    /**
     * words.show was opened and has not closed. NO SHEET BEFORE THE CHECK:
     * the machine opens in ASK with `check_now`, [ShowCheck] runs the owner
     * check, and the sheet goes up only once the machine has something to
     * draw.
     */
    private var showRequested by mutableStateOf(false)

    @Composable
    private fun ShowCheck() {
        val state by show.states.collectAsStateWithLifecycle()
        val activity = LocalActivity.current as? FragmentActivity
        LaunchedEffect(state, showRequested) {
            if (!showRequested) return@LaunchedEffect
            when {
                state.phase == WordsShowState.Phase.PHASE_CLOSED -> showRequested = false
                state.check_now -> verify(activity, state.verify_reason)
                state.phase != WordsShowState.Phase.PHASE_UNSPECIFIED && showing == null -> showing = Sheet.SHOW
            }
        }
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

    private fun sendMake(event: VaultWordsEvent) {
        // WHICH RESTORE IS THE STATE'S (#1047 E4): RESTORE_FIRST means this
        // phone holds a seed, so words.enter opens RESTORE_HELD — no words
        // to type, only the laptop's address. Read before the event moves it.
        val purpose = make.states.value.restore_purpose
        make.forward(event)
        if (event.restore != null) {
            showing = Sheet.ENTER
            make.forward(VaultWordsEvent(dismissed = VaultWordsEvent.Dismissed()))
            if (purpose == WordsEntryState.Purpose.PURPOSE_RESTORE_HELD) enter.openRestoreHeld() else enter.openRestore()
        }
    }

    /**
     * pair.laptop's events. `WordsTapped` IS AN INTENT: the machine closes the
     * pairing and the shell opens words.enter's re-key in its place — the
     * door Locker's wall has (#1047 E1). The sheet is swapped before the
     * machine's CLOSED arrives, so that arrival leaves the words sheet up.
     */
    private fun sendPair(event: PairLaptopEvent) {
        pair.forward(event)
        if (event.words != null) openRekeyForPairing()
    }

    /** words.show's owner check, answered as the machine's event. */
    private fun verify(activity: FragmentActivity?, reason: String) {
        if (verifying) return
        verifying = true
        ownerCheck(activity, reason) { ok, cancelled ->
            verifying = false
            show.forward(
                if (ok) {
                    WordsShowEvent(verified = WordsShowEvent.Verified())
                } else {
                    WordsShowEvent(verify_failed = WordsShowEvent.VerifyFailed(cancelled = cancelled))
                },
            )
        }
    }

    /**
     * THE SHEET WAS SWIPED AWAY (or backed out of). words.make, words.show
     * and pair.laptop hear `Dismissed`; words.enter has no dismissal of its
     * own and its way out is its Cancel — offered only while ENTERING.
     */
    private fun swipedAway(sheet: Sheet) {
        showing = null
        when (sheet) {
            Sheet.MAKE -> make.forward(VaultWordsEvent(dismissed = VaultWordsEvent.Dismissed()))
            Sheet.ENTER -> enter.forward(WordsEntryEvent(secondary = WordsEntryEvent.Secondary()))
            Sheet.SHOW -> show.forward(WordsShowEvent(dismissed = WordsShowEvent.Dismissed()))
            Sheet.PAIR -> pair.forward(PairLaptopEvent(dismissed = PairLaptopEvent.Dismissed()))
        }
    }

    @Composable
    public fun Sheets() {
        ShowCheck()
        val sheet = showing ?: return
        val makeState by make.states.collectAsStateWithLifecycle()
        val enterState by enter.states.collectAsStateWithLifecycle()
        val showState by show.states.collectAsStateWithLifecycle()
        val pairState by pair.states.collectAsStateWithLifecycle()
        val activity = LocalActivity.current as? FragmentActivity
        val context = LocalContext.current
        LeftForeground(sheet)
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
                    pair.forward(
                        if (code != null) {
                            PairLaptopEvent(scanned = PairLaptopEvent.Scanned(payload = code))
                        } else {
                            PairLaptopEvent(unread = PairLaptopEvent.PhotoUnread())
                        },
                    )
                }
            }
        }
        val pickPhoto = {
            photo.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
        }
        val secure = when (sheet) {
            Sheet.MAKE -> makeState.secure
            Sheet.ENTER -> enterState.secure
            Sheet.SHOW -> showState.secure
            Sheet.PAIR -> false
        }
        // A SWIPE IS A WAY OUT ONLY WHERE THE MACHINE HEARS ONE: not while the
        // key is kept or the vault made, and not while words.enter works.
        val swipeable = when (sheet) {
            Sheet.MAKE -> makeState.phase != VaultWordsState.Phase.PHASE_CHECKING &&
                makeState.phase != VaultWordsState.Phase.PHASE_MAKING
            Sheet.ENTER -> enterState.phase == WordsEntryState.Phase.PHASE_ENTERING
            // words.show can always be left: leaving drops the words.
            Sheet.SHOW -> true
            // Not while the core is pairing.
            Sheet.PAIR -> pairState.phase != PairLaptopState.Phase.PHASE_PAIRING
        }
        SecureWindow(secure)
        SheetRoom(
            title = "",
            onDismiss = { swipedAway(sheet) },
            swipeable = swipeable,
            secure = secure,
            expanded = true,
        ) {
            NoAutofill()
            when (sheet) {
                Sheet.MAKE -> VaultWordsScreen(makeState, ::sendMake)
                Sheet.ENTER -> WordsEntryScreen(enterState, enter::forward)
                Sheet.SHOW -> WordsShowScreen(showState, show::forward) { reason -> verify(activity, reason) }
                Sheet.PAIR -> PairLaptopScreen(pairState, ::sendPair, onScan = scan, onPhoto = pickPhoto)
            }
        }
        if (scanning && sheet == Sheet.PAIR) {
            PairScanner(
                photoLabel = pairState.photo_label,
                onRead = { payload ->
                    scanning = false
                    pair.forward(PairLaptopEvent(scanned = PairLaptopEvent.Scanned(payload = payload)))
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

    /**
     * words.show DROPS ITS WORDS WHEN THE APP LEAVES THE FOREGROUND, as a
     * swipe would: `Dismissed` on `ON_STOP` — but not while the owner check's
     * own prompt is up, which is not leaving.
     */
    @Composable
    private fun LeftForeground(sheet: Sheet) {
        val owner = LocalLifecycleOwner.current
        val current by rememberUpdatedState(sheet)
        DisposableEffect(owner) {
            val observer = LifecycleEventObserver { _, event ->
                if (event == Lifecycle.Event.ON_STOP && current == Sheet.SHOW && !verifying) {
                    show.forward(WordsShowEvent(dismissed = WordsShowEvent.Dismissed()))
                }
            }
            owner.lifecycle.addObserver(observer)
            onDispose { owner.lifecycle.removeObserver(observer) }
        }
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
