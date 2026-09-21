package dev.centraid.shared.shell

import centraid.screen.v1.HomeEvent
import centraid.screen.v1.HomeState
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.sync.DrainPass
import dev.centraid.shared.sync.ShelfDrain
import dev.centraid.shared.sync.TransferRule
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * What SwiftUI holds instead of a `StateFlow` (#1020, wave A).
 *
 * `ScreenHost` is the right shape for Kotlin and the wrong shape for Swift:
 * `send` is `suspend` and `state` is a `StateFlow`, neither of which crosses the
 * Kotlin/Native boundary as anything a SwiftUI view can use. This is the
 * adapter, and it is deliberately the only one — `mobile/README.md` names
 * "the bridge from SwiftUI to `ScreenHost`" as the first thing an iOS session
 * connects.
 *
 * **BYTES, NOT OBJECTS.** The state crosses as an encoded `HomeState` and the
 * event arrives as an encoded `HomeEvent`, which is the same choice
 * `centraid.screen.v1.ScreenState` makes for the same reason: Swift decodes it
 * with SwiftProtobuf from the same schema Wire reads here, so one fixture
 * proves both sides. Handing Swift a Kotlin object instead would put an
 * Objective-C bridging layer between the two shells and give the contract two
 * shapes.
 *
 * Android does NOT use this: Compose collects the `StateFlow` directly, because
 * on that side it already is the right shape.
 */
public class HomeBridge {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    /**
     * The live session, once the core is open.
     *
     * Null until then, and the view draws `HomeMachine.initial()` in the
     * meantime — which is the loading grid, and is true.
     */
    private var session: HomeSession? = null
    private var onState: ((ByteArray) -> Unit)? = null

    /**
     * The drain over this device's shelf, once there is one.
     *
     * The SESSION's, not this bridge's: a pass is over the shelf and the shelf
     * is the session's, and Android reaches the same object without going
     * through this adapter at all. Null before the session exists, for the same
     * reason [session] is — a background window that arrives before the app has
     * finished launching has nothing to drain, which is not a failure.
     */
    private val shelfDrain: ShelfDrain? get() = session?.drain

    /**
     * Who is waiting for the session, so the app screens can be attached to it
     * (#1025 S5, lane L5).
     *
     * The session is opened asynchronously — [open] says why it cannot be a
     * constructor — so a shell that wanted to attach a screen to it had nothing
     * to attach to at the moment it was assembling its views. A callback rather
     * than a nullable getter the shell polls: there is exactly one moment the
     * session comes into existence, and a poll would either miss it or spin.
     *
     * This carries a `HomeSession` and never a screen, which is what keeps it
     * inside `PerAppLayoutSpec`'s second rule — the app bridges name their own
     * types, in their own packages, and this file names none of them.
     */
    private val waitingForSession = mutableListOf<(HomeSession) -> Unit>()

    /**
     * Run [attach] against the session, now or as soon as there is one.
     *
     * Called immediately when the session is already open, because a shell that
     * assembled a screen late would otherwise wait for a moment that has passed.
     */
    public fun onSession(attach: (HomeSession) -> Unit) {
        val open = session
        if (open != null) attach(open) else waitingForSession += attach
    }

    /**
     * OPEN THIS DEVICE'S VAULTS, AND START PUBLISHING.
     *
     * Not in the constructor: opening a core is I/O that asserts it is not on
     * the UI thread, and a Swift `let` that blocked the main thread on SQLite
     * is the frozen app the assertion exists to catch.
     *
     * A DIRECTORY, not a list of paths (#1025 S5). Wave A took a list because
     * the shell enumerated whatever `.db` files had been PLACED in its
     * container; a device makes its own vaults now, so what the shell knows is
     * where they go and [Shelf] is what reads them. The empty directory — a
     * phone that has not made a vault yet — is the ordinary first run and not
     * an error: Home draws the empty shelf, and the member's next move is
     * [found].
     */
    public fun open(vaultDir: String) {
        scope.launch {
            val opened = HomeSession.open(
                vaultDir = vaultDir,
                services = platformServices(),
                dispatcher = Dispatchers.Default,
                uiThreadName = "main",
            )
            session = opened
            // THE WAITERS BEFORE THE COLLECT, because `collect` on a
            // `StateFlow` never returns: a screen attached after this line
            // would be attached never.
            waitingForSession.forEach { it(opened) }
            waitingForSession.clear()
            opened.state.collect { state -> onState?.invoke(state.encode()) }
        }
    }

    /**
     * Publish every state to [onState], starting with the current one.
     *
     * The callback fires on the main dispatcher because its only caller is a
     * SwiftUI `@Published` setter, and SwiftUI requires that. Nothing expensive
     * runs here — the reduce already happened.
     */
    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        // The FIRST state, immediately. A view that subscribed and then waited
        // for a change would draw nothing at all until a read landed.
        onState(HomeMachine.initial().encode())
    }

    /**
     * Forward one encoded event.
     *
     * Not `suspend`: a SwiftUI button cannot await, and a view that could await
     * a reducer would be a view holding the main thread while a screen thinks.
     * The launch is what keeps `send`'s ordering — one coroutine, one queue —
     * without the caller knowing there is one.
     */
    public fun send(event: ByteArray) {
        session?.send(HomeEvent.ADAPTER.decode(event))
    }

    /**
     * MAKE A VAULT ON THIS PHONE, and call back with what happened (#1029 §1).
     *
     * What replaces `pair`, which took a ticket, a device name and a platform
     * string and redeemed them against a gateway. None of the three has a
     * reader any more: a vault is founded here, so the only input is the tap.
     *
     * Not `suspend`, for the same reason [send] is not: a SwiftUI button cannot
     * await. The callback fires on the main dispatcher because its only caller
     * is a `@Published` setter.
     */
    public fun found(onOutcome: (FoundResult) -> Unit) {
        val session = this.session ?: return onOutcome(FoundResult.NoSession)
        scope.launch { onOutcome(session.found()) }
    }

    /**
     * THIS VAULT MOVED TO THE MEMBER'S OTHER PHONE (#1029 F1).
     *
     * Not `suspend`, for the same reason [send] is not. See
     * [HomeSession.vaultMoved] for who calls it and why there is no way back
     * through this door.
     */
    public fun vaultMoved(vaultId: String, atIso: String, unacked: Long) {
        val session = this.session ?: return
        scope.launch { session.vaultMoved(vaultId, atIso, unacked) }
    }

    /**
     * THE DRAIN, AS THE ONE DOOR BOTH SHELLS CALL (#1029 W18-6).
     *
     * A pass nobody invokes is the state W5B left with better copy, so the
     * trigger lives here rather than in either shell: iOS calls [drain] from
     * its two `BGTaskScheduler` handlers and [becameActive] from the scene
     * phase; Android calls [drain] from its `CoroutineWorker` and
     * [becameActive] from the lifecycle owner. What a pass IS stays in
     * `commonMain` ([ShelfDrain]).
     *
     * Not `suspend` and callback-shaped, for the same reason [send] is not: a
     * SwiftUI view cannot await, and a `BGTask` handler is a completion
     * callback already. [onDone] is handed whether every held vault's spool is
     * empty — which is exactly what `setTaskCompleted(success:)` takes.
     *
     * **`deadlineMs` is the WINDOW's, not a preference.** `0` is the
     * foreground's "no deadline" (`phone.proto`); a background handler passes
     * what the OS said it had.
     */
    public fun drain(deadlineMs: Long, onDone: (Boolean) -> Unit) {
        val drain = shelfDrain ?: return onDone(false)
        scope.launch { onDone(drained(drain.run(deadlineMs))) }
    }

    /** The app became active. See [drain]. */
    public fun becameActive(onDone: (Boolean) -> Unit = {}) {
        val drain = shelfDrain ?: return onDone(false)
        scope.launch { onDone(drained(drain.onBecameActive())) }
    }

    /**
     * A commit landed, debounced ([ShelfDrain.afterCommit]).
     *
     * Fire-and-forget: its caller is the change stream, which has nothing to
     * do with the answer and must not be made to wait for a network.
     */
    public fun afterCommit() {
        val drain = shelfDrain ?: return
        scope.launch { drain.afterCommit() }
    }

    /**
     * Every vault's spool empty.
     *
     * **A device holding nothing is drained**, which is true and is what a
     * background window should report: there was nothing to send and the task
     * finished. A vault whose pass was refused as busy is NOT drained — another
     * pass is still working, and claiming success would let iOS believe a
     * window did more than it did.
     */
    private fun drained(outcomes: List<ShelfDrain.Outcome>): Boolean = outcomes.all {
        val outcome = it.outcome
        outcome is DrainPass.Outcome.Ran && outcome.answer.drained
    }

    /**
     * "N changes since <date>" for the vault in front, or null (#1029 F1).
     *
     * A door on the bridge rather than a screen event, for the reason
     * [transferRule] is one: it is not a reduction. The line DOES have a slot
     * on `VaultLockup` now (#1029 W5) and every roster row carries it; this
     * answers the same derivation for a caller that wants the vault in front
     * without subscribing. See [HomeSession.frozenLine].
     */
    public fun frozenLine(): String? = session?.frozenLine

    /**
     * FORGET A VAULT (#1025 S7-9).
     *
     * The inverse of [found], and the same shape for the same reason: a
     * SwiftUI button cannot await. [onDone] fires when the shelf has closed
     * the core, deleted the file and its byte store, and rebound the session
     * onto whatever came forward.
     *
     * **On a phone that IS the vault this destroys the member's rows**, and
     * there is no copy on a gateway to fall back to. See `Shelf.forget`.
     */
    public fun forget(vaultId: String, onDone: () -> Unit = {}) {
        val session = this.session ?: return onDone()
        scope.launch {
            session.forget(vaultId)
            onDone()
        }
    }

    /**
     * THE MEMBER'S TRANSFER RULE, READ (#1025 S4, D-1025-S7-60).
     *
     * A door on the bridge rather than a screen event, because it is not a
     * reduction: reading it is a secure-store call, which is I/O, and the
     * sheet that shows it is chrome on both shells rather than a screen with a
     * machine of its own.
     *
     * The rule's WORD crosses and not the enum: an ordinary Kotlin enum
     * exports as an Objective-C class whose cases a Swift `switch` cannot be
     * exhaustive over, so both shells match on `TransferRule.stored` — the
     * same word the store holds — and `TransferRule.of` is the one parser.
     */
    public fun transferRule(onRule: (String) -> Unit) {
        scope.launch { onRule(TransferRule.read(platformServices().secureStore).stored) }
    }

    /**
     * THE MEMBER CHANGED IT.
     *
     * Written and then re-read to the callback, so a shell draws what the
     * store HOLDS rather than what it sent: an unknown word is the
     * conservative default (`TransferRule.of`), and a sheet showing the tap
     * rather than the answer would show a selection the next launch does not
     * have.
     *
     * **No pass is started from here.** A member changing a rule has not asked
     * for a sync; what the new rule governs is the NEXT window, and a rule
     * change that spent data immediately would be the opposite of the setting
     * on a member who has just chosen to spend less.
     */
    public fun setTransferRule(stored: String, onRule: (String) -> Unit = {}) {
        scope.launch {
            val rule = TransferRule.of(stored)
            TransferRule.write(platformServices().secureStore, rule)
            onRule(rule.stored)
        }
    }

    /**
     * The three rules, in the order a sheet lists them, each with the sentence
     * a member reads.
     *
     * FROM THE SHELL'S ONE COPY SOURCE (`TransferRule`), so iOS and Android
     * cannot word the same choice two ways — the reason every rule both shells
     * read lives in `commonMain` and not once per shell.
     */
    public fun transferRuleChoices(): List<TransferRuleChoice> =
        TransferRule.entries.map { TransferRuleChoice(it.stored, it.sentence) }

    /** The current state, for a view that needs one before it subscribes. */
    public fun current(): ByteArray =
        (session?.state?.value ?: HomeMachine.initial()).encode()

    /**
     * Release the scope. A screen that is gone reduces nothing.
     *
     * The cores are closed on the session's own scope and the scope is
     * cancelled after: closing N cores is N ABI calls and none of them belongs
     * on the caller's thread, which on iOS is the UI thread.
     */
    public fun close() {
        val going = session
        session = null
        if (going == null) {
            scope.cancel()
            return
        }
        scope.launch {
            going.close()
            scope.cancel()
        }
    }

    /**
     * THE OS IS ASKING FOR MEMORY BACK (#1025 S7-13).
     *
     * From iOS's `didReceiveMemoryWarning` and Android's `onTrimMemory`. Every
     * background vault's core is closed and the foreground's is kept; a rested
     * vault reopens on the next tap.
     */
    public fun rest() {
        val open = session ?: return
        scope.launch { open.rest() }
    }

    private fun HomeState.encode(): ByteArray = HomeState.ADAPTER.encode(this)
}

/**
 * One row of the transfer-rules sheet, as both shells draw it.
 *
 * A plain data class because it crosses to Swift: `stored` is what goes back
 * to [HomeBridge.setTransferRule] and `sentence` is what a member reads.
 */
public data class TransferRuleChoice(
    public val stored: String,
    public val sentence: String,
)
