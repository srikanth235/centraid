package dev.centraid.android.screens.locker

import android.content.ActivityNotFoundException
import android.content.Intent
import android.view.Window
import androidx.activity.compose.LocalActivity
import androidx.core.net.toUri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import centraid.screen.v1.LockerEditorEvent
import centraid.screen.v1.LockerGeneratorEvent
import centraid.screen.v1.LockerHomeEvent
import centraid.screen.v1.LockerHomeState
import centraid.screen.v1.LockerItemEvent
import centraid.screen.v1.LockerLockEvent
import centraid.screen.v1.LockerLockState
import dev.centraid.android.kit.AppBand
import dev.centraid.android.kit.AppPlace
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.TrashListScreen
import dev.centraid.android.screens.AppRoutes
import dev.centraid.android.screens.RouteNav
import dev.centraid.android.screens.words.SecureHolds
import dev.centraid.design.copy.LockerCopy
import dev.centraid.shared.apps.locker.LockerEditorBridge
import dev.centraid.shared.apps.locker.LockerGeneratorBridge
import dev.centraid.shared.apps.locker.LockerHomeBridge
import dev.centraid.shared.apps.locker.LockerItemBridge
import dev.centraid.shared.apps.locker.LockerLockBridge
import dev.centraid.shared.apps.locker.LockerTrashBridge
import dev.centraid.shared.nav.Destination
import dev.centraid.shared.nav.NavStack
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * LOCKER'S ROUTES (#1047, D-5): `locker.home` (Items · Review · Generate ·
 * Search, More as a sheet) and every page pushed from it, one bridge each for
 * the activity's life — and [LockerLockBridge], the wall and the platform
 * seam, held here for the same life.
 *
 * **Every Locker destination is drawn under the wall while `cover` is set.**
 * The bridges are still opened underneath (a read waits for the gate, and the
 * machines wipe what they held on a relock), but nothing of Locker is drawn
 * until the gate says UNLOCKED.
 *
 * **While `secure` is set, the activity's window carries `FLAG_SECURE`**:
 * screenshots, recordings and the recents thumbnail of an open Locker are
 * blank. The hold is taken inside [Routes], so a relock (the gate clears
 * `secure`) or leaving Locker for any other destination lets it go. Locker's
 * sheets and dialogs are windows made after the hold, whose default
 * `SecureFlagPolicy.Inherit` copies the flag from this window.
 */
public class LockerRoutes(
    /**
     * THE WALL'S "Enter your 24 words" (#1047 E3): the shell opens words.enter
     * for PURPOSE_REKEY. The gate hears `WordsTapped` first (it ignores it).
     */
    private val openWords: () -> Unit = {},
) : AppRoutes {
    private val lock = LockerLockBridge()
    private val home = LockerHomeBridge()
    private val item = LockerItemBridge()
    private val editor = LockerEditorBridge()
    private val generator = LockerGeneratorBridge()
    private val trash = LockerTrashBridge()

    /** The wall's state, for Compose: the bridge's own bytes, decoded as they are published. */
    private val wall = MutableStateFlow(lock.lock)

    /** The last prompt token raised: the OS prompt goes up once per token. */
    private var raised: Long = 0L

    /**
     * A PROMPT IS UP. The device-credential screen on older Android is an
     * activity of its own, so ours stops under it — and a stop there is the
     * prompt, not the member leaving; the relock would drop the very prompt
     * being answered. (A member who does leave cancels the prompt, which
     * answers CANCELLED; nothing is open meanwhile.)
     */
    private var prompting: Boolean = false

    /** The window a Locker page is drawn in while one is on screen, or null. */
    private var shown: Window? = null

    /** The window this route holds `FLAG_SECURE` on, or null. */
    private var held: Window? = null

    /** The application, once the seam has run: the clipboard's context. */
    private var app: android.content.Context? = null

    /** The wall's last `clipboard_clear` acted on: once per new value. */
    private var cleared: Long = lock.lock.clipboard_clear

    init {
        lock.observe { bytes ->
            val next = LockerLockState.ADAPTER.decode(bytes)
            wall.value = next
            shield()
            // THE MEMBER LOCKED: Locker's own copy comes off the clipboard.
            if (next.clipboard_clear > cleared) {
                cleared = next.clipboard_clear
                app?.let { LockerSeam.clearOwn(it) }
            }
        }
    }

    /**
     * THE CAPTURE SHIELD, FOLLOWING THE GATE AS IT PUBLISHES (#1047): on
     * exactly while a Locker page is on screen and the gate says `secure`.
     * Applied from the bridge's own callback and not from a lifecycle-aware
     * collection, which is paused while the activity is stopped — so a relock
     * by `ON_STOP` drops the flag then, not on the way back, when the window's
     * surface had already come back shielded (the #1047 walk: a black
     * screenshot until the next background).
     */
    private fun shield() {
        val want = shown?.takeIf { wall.value.secure }
        if (want === held) return
        held?.let { SecureHolds.release(it) }
        want?.let { SecureHolds.take(it) }
        held = want
    }

    /**
     * THE GATE RE-READS THE PHONE'S LOCK AND `keyed`: words.enter just closed,
     * and a re-key that landed turns "Enter your 24 words" into "Unlock with …".
     */
    public fun reattach(context: android.content.Context) {
        lock.forward(LockerSeam.attached(context))
    }

    override fun handles(destination: Destination): Boolean = when (destination) {
        is Destination.LockerHome, is Destination.LockerItem, is Destination.LockerEditor,
        Destination.LockerGenerator, Destination.LockerTrash,
        -> true
        else -> false
    }

    override fun opens(moveId: String): Destination? = if (moveId == "locker") {
        home.open()
        Destination.LockerHome()
    } else {
        null
    }

    override fun attach(session: HomeSession, scope: CoroutineScope) {
        lock.attach(session)
        home.attach(session)
        item.attach(session)
        editor.attach(session)
        generator.attach(session)
        trash.attach(session)
    }

    /**
     * THE SEAM, WHEREVER THE MEMBER IS: the lifecycle (`ON_STOP` relocks —
     * not `ON_PAUSE`, which the prompt itself causes — and `ON_START`
     * re-reads the phone's lock and the core's session), and the OS prompt,
     * raised once per token the wall carries.
     */
    @Composable
    override fun Global(nav: RouteNav) {
        val context = LocalContext.current
        app = context.applicationContext
        val owner = LocalLifecycleOwner.current
        DisposableEffect(owner) {
            val observer = LifecycleEventObserver { _, event ->
                when (event) {
                    Lifecycle.Event.ON_STOP -> if (!prompting) lock.backgrounded()
                    Lifecycle.Event.ON_START -> if (!prompting) {
                        lock.forward(LockerSeam.attached(context))
                        lock.foregrounded()
                    }
                    else -> Unit
                }
            }
            owner.lifecycle.addObserver(observer)
            onDispose { owner.lifecycle.removeObserver(observer) }
        }
        val state by wall.collectAsStateWithLifecycle()
        val prompt = state.prompt
        LaunchedEffect(prompt?.token) {
            if (prompt == null || prompt.token == 0L || prompt.token <= raised) return@LaunchedEffect
            val activity = context as? FragmentActivity
            raised = prompt.token
            if (activity == null) {
                lock.forward(answered(prompt.token, LockerLockEvent.PromptAnswered.Outcome.OUTCOME_FAILED))
                return@LaunchedEffect
            }
            prompting = true
            LockerSeam.raise(activity, prompt) { outcome ->
                prompting = false
                lock.forward(answered(prompt.token, outcome))
            }
        }
    }

    @Composable
    override fun Routes(destination: Destination, nav: RouteNav) {
        val context = LocalContext.current
        // ON ENTERING LOCKER: the phone's lock, read now (a passcode may have
        // been set since the last look).
        LaunchedEffect(Unit) { lock.forward(LockerSeam.attached(context)) }
        val state by wall.collectAsStateWithLifecycle()
        // THE CAPTURE SHIELD (#1047): a Locker page is on screen while this
        // composes; `shield` adds the gate's `secure`, and leaving drops it.
        val window = LocalActivity.current?.window
        DisposableEffect(window) {
            shown = window
            shield()
            onDispose {
                shown = null
                shield()
            }
        }
        val unlock = { lock.forward(LockerLockEvent(unlock = LockerLockEvent.UnlockTapped())) }
        val words = {
            lock.forward(LockerLockEvent(words = LockerLockEvent.WordsTapped()))
            openWords()
        }
        when (destination) {
            is Destination.LockerHome -> HomeRoute(nav, state, unlock, words)
            is Destination.LockerItem -> {
                LaunchedEffect(destination) { item.open(destination.itemId, destination.parent) }
                // LEAVING CONCEALS: whatever was revealed goes with the page.
                DisposableEffect(destination) { onDispose { item.departed() } }
                val held by item.host.state.collectAsStateWithLifecycle()
                val screen = held.screen
                LockerClipboardEffect(screen.clipboard) { token ->
                    item.forward(LockerItemEvent(clipboard_done = LockerItemEvent.ClipboardDone(token = token)))
                }
                if (state.cover) {
                    CoveredPage(state, nav, unlock, words)
                } else {
                    LockerItemScreen(
                        screen,
                        onEvent = { event ->
                            item.forward(event)
                            if (event.edit != null) {
                                push(nav, Destination.LockerEditor(itemId = destination.itemId)) { editor.openEdit(destination.itemId) }
                            }
                        },
                        onOpen = { address -> open(context, address) },
                        onBack = nav::pop,
                    )
                }
            }
            is Destination.LockerEditor -> EditorRoute(destination, nav, state, unlock, words)
            Destination.LockerGenerator -> {
                LaunchedEffect(destination) { generator.open() }
                val held by generator.host.state.collectAsStateWithLifecycle()
                val screen = held.screen
                LockerClipboardEffect(screen.clipboard) { token ->
                    generator.forward(LockerGeneratorEvent(clipboard_done = LockerGeneratorEvent.ClipboardDone(token = token)))
                }
                if (state.cover) {
                    CoveredPage(state, nav, unlock, words)
                } else {
                    val parent = nav.stack.entries.getOrNull(nav.stack.entries.size - 2)
                    LockerGeneratorPage(
                        screen,
                        parent = if (parent is Destination.LockerEditor) editor.screen.chrome?.title.orEmpty() else home.screen.chrome?.title.orEmpty(),
                        onEvent = { event -> generated(nav, event) },
                        onBack = nav::pop,
                    )
                }
            }
            Destination.LockerTrash -> {
                LaunchedEffect(destination) { trash.open() }
                val held by trash.host.state.collectAsStateWithLifecycle()
                if (state.cover) CoveredPage(state, nav, unlock, words) else TrashListScreen(state = held, onEvent = trash::forward, onBack = nav::pop)
            }
            else -> Unit
        }
    }

    @Composable
    private fun HomeRoute(nav: RouteNav, wallState: LockerLockState, unlock: () -> Unit, words: () -> Unit) {
        val held by home.host.state.collectAsStateWithLifecycle()
        val state = held.screen
        val generated by generator.host.state.collectAsStateWithLifecycle()
        // THE ROUTE FOLLOWS THE MACHINE: a band tab swaps the top entry's parameter, never a push.
        LaunchedEffect(state.destination) {
            val band = state.destination
            val top = nav.stack.current
            if (band != LockerHomeState.Destination.DESTINATION_UNSPECIFIED && top is Destination.LockerHome && top.destination != band) {
                nav.go(NavStack(nav.stack.entries.dropLast(1) + top.copy(destination = band)))
            }
            // GENERATE DRAWS THE GENERATOR IN THE BAND'S SLOT, freshly opened.
            if (band == LockerHomeState.Destination.DESTINATION_GENERATE) generator.open()
        }
        val generatorScreen = generated.screen
        LockerClipboardEffect(generatorScreen.clipboard) { token ->
            generator.forward(LockerGeneratorEvent(clipboard_done = LockerGeneratorEvent.ClipboardDone(token = token)))
        }
        // THE WALL IN THE APP'S PLACE, with the band's Home (iOS draws the
        // same): a locked Locker is never a room with no way out but Back.
        if (wallState.cover) {
            AppPlace(
                app = "locker",
                title = state.chrome?.title.orEmpty().ifEmpty { LockerCopy.APP_NAME },
                band = { AppBand(app = "locker", tabs = emptyList(), onSelect = {}, onHome = nav::home) },
            ) { LockerWall(wallState, unlock, words) }
            return
        }
        LockerHomeScreen(
            state = state,
            generator = generatorScreen,
            onHome = nav::home,
            onGenerator = { event -> generated(nav, event) },
            onEvent = { event: LockerHomeEvent ->
                home.forward(event)
                val here = state.chrome?.title.orEmpty()
                when {
                    event.add != null -> push(nav, Destination.LockerEditor()) { editor.openAdd() }
                    event.item != null -> push(nav, Destination.LockerItem(event.item!!.item_id, parent = here))
                    event.more != null -> when (event.more!!.key) {
                        "trash" -> push(nav, Destination.LockerTrash)
                        "lock" -> lock.forward(LockerLockEvent(lock = LockerLockEvent.LockTapped()))
                        else -> Unit
                    }
                }
            },
        )
    }

    /** The generator's events; "Put it on an item" opens the editor with the output, bridge to bridge. */
    private fun generated(nav: RouteNav, event: LockerGeneratorEvent) {
        generator.forward(event)
        if (event.use != null) {
            push(nav, Destination.LockerEditor(type = "login", fromGenerator = true)) { editor.openAddFrom(generator) }
        }
    }

    /**
     * THE EDITOR: explicit Save. The machine says when it is done (a committed
     * save, a clean cancel, a confirmed discard, a relock) and the route pops
     * then — only on a change to done SEEN in this sitting (Tally's rule).
     */
    @Composable
    private fun EditorRoute(
        destination: Destination.LockerEditor,
        nav: RouteNav,
        wallState: LockerLockState,
        unlock: () -> Unit,
        words: () -> Unit,
    ) {
        val held by editor.host.state.collectAsStateWithLifecycle()
        val state = held.screen
        val seenOpen = remember(destination) { booleanArrayOf(false) }
        if (!state.done) seenOpen[0] = true
        LaunchedEffect(state.done) {
            if (state.done && seenOpen[0]) {
                seenOpen[0] = false
                if (nav.stack.current == destination) nav.pop()
            }
        }
        DisposableEffect(Unit) { onDispose { editor.departed() } }
        if (wallState.cover) {
            CoveredPage(wallState, nav, unlock, words)
        } else {
            LockerEditorScreen(state, onEvent = { event: LockerEditorEvent -> editor.forward(event) })
        }
    }

    /**
     * A PUSHED LOCKER PAGE, COVERED: the wall in a page whose back returns to
     * where the member came from (iOS `LockerCovered`).
     */
    @Composable
    private fun CoveredPage(wall: LockerLockState, nav: RouteNav, unlock: () -> Unit, words: () -> Unit) {
        PushedPage(title = "", parentTitle = LockerCopy.APP_NAME, onBack = nav::pop) { LockerWall(wall, unlock, words) }
    }

    /** A push, with the target bridge's open where the push is its reason to read. */
    private fun push(nav: RouteNav, destination: Destination, open: (() -> Unit)? = null) {
        open?.invoke()
        nav.go(nav.stack.push(destination))
    }

    private fun answered(token: Long, outcome: LockerLockEvent.PromptAnswered.Outcome): LockerLockEvent =
        LockerLockEvent(answered = LockerLockEvent.PromptAnswered(token = token, outcome = outcome))

    /** A login's address, handed to the browser the member uses. */
    private fun open(context: android.content.Context, address: String) {
        if (address.isBlank()) return
        val uri = address.toUri()
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            // No app takes a web address on this phone; the Copy verb beside it still does.
        }
    }
}
