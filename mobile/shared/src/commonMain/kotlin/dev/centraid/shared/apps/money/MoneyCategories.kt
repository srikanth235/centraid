package dev.centraid.shared.apps.money

import centraid.core.v1.AppQueryRequest
import centraid.core.v1.MoneyCategoriesRequest
import centraid.screen.v1.Confirm
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.MoneyAction
import centraid.screen.v1.MoneyCategoriesData
import centraid.screen.v1.MoneyCategoriesEvent
import centraid.screen.v1.MoneyCategoriesState
import centraid.screen.v1.MoneyCategoryEntry
import centraid.screen.v1.MoneyCategoryGroup
import centraid.screen.v1.MoneyPageChrome
import centraid.screen.v1.SeatState
import centraid.screen.v1.StatusLine
import centraid.screen.v1.WriteSettled
import centraid.screen.v1.WriteState
import dev.centraid.design.copy.MoneyCopy
import dev.centraid.shared.kit.ContentLens
import dev.centraid.shared.kit.InvokeKeys
import dev.centraid.shared.kit.ReadContent
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.screen.Step
import dev.centraid.shared.nav.ScreenIds

/**
 * CATEGORIES (#1099, R-1099-16): one scheme, two levels. A category is added
 * under a group, merged into another (every line filed under it moves), or
 * archived so it leaves the pickers and keeps its history; archiving is undone
 * the same way. The starters are the vault's own and are managed here like any
 * other.
 */
public object MoneyCategoriesMachine :
    MoneyQueryMachine<MoneyCategoriesState, MoneyCategoriesEvent, MoneyCategoriesData>("money.categories", MONEY_TABLES) {
    public const val SCREEN_ID: String = ScreenIds.MONEY_CATEGORIES
    public const val CMD_ADD: String = "category.add"
    public const val CMD_MERGE: String = "category.merge"

    /** Archiving a category is the archived flag on it: the shared verbs. */
    public const val CMD_ARCHIVE: String = "flag.set"
    public const val CMD_RESTORE: String = "flag.clear"

    public const val ROW_MERGE: String = "merge"
    public const val ROW_ARCHIVE: String = "archive"
    public const val ROW_RESTORE: String = "restore"

    private const val NAME_MAX: Int = 60

    override val lens: ContentLens<MoneyCategoriesState, MoneyCategoriesData> = Lens

    override fun blank(): MoneyCategoriesState = MoneyCategoriesState(
        write = WriteState(phase = WriteState.Phase.PHASE_IDLE),
        sheet = MoneyCategoriesState.Sheet.SHEET_NONE,
        chrome = chrome(""),
    )

    override fun withSeat(screen: MoneyCategoriesState, seat: SeatState): MoneyCategoriesState = screen.copy(seat = seat)

    override fun view(held: MoneyHeld<MoneyCategoriesState>, event: MoneyCategoriesEvent): Step<MoneyHeld<MoneyCategoriesState>> {
        val screen = held.screen
        return when {
            event.opened != null -> reload(
                held.copy(
                    screen = blank().copy(
                        seat = screen.seat,
                        chrome = chrome(event.opened.parent),
                        draft_token = event.opened.draft_token,
                    ),
                ),
            )

            event.refreshed != null -> read(overRows(held))

            event.add != null -> Step(
                held.copy(
                    screen = screen.copy(
                        sheet = MoneyCategoriesState.Sheet.SHEET_ADD,
                        name_draft = "",
                        group_id = "",
                        status = null,
                    ),
                ),
            )

            event.name != null -> Step(held.copy(screen = screen.copy(name_draft = event.name.text)))

            event.group != null -> Step(held.copy(screen = screen.copy(group_id = event.group.group_id)))

            event.save != null -> add(held)

            event.category != null -> Step(
                held.copy(
                    screen = screen.copy(
                        sheet = MoneyCategoriesState.Sheet.SHEET_ROW,
                        category_id = event.category.category_id,
                        status = null,
                    ),
                ),
            )

            event.row_action != null -> rowAction(held, event.row_action.key)

            event.merge_into != null -> {
                val from = entry(held, screen.category_id)
                val into = entry(held, event.merge_into.category_id)
                if (from == null || into == null) {
                    Step(held)
                } else {
                    Step(
                        held.copy(
                            screen = screen.copy(
                                merge_into = into.category_id,
                                confirm = Confirm(
                                    title = MoneyCopy.MERGE_TITLE,
                                    body = MoneyFold.fill(MoneyCopy.MERGE_BODY, "from" to from.label, "into" to into.label),
                                    confirm_label = MoneyCopy.MERGE_CONFIRM,
                                    destructive = true,
                                ),
                            ),
                        ),
                    )
                }
            }

            event.confirm_dismissed != null -> Step(held.copy(screen = screen.copy(confirm = null, merge_into = "")))

            event.confirm_accepted != null && screen.confirm != null && screen.merge_into.isNotEmpty() -> {
                val input = MoneyFold.json(
                    "from_id" to MoneyFold.str(screen.category_id),
                    "into_id" to MoneyFold.str(screen.merge_into),
                )
                val cleared = held.copy(screen = screen.copy(confirm = null, sheet = MoneyCategoriesState.Sheet.SHEET_NONE))
                WriteLaw.submit(Writes, cleared, CMD_MERGE, input, InvokeKeys.of(CMD_MERGE, screen.category_id, screen.merge_into))
            }

            event.sheet_closed != null -> Step(
                held.copy(screen = screen.copy(sheet = MoneyCategoriesState.Sheet.SHEET_NONE, confirm = null, merge_into = "")),
            )

            else -> Step(held)
        }
    }

    private fun entry(held: MoneyHeld<MoneyCategoriesState>, id: String) =
        held.answers.categories?.groups.orEmpty().flatMap { it.categories }.firstOrNull { it.category_id == id }

    private fun rowAction(held: MoneyHeld<MoneyCategoriesState>, key: String): Step<MoneyHeld<MoneyCategoriesState>> {
        val screen = held.screen
        return when (key) {
            ROW_MERGE -> Step(held.copy(screen = screen.copy(sheet = MoneyCategoriesState.Sheet.SHEET_MERGE)))
            ROW_ARCHIVE, ROW_RESTORE -> {
                val archived = key == ROW_ARCHIVE
                val input = MoneyFold.json(
                    "id" to MoneyFold.str(screen.category_id),
                    "flag" to MoneyFold.str("archived"),
                )
                val command = if (archived) CMD_ARCHIVE else CMD_RESTORE
                WriteLaw.submit(
                    Writes,
                    held.copy(screen = screen.copy(sheet = MoneyCategoriesState.Sheet.SHEET_NONE)),
                    command,
                    input,
                    InvokeKeys.of(command, screen.category_id),
                )
            }
            else -> Step(held)
        }
    }

    private fun add(held: MoneyHeld<MoneyCategoriesState>): Step<MoneyHeld<MoneyCategoriesState>> {
        val screen = held.screen
        val name = screen.name_draft.trim()
        if (name.isEmpty() || name.length > NAME_MAX) return Step(held)
        // A category is named by its words and its group, so asking again is the same ask.
        val id = "${screen.group_id}/$name"
        val input = MoneyFold.json(
            "title" to MoneyFold.str(name),
            "parent_id" to screen.group_id.ifEmpty { null }?.let(MoneyFold::str),
        )
        return WriteLaw.submit(
            Writes,
            held.copy(tokens = held.tokens + 1, screen = screen.copy(sheet = MoneyCategoriesState.Sheet.SHEET_NONE)),
            CMD_ADD,
            input,
            InvokeKeys.of(CMD_ADD, id),
        )
    }

    override fun settled(held: MoneyHeld<MoneyCategoriesState>, settled: WriteSettled): Step<MoneyHeld<MoneyCategoriesState>> {
        val step = WriteLaw.settled(Writes, held, settled)
        if (step.state === held) return step
        val screen = step.state.screen
        val command = settled.invoke_key.substringBefore(':')
        val status = if (settled.committed) {
            StatusLine(
                sentence = when (command) {
                    CMD_ADD -> MoneyCopy.DONE_CATEGORY_ADDED
                    CMD_MERGE -> MoneyCopy.DONE_MERGED
                    else -> MoneyCopy.DONE_ARCHIVED
                },
            )
        } else {
            StatusLine(sentence = settled.failure?.sentence?.takeIf { it.isNotEmpty() } ?: MoneyCopy.WRITE_REFUSED, refused = true)
        }
        return Step(step.state.copy(screen = screen.copy(status = status, merge_into = "")), step.effects)
    }

    override fun fold(held: MoneyHeld<MoneyCategoriesState>): MoneyCategoriesData? {
        val answer = held.answers.categories ?: return null
        val screen = held.screen
        val groups = answer.groups.map { group ->
            MoneyCategoryGroup(
                group_id = group.group_id,
                label = group.label,
                rows = group.categories.map { category ->
                    MoneyCategoryEntry(
                        category_id = category.category_id,
                        label = category.label,
                        archived = category.archived,
                        meta = if (category.archived) MoneyCopy.ARCHIVED else "",
                        accessibility_label = listOf(category.label, group.label, if (category.archived) MoneyCopy.ARCHIVED else "")
                            .filter { it.isNotEmpty() }.joinToString(", "),
                    )
                },
            )
        }
        val name = screen.name_draft.trim()
        val picked = entry(held, screen.category_id)
        return MoneyCategoriesData(
            groups = groups,
            add_label = MoneyCopy.CATEGORY_ADD,
            empty = if (groups.all { it.rows.isEmpty() }) EmptyState(headline = MoneyCopy.CATEGORIES_EMPTY) else null,
            add_title = MoneyCopy.CATEGORY_ADD_TITLE,
            name_label = MoneyCopy.CATEGORY_NAME,
            group_label = MoneyCopy.CATEGORY_GROUP,
            group_options = listOf(MoneyFold.choice("", MoneyCopy.NO_GROUP, screen.group_id.isEmpty())) +
                answer.groups.map { MoneyFold.choice(it.group_id, it.label, it.group_id == screen.group_id) },
            save_label = MoneyCopy.CATEGORY_ADD_SAVE,
            can_save = name.isNotEmpty() && name.length <= NAME_MAX,
            issue = if (name.length > NAME_MAX) MoneyCopy.CATEGORY_NAME_LONG else "",
            row_title = picked?.label.orEmpty(),
            row_actions = if (picked == null) {
                emptyList()
            } else {
                listOf(
                    MoneyAction(key = ROW_MERGE, label = MoneyCopy.ACTION_MERGE, icon_key = "Layers", enabled = !picked.archived),
                    if (picked.archived) {
                        MoneyAction(key = ROW_RESTORE, label = MoneyCopy.ACTION_RESTORE, icon_key = "Refresh", enabled = true)
                    } else {
                        MoneyAction(key = ROW_ARCHIVE, label = MoneyCopy.ACTION_ARCHIVE, icon_key = "Archive", enabled = true)
                    },
                )
            },
            merge_title = MoneyCopy.MERGE_SHEET_TITLE,
            merge_options = answer.groups.flatMap { group ->
                group.categories.filter { !it.archived && it.category_id != screen.category_id }.map {
                    MoneyFold.choice(it.category_id, it.label, false, group.label)
                }
            },
            cancel_label = MoneyCopy.CANCEL,
        )
    }

    override fun decorate(held: MoneyHeld<MoneyCategoriesState>): MoneyCategoriesState = held.screen

    private fun chrome(parent: String): MoneyPageChrome = MoneyPageChrome(
        title = MoneyCopy.CATEGORIES_TITLE,
        back_label = parent.ifEmpty { MoneyCopy.APP_TITLE },
        retry = MoneyCopy.RETRY,
    )

    private object Writes : WriteLens<MoneyHeld<MoneyCategoriesState>> {
        override fun write(state: MoneyHeld<MoneyCategoriesState>): WriteState = state.screen.write ?: WriteState()

        override fun with(state: MoneyHeld<MoneyCategoriesState>, write: WriteState): MoneyHeld<MoneyCategoriesState> =
            state.copy(screen = state.screen.copy(write = write))
    }

    internal object Lens : ContentLens<MoneyCategoriesState, MoneyCategoriesData> {
        override fun content(state: MoneyCategoriesState): ReadContent<MoneyCategoriesData> = when {
            state.data_ != null -> ReadContent.Data(state.data_)
            state.failure != null -> ReadContent.Failed(state.failure)
            state.denied != null -> ReadContent.Denied(state.denied)
            else -> ReadContent.Loading(state.loading?.first_load ?: true)
        }

        override fun with(state: MoneyCategoriesState, content: ReadContent<MoneyCategoriesData>): MoneyCategoriesState = when (content) {
            is ReadContent.Loading -> state.copy(loading = Loading(first_load = content.firstLoad), failure = null, denied = null, data_ = null)
            is ReadContent.Failed -> state.copy(loading = null, failure = content.failure, denied = null, data_ = null)
            is ReadContent.Denied -> state.copy(loading = null, failure = null, denied = content.denied, data_ = null)
            is ReadContent.Data -> state.copy(loading = null, failure = null, denied = null, data_ = content.data)
        }
    }
}

public object MoneyCategoriesReads : MoneyQueries<MoneyCategoriesState, MoneyCategoriesEvent>(
    screenId = MoneyCategoriesMachine.SCREEN_ID,
    tables = MONEY_TABLES,
    ask = { _, _ -> listOf(AppQueryRequest(money_categories = MoneyCategoriesRequest())) },
)
