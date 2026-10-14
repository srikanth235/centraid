package dev.centraid.shared.apps.money

import centraid.screen.v1.MoneyAccountsEvent
import centraid.screen.v1.MoneyAccountsState
import centraid.screen.v1.MoneyCategoriesEvent
import centraid.screen.v1.MoneyCategoriesState
import centraid.screen.v1.MoneyHomeEvent
import centraid.screen.v1.MoneyHomeState
import centraid.screen.v1.MoneyImportEvent
import centraid.screen.v1.MoneyImportState
import centraid.screen.v1.MoneyRecurringEvent
import centraid.screen.v1.MoneyRecurringState
import centraid.screen.v1.MoneyRulesEvent
import centraid.screen.v1.MoneyRulesState
import centraid.screen.v1.MoneySearchEvent
import centraid.screen.v1.MoneySearchState
import centraid.screen.v1.MoneyTargetEvent
import centraid.screen.v1.MoneyTargetState
import centraid.screen.v1.MoneyTransactionEvent
import centraid.screen.v1.MoneyTransactionState
import com.squareup.wire.Message
import com.squareup.wire.ProtoAdapter
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.shell.HomeSession
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlin.random.Random

/**
 * WHAT BOTH SHELLS HOLD FOR ONE MONEY SCREEN. Tasks' bridge shape: bytes across
 * to SwiftUI, nothing `suspend`, and only the screen ever leaves; the raw answers
 * stay in [MoneyHeld]. Each screen names a subclass so the Swift symbol is the
 * screen's own (`MoneyHomeBridge`, ...), and a pushed screen is opened with one
 * call.
 */
public open class MoneyBridge<S : Message<S, *>, E : Message<E, *>>(
    machine: ScreenMachine<MoneyHeld<S>, MoneyInput<E>>,
    private val events: ProtoAdapter<E>,
    private val wire: (HomeSession, ScreenHost<MoneyHeld<S>, MoneyInput<E>>, () -> Boolean) -> Unit,
    dispatcher: CoroutineDispatcher = Dispatchers.Main,
) {
    /** One host per bridge, never re-created (`ChangeStream.route` holds it). */
    public val host: ScreenHost<MoneyHeld<S>, MoneyInput<E>> = ScreenHost(machine)

    /** The bridge's one queue; the import page's plan runner launches on it. */
    protected val scope: CoroutineScope = CoroutineScope(SupervisorJob() + dispatcher)
    private var onState: ((ByteArray) -> Unit)? = null
    private var outliving: CoroutineScope? = null

    @kotlin.concurrent.Volatile
    private var hasLeft: Boolean = false

    /** Put this screen on the session's core, once per bridge, and publish. */
    public open fun attach(session: HomeSession) {
        outliving = session.outliving
        wire(session, host) { hasLeft }
        scope.launch {
            host.state.map { it.screen }.distinctUntilChanged().collect { onState?.invoke(it.encode()) }
        }
    }

    /** The screen a view draws, now (Compose). */
    public val screen: S get() = host.state.value.screen

    /** Publish every screen state to [onState], starting with the current one. */
    public fun observe(onState: (ByteArray) -> Unit) {
        this.onState = onState
        onState(screen.encode())
    }

    /** Forward one event, encoded (SwiftUI). */
    public fun send(event: ByteArray) {
        forward(events.decode(event))
    }

    /** Forward one event (Compose). Named apart from [send] so Swift sees one `send(event:)`. */
    public fun forward(event: E) {
        hasLeft = false
        scope.launch { host.send(MoneyInput.View(event)) }
    }

    /** A Kotlin-side input from the shell's platform seam (a picked file). */
    protected fun deliver(input: MoneyInput<E>) {
        hasLeft = false
        scope.launch { host.send(input) }
    }

    /** The current screen state, encoded. */
    public fun current(): ByteArray = screen.encode()

    /** Close = done: the machine's `left` runs on the session's scope, then the bridge's is released. */
    public fun leave() {
        departed()
        close()
    }

    /** The screen closed and the bridge stays: a write in flight is reported as stranded if it fails. */
    public fun departed() {
        hasLeft = true
        val event = host.machine.left() ?: return
        outliving?.launch(start = CoroutineStart.UNDISPATCHED) { host.send(event) }
    }

    /** Release the scope. A screen that is gone reduces nothing. */
    public fun close() {
        hasLeft = true
        scope.cancel()
    }

    public companion object {
        /** A sitting's token: unique enough to tell two sittings apart, and nothing else. */
        public fun token(): String = Random.nextLong().toULong().toString(TOKEN_RADIX)

        private const val TOKEN_RADIX: Int = 36
    }
}

public class MoneyHomeBridge :
    MoneyBridge<MoneyHomeState, MoneyHomeEvent>(
        machine = MoneyHomeMachine,
        events = MoneyHomeEvent.ADAPTER,
        wire = { session, host, left -> session.attachQueries(host, MoneyHomeReads, MoneyHomeReads, left = left) },
    ) {
    /** Land on [destination]. */
    public fun open(destination: MoneyHomeState.Destination) {
        forward(MoneyHomeEvent(opened = MoneyHomeEvent.Opened(destination = destination)))
    }

    /** Swift cannot omit a Kotlin default argument: this is the call with it spelled out. */
    public fun open() {
        open(MoneyHomeState.Destination.DESTINATION_SPENDING)
    }
}

public class MoneyTransactionBridge :
    MoneyBridge<MoneyTransactionState, MoneyTransactionEvent>(
        machine = MoneyTransactionMachine,
        events = MoneyTransactionEvent.ADAPTER,
        wire = { session, host, left -> session.attachQueries(host, MoneyTransactionReads, MoneyTransactionReads, left = left) },
    ) {
    /** [parent] is the pushing page's own title, which the back control says. */
    public fun open(txnId: String, parent: String) {
        forward(
            MoneyTransactionEvent(opened = MoneyTransactionEvent.Opened(txn_id = txnId, parent = parent, draft_token = token())),
        )
    }

    public fun open(txnId: String) {
        open(txnId, "")
    }
}

public class MoneyTargetBridge :
    MoneyBridge<MoneyTargetState, MoneyTargetEvent>(
        machine = MoneyTargetMachine,
        events = MoneyTargetEvent.ADAPTER,
        wire = { session, host, left -> session.attachQueries(host, MoneyTargetReads, MoneyTargetReads, left = left) },
    ) {
    /** [month] is `YYYY-MM`; [currency] is the category line's, which a plan is per. */
    public fun open(month: String, categoryId: String, currency: String) {
        forward(
            MoneyTargetEvent(
                opened = MoneyTargetEvent.Opened(month = month, category_id = categoryId, currency = currency, draft_token = token()),
            ),
        )
    }
}

public class MoneyRecurringBridge :
    MoneyBridge<MoneyRecurringState, MoneyRecurringEvent>(
        machine = MoneyRecurringMachine,
        events = MoneyRecurringEvent.ADAPTER,
        wire = { session, host, left -> session.attachQueries(host, MoneyRecurringReads, MoneyRecurringReads, left = left) },
    ) {
    public fun open(parent: String) {
        forward(MoneyRecurringEvent(opened = MoneyRecurringEvent.Opened(parent = parent)))
    }

    public fun open() {
        open("")
    }
}

/**
 * `money.import`, both shells. `ChooseTapped` is the shell's cue to open the OS
 * picker (`.fileImporter` on iOS, the Storage Access Framework's `OpenDocument`
 * on Android) and read the chosen file's bytes from the picker's own URI, never
 * copying them into app storage, then call [picked]; a dismissed picker changes
 * nothing. The bridge runs each plan the machine asks for ONCE per token and
 * answers it; publishing is the machine's own write.
 */
public class MoneyImportBridge :
    MoneyBridge<MoneyImportState, MoneyImportEvent>(
        machine = MoneyImportMachine,
        events = MoneyImportEvent.ADAPTER,
        wire = { session, host, left -> session.attachQueries(host, MoneyImportReads, MoneyImportReads, left = left) },
    ) {
    private var worked: Long = 0L

    override fun attach(session: HomeSession) {
        super.attach(session)
        runPlans(CoreMoneyDoor { session.shelf.core() })
    }

    /** The plan runner on its own: the seam a spec wires a fake door through. */
    internal fun runPlans(door: MoneyDoor) {
        scope.launch {
            host.state.map { it.job }.distinctUntilChanged().collect { job ->
                if (job != null && job.token > worked) {
                    worked = job.token
                    val held = host.state.value
                    val file = held.file
                    val ask = MoneyImportMachine.askOf(held)
                    val outcome = if (file == null || ask == null) {
                        MoneyPlanOutcome.Unreachable(dev.centraid.design.copy.MoneyCopy.NO_ANSWER)
                    } else {
                        door.plan(file.bytes, ask, platformServices().clock.read().zone)
                    }
                    host.send(MoneyInput.Planned(job.token, outcome))
                }
            }
        }
    }

    public fun open(parent: String) {
        forward(MoneyImportEvent(opened = MoneyImportEvent.Opened(parent = parent, draft_token = token())))
    }

    public fun open() {
        open("")
    }

    /** The OS picker's file, as it was on disk. */
    public fun picked(name: String, bytes: ByteArray) {
        deliver(MoneyInput.Picked(name, bytes))
    }
}

public class MoneyAccountsBridge :
    MoneyBridge<MoneyAccountsState, MoneyAccountsEvent>(
        machine = MoneyAccountsMachine,
        events = MoneyAccountsEvent.ADAPTER,
        wire = { session, host, left -> session.attachQueries(host, MoneyAccountsReads, MoneyAccountsReads, left = left) },
    ) {
    public fun open(parent: String) {
        forward(MoneyAccountsEvent(opened = MoneyAccountsEvent.Opened(parent = parent, draft_token = token())))
    }

    public fun open() {
        open("")
    }
}

public class MoneyRulesBridge :
    MoneyBridge<MoneyRulesState, MoneyRulesEvent>(
        machine = MoneyRulesMachine,
        events = MoneyRulesEvent.ADAPTER,
        wire = { session, host, left -> session.attachQueries(host, MoneyRulesReads, MoneyRulesReads, left = left) },
    ) {
    public fun open(parent: String) {
        forward(MoneyRulesEvent(opened = MoneyRulesEvent.Opened(parent = parent, draft_token = token())))
    }

    public fun open() {
        open("")
    }
}

public class MoneyCategoriesBridge :
    MoneyBridge<MoneyCategoriesState, MoneyCategoriesEvent>(
        machine = MoneyCategoriesMachine,
        events = MoneyCategoriesEvent.ADAPTER,
        wire = { session, host, left -> session.attachQueries(host, MoneyCategoriesReads, MoneyCategoriesReads, left = left) },
    ) {
    public fun open(parent: String) {
        forward(MoneyCategoriesEvent(opened = MoneyCategoriesEvent.Opened(parent = parent, draft_token = token())))
    }

    public fun open() {
        open("")
    }
}

public class MoneySearchBridge :
    MoneyBridge<MoneySearchState, MoneySearchEvent>(
        machine = MoneySearchMachine,
        events = MoneySearchEvent.ADAPTER,
        wire = { session, host, left -> session.attachQueries(host, MoneySearchReads, MoneySearchReads, left = left) },
    ) {
    public fun open() {
        forward(MoneySearchEvent(opened = MoneySearchEvent.Opened()))
    }
}
