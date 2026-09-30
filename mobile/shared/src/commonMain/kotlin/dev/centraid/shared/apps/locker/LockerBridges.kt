package dev.centraid.shared.apps.locker

import centraid.core.v1.PageQuery
import centraid.core.v1.Row
import centraid.screen.v1.LockerEditorEvent
import centraid.screen.v1.LockerEditorState
import centraid.screen.v1.LockerGeneratorEvent
import centraid.screen.v1.LockerGeneratorState
import centraid.screen.v1.LockerHomeEvent
import centraid.screen.v1.LockerHomeState
import centraid.screen.v1.LockerItemEvent
import centraid.screen.v1.LockerItemState
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.TrashListEvent
import centraid.screen.v1.TrashListState
import dev.centraid.design.copy.LockerCopy
import dev.centraid.shared.kit.ScreenBridge
import dev.centraid.shared.kit.TrashCopy
import dev.centraid.shared.kit.TrashMachine
import dev.centraid.shared.kit.TrashReads
import dev.centraid.shared.kit.TrashSpec
import dev.centraid.shared.platform.platformServices
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.sync.ScreenReads
import dev.centraid.shared.sync.ScreenWrites
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch

/**
 * ONE BRIDGE PER LOCKER SCREEN (#1047), each with a stable Swift name and one
 * call to open it — plus [LockerLockBridge], the wall and the platform seam
 * (`LockerGate.kt`). A shell pushes the matching `Destination.Locker*`, calls
 * `open…`, forwards the screen's events and routes the intents it reads off
 * them (the machines change nothing on an intent).
 *
 * Every one of them rides [LockerGate.shared]: it reads when the Locker opens
 * and wipes what it held when it closes.
 */
public class LockerHomeBridge : LockerScreenBridge<LockerHomeState, LockerHomeEvent>(
    LockerHomeMachine,
    LockerHomeEvent.ADAPTER,
    LockerHomeReads,
) {
    /** Land on [destination] — Items unless the shell says otherwise. */
    public fun open(destination: LockerHomeState.Destination) {
        forward(LockerHomeEvent(opened = LockerHomeEvent.Opened(destination = destination)))
    }

    /** Items: the call Swift can make (default arguments do not cross). */
    public fun open() {
        open(LockerHomeState.Destination.DESTINATION_ITEMS)
    }
}

/**
 * One item. Its events carry CSPRNG bytes because a new custom field's id is
 * minted from them: a sealed value is bound to its field's id before the row
 * exists (D-1020-L9, #1047 T2).
 */
public class LockerItemBridge : LockerScreenBridge<LockerItemState, LockerItemEvent>(
    LockerItemMachine,
    LockerItemEvent.ADAPTER,
    LockerItemReads,
    entropy = ENTROPY_BYTES,
) {
    /** [parent] is the pushing page's title, which the back control says. */
    public fun open(itemId: String, parent: String) {
        forward(LockerItemEvent(opened = LockerItemEvent.Opened(item_id = itemId, parent = parent)))
    }

    public fun open(itemId: String) {
        open(itemId, "")
    }
}

/**
 * The editor. [openAdd] MINTS THE NEW ITEM'S ID here, from the platform
 * CSPRNG: the core seals a secret against its row's id, so the id exists
 * before the row does (D-1020-L9), and a double tap is one item.
 */
public class LockerEditorBridge : LockerScreenBridge<LockerEditorState, LockerEditorEvent>(
    LockerEditorMachine,
    LockerEditorEvent.ADAPTER,
    LockerEditorReads,
    entropy = ENTROPY_BYTES,
) {
    /** A new item of [type] (`login` when empty); [password] presets one, from the generator. */
    public fun openAdd(type: String, password: String) {
        forward(
            LockerEditorEvent(
                opened = LockerEditorEvent.Opened(
                    mode = LockerEditorState.Mode.MODE_ADD,
                    item_id = mintItemId(),
                    type = type,
                    password = password,
                ),
            ),
        )
    }

    public fun openAdd() {
        openAdd("", "")
    }

    /** "Put it on an item": a new login carrying [generator]'s output, handed over here and not through a route. */
    public fun openAddFrom(generator: LockerGeneratorBridge) {
        openAdd("login", generator.screen.output)
    }

    public fun openEdit(itemId: String) {
        forward(LockerEditorEvent(opened = LockerEditorEvent.Opened(mode = LockerEditorState.Mode.MODE_EDIT, item_id = itemId)))
    }
}

public class LockerGeneratorBridge : LockerScreenBridge<LockerGeneratorState, LockerGeneratorEvent>(
    LockerGeneratorMachine,
    LockerGeneratorEvent.ADAPTER,
    LockerGeneratorReads,
    entropy = ENTROPY_BYTES,
) {
    public fun open() {
        forward(LockerGeneratorEvent(opened = LockerGeneratorEvent.Opened()))
    }
}

/**
 * LOCKER'S TRASH, the kit's one trash screen (#1015 D1) with Locker as its
 * parameter: 30 days with the star and the tags kept, restore, and Delete
 * forever through `locker.purge_item` (confirmed). There is no Locker command
 * that empties the trash, so there is no "Empty trash" (R-1047-K5).
 */
public val LOCKER_TRASH: TrashSpec = TrashSpec(
    appId = "locker",
    table = "locker_item",
    restoreCommand = "locker.restore_item",
    purgeCommand = "locker.purge_item",
    emptyCommand = null,
    idColumn = "item_id",
    titleColumn = "title",
    purgeWindowDays = 30,
    purgeAtColumn = "purge_at",
    copy = TrashCopy(
        purgeTitle = LockerCopy.PURGE_TITLE,
        purgeBody = LockerCopy.PURGE_BODY,
        purgeAction = LockerCopy.PURGE_ACTION,
        emptyStateBody = LockerCopy.TRASH_EMPTY_BODY,
        purgesOn = LockerCopy.TRASH_PURGES_ON,
    ),
    backLabel = LockerCopy.APP_NAME,
)

/**
 * THE KIT'S TRASH READ, BEHIND THE GATE. A trash row is a title, and a title
 * is inside Locker: while the gate is closed there is no query, and the
 * runtime's refusal says the Locker is locked.
 */
public class LockerTrashReads(private val gate: LockerGate = LockerGate.shared) :
    ScreenReads<TrashListState, TrashListEvent>,
    ScreenWrites<TrashListState, TrashListEvent> {
    private val kit = TrashReads(LOCKER_TRASH)

    override val screenId: String get() = kit.screenId
    override val table: String get() = kit.table
    override val limit: Int get() = kit.limit
    override val appId: String get() = kit.appId

    override fun query(state: TrashListState, afterCursor: String?): PageQuery? =
        if (gate.open.value) kit.query(state, afterCursor) else null

    override fun query(state: TrashListState, afterCursor: String?, zone: String): PageQuery? =
        if (gate.open.value) kit.query(state, afterCursor, zone) else null

    override fun arrived(rows: List<Row>, nextCursor: String?): TrashListEvent = kit.arrived(rows, nextCursor)

    override fun arrived(rows: List<Row>, nextCursor: String?, answeredCursor: String?): TrashListEvent =
        kit.arrived(rows, nextCursor, answeredCursor)

    override fun refused(failure: ReadFailure): TrashListEvent =
        kit.refused(if (gate.open.value) failure else Reads.refused(LockerCopy.LOCKED_SENTENCE))

    override fun settled(status: centraid.core.v1.CommandStatus, sentence: String, invokeKey: String): TrashListEvent =
        kit.settled(status, sentence, invokeKey)
}

public val LockerTrashMachine: TrashMachine = TrashMachine(LOCKER_TRASH)

/**
 * The trash's bridge. A gate change re-reads the list: closed, the read is
 * refused and the titles go with it; open, they come back.
 */
public class LockerTrashBridge(private val gate: LockerGate = LockerGate.shared) : ScreenBridge<TrashListState, TrashListEvent>(
    machine = LockerTrashMachine,
    events = TrashListEvent.ADAPTER,
    wire = { w ->
        LockerGate.bind(w.session)
        val reads = LockerTrashReads(gate)
        w.session.attachScreen(w.host, reads, reads, left = w.left)
    },
) {
    private val watch = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    init {
        watch.launch { gate.open.drop(1).collect { forward(TrashListEvent(refreshed = TrashListEvent.Refreshed())) } }
    }

    public fun open() {
        forward(TrashListEvent(opened = TrashListEvent.Opened()))
    }
}

/** Bytes of CSPRNG a generating screen gets with each event: enough for 40 characters' rejection sampling. */
internal const val ENTROPY_BYTES: Int = 128

/** A fresh item id: 32 hex digits of CSPRNG. */
internal fun mintItemId(): String =
    platformServices().secureRandom.bytes(16).joinToString("") { (it.toInt() and 0xff).toString(16).padStart(2, '0') }
