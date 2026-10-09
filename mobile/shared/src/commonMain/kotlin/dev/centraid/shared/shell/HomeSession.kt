package dev.centraid.shared.shell

import centraid.screen.v1.HomeEvent
import centraid.screen.v1.HomeState
import centraid.screen.v1.HomeStatus
import centraid.screen.v1.SeatState
import centraid.screen.v1.VaultLockup
import dev.centraid.core.CentraidCore
import dev.centraid.design.CentraidCatalog
import dev.centraid.design.copy.SharedCopy
import dev.centraid.shared.custody.DevSeed
import dev.centraid.shared.platform.BackgroundTasks
import dev.centraid.shared.platform.PlatformServices
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.sync.BackupReading
import dev.centraid.shared.sync.BackupStatusStore
import dev.centraid.shared.sync.ChangeStream
import dev.centraid.shared.sync.CoreBackupDoors
import dev.centraid.shared.sync.CoreBackupStatus
import dev.centraid.shared.sync.CoreDrainDoor
import dev.centraid.shared.sync.DrainAnswer
import dev.centraid.shared.sync.DrainPass
import dev.centraid.shared.sync.ForgetAnswer
import dev.centraid.shared.sync.LibraryDeleter
import dev.centraid.shared.sync.PassConditions
import dev.centraid.shared.sync.ScreenQueries
import dev.centraid.shared.sync.ScreenQueryRuntime
import dev.centraid.shared.sync.ScreenReads
import dev.centraid.shared.sync.ScreenRuntime
import dev.centraid.shared.sync.ScreenWrites
import dev.centraid.shared.sync.ShelfDrain
import dev.centraid.shared.sync.StrandedWrites
import dev.centraid.shared.sync.UploadLoop
import dev.centraid.shared.sync.UploadPin
import dev.centraid.shared.sync.freezeFor
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlin.time.TimeMark
import kotlin.time.TimeSource

/**
 * HOME, WIRED TO A REAL VAULT — AND TO THE OTHERS THE DEVICE HOLDS
 * (#1020, wave A).
 *
 * One object holding the things a live screen needs and both shells were
 * assembling separately: the [ScreenHost] that reduces, the [CentraidCore] that
 * reads, the [HomeRuntime] that carries effects from the first to the second,
 * and the roster that says which other vaults a switch could point at. It lives
 * in `commonMain` because the wiring is identical on both sides and a shell
 * that assembled it itself would be a second chance to assemble it differently
 * — Android's Home drew an empty page for exactly that reason, having never
 * sent `Opened` at all.
 *
 * ## A VIEW OVER THE SHELF'S FOREGROUND HOLDING (#1025 S7-9)
 *
 * This used to own the set of vaults itself: it took a `pathsById` map from a
 * one-shot survey, held the pairing store, held a `link` it moved by hand, and
 * pairing rode its LIVE core — which destroyed the vault that core was open on.
 * [Shelf] owns all of that now. What is left here is the part that was always
 * this object's: a [ScreenHost] that reduces, a [HomeRuntime] that serves its
 * effects, a [ChangeStream] that feeds it what arrives, and the job of pointing
 * all three at whichever core the shelf has in front.
 *
 * **A switch is a REBIND and not a reopen of this session.** [rebind]
 * re-points the change reader and publishes the new lockup; [HomeRuntime]
 * already reads the core through a supplier (R-HOME-2), so it keeps collecting
 * — cancelling it raced the switch's `ReadPage` against a `SharedFlow` with
 * `replay = 0` and left every tile LOADING forever (#1025 live-home). App
 * screens stay attached the same way. Since D-1025-S7-13 / D-1025-S7-17 every
 * held vault's core stays open; a switch is a pointer move on the shelf.
 *
 * **The order in [open] is load-bearing.** The runtime collects effects BEFORE
 * `Opened` is sent, because `ScreenHost` buffers only `EFFECT_BUFFER` of them
 * and the read Home asks for on open is the first one emitted. A runner
 * attached afterwards would miss it and every tile would sit `LOADING` for ever.
 *
 * **A core that will not open is not a crash.** The screen still runs; the
 * seat says it is waiting for a vault and Home takes its `failure` branch
 * ("No vault is open on this device.") rather than seeding `LOADING` tiles no
 * read will ever answer — the alternative is an app that will not start
 * because a file is missing, or one that spins for ever.
 */
public class HomeSession private constructor(
    private val scope: CoroutineScope,
    private val host: ScreenHost<HomeState, HomeEvent>,
    private val services: PlatformServices,
    /**
     * EVERY VAULT THIS DEVICE HOLDS, and the only thing that adds or removes
     * one. See [Shelf].
     */
    public val shelf: Shelf,
    private var runtime: Job?,
    /**
     * The one consumer of the core's change stream (#1025 S5).
     *
     * It is the SESSION's and not a screen's, because it outlives every screen:
     * a list the member has scrolled away from must be right when they come
     * back, and a stream that started when a screen appeared would leave it
     * stale for exactly as long as it was not visible.
     */
    public val changes: ChangeStream,
    private var changeReader: Job?,
) {
    public val state: StateFlow<HomeState> get() = host.state

    /** The monotonic origin the commit debounce measures from. See [drain]. */
    private val sinceOpen: TimeMark = TimeSource.Monotonic.markNow()

    /**
     * THE PASS OVER THIS DEVICE'S SHELF (#1080, the shells; #1029 W18-6).
     *
     * On the session and not on either shell, because a pass is over the
     * SHELF — every held vault — and the shelf is this object's. iOS reaches it
     * through `HomeBridge`, Android directly and from its workers. The
     * session's own triggers are wired in [open]: the first pass, every
     * commit, and the radio moving.
     *
     * The member's rule and the platform's reading are read at the start of
     * every run ([PassConditions.read]); the next window is asked for after
     * every pass, because a `BGTaskRequest` is one-shot.
     */
    public val drain: ShelfDrain = ShelfDrain(
        holdings = { shelf.all() },
        doorFor = { core -> CoreDrainDoor(core) },
        // MONOTONIC, NOT THE WALL CLOCK: it measures only "how long since",
        // and a phone whose clock moves would debounce for hours or never. It
        // is never a backup claim; those moments are the gateway's.
        nowMs = { sinceOpen.elapsedNow().inWholeMilliseconds },
        conditions = { PassConditions.read(services) },
        reschedule = DrainPass.Rescheduler { services.backgroundTasks.resubmit() },
        // WHAT THE SPOOL HAD NO ROOM FOR AT IMPORT, streamed from the library
        // again when the core asks (`need_bytes`).
        feed = { vaultId, needs -> libraryFeed.feed(vaultId, needs) },
        onOutcome = { outcome -> settle(outcome) },
    )

    private val libraryFeed: LibraryFeed = LibraryFeed(services) { vaultId ->
        shelf.all().firstOrNull { it.vaultId == vaultId && it.moved == null }?.core
    }

    /**
     * WHAT THE OS SAID WHEN THIS LAUNCH REGISTERED ITS WINDOWS, or null before
     * it answered. A member reads it: "Background App Refresh is off" is a
     * reason their backup waits for the app to be opened.
     */
    public val backgroundRegistration: StateFlow<BackgroundTasks.Registration?>
        get() = registration.asStateFlow()

    private val registration = MutableStateFlow<BackgroundTasks.Registration?>(null)

    /**
     * "BACK UP NOW" (#1080, the three controls): a snapshot and everything
     * that can move, inside the platform's long-run envelope — a foreground
     * notification on Android, an awake screen on iOS — which is released
     * however the run ends. A second press joins the first ([ShelfDrain.backUpNow]).
     */
    public suspend fun backUpNow(): List<ShelfDrain.Outcome> {
        services.backgroundTasks.backlog(start = true)
        return try {
            drain.backUpNow()
        } finally {
            services.backgroundTasks.backlog(start = false)
        }
    }

    /**
     * EVERY VAULT'S BACKUP READING AND THE FOREGROUND'S LINE (#1080). Re-read
     * after each pass ([settle]) and on every rebind, so Home's line follows a
     * switch; the Backup screen re-reads it when it opens.
     */
    public val backupStatus: BackupStatusStore = BackupStatusStore(
        holdings = { shelf.all() },
        foreground = { shelf.foregroundHolding()?.vaultId },
        doorFor = { core -> CoreBackupStatus(core) },
        // THE WALL CLOCK, for "2 minutes ago" only: every time it is compared
        // with is the gateway's.
        nowMs = { services.clock.read().epochMillis },
    )

    /**
     * ONE VAULT'S PASS ENDED: re-read its status, and freeze a vault another
     * phone claimed. The gateway's `MOVED` — on this pass, or remembered by the
     * core's ledger — is the producer `Shelf.freeze` was waiting for (#1029 F1).
     */
    private suspend fun settle(outcome: ShelfDrain.Outcome) {
        val reading = backupStatus.refresh(outcome.vaultId)
        val answer = (outcome.outcome as? DrainPass.Outcome.Ran)?.answer
        freezeIfMoved(outcome.vaultId, reading, movedAtMs = answer?.movedAtMs?.takeIf {
            answer.stopped == DrainAnswer.Stopped.MOVED
        })
        // EVERY iOS PASS ENDS WITH RECONCILE → HANDOFF → ENQUEUE (A11): what
        // the pass sealed but did not move goes to the OS to carry while the
        // app is suspended. No loop is installed on Android.
        uploads?.afterPass(outcome.vaultId)
    }

    /** The iOS mover's Kotlin half, once the shell installed one ([attachUploads]). */
    private var uploads: UploadLoop? = null

    /**
     * THE SHELL'S HAND ON THE OS LIBRARY, or null (#1080 A20). Free up space
     * reads it at each use: Android installs one when its activity is created
     * and clears it when the activity is destroyed, because the deleter holds
     * that activity's launcher for the system's confirmation, and a rotation
     * must not leave a destroyed activity here. iOS installs one, once,
     * through `HomeBridge`.
     */
    public val libraryDeleter: LibraryDeleter? get() = deleter

    private var deleter: LibraryDeleter? = null

    /** Install the shell's deleter, or clear it with null. See [libraryDeleter]. */
    public fun installLibraryDeleter(deleter: LibraryDeleter?) {
        this.deleter = deleter
    }

    /**
     * Bind the iOS mover's loop to this session's vaults (`HomeBridge`). A
     * frozen vault hands nothing off: the gateway would refuse its writes. Nor
     * does the sample, which is never backed up (R-SAMPLE-5).
     */
    public fun attachUploads(loop: UploadLoop) {
        uploads = loop
        fun drainable() = shelf.all().filter { it.core != null && it.moved == null && !it.sample }
        loop.attach(
            UploadLoop.Binding(
                vaults = { drainable().map { it.vaultId } },
                doorsFor = { vaultId ->
                    if (drainable().none { it.vaultId == vaultId }) {
                        null
                    } else {
                        CoreBackupDoors { shelf.all().firstOrNull { it.vaultId == vaultId }?.core }
                    }
                },
                resubmit = { services.backgroundTasks.resubmit() },
            ),
        )
    }

    /**
     * Every held vault's pinned gateway certificates (`pins`), for the shell's
     * own TLS. Null when no vault's core answered — a refusal is never an
     * empty list, which would read as "trust nothing".
     */
    public suspend fun uploadPins(): List<UploadPin>? {
        val answers = shelf.all().mapNotNull { holding ->
            holding.core?.let { core -> CoreBackupDoors { core }.pins() }
        }
        if (answers.isEmpty()) return null
        return answers.flatten().distinctBy { it.gateway to it.certDer.toList() }
    }

    /** Freeze [vaultId] once, when a pass or the ledger says it moved ([freezeFor]). */
    private suspend fun freezeIfMoved(vaultId: String, reading: BackupReading?, movedAtMs: Long?) {
        val moved = freezeFor(reading, movedAtMs) ?: return
        if (shelf.all().any { it.vaultId == vaultId && it.moved != null }) return
        vaultMoved(vaultId, moved.atIso, moved.unacked)
        backupStatus.publish()
    }

    /**
     * Stop backing [shelf]'s foreground vault up to [gatewayId] (seam
     * contract A5): the ledger drops the destination and its confirmations,
     * and what that gateway holds stays there. True when forgotten, false when
     * the core knew no such destination, null when there was no core to ask.
     */
    public suspend fun forgetDestination(gatewayId: String): ForgetAnswer? {
        val forgotten = CoreBackupDoors { shelf.core() }.forget(gatewayId)
        backupStatus.refreshForeground()
        return forgotten
    }

    /**
     * The member changed the rule: the windows' constraints follow it, and on
     * iOS every upload the OS holds is cancelled, because each keeps the
     * cellular flag of the rule it was handed off under ([UploadLoop.cancelAll]).
     */
    public fun ruleChanged() {
        services.backgroundTasks.resubmit()
        uploads?.cancelAll()
    }

    /**
     * THE FOREGROUND HOLDING'S CORE, ASKED OF THE SHELF EVERY TIME.
     *
     * A property and not a field, and that is what makes a switch a rebind: the
     * effect runner and every attached app screen take the core as a SUPPLIER,
     * so the shelf moving the foreground is picked up by the next read rather
     * than leaving anything bound to a closed handle.
     */
    private val core: CentraidCore? get() = shelf.core()

    /** Whether this session has a core behind it at all. */
    public val live: Boolean get() = core != null

    public fun send(event: HomeEvent) {
        scope.launch { host.send(event) }
    }

    /**
     * THE SCOPE A SCREEN'S LAST WRITE RUNS ON. A bridge's `leave()` sends the
     * screen's `Left` event here rather than on its own scope, so releasing the
     * bridge does not cancel the flush it just asked for.
     */
    internal val outliving: CoroutineScope get() = scope

    /**
     * A write that failed after its screen was left (the kit's autosave flush
     * on close). Home's status line says so ([serveStranded]).
     */
    public val strandedWrites: SharedFlow<StrandedWrite> get() = _stranded.asSharedFlow()

    private val _stranded = MutableSharedFlow<StrandedWrite>(extraBufferCapacity = STRANDED_BUFFER)

    private val strand = StrandedWrites { appId, command, sentence ->
        _stranded.tryEmit(StrandedWrite(appId, command, sentence))
    }

    /**
     * PUT AN APP SCREEN ON THIS SESSION'S CORE (#1025 S5, lane L5).
     *
     * The three app screens have no core of their own and must not get one:
     * R-1020-24 is one core per VAULT FILE — re-keyed from "per process" by
     * #1025 S7-13, so the shelf can hold every vault open at once — and
     * `SingleHandleGuard` refuses a second handle on the file this session is
     * already reading. So Tally, Photos and Notes read through the handle this
     * session holds. Until this method existed nothing served their `ReadPage`
     * effects at all and all three sat on their seeded `LOADING` state for ever.
     *
     * **Both halves, every time.** The runtime serves what the screen ASKS for;
     * `changes.route` delivers what arrives from sync without being asked. A
     * screen given only the first is the product as it was before S5 — it
     * answers a tap and never moves on its own.
     *
     * **It survives a vault switch without being re-attached.**
     * [ScreenRuntime] takes the core as a SUPPLIER — `{ core }`, read at each
     * read — so a switch that closes one core and opens another is picked up by
     * the next read rather than leaving this screen bound to a closed handle.
     * The routing needs no repair either: `ChangeStream.route` is registration
     * on the stream object, which outlives the cores, and [attach] restarts the
     * reader against whichever core is open.
     *
     * Registration is additive and there is no removal, for the reason
     * `ChangeStream.route` gives: a screen the member has scrolled away from
     * must be right when they come back.
     */
    public fun <S, E> attachScreen(
        host: ScreenHost<S, E>,
        reads: ScreenReads<S, E>,
        /** Null for a screen with no write. See [ScreenWrites]. */
        writes: ScreenWrites<S, E>? = null,
        /** Whether the screen was left; its bridge's. See [StrandedWrites]. */
        left: () -> Boolean = { false },
    ): Job {
        changes.route(host)
        return ScreenRuntime(
            core = { core },
            host = host,
            reads = reads,
            scope = scope,
            writes = writes,
            left = left,
            stranded = strand,
            // READ OFF THE SHELF AT THE MOMENT OF THE WRITE (#1029 F1). A
            // vault frozen while the member was mid-edit must refuse the save
            // they then press, and a value read at attach would not.
            readOnly = { if (shelf.foregroundHolding()?.readOnly == true) Shelf.MOVED_SENTENCE else null },
            zone = { services.clock.read().zone },
        ).start()
    }

    /**
     * A SECOND READ FOR A SCREEN THAT IS ALREADY ATTACHED (#1029, photos port).
     *
     * **The read door has no join clause**, and two screens need one. A place
     * card is `core_place`'s name, pin and zone beside `media_asset`'s count
     * and cover; a person row is `core_party`'s display name beside
     * `media_face_region`'s count. Neither is answerable in one statement, so
     * those screens run two passes and merge the answers into one state.
     *
     * **This exists because [attachScreen] is not idempotent.** It does two
     * things — serve the screen's `ReadPage` effects, and `changes.route(host)`
     * so sync moves the screen without a tap — and the second is *registration
     * with no removal*, by design ("a screen the member has scrolled away from
     * must be right when they come back"). Calling it twice for a second read
     * therefore routes the same host twice, and every change event delivers
     * two re-reads for ever. That is not a leak anyone would notice in a test
     * and is a doubling of read load on a real vault, growing by one multiple
     * per extra pass.
     *
     * So: one [attachScreen] for the screen, and one of these per further
     * read. The route is deliberately absent here — the host is already on the
     * stream, and the screen's own `rowsChanged` is what decides whether a
     * table it reads in EITHER pass is one of its own.
     *
     * The merge is the machine's business and not this method's: an `arrived`
     * that had to know which pass it came from would be a reducer with a mode,
     * so both screens make theirs commutative instead.
     *
     * ## WHICH OF THE TWO SHAPES A MULTI-READ SCREEN TAKES
     *
     * Four screens hit this independently and three invented different
     * mechanisms, so the rule is written here once. **The question is whether a
     * partial answer is a state the screen can render.**
     *
     * - **It is** when the second read ENRICHES rows the first already
     *   produced — a place's asset count, a cluster's bytes, a lightbox's
     *   people. Then this method is the answer: each leg lands its own event,
     *   the reducer merges commutatively, and the screen draws the rows it has
     *   with the columns it has. Every one of those events is an AMENDMENT and
     *   says so on the wire (`DataArrived.amendment`,
     *   `PlacementArrived`, `ThumbnailsArrived`), because a reducer that cannot
     *   tell a merge from a replace paints one subject's data onto another.
     * - **It is not** when the data case cannot be CONSTRUCTED until both reads
     *   land — a person row is a `core_party` name and a `media_face_region`
     *   count, and neither half is a row. Then the fan-out belongs in the
     *   bridge, which folds both answers and sends ONE event, exactly as
     *   `HomeRuntime` fans out seven reads per app. There is no third option:
     *   a screen's `content` is a protobuf `oneof`, so Wire REFUSES a state
     *   with `loading` and `data` both set, and there is nowhere to park the
     *   first answer while the second is in flight.
     *
     * Neither shape is a workaround for the other. A screen that folds in the
     * bridge when it could amend gives up showing anything until the slowest
     * read returns; a screen that amends when it cannot construct has to invent
     * a half-built row.
     */
    public fun <S, E> attachReads(
        host: ScreenHost<S, E>,
        reads: ScreenReads<S, E>,
    ): Job = ScreenRuntime(
        core = { core },
        host = host,
        reads = reads,
        scope = scope,
        writes = null,
        readOnly = { if (shelf.foregroundHolding()?.readOnly == true) Shelf.MOVED_SENTENCE else null },
        zone = { services.clock.read().zone },
    ).start()

    /**
     * PUT A SCREEN THAT READS THROUGH APP QUERIES ON THIS SESSION'S CORE
     * (#1046).
     *
     * [attachScreen]'s twin for a [ScreenQueries] screen — one whose reads the
     * core runs as an app's own query (`app_query.proto`) because no page read
     * can say them. Both halves, as there: the runtime serves what the screen
     * asks for, and `changes.route` delivers what arrives unasked, which the
     * machine's `rowsChanged` turns into a re-read on exactly
     * [ScreenQueries.tables].
     *
     * The device's zone is the PLATFORM's and is read at every read
     * ([PlatformServices.clock]); a bridge passes nothing for it. Like
     * [attachScreen], this is registration with no removal — call it once per
     * screen host.
     */
    public fun <S, E> attachQueries(
        host: ScreenHost<S, E>,
        queries: ScreenQueries<S, E>,
        /** Null for a screen with no write. See [ScreenWrites]. */
        writes: ScreenWrites<S, E>? = null,
        /** Whether the screen was left; its bridge's. See [StrandedWrites]. */
        left: () -> Boolean = { false },
    ): Job {
        changes.route(host)
        return ScreenQueryRuntime(
            core = { core },
            host = host,
            queries = queries,
            clock = services.clock,
            scope = scope,
            writes = writes,
            left = left,
            stranded = strand,
            readOnly = { if (shelf.foregroundHolding()?.readOnly == true) Shelf.MOVED_SENTENCE else null },
        ).start()
    }

    /**
     * MAKE A VAULT ON THIS PHONE (#1029 §1).
     *
     * What replaces `pair`, which redeemed a ticket against a gateway and took
     * a copy of a vault that lived somewhere else. The phone is the vault, so
     * the shell founds one: [Shelf.found] names a fresh file, opens it with
     * `create`, and the session REBINDS onto it because the shelf has moved the
     * foreground to the vault just made.
     *
     * A refusal is a CODE from the shelf and the sentence is made HERE, from
     * this table. A failure's own words are for a log — the simulator once
     * showed a member a Rust error's `Display` — and a sentence a member reads
     * is the shell's to write.
     *
     * **THE MEMBER'S FIRST VAULT COMES WITH COMPANY.** When the shelf holds
     * no vault of the member's own, the new one gets two starter rows (a note
     * and a task) and, once it is in front, the SAMPLE VAULT is founded beside
     * it ([Shelf.foundSample]) — in the background, best-effort, and without
     * taking the front. A sample that fails to seed is deleted by the shelf
     * and the member's vault is untouched; "Add sample" ([addSample]) is the
     * way back. A second vault of their own gets neither. A restore is not a
     * found and gets neither either.
     */
    public suspend fun found(
        name: String = Shelf.DEFAULT_VAULT_NAME,
        ownerName: String = Shelf.DEFAULT_OWNER_NAME,
    ): FoundResult {
        val first = shelf.all().none { !it.sample }
        return when (val outcome = shelf.found(name = name, ownerName = ownerName, starters = first)) {
            is Shelf.FoundOutcome.Founded -> {
                rebind()
                if (first) scope.launch { shelf.foundSample() }
                FoundResult.Made(outcome.holding.name)
            }
            is Shelf.FoundOutcome.Refused -> FoundResult.Refused(
                when (outcome.because) {
                    Shelf.FoundRefusal.NO_CORE ->
                        "Centraid could not make a vault on this device."
                    // THE SENTENCE NO LONGER NAMES A MISSING DOOR (#1029 W5).
                    // It said "this build cannot make a new vault yet", which
                    // was true while nothing over the ABI wrote `core_vault`
                    // and is a lie now that `FoundRequest` does. What reaches
                    // this arm today is a found the CORE refused, and the
                    // remedy a member has is to try again — the shelf picks a
                    // different fresh file each time.
                    Shelf.FoundRefusal.NOT_FOUNDED ->
                        "Centraid made the file and could not make it a vault. Try again."
                    Shelf.FoundRefusal.ALREADY_HELD ->
                        "This device already holds that vault."
                },
            )
        }
    }

    /**
     * ADD THE SAMPLE VAULT BACK ("Add sample"). [Shelf.foundSample]: founded
     * and seeded beside whatever is in front, which stays in front. Answers
     * whether the device holds the sample afterwards.
     */
    public suspend fun addSample(): Boolean {
        shelf.foundSample()
        return shelf.hasSample.value
    }

    /**
     * REMOVE THE SAMPLE VAULT ("Remove sample"). [Shelf.forget] on the sample's
     * holding: its directory is deleted whole and the member's own vault is in
     * front afterwards. Nothing of the member's is touched, but it still
     * deletes a vault, so the shell confirms before calling this
     * (`HomeWords.SAMPLE_REMOVE_BODY`). A device holding no sample is left as
     * it is.
     */
    public suspend fun removeSample() {
        val sample = shelf.sampleHolding() ?: return
        forget(sample.vaultId)
    }

    /**
     * HOLD WHAT A RESTORE BROUGHT BACK, and bind Home to it (#1047 E1).
     * See [Shelf.adoptRestored]; the seed is already stored.
     */
    public suspend fun adoptRestored(restored: List<Shelf.Restored>): Int {
        val added = shelf.adoptRestored(restored)
        rebind()
        // A RESTORE THAT FINISHED IS A PASS'S REASON (`WakeReason.RESTORED`):
        // the ledger beside a restored vault is new, so until a pass asks the
        // gateway what it holds, the line counts "0 of 50" for a library that
        // is all there (#1080, the simulator restore). Launched, not awaited:
        // the restore's own answer is on screen first.
        if (added > 0) scope.launch { drain.afterRestore() }
        return added
    }

    /**
     * REOPEN THIS PHONE'S VAULTS WITH THE WORDS HANDED BACK (#1047 E1). See
     * [Shelf.rekey]; a foreground core that was replaced is rebound.
     */
    public suspend fun rekeyed(): Int {
        val keyed = shelf.rekey()
        rebind()
        return keyed
    }

    /**
     * THIS VAULT MOVED TO THE MEMBER'S OTHER PHONE (#1029 F1).
     *
     * Freezes it: writes are refused with [Shelf.MOVED_SENTENCE] and reads go
     * on working. **Nothing is deleted and nothing is taken back.** Both phones
     * hold the same seed, so this is cooperation and not enforcement — see
     * [Shelf.Moved].
     *
     * The session republishes so the frozen holding's line is on screen without
     * waiting for the next touch.
     *
     * ## Who calls it
     *
     * `freezeIfMoved`, when a pass stops `MOVED` or the core's `backup_status`
     * says the vault is frozen (#1080): `dev.centraid.shared.sync.freezeFor`
     * answers these two arguments, as `movedFrom` does for a refusal carrying
     * `ERROR_CODE_VAULT_MOVED` and `error.proto`'s `VaultMoved`. [Shelf.freeze]
     * has the note.
     */
    public suspend fun vaultMoved(vaultId: String, atIso: String, unacked: Long) {
        shelf.freeze(vaultId, atIso, unacked)
        publishLockup()
    }

    /**
     * "N changes since <date>" for the vault in front, or null (#1029 F1).
     *
     * **It is on `VaultLockup` now** (#1029 W5, hand-off 3): every row the
     * roster publishes carries `frozen_line` and `STATE_FROZEN`, so the
     * switcher's caption and the header's second line are two renderings of one
     * stream, which is the rule this shelf keeps about everything else.
     *
     * This property stays because a shell asking about THE VAULT IN FRONT
     * without subscribing to the roster is a real call site (chrome outside the
     * screen contract), and it is not a second source: both it and the lockup
     * read [Shelf.Holding.frozenLine], which is the one derivation.
     */
    public val frozenLine: String? get() = shelf.foregroundHolding()?.frozenLine

    /**
     * FORGET A VAULT (#1025 S7-9).
     *
     * The inverse of [found]: [Shelf.forget] closes the core, drops the
     * holding, and deletes the file, its byte store and its sidecars. The
     * session rebinds onto whatever the shelf brought forward, which is the
     * first remaining holding, or none.
     *
     * **On a phone that IS the vault this destroys the member's rows**, and
     * there is no copy elsewhere to fall back to. See [Shelf.forget].
     */
    public suspend fun forget(vaultId: String) {
        shelf.forget(vaultId)
        rebind()
    }

    /**
     * SAY WHAT THIS DEVICE IS (#1025 S5, D-1025-S5-6; reshaped by #1029 §1).
     *
     * Three facts, and each one is now about THIS DEVICE rather than about a
     * link to a gateway:
     *
     * * **Availability** — is a vault open here at all.
     * * **Durability** — `AUTHORITATIVE`, always, and that is the change. It
     *   used to be the last pass's answer: a seat that reached its gateway this
     *   window wrote authoritatively and one that did not was `LOCAL_ONLY`,
     *   which is to say its writes were in an outbox somebody else had to
     *   accept. The phone is the vault. A write that commits here IS the
     *   record, so there is no state in which a member's work is held
     *   provisionally, and reporting one would be this shell inventing a doubt.
     * * **Connectivity** — the platform's own reading, which is still a fact a
     *   member reads and still nothing the vault depends on.
     *
     * `centraid.core.v1.ConnectivityEvent` exists on the event stream and has
     * no producer in `crates/core`; when it gains one, this is the function
     * that changes and no screen does.
     */
    private suspend fun publishSeat() {
        val reading = services.networkStatus.current()
        changes.publishSeat(
            SeatState(
                availability = if (core == null) {
                    SeatState.Availability.AVAILABILITY_WAITING_FOR_MOUNT
                } else {
                    SeatState.Availability.AVAILABILITY_READY
                },
                durability = SeatState.Durability.DURABILITY_AUTHORITATIVE,
                connectivity = when {
                    reading.platformRefused ->
                        SeatState.Connectivity.CONNECTIVITY_UNKNOWN_PLATFORM_REFUSED
                    !reading.online -> SeatState.Connectivity.CONNECTIVITY_OFFLINE
                    reading.metered -> SeatState.Connectivity.CONNECTIVITY_ONLINE_METERED
                    else -> SeatState.Connectivity.CONNECTIVITY_ONLINE_UNMETERED
                },
            ),
        )
    }

    /**
     * Close the session and the core the shelf is holding.
     *
     * The shelf's holdings are NOT forgotten — they are files on disk and a
     * closed app still holds its vaults. Only [forget] removes one.
     */
    public suspend fun close() {
        shelf.closeAll()
        scope.cancel()
    }

    /**
     * THE OS IS ASKING FOR MEMORY BACK (#1025 S7-13).
     *
     * Wired from iOS's `didReceiveMemoryWarning` and Android's `onTrimMemory`.
     * Every background vault's core closes; the foreground's stays, because a
     * memory warning is not a reason to empty the screen a member is reading.
     * A rested vault reopens on the next tap.
     */
    public suspend fun rest() {
        shelf.rest()
    }

    /**
     * POINT THE CHANGE READER AT WHATEVER IS IN FRONT, and make sure the
     * Home effect runner is collecting (R-HOME-1, #1025 live-home).
     *
     * [HomeRuntime] takes the core as a SUPPLIER — `{ core }`, read at each
     * page — so a switch that moves the shelf's foreground is picked up by the
     * next tile read without tearing the collector down. Cancelling it on
     * every identity change was the live bug: `start()` schedules `collect`
     * asynchronously, `publishLockup` then emits `ReadPage` into a
     * `SharedFlow` with `replay = 0`, and every tile stayed LOADING forever
     * while Photos (already collecting through the same supplier pattern)
     * drew.
     *
     * The change reader IS per CORE and restarts here (#1025 S7-13):
     * `CentraidCore.startReader` is idempotent and its job lives on the
     * core's own scope; this session's consumer must follow the foreground.
     *
     * **REBINDING TO THE CORE ALREADY BOUND IS NOT A REBIND.** Early-return is
     * valid only when the foreground core identity is unchanged (R-HOME-1);
     * the lockup and the seat line are still published, because a caller that
     * rebound had a reason to think something moved.
     */
    private suspend fun rebind(): Unit = rebinding.withLock {
        val open = core
        if (open != null && open === bound) {
            publishSeat()
            publishLockup()
            publishFoundingDay()
            return@withLock
        }
        changeReader?.cancelAndJoin()
        changeReader = null
        bound = open
        when {
            open == null -> {
                runtime?.cancelAndJoin()
                runtime = null
            }
            runtime == null -> {
                runtime = HomeRuntime(
                    core = { core },
                    host = host,
                    scope = scope,
                    clock = services.clock,
                ).start()
            }
        }
        if (open != null) {
            changeReader = changes.start(open, scope)
        }
        // THE SEAT LINE TRAVELS WITH THE BINDING: what it says — is a vault
        // open, is a write durable, what does the radio report — changes
        // exactly when the foreground does. So does the backup line.
        publishSeat()
        publishLockup()
        val front = shelf.foregroundHolding()?.vaultId
        val reading = backupStatus.refreshForeground()
        if (front != null) freezeIfMoved(front, reading, movedAtMs = null)
        publishFoundingDay()
    }

    /**
     * The core the change reader is currently pointed at.
     *
     * Compared by IDENTITY and not by vault id. A switch moves the foreground
     * to another holding's already-open core (D-1025-S7-13), so this changes
     * on every real A→B move; the early-return above is the case where a
     * caller rebinds onto the core already bound. It still has to be identity
     * for a holding woken from [Shelf.rest], where the handle under one vault
     * id is replaced.
     */
    private var bound: CentraidCore? = null

    /**
     * ONE REBIND AT A TIME. Two interleaved would leave one cancelling the
     * runtime the other had just started, and Home would sit on its loading
     * grid with nothing serving it.
     */
    private val rebinding = Mutex()

    /**
     * The foreground vault's lockup, and it is the SHELF's row.
     *
     * The name and the colour come from the holding — which read them out of
     * the replica's own `core_vault` row — and the state is derived by
     * [Shelf.Holding.state] from what the last pass actually did. Nothing here
     * decides either, which is the point: the header's second line and the
     * switcher row for the same vault are one value rendered twice, and cannot
     * disagree the way a session-held `link` and a launch-time survey did.
     *
     * A device holding NOTHING sends an empty lockup rather than none: the
     * member still gets "No vault yet" over a Home that says there is no vault
     * to read, and the alternative is a lockup that silently never appears. `STATE_UNSPECIFIED` rides it, and is what it should be — a Home
     * nobody has told anything yet draws no second line rather than a claim.
     *
     * **Sent again after every round, and that is not a switch.** `HomeMachine`
     * compares the incoming lockup to the one it holds and moves only the
     * lockup when they name the same vault, so a line going `syncing` →
     * `synced` costs nothing and does not throw away a tile.
     */
    private suspend fun publishLockup() {
        val lockup = shelf.foregroundHolding()?.lockup() ?: VaultLockup()
        host.send(HomeEvent(vault_changed = HomeEvent.VaultChanged(vault = lockup)))
    }

    /**
     * WHETHER THE VAULT IN FRONT WAS FOUNDED TODAY, the notice slot's one told
     * input (R-SAMPLE-8). Read here, at every rebind, because the zone is the
     * platform's and the machine is pure; sent after the lockup, so a switch
     * resets what Home holds right before this arrives.
     */
    private suspend fun publishFoundingDay() {
        val holding = shelf.foregroundHolding()
        val foundedToday = holding != null &&
            FoundingDay.isToday(holding.foundedAt, services.clock.read())
        host.send(
            HomeEvent(founding_day = HomeEvent.FoundingDayKnown(founded_today = foundedToday)),
        )
    }

    /**
     * Serve the effects this session owns, rather than the ones a core serves.
     *
     * [HomeRuntime] turns `ReadPage` into a read; a `SwitchVault` is not a read
     * at all — it is the shelf's foreground — so it is served here, by the
     * object that owns the binding. Two collectors on one `SharedFlow`
     * each see every effect and each ignores what is not theirs.
     */
    private fun serveSwitches(): Job = scope.launch {
        host.effects.collect { effect ->
            when (effect) {
                is ScreenEffect.SwitchVault -> switchTo(effect.vaultId)
                else -> Unit
            }
        }
    }

    /**
     * THE ROSTER, FORWARDED AS IT MOVES (#1025 S7-9).
     *
     * One collector on [Shelf.roster] for the life of the session. It replaces
     * the single `VaultsListed` the old `open` sent once and never again — so a
     * vault admitted a minute after launch did not exist to any screen until
     * the app was relaunched, and a vault that went offline kept whatever the
     * launch survey had guessed about it.
     */
    private fun serveRoster(): Job = scope.launch {
        shelf.roster.collect { vaults ->
            host.send(HomeEvent(roster_changed = HomeEvent.RosterChanged(vaults = vaults)))
        }
    }

    /**
     * A WRITE STRANDED BY ITS SCREEN'S CLOSING lands on Home's status line —
     * the one feedback channel with no screen of its own to be on — in the
     * attention tone, with the core's sentence when it gave one.
     */
    private fun serveStranded(): Job = scope.launch {
        strandedWrites.collect { write ->
            host.send(HomeEvent(status = HomeEvent.StatusChanged(status = strandedStatus(write))))
        }
    }

    /**
     * RE-POINT THE WHOLE APP AT ANOTHER VAULT.
     *
     * An id with no holding, or a file that will not open, leaves the session
     * on the vault it was on — [Shelf.bringToFront] answers null and reopens
     * what was there. That is the honest outcome: the member is still reading
     * something real.
     */
    private suspend fun switchTo(vaultId: String) {
        shelf.bringToFront(vaultId) ?: return
        // THE LOCKUP IS WHAT STARTS THE RELOAD: the machine sees a vault whose
        // id differs from the one it is holding, throws away every tile it read
        // out of the old vault, and asks for the new one's — which the
        // supplier-backed runtime already collecting serves against the
        // foreground core (R-HOME-1).
        rebind()
    }

    public companion object {
        /**
         * Open a session over the vaults at [vaultDir] (#1025 S5, D-1025-S5-2;
         * #1025 S7-9; #1029 §1).
         *
         * ## A DIRECTORY, NOT A LIST OF PATHS
         *
         * Wave A's shell opened whatever `.db` files had been PLACED in its
         * container, as a `GATEWAY`, because there was no way for a phone to
         * get a vault of its own: `mobile/scripts/demo-vault.sh` copied a
         * gateway-role artifact in. S5 replaced that with a pairing, and #1029
         * replaces the pairing with the phone founding its own — so the
         * directory is the roster, [Shelf] opens every file in it the same way,
         * and an EMPTY directory is the ordinary first run rather than an
         * error.
         *
         * ## The order is load-bearing
         *
         * 1. [Shelf.load] runs FIRST: it opens each file in turn and asks it
         *    which vault it is. It ends holding every vault's core, and the
         *    foreground one is what everything below binds to.
         * 2. The runtime collects effects BEFORE `Opened` is sent, because
         *    `ScreenHost` buffers only `EFFECT_BUFFER` of them and the read
         *    Home asks for on open is the first one emitted. A runner attached
         *    afterwards would miss it and every tile would sit `LOADING` for
         *    ever.
         * 3. The change stream starts with the runtime and not later, because
         *    a screen attached after the first rows land would show a
         *    springboard of the counts the vault had before them.
         */
        public suspend fun open(
            vaultDir: String,
            services: PlatformServices,
            dispatcher: CoroutineDispatcher,
            uiThreadName: String,
            /** A debug build's demo seed, or null — always null in release. See [DevSeed]. */
            devSeed: DevSeed? = null,
        ): HomeSession {
            val scope = CoroutineScope(SupervisorJob() + dispatcher)
            val host = ScreenHost(HomeMachine)
            val shelf = Shelf(vaultDir, services, dispatcher, uiThreadName)
            // FIRST, and with nothing else open. See the header.
            shelf.load(devSeed)
            val session = HomeSession(
                scope = scope,
                host = host,
                services = services,
                shelf = shelf,
                runtime = null,
                changes = ChangeStream(),
                changeReader = null,
            )
            session.changes.route(host)
            // THE COMMIT TRIGGER. Debounced inside `ShelfDrain`, and launched
            // rather than awaited: the listener runs on the one consumer of the
            // core's bounded, drop-nothing event queue, and a listener that
            // waited for a network there would stall it.
            session.changes.onCommit = { scope.launch { session.drain.afterCommit() } }
            // THE RADIO MOVED: a link that came back, or Wi-Fi after cellular,
            // is when withheld originals can go. Debounced on its own clock.
            services.networkStatus.onChange { reading -> scope.launch { session.drain.onConnectivity(reading) } }
            session.serveSwitches()
            // THE ROSTER COLLECTOR BEFORE THE REBIND, so the roster the shelf
            // is already holding reaches Home rather than being the one value
            // that arrives only on the next change.
            session.serveRoster()
            session.serveStranded()
            // HOME DRAWS THE BACKUP LINE FROM ITS OWN STATE (A11): every line
            // the store draws becomes a `BackupLineChanged`.
            scope.launch {
                session.backupStatus.line.collect { line ->
                    host.send(HomeEvent(backup_line = HomeEvent.BackupLineChanged(line = line)))
                }
            }
            session.rebind()
            host.send(HomeEvent(opened = HomeEvent.Opened()))
            // THE ONE LAUNCH REGISTRATION, here and nowhere else in commonMain
            // (`BackgroundSchedulingSpec`): both shells open a session at
            // launch, and a background window the OS never registered is a
            // backup that runs only while the app is open.
            scope.launch {
                session.registration.value = services.backgroundTasks.register()
                session.drain.onSessionOpened()
            }
            return session
        }
    }
}

/** One write that failed after its screen was left. [sentence] is the core's, or empty. */
public data class StrandedWrite(
    public val appId: String,
    public val command: String,
    public val sentence: String,
)

/** A handful: a member closes one editor at a time. */
private const val STRANDED_BUFFER: Int = 8

/**
 * WHAT HOME'S STATUS LINE SAYS ABOUT A STRANDED WRITE: the app by name, and
 * the core's sentence when there is one. Attention, never urgent — the words
 * are still in the member's memory, and nothing else was lost — and nowhere
 * to go: the screen that could retry it has closed.
 */
public fun strandedStatus(write: StrandedWrite): HomeStatus {
    val app = CentraidCatalog.byId[write.appId]?.name ?: write.appId
    val sentence = write.sentence.trim()
    return HomeStatus(
        tone = HomeStatus.Tone.TONE_ATTENTION,
        copy = if (sentence.isEmpty()) {
            SharedCopy.STRANDED_WRITE.replace("{app}", app)
        } else {
            SharedCopy.STRANDED_WRITE_WHY.replace("{app}", app).replace("{sentence}", sentence)
        },
        action = "",
        destination = HomeStatus.Destination.DESTINATION_NONE,
    )
}
