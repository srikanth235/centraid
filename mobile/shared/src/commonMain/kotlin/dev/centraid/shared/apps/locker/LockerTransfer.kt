package dev.centraid.shared.apps.locker

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.LockerExportFormat
import centraid.core.v1.LockerImportPlan
import centraid.core.v1.LockerImportVerdict
import centraid.core.v1.LockerItemsRequest
import centraid.core.v1.LockerRevealRefusal
import centraid.screen.v1.Confirm
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.LockerChoice
import centraid.screen.v1.LockerExportChrome
import centraid.screen.v1.LockerExportData
import centraid.screen.v1.LockerExportEvent
import centraid.screen.v1.LockerExportState
import centraid.screen.v1.LockerFact
import centraid.screen.v1.LockerImportChrome
import centraid.screen.v1.LockerImportData
import centraid.screen.v1.LockerImportEvent
import centraid.screen.v1.LockerImportLine
import centraid.screen.v1.LockerImportState
import centraid.screen.v1.LockerLockEvent
import centraid.screen.v1.LockerPrompt
import centraid.screen.v1.SeatState
import centraid.screen.v1.StatusChip
import centraid.screen.v1.StatusLine
import dev.centraid.design.copy.LockerCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.screen.Step
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/** The item count both pages read: the shelf's own counts, a small window. */
private fun countRequest(zone: String): AppQueryRequest =
    AppQueryRequest(locker_items = LockerItemsRequest(limit = 20, tz = zone))

/** Live and archived items — what an export writes. `null` while unknown. */
private fun exportable(held: LockerHeld<*>): Int? {
    val items = held.answers.items ?: return null
    val live = items.total ?: return null
    return live + (items.archived_count ?: 0)
}

// ---------------------------------------------------------------------------
// locker.export
// ---------------------------------------------------------------------------

/**
 * EVERY SECRET, IN A FILE (#1047 T2; the handoff's `locker/export`).
 *
 * THREE ASKS, IN ORDER, before a byte exists: the confirm, which names the
 * consequence; the phone's owner check, raised AFRESH on `prompt` whether or
 * not Locker is already open (the lock wall's seam and outcome map); then
 * the core, which writes the one mass-reveal receipt before it opens a cell.
 * The file the core answers is held Kotlin-side ([LockerHeld.file]) only
 * until the save sheet answers — the bridge hands it to the shell's
 * [LockerExportBridge.onSave] and nothing else — and a relock, a leave or any
 * answer drops it. The screen never carries a byte of it.
 */
public object LockerExportMachine :
    LockerQueryMachine<LockerExportState, LockerExportEvent, LockerExportData>(LOCKER_EXPORT, LOCKER_TABLES) {
    public const val SCREEN_ID: String = LOCKER_EXPORT

    private const val CSV: String = "csv"
    private const val JSON: String = "json"

    override val lens: ContentLens<LockerExportState, LockerExportData> = ExportLens

    override fun blank(): LockerExportState = LockerExportState(phase = LockerExportState.Phase.PHASE_IDLE)

    override fun seatOf(screen: LockerExportState): SeatState = screen.seat ?: SeatState()

    override fun withSeat(screen: LockerExportState, seat: SeatState): LockerExportState = screen.copy(seat = seat)

    /** The format picked: the state's own parameter. */
    private fun format(held: LockerHeld<LockerExportState>): String = if (held.screen.format == JSON) JSON else CSV

    override fun view(held: LockerHeld<LockerExportState>, event: LockerExportEvent, entropy: ByteArray): Step<LockerHeld<LockerExportState>> {
        val phase = held.screen.phase
        return when {
            event.opened != null -> reload(
                LockerHeld(
                    screen = blank().copy(seat = held.screen.seat),
                    open = held.open,
                    tokens = held.tokens,
                ),
            )
            event.refreshed != null -> read(overRows(held))
            event.format != null && phase == LockerExportState.Phase.PHASE_IDLE && event.format.key in setOf(CSV, JSON) ->
                refold(held.copy(screen = held.screen.copy(format = event.format.key)))
            event.commit != null && phase == LockerExportState.Phase.PHASE_IDLE && (exportable(held) ?: 0) > 0 -> Step(
                held.copy(
                    screen = held.screen.copy(
                        status = null,
                        confirm = Confirm(
                            title = LockerCopy.EXPORT_CONFIRM_TITLE,
                            body = LockerCopy.EXPORT_CONFIRM_BODY,
                            confirm_label = LockerCopy.EXPORT_CONFIRM,
                            destructive = true,
                        ),
                    ),
                ),
            )
            event.dismissed != null -> Step(held.copy(screen = held.screen.copy(confirm = null)))
            // THE OWNER CHECK, AFRESH: a new token the shell raises once.
            event.confirmed != null && held.screen.confirm != null -> {
                val token = held.tokens + 1
                refold(
                    held.copy(
                        tokens = token,
                        screen = held.screen.copy(
                            confirm = null,
                            phase = LockerExportState.Phase.PHASE_CHECKING,
                            prompt = LockerPrompt(
                                token = token,
                                reason = LockerCopy.EXPORT_PROMPT_REASON,
                                title = LockerCopy.EXPORT_PROMPT_TITLE,
                                subtitle = LockerCopy.EXPORT_PROMPT_SUBTITLE,
                            ),
                        ),
                    ),
                )
            }
            event.answered != null -> answered(held, event.answered)
            event.save_settled != null && phase == LockerExportState.Phase.PHASE_SAVING -> {
                val settled = event.save_settled
                val unopened = held.file?.unopened ?: 0
                val sentence = when {
                    settled.saved && unopened > 0 -> LockerFold.fill(LockerCopy.EXPORT_WRITTEN_PARTIAL, "n" to unopened.toString())
                    settled.saved -> LockerCopy.EXPORT_WRITTEN
                    settled.cancelled -> LockerCopy.EXPORT_NOT_SAVED
                    else -> settled.sentence.ifEmpty { LockerCopy.EXPORT_SAVE_REFUSED }
                }
                refold(
                    held.copy(
                        file = null,
                        job = null,
                        screen = held.screen.copy(
                            phase = LockerExportState.Phase.PHASE_IDLE,
                            status = StatusLine(sentence = sentence, refused = !settled.saved && !settled.cancelled),
                        ),
                    ),
                )
            }
            // LEAVING DROPS THE FILE, and a prompt nobody will answer.
            event.left != null -> refold(
                held.copy(
                    file = null,
                    job = null,
                    screen = held.screen.copy(
                        confirm = null,
                        prompt = null,
                        phase = LockerExportState.Phase.PHASE_IDLE,
                    ),
                ),
            )
            else -> Step(held)
        }
    }

    override fun left(): LockerInput<LockerExportEvent> = LockerInput.View(LockerExportEvent(left = LockerExportEvent.Left()))

    private fun answered(held: LockerHeld<LockerExportState>, answered: LockerLockEvent.PromptAnswered): Step<LockerHeld<LockerExportState>> {
        val prompt = held.screen.prompt ?: return Step(held)
        // AN ANSWER TO ANOTHER TOKEN IS NOBODY'S.
        if (answered.token != prompt.token || held.screen.phase != LockerExportState.Phase.PHASE_CHECKING) return Step(held)
        if (answered.outcome != LockerLockEvent.PromptAnswered.Outcome.OUTCOME_SUCCEEDED) {
            return refold(
                held.copy(
                    screen = held.screen.copy(
                        prompt = null,
                        phase = LockerExportState.Phase.PHASE_IDLE,
                        status = StatusLine(sentence = LockerCopy.EXPORT_NOT_CONFIRMED),
                    ),
                ),
            )
        }
        val token = held.tokens + 1
        val format = if (format(held) == JSON) LockerExportFormat.LOCKER_EXPORT_FORMAT_JSON else LockerExportFormat.LOCKER_EXPORT_FORMAT_CSV
        return refold(
            held.copy(
                tokens = token,
                job = LockerJob.Export(token, format),
                screen = held.screen.copy(prompt = null, phase = LockerExportState.Phase.PHASE_WRITING),
            ),
        )
    }

    override fun worked(held: LockerHeld<LockerExportState>, input: LockerInput.Worked): Step<LockerHeld<LockerExportState>> {
        val exported = (input.answer as? LockerDoorAnswer.Session)?.exported
        if (exported == null) {
            val sentence = when (val answer = input.answer) {
                is LockerDoorAnswer.Unreachable -> answer.sentence
                is LockerDoorAnswer.Session ->
                    if (answer.refusal == LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_LOCKED) LockerCopy.REVEAL_LOCKED else LockerCopy.EXPORT_FAILED
            }
            return refold(
                held.copy(
                    job = null,
                    screen = held.screen.copy(phase = LockerExportState.Phase.PHASE_IDLE, status = StatusLine(sentence = sentence, refused = true)),
                ),
            )
        }
        val token = held.tokens + 1
        return refold(
            held.copy(
                tokens = token,
                job = null,
                file = LockerFile(exported.fileName, exported.content, exported.mediaType, token = token, unopened = exported.unopened),
                screen = held.screen.copy(phase = LockerExportState.Phase.PHASE_SAVING),
            ),
        )
    }

    override fun fold(held: LockerHeld<LockerExportState>): LockerExportData? {
        val count = exportable(held) ?: return null
        val busy = held.screen.phase != LockerExportState.Phase.PHASE_IDLE
        val json = format(held) == JSON
        return LockerExportData(
            lede = LockerCopy.EXPORT_LEDE,
            what_label = LockerCopy.EXPORT_WHAT,
            what_value = LockerFold.fill(if (count == 1) LockerCopy.EXPORT_WHAT_ONE else LockerCopy.EXPORT_WHAT_MANY, "n" to count.toString()),
            leaves_out = LockerCopy.EXPORT_LEAVES_OUT,
            format_label = LockerCopy.EXPORT_FORMAT,
            formats = listOf(
                LockerChoice(key = CSV, label = LockerCopy.EXPORT_FORMAT_CSV, selected = !json),
                LockerChoice(key = JSON, label = LockerCopy.EXPORT_FORMAT_JSON, selected = json),
            ),
            format_note = if (json) LockerCopy.EXPORT_FORMAT_JSON_NOTE else LockerCopy.EXPORT_FORMAT_CSV_NOTE,
            where_label = LockerCopy.EXPORT_WHERE,
            where_value = LockerCopy.EXPORT_WHERE_VALUE,
            where_note = LockerCopy.EXPORT_WHERE_NOTE,
            commit_label = if (busy || count == 0) "" else LockerCopy.EXPORT_COMMIT,
            commit_note = when {
                count == 0 -> LockerCopy.EXPORT_NOTHING
                held.screen.phase == LockerExportState.Phase.PHASE_WRITING -> LockerCopy.EXPORT_WRITING
                held.screen.phase == LockerExportState.Phase.PHASE_SAVING -> LockerCopy.EXPORT_SAVING
                else -> LockerCopy.EXPORT_COMMIT_NOTE
            },
        )
    }

    override fun decorate(held: LockerHeld<LockerExportState>): LockerExportState =
        held.screen.copy(chrome = LockerExportChrome(title = LockerCopy.EXPORT_TITLE, back_label = LockerCopy.APP_NAME, retry = LockerCopy.RETRY))

    /** The file and its token, for the save seam — only while its sheet is up. */
    internal fun saving(held: LockerHeld<LockerExportState>): LockerFile? =
        held.file?.takeIf { held.screen.phase == LockerExportState.Phase.PHASE_SAVING }

    private object ExportLens : ContentLens<LockerExportState, LockerExportData> {
        override fun content(state: LockerExportState): ReadContent<LockerExportData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: LockerExportState, content: ReadContent<LockerExportData>): LockerExportState = when (content) {
            is ReadContent.Loading -> state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

private const val LOCKER_EXPORT: String = "locker.export"
private const val LOCKER_IMPORT: String = "locker.import"

/** What the export page asks: the counts. Nothing while locked. */
public object LockerExportReads : LockerQueries<LockerExportState, LockerExportEvent>(
    screenId = LOCKER_EXPORT,
    tables = LOCKER_TABLES,
    ask = { _, now -> listOf(countRequest(now.zone)) },
)

/**
 * `locker.export`, both shells.
 *
 * ## The platform seam: saving the file
 *
 * [onSave] is the shell's: handed the file's bytes, the name the core
 * proposed and its media type, it presents the OS save sheet —
 * `.fileExporter` on iOS, the Storage Access Framework's `CreateDocument` on
 * Android — writes the bytes exactly as given, and answers once with
 * [saved], [saveCancelled] or [saveRefused]. It writes no copy anywhere else:
 * no temporary file, no cache, no app storage. Unset, the export refuses.
 *
 * The owner check is the lock wall's seam: when the state carries a
 * `prompt` token the shell has not raised, it raises the OS prompt and sends
 * `answered` with the outcome, exactly as for the wall.
 */
public class LockerExportBridge : LockerScreenBridge<LockerExportState, LockerExportEvent>(
    LockerExportMachine,
    LockerExportEvent.ADAPTER,
    LockerExportReads,
) {
    /** The shell's save sheet: `(bytes, fileName, mediaType)`. See the class header. */
    public var onSave: ((bytes: ByteArray, fileName: String, mediaType: String) -> Unit)? = null

    private val seam = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var handed: Long = 0L

    init {
        seam.launch {
            host.state.map { LockerExportMachine.saving(it) }.distinctUntilChanged().collect { file ->
                if (file == null || file.token <= handed) return@collect
                handed = file.token
                val sheet = onSave
                if (sheet == null) saveRefused(LockerCopy.EXPORT_NO_SAVER) else sheet(file.bytes, file.name, file.mediaType)
            }
        }
    }

    public fun open(parent: String) {
        forward(LockerExportEvent(opened = LockerExportEvent.Opened(parent = parent)))
    }

    public fun open() {
        open("")
    }

    public fun saved() {
        forward(LockerExportEvent(save_settled = LockerExportEvent.SaveSettled(saved = true)))
    }

    public fun saveCancelled() {
        forward(LockerExportEvent(save_settled = LockerExportEvent.SaveSettled(cancelled = true)))
    }

    public fun saveRefused(sentence: String) {
        forward(LockerExportEvent(save_settled = LockerExportEvent.SaveSettled(sentence = sentence)))
    }
}

// ---------------------------------------------------------------------------
// locker.import
// ---------------------------------------------------------------------------

/**
 * A PASSWORD-MANAGER FILE, READ, REVIEWED AND SEALED IN (#1047 T2; the
 * handoff's `locker/import`: draft → review → publish).
 *
 * Choose is an intent the shell answers with the OS picker; the picked bytes
 * arrive as [LockerInput.Picked] and are held Kotlin-side ([LockerHeld.file])
 * — never on the drawn state — while the core plans them. Add writes the plan
 * (every secret sealed by the core on the way in) and drops the file; Discard
 * drops it and writes nothing; so does a relock or leaving.
 */
public object LockerImportMachine :
    LockerQueryMachine<LockerImportState, LockerImportEvent, LockerImportData>(LOCKER_IMPORT, LOCKER_TABLES) {
    public const val SCREEN_ID: String = LOCKER_IMPORT

    override val lens: ContentLens<LockerImportState, LockerImportData> = ImportLens

    override fun blank(): LockerImportState = LockerImportState(phase = LockerImportState.Phase.PHASE_IDLE)

    override fun seatOf(screen: LockerImportState): SeatState = screen.seat ?: SeatState()

    override fun withSeat(screen: LockerImportState, seat: SeatState): LockerImportState = screen.copy(seat = seat)

    /** The plan the core answered, Kotlin-side. Rows carry no secret. */
    private fun plan(held: LockerHeld<LockerImportState>): LockerImportPlan? = held.plan

    override fun view(held: LockerHeld<LockerImportState>, event: LockerImportEvent, entropy: ByteArray): Step<LockerHeld<LockerImportState>> {
        val phase = held.screen.phase
        return when {
            event.opened != null -> reload(
                LockerHeld(
                    screen = blank().copy(seat = held.screen.seat),
                    open = held.open,
                    tokens = held.tokens,
                ),
            )
            event.refreshed != null -> read(overRows(held))
            event.publish != null && phase == LockerImportState.Phase.PHASE_PLANNED && writes(plan(held)) > 0 && held.file != null -> {
                val token = held.tokens + 1
                refold(
                    held.copy(
                        tokens = token,
                        job = LockerJob.Import(token, publish = true),
                        screen = held.screen.copy(phase = LockerImportState.Phase.PHASE_PUBLISHING, status = null),
                    ),
                )
            }
            event.discard != null && phase == LockerImportState.Phase.PHASE_PLANNED -> refold(
                idle(held).copy(screen = held.screen.copy(phase = LockerImportState.Phase.PHASE_IDLE, status = StatusLine(sentence = LockerCopy.IMPORT_DISCARDED))),
            )
            // LEAVING DROPS THE FILE; a write under way still lands.
            event.left != null && phase != LockerImportState.Phase.PHASE_PUBLISHING -> refold(
                idle(held).copy(screen = held.screen.copy(phase = LockerImportState.Phase.PHASE_IDLE, status = null)),
            )
            // `choose` IS AN INTENT: the shell opens the picker.
            else -> Step(held)
        }
    }

    override fun left(): LockerInput<LockerImportEvent> = LockerInput.View(LockerImportEvent(left = LockerImportEvent.Left()))

    private fun idle(held: LockerHeld<LockerImportState>): LockerHeld<LockerImportState> =
        held.copy(file = null, job = null, plan = null)

    override fun picked(held: LockerHeld<LockerImportState>, input: LockerInput.Picked): Step<LockerHeld<LockerImportState>> {
        val phase = held.screen.phase
        if (phase == LockerImportState.Phase.PHASE_READING || phase == LockerImportState.Phase.PHASE_PUBLISHING) return Step(held)
        val token = held.tokens + 1
        return refold(
            held.copy(
                tokens = token,
                file = LockerFile(input.name, input.bytes),
                plan = null,
                job = LockerJob.Import(token, publish = false),
                screen = held.screen.copy(phase = LockerImportState.Phase.PHASE_READING, status = null),
            ),
        )
    }

    override fun worked(held: LockerHeld<LockerImportState>, input: LockerInput.Worked): Step<LockerHeld<LockerImportState>> {
        val session = input.answer as? LockerDoorAnswer.Session
        val plan = session?.plan
        if (plan == null) {
            val sentence = when {
                input.answer is LockerDoorAnswer.Unreachable -> input.answer.sentence
                session?.refusal == LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_NOT_READABLE -> LockerCopy.IMPORT_NOT_READABLE
                session?.refusal == LockerRevealRefusal.LOCKER_REVEAL_REFUSAL_LOCKED -> LockerCopy.REVEAL_LOCKED
                else -> LockerCopy.IMPORT_FAILED
            }
            val publishing = held.screen.phase == LockerImportState.Phase.PHASE_PUBLISHING
            return refold(
                held.copy(
                    job = null,
                    // A REFUSED PUBLISH KEEPS THE PLAN, so Add can be tried
                    // again; a refused read has nothing to keep.
                    file = if (publishing) held.file else null,
                    screen = held.screen.copy(
                        phase = if (publishing) LockerImportState.Phase.PHASE_PLANNED else LockerImportState.Phase.PHASE_IDLE,
                        status = StatusLine(sentence = sentence, refused = true),
                    ),
                ),
            )
        }
        if (plan.published) {
            val sentence = buildString {
                append(
                    LockerFold.fill(
                        LockerCopy.IMPORT_PUBLISHED,
                        "created" to plan.created.toString(),
                        "filled" to plan.filled.toString(),
                        "held" to plan.held_count.toString(),
                    ),
                )
                if (plan.failed > 0) append(LockerFold.fill(LockerCopy.IMPORT_FAILED_ROWS, "n" to plan.failed.toString()))
            }
            return refold(
                held.copy(
                    job = null,
                    file = null,
                    plan = plan,
                    screen = held.screen.copy(
                        phase = LockerImportState.Phase.PHASE_PUBLISHED,
                        status = StatusLine(sentence = sentence, refused = plan.failed > 0),
                    ),
                ),
            )
        }
        return refold(held.copy(job = null, plan = plan, screen = held.screen.copy(phase = LockerImportState.Phase.PHASE_PLANNED)))
    }

    /** The rows a publish writes: new and fill. */
    private fun writes(plan: LockerImportPlan?): Int = (plan?.new_count ?: 0) + (plan?.fill_count ?: 0)

    override fun fold(held: LockerHeld<LockerImportState>): LockerImportData? {
        held.answers.items ?: return null
        val phase = held.screen.phase
        val plan = plan(held)
        val drawn = plan.takeIf { phase == LockerImportState.Phase.PHASE_PLANNED || phase == LockerImportState.Phase.PHASE_PUBLISHING || phase == LockerImportState.Phase.PHASE_PUBLISHED }
        val busy = phase == LockerImportState.Phase.PHASE_READING || phase == LockerImportState.Phase.PHASE_PUBLISHING
        return LockerImportData(
            lede = LockerCopy.IMPORT_LEDE,
            file_label = LockerCopy.IMPORT_FILE,
            file_value = held.file?.name ?: LockerCopy.IMPORT_NO_FILE,
            file_note = when (phase) {
                LockerImportState.Phase.PHASE_READING -> LockerCopy.IMPORT_READING
                LockerImportState.Phase.PHASE_PUBLISHED -> LockerCopy.IMPORT_DONE_NOTE
                else -> LockerCopy.IMPORT_FILE_NOTE
            },
            choose_label = if (busy) "" else LockerCopy.IMPORT_CHOOSE,
            verdicts_label = LockerCopy.IMPORT_VERDICTS,
            verdicts = VERDICTS.map { (chip, sentence) -> LockerFact(label = chip, detail = sentence) },
            counts = drawn?.let {
                LockerFold.fill(
                    LockerCopy.IMPORT_COUNTS,
                    "new" to it.new_count.toString(),
                    "fill" to it.fill_count.toString(),
                    "held" to it.held_count.toString(),
                    "skipped" to it.skipped_count.toString(),
                )
            }.orEmpty(),
            rows_label = if (drawn?.rows?.isNotEmpty() == true) LockerCopy.IMPORT_ROWS else "",
            rows = drawn?.rows.orEmpty().mapIndexed { index, row ->
                val (chip, sentence) = verdictOf(row.verdict)
                val meta = listOf(LockerFold.typeLabel(row.type), row.subtitle, sentence).filter { it.isNotEmpty() }.joinToString(" · ")
                LockerImportLine(
                    key = "row:$index",
                    title = row.title.ifEmpty { LockerCopy.IMPORT_UNTITLED },
                    meta = meta,
                    chip = StatusChip(
                        label = chip,
                        tone = if (row.verdict == LockerImportVerdict.LOCKER_IMPORT_VERDICT_NEW || row.verdict == LockerImportVerdict.LOCKER_IMPORT_VERDICT_FILL) {
                            StatusChip.Tone.TONE_UNSPECIFIED
                        } else {
                            StatusChip.Tone.TONE_SEAM
                        },
                    ),
                    accessibility_label = listOf(row.title, meta, chip).filter { it.isNotEmpty() }.joinToString(", "),
                )
            },
            publish_label = if (phase == LockerImportState.Phase.PHASE_PLANNED && writes(plan) > 0) LockerCopy.IMPORT_PUBLISH else "",
            publish_note = if (phase == LockerImportState.Phase.PHASE_PLANNED && writes(plan) > 0) LockerCopy.IMPORT_PUBLISH_NOTE else "",
            discard_label = if (phase == LockerImportState.Phase.PHASE_PLANNED) LockerCopy.IMPORT_DISCARD else "",
            empty = if (drawn != null && drawn.rows.isEmpty()) {
                EmptyState(headline = LockerCopy.IMPORT_NOTHING, body = LockerCopy.IMPORT_NOTHING_BODY)
            } else {
                null
            },
        )
    }

    private fun verdictOf(verdict: LockerImportVerdict): Pair<String, String> = when (verdict) {
        LockerImportVerdict.LOCKER_IMPORT_VERDICT_NEW -> VERDICTS[0]
        LockerImportVerdict.LOCKER_IMPORT_VERDICT_FILL -> VERDICTS[1]
        LockerImportVerdict.LOCKER_IMPORT_VERDICT_HELD -> VERDICTS[2]
        else -> VERDICTS[3]
    }

    /** The handoff's import verdicts (README §6), each with its chip. */
    private val VERDICTS: List<Pair<String, String>> = listOf(
        LockerCopy.IMPORT_CHIP_NEW to LockerCopy.IMPORT_VERDICT_NEW,
        LockerCopy.IMPORT_CHIP_FILL to LockerCopy.IMPORT_VERDICT_FILL,
        LockerCopy.IMPORT_CHIP_HELD to LockerCopy.IMPORT_VERDICT_HELD,
        LockerCopy.IMPORT_CHIP_SKIPPED to LockerCopy.IMPORT_VERDICT_SKIPPED,
    )

    override fun decorate(held: LockerHeld<LockerImportState>): LockerImportState =
        held.screen.copy(chrome = LockerImportChrome(title = LockerCopy.IMPORT_TITLE, back_label = LockerCopy.APP_NAME, retry = LockerCopy.RETRY))

    private object ImportLens : ContentLens<LockerImportState, LockerImportData> {
        override fun content(state: LockerImportState): ReadContent<LockerImportData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: LockerImportState, content: ReadContent<LockerImportData>): LockerImportState = when (content) {
            is ReadContent.Loading -> state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

/** What the import page asks: the counts. Nothing while locked. */
public object LockerImportReads : LockerQueries<LockerImportState, LockerImportEvent>(
    screenId = LOCKER_IMPORT,
    tables = LOCKER_TABLES,
    ask = { _, now -> listOf(countRequest(now.zone)) },
)

/**
 * `locker.import`, both shells. `ChooseTapped` is the shell's cue to open the
 * OS picker (`.fileImporter` on iOS, the Storage Access Framework's
 * `OpenDocument` on Android) and read the chosen file's bytes — from the
 * picker's own URI, never copied into app storage — then call [picked]; a
 * dismissed picker changes nothing.
 */
public class LockerImportBridge : LockerScreenBridge<LockerImportState, LockerImportEvent>(
    LockerImportMachine,
    LockerImportEvent.ADAPTER,
    LockerImportReads,
) {
    public fun open(parent: String) {
        forward(LockerImportEvent(opened = LockerImportEvent.Opened(parent = parent)))
    }

    public fun open() {
        open("")
    }

    /** The OS picker's file, as it was on disk. */
    public fun picked(name: String, bytes: ByteArray) {
        deliver(LockerInput.Picked(name, bytes))
    }
}
