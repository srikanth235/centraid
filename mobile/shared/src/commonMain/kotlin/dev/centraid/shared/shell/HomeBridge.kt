package dev.centraid.shared.shell

import centraid.screen.v1.HomeEvent
import centraid.screen.v1.HomeState
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.sync.TransferRule
import dev.centraid.shared.sync.WakeReason
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
     * OPEN THIS DEVICE'S REPLICAS, AND START PUBLISHING.
     *
     * Not in the constructor: opening a core is I/O that asserts it is not on
     * the UI thread, and a Swift `let` that blocked the main thread on SQLite
     * is the frozen app the assertion exists to catch.
     *
     * A DIRECTORY, not a list of paths (#1025 S5). Wave A took a list because
     * the shell enumerated whatever `.db` files had been PLACED in its
     * container; a device makes its own replicas now, so what the shell knows
     * is where they go and [Replicas] knows what they are called. The empty
     * directory — a phone that has never paired — is the ordinary first run and
     * not an error: the core opens unpaired, Home draws, and the member's next
     * move is the gateway sheet.
     */
    public fun open(replicaDir: String) {
        scope.launch {
            val opened = HomeSession.open(
                replicaDir = replicaDir,
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
     * Redeem a pairing ticket, and call back with what happened (#1020,
     * D-1020-B7).
     *
     * Not `suspend`, for the same reason [send] is not: a SwiftUI button cannot
     * await. The callback fires on the main dispatcher because its only caller
     * is a `@Published` setter.
     *
     * A session with no core answers [PairOutcome.NoCore] rather than throwing.
     * That is the state a device is in before a vault is placed on it, and it
     * is not an error.
     *
     * The answer has THREE shapes and not two (#1025 S7-9): a vault that was
     * admitted and could be asked its own name, a vault that was admitted and
     * whose copy has not landed yet ([PairOutcome.Copying]), and a refusal. The
     * middle one exists because the ticket's `vault_name` is the gateway's CLI
     * flag and not the vault's `display_name`, so there is nothing truthful to
     * print until a replica can answer for itself.
     */
    public fun pair(
        ticket: String,
        deviceName: String,
        platform: String,
        onOutcome: (PairOutcome) -> Unit,
    ) {
        val session = this.session ?: return onOutcome(PairOutcome.NoCore)
        scope.launch { onOutcome(session.pair(ticket, deviceName, platform)) }
    }

    /**
     * FORGET A VAULT (#1025 S7-9).
     *
     * The inverse of [pair], and the same shape for the same reason: a SwiftUI
     * button cannot await. [onDone] fires when the shelf has closed the core,
     * deleted the replica and its byte store, dropped the pairing record and
     * the endpoint key, and rebound the session onto whatever came forward.
     *
     * **The gateway keeps this device enrolled.** Forgetting is local — it says
     * "this phone is not holding that vault any more", not "that vault should
     * stop trusting this phone", which is a decision for whoever holds the
     * vault to take on the gateway. See `Shelf.forget`.
     */
    public fun forget(vaultId: String, onDone: () -> Unit = {}) {
        val session = this.session ?: return onDone()
        scope.launch {
            session.forget(vaultId)
            onDone()
        }
    }

    /**
     * Run one sync ROUND — one pass per vault this device holds, foreground
     * first, under one shared window (#1025 S7-9).
     *
     * The pass BLOCKS the core's dispatcher for its duration — it is network
     * I/O — which is why it is launched rather than awaited and why nothing
     * here touches the UI thread beyond the callback.
     */
    public fun syncNow(wake: WakeReason = WakeReason.FOREGROUND, onOutcome: (SyncOutcome) -> Unit) {
        val session = this.session
            ?: return onOutcome(SyncOutcome(unreachable = true, sentence = "No vault is open."))
        scope.launch { onOutcome(session.syncNow(wake)) }
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
     * cannot word the same choice two ways — the reason `SyncWindowPolicy`
     * lives in `commonMain` and not in each shell.
     */
    public fun transferRuleChoices(): List<TransferRuleChoice> =
        TransferRule.entries.map { TransferRuleChoice(it.stored, it.sentence) }

    /**
     * THE MEMBER ARRIVED (#1025 S2, D-1025-S7-40).
     *
     * One round, then a tail on the foreground holding that stays open until
     * something closes it. This is what a shell calls when the app becomes
     * active — there is no timer to start beside it, and starting one would be
     * a second mechanism for the thing this one does.
     */
    public fun foreground(onOutcome: (SyncOutcome) -> Unit = {}) {
        val session = this.session
            ?: return onOutcome(SyncOutcome(unreachable = true, sentence = "No vault is open."))
        scope.launch { onOutcome(session.foreground()) }
    }

    /**
     * THE MEMBER LEFT, and the OS gave this device a window (#1025 S2).
     *
     * The tail is closed first — a stream parked on a quiet gateway would spend
     * the whole window waiting — and then one bounded round runs inside it.
     */
    public fun background(
        wake: WakeReason = WakeReason.SCHEDULED,
        onOutcome: (SyncOutcome) -> Unit = {},
    ) {
        val session = this.session ?: return onOutcome(SyncOutcome(unreachable = true))
        scope.launch { onOutcome(session.background(wake)) }
    }

    /**
     * CLOSE THE TAIL AND NOTHING ELSE. What locking and suspending do.
     *
     * No round follows: a device that is locked is a device whose decrypted
     * material is being cleared, and a pass would be work started at the moment
     * everything else is stopping.
     */
    public fun stopTail() {
        val open = session ?: return
        scope.launch { open.stopTail() }
    }

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
     * vault reopens on the next tap or the next sync round.
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
