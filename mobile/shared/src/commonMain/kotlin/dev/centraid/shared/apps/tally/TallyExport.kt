package dev.centraid.shared.apps.tally

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.TallyDashboardRequest
import centraid.core.v1.TallyExportRequest
import centraid.core.v1.TallyGroupCard
import centraid.screen.v1.EmptyState
import centraid.screen.v1.SeatState
import centraid.screen.v1.TallyChoice
import centraid.screen.v1.TallyExportChrome
import centraid.screen.v1.TallyExportData
import centraid.screen.v1.TallyExportEvent
import centraid.screen.v1.TallyExportState
import dev.centraid.design.copy.TallyCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.dataOf
import dev.centraid.shared.screen.Step
import kotlinx.coroutines.launch

/**
 * A GROUP'S LEDGER AS A FILE (#1047, R-1047-Q5). The handoff's `tally/export`:
 * a group, a range, what the file holds, and Save.
 *
 * THE CORE RENDERS THE FILE. `tally.export` answers `csv` — RFC 4180, each
 * amount a plain decimal by its currency's exponent — and `file_name`, so
 * nothing here formats money and no view writes a byte of it. The group and
 * the range are the REQUEST (law 2): picking either reads again. A range is a
 * `since` day off the dashboard's `today` (this year's first day, this
 * month's), so there is no calendar here; until `today` has been answered,
 * only Everything is offered.
 *
 * The dashboard is read beside the export for the group picker: live groups,
 * then archived ones. A vault with exactly one group has it picked.
 *
 * The file stays Kotlin-side ([TallyAnswers.export]); Save hands it to the
 * platform through [TallyExportBridge.onSave].
 */
public object TallyExportMachine :
    TallyQueryMachine<TallyExportState, TallyExportEvent, TallyExportData>(SCREEN, TALLY_LEDGER_TABLES) {
    public const val SCREEN_ID: String = SCREEN

    /** The window asked for: the core's ceiling, so a long ledger is one file. */
    public const val LIMIT: Int = 2000

    /** How many of the file's rows the screen draws under "In the file". */
    public const val PREVIEW: Int = 20

    private const val YEAR: Int = 4
    private const val MONTH: Int = 7

    override val lens: ContentLens<TallyExportState, TallyExportData> = ExportLens

    override fun blank(): TallyExportState = TallyExportState(
        range = TallyExportState.Range.RANGE_EVERYTHING,
        save = TallyExportState.Save.SAVE_IDLE,
        sheet = TallyExportState.Sheet.SHEET_NONE,
    )

    override fun withSeat(screen: TallyExportState, seat: SeatState): TallyExportState = screen.copy(seat = seat)

    override fun view(held: TallyHeld<TallyExportState>, event: TallyExportEvent): Step<TallyHeld<TallyExportState>> =
        when {
            event.opened != null -> reload(
                held.copy(
                    screen = blank().copy(
                        group_id = event.opened.group_id,
                        parent = event.opened.parent,
                        seat = held.screen.seat,
                    ),
                ),
            )
            event.refreshed != null -> read(overRows(held))
            // THE CHOICES SHEET (#1015 D4): one up at a time, only over choices to make.
            event.sheet_opened != null -> {
                val sheet = event.sheet_opened.sheet
                val offered = when (sheet) {
                    TallyExportState.Sheet.SHEET_GROUP -> groups(held).isNotEmpty()
                    TallyExportState.Sheet.SHEET_RANGE -> held.answers.dashboard != null
                    else -> false
                }
                if (offered) Step(held.copy(screen = held.screen.copy(sheet = sheet))) else Step(held)
            }
            event.sheet_closed != null -> Step(closed(held))
            // A PICK CLOSES ITS SHEET, whether or not it changes the window.
            event.group != null -> {
                val id = event.group.group_id
                if (id == held.screen.group_id || id !in groupIds(held)) {
                    Step(closed(held))
                } else {
                    window(held, closed(held).screen.copy(group_id = id))
                }
            }
            event.range != null -> {
                val range = event.range.range
                if (range == held.screen.range || sinceOf(range, today(held)) == null) {
                    Step(closed(held))
                } else {
                    window(held, closed(held).screen.copy(range = range))
                }
            }
            // SAVE: the sheet goes up only over a file the core rendered.
            event.save != null ->
                if (canSave(held) && held.screen.save != TallyExportState.Save.SAVE_OPEN) {
                    Step(held.copy(screen = held.screen.copy(save = TallyExportState.Save.SAVE_OPEN, status_label = "")))
                } else {
                    Step(held)
                }
            event.save_settled != null && held.screen.save == TallyExportState.Save.SAVE_OPEN -> {
                val settled = event.save_settled
                Step(
                    held.copy(
                        screen = held.screen.copy(
                            save = when {
                                settled.saved -> TallyExportState.Save.SAVE_SAVED
                                settled.cancelled -> TallyExportState.Save.SAVE_IDLE
                                else -> TallyExportState.Save.SAVE_REFUSED
                            },
                            status_label = when {
                                settled.saved -> TallyCopy.EXPORT_SAVED
                                settled.cancelled -> ""
                                else -> settled.sentence.ifEmpty { TallyCopy.EXPORT_NO_SAVER }
                            },
                        ),
                    ),
                )
            }
            else -> Step(held)
        }

    private fun closed(held: TallyHeld<TallyExportState>): TallyHeld<TallyExportState> =
        held.copy(screen = held.screen.copy(sheet = TallyExportState.Sheet.SHEET_NONE))

    /**
     * A NEW WINDOW: skeletons over the old file's rows would be a file the
     * member did not ask for, so the export is dropped and read again.
     */
    private fun window(held: TallyHeld<TallyExportState>, screen: TallyExportState): Step<TallyHeld<TallyExportState>> =
        read(
            held.copy(
                screen = lens.with(
                    screen.copy(save = TallyExportState.Save.SAVE_IDLE, status_label = ""),
                    ReadContent.Loading(firstLoad = true),
                ),
                answers = held.answers.copy(export = null),
            ),
        )

    /** ONE GROUP IS PICKED FOR THE MEMBER: nothing else could be meant. */
    override fun absorb(held: TallyHeld<TallyExportState>): TallyHeld<TallyExportState> {
        if (held.screen.group_id.isNotEmpty()) return held
        val only = groups(held).singleOrNull() ?: return held
        return held.copy(screen = held.screen.copy(group_id = only.group_id))
    }

    /**
     * The group picked after the first answer (the one-group case) has no
     * export yet: read again for it. Everything else is the base's.
     */
    override fun reduce(
        state: TallyHeld<TallyExportState>,
        event: TallyInput<TallyExportEvent>,
    ): Step<TallyHeld<TallyExportState>> {
        val step = super.reduce(state, event)
        val next = step.state
        val wanting = event is TallyInput.Answered && next.screen.group_id.isNotEmpty() &&
            next.answers.export == null && !next.reading
        return if (wanting) {
            val again = read(next.copy(screen = lens.with(next.screen, ReadContent.Loading(firstLoad = true))))
            Step(again.state, step.effects + again.effects)
        } else {
            step
        }
    }

    override fun fold(held: TallyHeld<TallyExportState>): TallyExportData? {
        val dashboard = held.answers.dashboard ?: return null
        val screen = held.screen
        val today = dashboard.today
        val all = groups(held)
        val groupChoices = all.map { card ->
            TallyChoice(
                key = card.group_id,
                label = card.name.ifBlank { TallyCopy.NO_GROUP_LABEL },
                selected = card.group_id == screen.group_id,
                enabled = true,
                hue = card.color,
            )
        }
        val ranges = RANGES.map { (range, label) ->
            TallyChoice(
                key = range.name,
                label = label,
                selected = range == screen.range,
                enabled = sinceOf(range, today) != null,
                export_range = range,
            )
        }
        val export = held.answers.export?.takeIf { screen.group_id.isNotEmpty() }
        if (all.isEmpty() || screen.group_id.isEmpty() || export == null) {
            return TallyExportData(
                groups = groupChoices,
                ranges = ranges,
                empty = EmptyState(headline = if (all.isEmpty()) TallyCopy.GROUPS_EMPTY else TallyCopy.EXPORT_PICK_GROUP),
            )
        }
        val groupName = export.group?.name ?: all.firstOrNull { it.group_id == screen.group_id }?.name ?: ""
        val expenses = export.expenses.map { TallyFold.expenseRow(it, today, withGroup = false) }
        val settlements = export.settlements.map { TallyFold.settlementRow(it, groupName, today) }
        val nothing = export.expenses.isEmpty() && export.settlements.isEmpty()
        return TallyExportData(
            groups = groupChoices,
            ranges = ranges,
            count_label = if (nothing) "" else countLabel(export),
            rows = (expenses + settlements).take(PREVIEW),
            empty = if (nothing) EmptyState(headline = TallyCopy.EXPORT_NOTHING) else null,
            can_save = !nothing && export.csv.isNotEmpty(),
            file_name = export.file_name,
        )
    }

    /** "12 expenses · 3 settlements"; "500 of 812 expenses · …" when the window cut the file. */
    internal fun countLabel(export: centraid.core.v1.TallyExport): String {
        fun part(held: Int, matched: Int, one: String, many: String): String {
            val noun = if (maxOf(held, matched) == 1) one else many
            return if (matched > held) {
                "${TallyCopy.EXPORT_WINDOW.replace("{n}", held.toString()).replace("{m}", matched.toString())} $noun"
            } else {
                "$held $noun"
            }
        }
        return listOf(
            part(export.expenses.size, export.expenses_in_window, TallyCopy.EXPENSE_ONE, TallyCopy.EXPENSE_MANY),
            part(export.settlements.size, export.settlements_in_window, TallyCopy.SETTLEMENT_ONE, TallyCopy.SETTLEMENT_MANY),
        ).joinToString(" · ")
    }

    override fun decorate(held: TallyHeld<TallyExportState>): TallyExportState =
        held.screen.copy(chrome = CHROME.copy(back = held.screen.parent.ifEmpty { TallyCopy.APP_TITLE }))

    /** Save is offered: a group, and a file the core rendered for it. */
    internal fun canSave(held: TallyHeld<TallyExportState>): Boolean =
        lens.dataOf(held.screen)?.can_save == true

    /** The file and its name, for the platform — only while its sheet is up. */
    internal fun file(held: TallyHeld<TallyExportState>): Pair<String, String>? {
        if (held.screen.save != TallyExportState.Save.SAVE_OPEN) return null
        val export = held.answers.export ?: return null
        if (export.csv.isEmpty()) return null
        return export.csv to export.file_name
    }

    /** What the screen asks: the dashboard (the picker, `today`), and the export once a group is picked. */
    internal fun requests(held: TallyHeld<TallyExportState>, zone: String): List<AppQueryRequest> = buildList {
        add(AppQueryRequest(tally_dashboard = TallyDashboardRequest(tz = zone)))
        val group = held.screen.group_id
        if (group.isNotEmpty()) {
            add(
                AppQueryRequest(
                    tally_export = TallyExportRequest(
                        group_id = group,
                        since = sinceOf(held.screen.range, today(held)) ?: "",
                        limit = LIMIT,
                        tz = zone,
                    ),
                ),
            )
        }
    }

    /**
     * A range's `since`: "" for Everything, the first day of `today`'s year
     * or month otherwise — or null when `today` is not known yet, and that
     * range cannot be asked.
     */
    internal fun sinceOf(range: TallyExportState.Range, today: String): String? = when (range) {
        TallyExportState.Range.RANGE_THIS_YEAR -> today.takeIf { it.length >= MONTH }?.let { "${it.take(YEAR)}-01-01" }
        TallyExportState.Range.RANGE_THIS_MONTH -> today.takeIf { it.length >= MONTH }?.let { "${it.take(MONTH)}-01" }
        else -> ""
    }

    private fun today(held: TallyHeld<TallyExportState>): String = held.answers.dashboard?.today ?: ""

    private fun groups(held: TallyHeld<TallyExportState>): List<TallyGroupCard> =
        held.answers.dashboard?.let { it.groups + it.archived_groups }.orEmpty()

    private fun groupIds(held: TallyHeld<TallyExportState>): Set<String> = groups(held).map { it.group_id }.toSet()

    private val RANGES: List<Pair<TallyExportState.Range, String>> = listOf(
        TallyExportState.Range.RANGE_EVERYTHING to TallyCopy.EXPORT_RANGE_ALL,
        TallyExportState.Range.RANGE_THIS_YEAR to TallyCopy.EXPORT_RANGE_YEAR,
        TallyExportState.Range.RANGE_THIS_MONTH to TallyCopy.EXPORT_RANGE_MONTH,
    )

    private val CHROME = TallyExportChrome(
        title = TallyCopy.EXPORT_HEAD,
        lede = TallyCopy.EXPORT_LEDE,
        group_label = TallyCopy.FIELD_GROUP,
        range_label = TallyCopy.EXPORT_RANGE,
        format_label = TallyCopy.EXPORT_FORMAT,
        format_value = TallyCopy.EXPORT_FORMAT_VALUE,
        save = TallyCopy.EXPORT_COMMIT,
        foot = TallyCopy.EXPORT_FOOT,
        retry = TallyCopy.RETRY,
        loading = TallyCopy.LOADING,
        back = TallyCopy.APP_TITLE,
        rows_heading = TallyCopy.EXPORT_ROWS_HEADING,
    )

    private object ExportLens : ContentLens<TallyExportState, TallyExportData> {
        override fun content(state: TallyExportState): ReadContent<TallyExportData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: TallyExportState, content: ReadContent<TallyExportData>): TallyExportState = when (content) {
            is ReadContent.Loading -> state.copy(
                loading = centraid.screen.v1.Loading(first_load = content.firstLoad),
                failure = null,
                denied = null,
                data_ = null,
            )
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

private const val SCREEN: String = "tally.export"

/** What `tally.export` asks the core: the dashboard, and the group's export once one is picked. */
public object TallyExportReads : TallyQueries<TallyExportState, TallyExportEvent>(
    screenId = TallyExportMachine.SCREEN_ID,
    tables = TallyExportMachine.tables,
    ask = { held, now -> TallyExportMachine.requests(held, now.zone) },
)

/**
 * `tally.export`, both shells.
 *
 * ## The platform seam: saving the file
 *
 * [onSave] is the shell's: handed the CSV text and the file name the core
 * proposed, it presents the platform's own sheet — `UIActivityViewController`
 * or `UIDocumentPickerViewController(forExporting:)` over a temporary file on
 * iOS, the Storage Access Framework's `CreateDocument("text/csv")` on Android
 * — and answers exactly once: [saved], [saveCancelled], or [saveRefused] with
 * a sentence. The shell writes the text as UTF-8, byte for byte; it formats
 * nothing. Unset, Save says this phone cannot save the file.
 */
public class TallyExportBridge : TallyScreenBridge<TallyExportState, TallyExportEvent>(
    TallyExportMachine,
    TallyExportEvent.ADAPTER,
    TallyExportReads,
) {
    /** The shell's save sheet: `(csv, fileName)`. See the class header. */
    public var onSave: ((csv: String, fileName: String) -> Unit)? = null

    /** Open over [groupId] (empty: pick one); [parent] is the pushing page's title. */
    public fun open(groupId: String, parent: String) {
        forward(TallyExportEvent(opened = TallyExportEvent.Opened(group_id = groupId, parent = parent)))
    }

    /** Swift cannot omit a default: these are the calls without them. */
    public fun open(groupId: String) {
        open(groupId, "")
    }

    public fun open() {
        open("", "")
    }

    /** Save: the platform's sheet, over the file the core rendered. */
    public fun save() {
        scope.launch {
            host.send(TallyInput.View(TallyExportEvent(save = TallyExportEvent.SaveRequested())))
            val (csv, name) = TallyExportMachine.file(host.state.value) ?: return@launch
            val sheet = onSave
            if (sheet == null) {
                host.send(
                    TallyInput.View(
                        TallyExportEvent(save_settled = TallyExportEvent.SaveSettled(sentence = TallyCopy.EXPORT_NO_SAVER)),
                    ),
                )
            } else {
                sheet(csv, name)
            }
        }
    }

    /** The platform wrote the file. */
    public fun saved() {
        forward(TallyExportEvent(save_settled = TallyExportEvent.SaveSettled(saved = true)))
    }

    /** The member closed the sheet. */
    public fun saveCancelled() {
        forward(TallyExportEvent(save_settled = TallyExportEvent.SaveSettled(cancelled = true)))
    }

    /** The platform would not write it, in the member's words. */
    public fun saveRefused(sentence: String) {
        forward(TallyExportEvent(save_settled = TallyExportEvent.SaveSettled(sentence = sentence)))
    }
}
