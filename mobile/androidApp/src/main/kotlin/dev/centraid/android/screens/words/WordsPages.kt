package dev.centraid.android.screens.words

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import centraid.core.v1.PairingScanned
import centraid.core.v1.PhotoUnread
import centraid.core.v1.Route
import centraid.core.v1.ScanCapability
import centraid.core.v1.WordsEnterEvent
import centraid.core.v1.WordsEnterOrigin
import centraid.core.v1.WordsEnterPurpose
import centraid.core.v1.WordsEnterRoute
import centraid.core.v1.WordsEnterState
import centraid.core.v1.WordsMakeRoute
import centraid.core.v1.WordsShowRoute
import dev.centraid.android.kit.NoAutofill
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The routes of the 24 words' screens, for the shell's own doors (the vault
 * switcher, the empty shelf, Locker's wall, the Backup tab). Rust's screens carry
 * `Route`s in their views; Home is not Rust's yet, so these spell the same three
 * values until it is.
 */
internal object CustodyRoutes {
    fun make(): Route = Route(screen = "words.make", words_make = WordsMakeRoute())

    /** Restore onto this phone; a phone already holding a seed restores from it. */
    fun restore(): Route = enter(WordsEnterPurpose.WORDS_ENTER_PURPOSE_RESTORE, WordsEnterOrigin.WORDS_ENTER_ORIGIN_UNSPECIFIED)

    fun rekey(origin: WordsEnterOrigin): Route = enter(WordsEnterPurpose.WORDS_ENTER_PURPOSE_REKEY, origin)

    fun show(): Route = Route(screen = "words.show", words_show = WordsShowRoute())

    private fun enter(purpose: WordsEnterPurpose, origin: WordsEnterOrigin): Route =
        Route(screen = "words.enter", words_enter = WordsEnterRoute(purpose = purpose, origin = origin))
}

/**
 * `words.enter` AS A PAGE: the grid, and the platform halves of scanning the
 * gateway's pairing code. The CAMERA grant is asked for at the moment Scan is
 * tapped and never before; a refusal leaves the paste field. The photo picker is
 * Scan on a phone with no camera, or the camera screen's photo button: no grant
 * to ask for, the system picker hands back only the one image chosen.
 */
@Composable
internal fun WordsEnterPage(state: WordsEnterState, onEvent: (WordsEnterEvent) -> Unit) {
    SecureWindow(state.secure)
    NoAutofill()
    val context = LocalContext.current
    // WHAT THIS PHONE CAN SCAN WITH is the shell's to say, once.
    LaunchedEffect(Unit) {
        val camera = context.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
        onEvent(WordsEnterEvent(capability = ScanCapability(camera = camera)))
    }
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
    val scanned = { code: String? ->
        onEvent(
            if (code != null) {
                WordsEnterEvent(scanned = PairingScanned(payload = code))
            } else {
                WordsEnterEvent(unread = PhotoUnread())
            },
        )
    }
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
    WordsEntryScreen(state, onEvent, onScan = scan, onPhoto = pickPhoto)
    if (scanning) {
        PairScanner(
            photoLabel = state.photo_label,
            onRead = { payload ->
                scanning = false
                scanned(payload)
            },
            onPhoto = {
                scanning = false
                pickPhoto()
            },
            onCancel = { scanning = false },
        )
    }
}
