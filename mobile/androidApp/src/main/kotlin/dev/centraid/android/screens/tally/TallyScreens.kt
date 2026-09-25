package dev.centraid.android.screens.tally

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.screen.v1.TallyChoice
import centraid.screen.v1.TallyEditorEvent
import centraid.screen.v1.TallyEditorState
import centraid.screen.v1.TallyExpenseEvent
import centraid.screen.v1.TallyExpenseState
import centraid.screen.v1.TallyFriendEvent
import centraid.screen.v1.TallyFriendState
import centraid.screen.v1.TallyGroupEvent
import centraid.screen.v1.TallyGroupState
import centraid.screen.v1.TallyHomeEvent
import centraid.screen.v1.TallyHomeState
import centraid.screen.v1.TallyRecurringEvent
import centraid.screen.v1.TallyRecurringState
import centraid.screen.v1.TallySearchEvent
import centraid.screen.v1.TallySearchState
import centraid.screen.v1.TallySettleUpEvent
import centraid.screen.v1.TallySettleUpState
import centraid.screen.v1.TallySpendingEvent
import centraid.screen.v1.TallySpendingState
import centraid.screen.v1.TallySplitMethod
import dev.centraid.android.kit.AppBand
import dev.centraid.android.kit.AppBandTab
import dev.centraid.android.kit.AppPlace
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.CentraidSearchField
import dev.centraid.android.kit.ChoiceFieldRow
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.FieldRow
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.QuietButton
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.SheetOption
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.ShowMoreFooter
import dev.centraid.android.kit.StatusLine
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

// ---------------------------------------------------------------------------
// tally.home — Balances · Activity · Groups, More as a sheet
// ---------------------------------------------------------------------------

@Composable
internal fun TallyHomeScreen(state: TallyHomeState, onEvent: (TallyHomeEvent) -> Unit, onHome: () -> Unit) {
    val chrome = state.chrome
    val data = state.data_
    AppPlace(
        app = "tally",
        title = chrome?.title.orEmpty(),
        trailing = chrome?.add_expense?.takeIf { it.isNotEmpty() }?.let { label ->
            RoomAction("Plus", label, "tally-add") { onEvent(TallyHomeEvent(add_expense = TallyHomeEvent.AddExpense())) }
        },
        status = data?.status_line.orEmpty(),
        band = {
            AppBand(
                app = "tally",
                tabs = state.band.filter { it.key != "more" }.map {
                    AppBandTab(key = it.key, label = it.label, iconKey = it.icon_key, selected = it.current)
                },
                onSelect = { key -> onEvent(TallyHomeEvent(band = TallyHomeEvent.BandPicked(key = key))) },
                onHome = onHome,
                onMore = if (state.band.any { it.key == "more" }) {
                    { onEvent(TallyHomeEvent(band = TallyHomeEvent.BandPicked(key = "more"))) }
                } else {
                    null
                },
            )
        },
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, data, state.denied),
            onRetry = { onEvent(TallyHomeEvent(refreshed = TallyHomeEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { dev.centraid.android.kit.KitWords.RETRY },
            skeleton = { RowSkeleton(label = chrome?.loading.orEmpty().ifEmpty { dev.centraid.android.kit.KitWords.OPENING }) },
        ) { home ->
            val dayOne = home.day_one_empty
            if (home.day_one && dayOne != null) {
                EmptyStateView(dayOne, onAction = { onEvent(TallyHomeEvent(add_expense = TallyHomeEvent.AddExpense())) })
            } else {
                LazyColumn {
                    when (state.destination) {
                        TallyHomeState.Destination.DESTINATION_ACTIVITY -> activity(state, onEvent)
                        TallyHomeState.Destination.DESTINATION_GROUPS -> groups(state, onEvent)
                        else -> balances(state, onEvent)
                    }
                }
            }
        }
    }
    when (state.sheet) {
        TallyHomeState.Sheet.SHEET_MORE -> OptionSheet(
            title = chrome?.more_title.orEmpty(),
            options = chrome?.more_rows.orEmpty().map { SheetOption(key = it.key, label = it.label, iconKey = it.icon_key, detail = it.meta) },
            onPick = { key -> onEvent(TallyHomeEvent(more = TallyHomeEvent.MorePicked(key = key))) },
            onDismiss = { onEvent(TallyHomeEvent(sheet_closed = TallyHomeEvent.SheetClosed())) },
        )
        TallyHomeState.Sheet.SHEET_READS -> SheetRoom(
            title = chrome?.reads_title.orEmpty(),
            onDismiss = { onEvent(TallyHomeEvent(sheet_closed = TallyHomeEvent.SheetClosed())) },
        ) {
            chrome?.reads_facts.orEmpty().forEach { fact -> FieldRow(key = fact.label, value = fact.detail) }
        }
        else -> Unit
    }
}

private fun LazyListScope.balances(state: TallyHomeState, onEvent: (TallyHomeEvent) -> Unit) {
    val home = state.data_ ?: return
    item(key = "hero") {
        TallyHeroView(home.hero)
        val settle = state.chrome?.settle_up.orEmpty()
        if (settle.isNotEmpty()) {
            QuietButton(label = settle, testTag = "tally-settle", modifier = Modifier.padding(horizontal = KitGeometry.GUTTER)) {
                onEvent(TallyHomeEvent(settle_up = TallyHomeEvent.SettleUp()))
            }
        }
    }
    item(key = "friends-head") { TallySection(home.friends_heading) }
    val settled = home.all_settled
    if (home.friends.isEmpty() && settled != null) {
        item(key = "settled") { EmptyStateView(settled, onAction = null) }
    }
    items(home.friends, key = { "f-" + it.person?.party_id.orEmpty() }) { friend ->
        val first = friend.balances.firstOrNull()
        val person = friend.person
        CentraidRow(
            title = person?.name.orEmpty(),
            meta = listOf(friend.meta, friend.balances.drop(1).joinToString(" · ") { money(it.amount) })
                .filter { it.isNotEmpty() }.joinToString(" · "),
            trailing = money(first?.amount),
            trailingNote = first?.label.orEmpty(),
            hueKey = person?.hue.orEmpty(),
            a11y = listOf(friend.accessibility_label, friend.balances.joinToString(", ") { money(it.amount) })
                .filter { it.isNotEmpty() }.joinToString(", "),
            testTag = "tally-friend-${person?.party_id.orEmpty()}",
            onTap = {
                onEvent(TallyHomeEvent(friend = TallyHomeEvent.FriendPicked(party_id = person?.party_id.orEmpty())))
            },
        )
    }
}

private fun LazyListScope.groups(state: TallyHomeState, onEvent: (TallyHomeEvent) -> Unit) {
    val home = state.data_ ?: return
    item(key = "groups-head") { TallySection(home.groups_heading) }
    val empty = home.groups_empty
    if (home.groups.isEmpty() && empty != null) item(key = "groups-empty") { EmptyStateView(empty, onAction = null) }
    items(home.groups, key = { "g-" + it.group_id }) { group -> GroupLine(group, onEvent) }
    if (home.archived_groups.isNotEmpty()) {
        item(key = "archived-head") { TallySection(home.archived_heading) }
        items(home.archived_groups, key = { "a-" + it.group_id }) { group -> GroupLine(group, onEvent) }
    }
}

@Composable
private fun GroupLine(group: centraid.screen.v1.TallyGroupRow, onEvent: (TallyHomeEvent) -> Unit) {
    val onTap = { onEvent(TallyHomeEvent(group = TallyHomeEvent.GroupPicked(group_id = group.group_id))) }
    Row(
        Modifier.fillMaxWidth().padding(start = KitGeometry.GUTTER),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TallyGroupMark(glyph = group.glyph, iconKey = group.icon_key, hue = group.hue)
        CentraidRow(
            title = group.name,
            modifier = Modifier.weight(1f),
            meta = group.meta,
            trailing = money(group.your_net?.amount),
            trailingNote = group.your_net?.label.orEmpty(),
            a11y = spoken(group.accessibility_label, group.your_net?.amount),
            testTag = "tally-group-${group.group_id}",
            onTap = onTap,
        )
    }
}

private fun LazyListScope.activity(state: TallyHomeState, onEvent: (TallyHomeEvent) -> Unit) {
    val home = state.data_ ?: return
    val empty = home.activity_empty
    if (home.activity.isEmpty() && empty != null) {
        item(key = "activity-empty") { EmptyStateView(empty, onAction = null) }
        return
    }
    home.activity.forEach { day ->
        item(key = "d-" + day.day) { TallySection(day.heading) }
        items(day.rows, key = { "r-" + it.row_key }) { row ->
            TallyLedgerLine(row) {
                onEvent(TallyHomeEvent(expense = TallyHomeEvent.ExpensePicked(expense_id = row.expense_id)))
            }
        }
    }
    item(key = "window") {
        TallyNote(home.activity_window)
        ShowMoreFooter(
            visible = home.more_activity,
            loading = false,
            label = state.chrome?.show_more.orEmpty().ifEmpty { dev.centraid.android.kit.KitWords.SHOW_MORE },
            onMore = { onEvent(TallyHomeEvent(show_more = TallyHomeEvent.ShowMore())) },
        )
    }
}

// ---------------------------------------------------------------------------
// tally.group
// ---------------------------------------------------------------------------

@Composable
internal fun TallyGroupScreen(
    state: TallyGroupState,
    parentTitle: String,
    onEvent: (TallyGroupEvent) -> Unit,
    onBack: () -> Unit,
) {
    val chrome = state.chrome
    val data = state.data_
    PushedPage(
        title = data?.name?.ifEmpty { null } ?: state.title,
        parentTitle = state.chrome?.back?.ifEmpty { null } ?: parentTitle,
        onBack = onBack,
        trailing = chrome?.add_expense?.takeIf { it.isNotEmpty() && data?.gone == null }?.let { label ->
            RoomAction("Plus", label, "tally-group-add") { onEvent(TallyGroupEvent(add_expense = TallyGroupEvent.AddExpense())) }
        },
        status = refusal(state.write),
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, data, state.denied),
            onRetry = { onEvent(TallyGroupEvent(refreshed = TallyGroupEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { dev.centraid.android.kit.KitWords.RETRY },
        ) { group ->
            val gone = group.gone
            if (gone != null) {
                EmptyStateView(gone, onAction = null)
                return@ReadStateView
            }
            LazyColumn {
                item(key = "hero") {
                    TallyGroupMark(
                        glyph = group.glyph,
                        iconKey = group.icon_key,
                        hue = group.hue,
                        modifier = Modifier.padding(start = KitGeometry.GUTTER, top = 8.dp),
                    )
                    TallyNote(group.archived_meta)
                    TallyHeroView(group.hero)
                    val settle = chrome?.settle_up.orEmpty()
                    if (settle.isNotEmpty()) {
                        QuietButton(label = settle, testTag = "tally-group-settle", modifier = Modifier.padding(horizontal = KitGeometry.GUTTER)) {
                            onEvent(TallyGroupEvent(settle_up = TallyGroupEvent.SettleUp()))
                        }
                    }
                }
                item(key = "members-head") { TallySection(group.members_heading) }
                items(group.members, key = { "m-" + it.person?.party_id.orEmpty() }) { member ->
                    CentraidRow(
                        title = member.person?.name.orEmpty(),
                        meta = member.meta,
                        trailing = money(member.net?.amount),
                        trailingNote = member.net?.label.orEmpty(),
                        hueKey = member.person?.hue.orEmpty(),
                        dimmed = member.departed,
                        a11y = spoken(member.accessibility_label, member.net?.amount),
                        testTag = "tally-member-${member.person?.party_id.orEmpty()}",
                        onTap = {
                            onEvent(TallyGroupEvent(member = TallyGroupEvent.MemberPicked(party_id = member.person?.party_id.orEmpty())))
                        },
                    )
                }
                val simplify = group.simplify
                if (simplify != null && simplify.heading.isNotEmpty()) {
                    item(key = "simplify") {
                        TallySection(simplify.heading)
                        TallyNote(simplify.state_line, ink = "text")
                        if (simplify.toggle_label.isNotEmpty() && simplify.toggle_enabled) {
                            QuietButton(
                                label = simplify.toggle_label,
                                testTag = "tally-simplify",
                                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER),
                            ) { onEvent(TallyGroupEvent(simplify_toggled = TallyGroupEvent.SimplifyToggled())) }
                        }
                        TallyNote(simplify.summary, ink = "text")
                        TallyNote(simplify.explanation)
                    }
                    items(simplify.transfers, key = { "t-" + it.key }) { transfer -> TallyTransferLine(transfer, onTap = null) }
                }
                item(key = "ledger-head") { TallySection(group.ledger_heading) }
                val ledgerEmpty = group.ledger_empty
                if (group.ledger.isEmpty() && ledgerEmpty != null) item(key = "ledger-empty") { EmptyStateView(ledgerEmpty, onAction = null) }
                items(group.ledger, key = { "l-" + it.row_key }) { row ->
                    TallyLedgerLine(row) { onEvent(TallyGroupEvent(expense = TallyGroupEvent.ExpensePicked(expense_id = row.expense_id))) }
                }
                if (group.settlements.isNotEmpty()) {
                    item(key = "settlements-head") { TallySection(group.settlements_heading) }
                    items(group.settlements, key = { "s-" + it.row_key }) { row ->
                        TallyLedgerLine(row) { onEvent(TallyGroupEvent(expense = TallyGroupEvent.ExpensePicked(expense_id = row.expense_id))) }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// tally.friend
// ---------------------------------------------------------------------------

@Composable
internal fun TallyFriendScreen(
    state: TallyFriendState,
    parentTitle: String,
    onEvent: (TallyFriendEvent) -> Unit,
    onBack: () -> Unit,
) {
    val chrome = state.chrome
    val data = state.data_
    PushedPage(
        title = data?.person?.name?.ifEmpty { null } ?: state.title,
        parentTitle = state.chrome?.back?.ifEmpty { null } ?: parentTitle,
        onBack = onBack,
        trailing = chrome?.add_expense?.takeIf { it.isNotEmpty() && data?.gone == null }?.let { label ->
            RoomAction("Plus", label, "tally-friend-add") { onEvent(TallyFriendEvent(add_expense = TallyFriendEvent.AddExpense())) }
        },
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, data, state.denied),
            onRetry = { onEvent(TallyFriendEvent(refreshed = TallyFriendEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { dev.centraid.android.kit.KitWords.RETRY },
        ) { friend ->
            val gone = friend.gone
            if (gone != null) {
                EmptyStateView(gone, onAction = null)
                return@ReadStateView
            }
            LazyColumn {
                item(key = "hero") {
                    TallyHeroView(friend.hero)
                    val settle = chrome?.settle_up.orEmpty()
                    if (settle.isNotEmpty()) {
                        QuietButton(label = settle, testTag = "tally-friend-settle", modifier = Modifier.padding(horizontal = KitGeometry.GUTTER)) {
                            onEvent(TallyFriendEvent(settle_up = TallyFriendEvent.SettleUp()))
                        }
                    }
                }
                item(key = "parts-head") { TallySection(friend.parts_heading) }
                items(friend.parts, key = { "p-" + it.group_id + it.title }) { part ->
                    CentraidRow(
                        title = part.title,
                        trailing = money(part.net?.amount),
                        trailingNote = part.net?.label.orEmpty(),
                        a11y = spoken(part.accessibility_label, part.net?.amount),
                        testTag = "tally-part-${part.group_id}",
                        onTap = if (part.group_id.isNotEmpty()) {
                            { onEvent(TallyFriendEvent(group = TallyFriendEvent.GroupPicked(group_id = part.group_id))) }
                        } else {
                            null
                        },
                    )
                }
                item(key = "parts-note") { TallyNote(friend.parts_note) }
                item(key = "ledger-head") { TallySection(friend.ledger_heading) }
                val ledgerEmpty = friend.ledger_empty
                if (friend.ledger.isEmpty() && ledgerEmpty != null) item(key = "ledger-empty") { EmptyStateView(ledgerEmpty, onAction = null) }
                items(friend.ledger, key = { "l-" + it.row_key }) { row ->
                    TallyLedgerLine(row) { onEvent(TallyFriendEvent(expense = TallyFriendEvent.ExpensePicked(expense_id = row.expense_id))) }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// tally.expense
// ---------------------------------------------------------------------------

@Composable
internal fun TallyExpenseScreen(
    state: TallyExpenseState,
    parentTitle: String,
    onEvent: (TallyExpenseEvent) -> Unit,
    onBack: () -> Unit,
) {
    val data = state.data_
    val chrome = state.chrome
    PushedPage(
        title = data?.title.orEmpty(),
        parentTitle = state.chrome?.back?.ifEmpty { null } ?: parentTitle,
        onBack = onBack,
        trailing = data?.edit_label?.takeIf { it.isNotEmpty() && !data.trashed && data.gone == null }?.let { label ->
            RoomAction("Pencil", label, "tally-expense-edit") { onEvent(TallyExpenseEvent(edit = TallyExpenseEvent.EditTapped())) }
        },
        status = refusal(state.write),
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, data, state.denied),
            onRetry = { onEvent(TallyExpenseEvent(refreshed = TallyExpenseEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { dev.centraid.android.kit.KitWords.RETRY },
        ) { expense ->
            val gone = expense.gone
            if (gone != null) {
                EmptyStateView(gone, onAction = null)
                return@ReadStateView
            }
            LazyColumn {
                item(key = "head") {
                    Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)) {
                        Text(money(expense.amount), style = centraidType("display"), color = centraidColor("text"))
                        val yours = expense.yours
                        if (yours != null) {
                            Text(
                                listOf(money(yours.amount), yours.label).filter { it.isNotEmpty() }.joinToString(" · "),
                                style = centraidType("annotLabel"),
                                color = centraidColor(toneInk(yours.tone)),
                            )
                        }
                    }
                    if (expense.trashed) TallyNote(expense.trash_line, ink = "net")
                }
                items(expense.fields, key = { "f-" + it.key }) { field -> FieldRow(key = field.key, value = field.value_, note = field.note) }
                if (expense.payers.isNotEmpty()) {
                    item(key = "payers-head") { TallySection(expense.payers_heading) }
                    items(expense.payers, key = { "pay-" + it.person?.party_id.orEmpty() }) { share ->
                        CentraidRow(
                            title = share.person?.name.orEmpty(),
                            trailing = money(share.amount),
                            hueKey = share.person?.hue.orEmpty(),
                            a11y = spoken(share.accessibility_label, share.amount),
                        )
                    }
                }
                if (expense.splits.isNotEmpty()) {
                    item(key = "splits-head") { TallySection(expense.splits_heading) }
                    items(expense.splits, key = { "split-" + it.person?.party_id.orEmpty() }) { share ->
                        CentraidRow(
                            title = share.person?.name.orEmpty(),
                            trailing = money(share.amount),
                            hueKey = share.person?.hue.orEmpty(),
                            a11y = spoken(share.accessibility_label, share.amount),
                        )
                    }
                }
                if (expense.lines.isNotEmpty()) {
                    item(key = "lines-head") { TallySection(expense.lines_heading) }
                    items(expense.lines, key = { "line-" + it.line_item_id }) { line ->
                        CentraidRow(title = line.title, meta = line.meta, trailing = money(line.amount))
                    }
                }
                if (expense.memo.isNotEmpty() || expense.memo_label.isNotEmpty()) {
                    item(key = "memo") {
                        if (expense.memo.isNotEmpty()) {
                            TallySection(expense.memo_heading)
                            Text(
                                expense.memo,
                                style = centraidType("body"),
                                color = centraidColor("text"),
                                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER),
                            )
                        }
                        // "Add memo" / "Edit memo": the sheet opens on the machine's say.
                        if (expense.memo_label.isNotEmpty()) {
                            QuietButton(
                                label = expense.memo_label,
                                testTag = "tally-memo",
                                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp),
                            ) { onEvent(TallyExpenseEvent(memo_opened = TallyExpenseEvent.MemoOpened())) }
                        }
                    }
                }
                if (expense.revisions.isNotEmpty()) {
                    item(key = "revisions-head") { TallySection(expense.revisions_heading) }
                    items(expense.revisions, key = { "rev-" + it.revision_id }) { revision ->
                        CentraidRow(
                            title = revision.title,
                            meta = listOf(revision.meta, money(revision.before_amount), revision.state_label)
                                .filter { it.isNotEmpty() }.joinToString(" · "),
                            testTag = "tally-revision-${revision.revision_id}",
                            accessory = if (revision.undo_label.isNotEmpty()) {
                                {
                                    QuietButton(label = revision.undo_label, testTag = "tally-undo-${revision.revision_id}") {
                                        onEvent(TallyExpenseEvent(undo = TallyExpenseEvent.UndoTapped(revision_id = revision.revision_id)))
                                    }
                                }
                            } else {
                                null
                            },
                        )
                    }
                }
                item(key = "actions") {
                    Row(Modifier.fillMaxWidth().padding(KitGeometry.GUTTER)) {
                        if (expense.trashed && expense.restore_label.isNotEmpty()) {
                            QuietButton(label = expense.restore_label, testTag = "tally-restore") {
                                onEvent(TallyExpenseEvent(restore = TallyExpenseEvent.RestoreTapped()))
                            }
                        }
                        if (!expense.trashed && expense.trash_label.isNotEmpty()) {
                            QuietButton(label = expense.trash_label, testTag = "tally-trash", ink = "net") {
                                onEvent(TallyExpenseEvent(trash = TallyExpenseEvent.TrashTapped()))
                            }
                        }
                    }
                }
            }
        }
    }
    // THE MEMO SHEET IS UP WHILE THE STATE HOLDS A DRAFT. Closing it — the
    // done key or a swipe — is done (#1015 D3): the machine writes changed words.
    val memoDraft = state.memo_draft
    if (memoDraft != null && data != null) {
        val closeMemo = { onEvent(TallyExpenseEvent(memo_closed = TallyExpenseEvent.MemoClosed())) }
        SheetRoom(
            title = data.memo_label.ifEmpty { data.memo_heading },
            onDismiss = closeMemo,
            primary = chrome?.memo_done?.takeIf { it.isNotEmpty() }?.let { SheetPrimary(it, testTag = "tally-memo-done", onPress = closeMemo) },
        ) {
            EditableFieldRow(
                key = "",
                value = memoDraft,
                // The draft is seeded once, when the sheet opens; typing is local after that.
                reload = null,
                placeholder = chrome?.memo_placeholder.orEmpty(),
                singleLine = false,
                testTag = "tally-memo-field",
                onEdit = { onEvent(TallyExpenseEvent(memo_changed = TallyExpenseEvent.MemoChanged(text = it))) },
            )
        }
    }
    val confirm = state.confirm
    if (confirm != null) {
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(TallyExpenseEvent(confirmed = TallyExpenseEvent.Confirmed())) },
            onDismiss = { onEvent(TallyExpenseEvent(dismissed = TallyExpenseEvent.Dismissed())) },
        )
    }
}

// ---------------------------------------------------------------------------
// tally.editor — explicit Save, split methods, leave-with-changes confirm
// ---------------------------------------------------------------------------

@Composable
internal fun TallyEditorScreen(state: TallyEditorState, parentTitle: String, onEvent: (TallyEditorEvent) -> Unit) {
    val chrome = state.chrome
    val data = state.data_
    val form = state.form
    val close = { onEvent(TallyEditorEvent(close = TallyEditorEvent.CloseTapped())) }
    // NOT AUTOSAVE: back asks the machine, which confirms a dirty leave.
    BackHandler(onBack = close)
    // A CHOICE IS A SHEET, and which one is up is the machine's `sheet`: a
    // row sends `SheetOpened`, a pick closes it there, a swipe sends `SheetClosed`.
    val choose = { sheet: TallyEditorState.Sheet -> onEvent(TallyEditorEvent(sheet_opened = TallyEditorEvent.SheetOpened(sheet = sheet))) }
    // Typing stays on the phone: the fields re-seed only while the form is clean.
    val reload = if (!state.dirty) state.baseline ?: form else null
    PushedPage(
        title = chrome?.title.orEmpty(),
        parentTitle = parentTitle,
        onBack = close,
        trailing = if (data?.can_save == true && chrome?.save.orEmpty().isNotEmpty()) {
            RoomAction("Check", chrome!!.save, "tally-editor-save") { onEvent(TallyEditorEvent(save = TallyEditorEvent.SaveTapped())) }
        } else {
            null
        },
        status = refusal(state.write),
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, data, state.denied),
            onRetry = { onEvent(TallyEditorEvent(refreshed = TallyEditorEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { dev.centraid.android.kit.KitWords.RETRY },
        ) { editor ->
            if (form == null) return@ReadStateView
            LazyColumn {
                item(key = "description") {
                    EditableFieldRow(
                        key = chrome?.description_key.orEmpty(),
                        value = form.description,
                        reload = reload,
                        placeholder = chrome?.description_placeholder.orEmpty(),
                        testTag = "tally-editor-description",
                        onEdit = { onEvent(TallyEditorEvent(description = TallyEditorEvent.DescriptionChanged(text = it))) },
                    )
                }
                item(key = "amount") {
                    EditableFieldRow(
                        key = chrome?.amount_key.orEmpty(),
                        value = form.amount_text,
                        reload = reload,
                        testTag = "tally-editor-amount",
                        onEdit = { onEvent(TallyEditorEvent(amount = TallyEditorEvent.AmountChanged(text = it))) },
                    )
                }
                item(key = "choices") {
                    ChoiceLine(chrome?.payer_key.orEmpty(), editor.payers) { choose(TallyEditorState.Sheet.SHEET_PAYER) }
                    ChoiceLine(chrome?.group_key.orEmpty(), editor.groups) { choose(TallyEditorState.Sheet.SHEET_GROUP) }
                    ChoiceLine(chrome?.category_key.orEmpty(), editor.categories) { choose(TallyEditorState.Sheet.SHEET_CATEGORY) }
                    ChoiceLine(chrome?.date_key.orEmpty(), editor.dates) { choose(TallyEditorState.Sheet.SHEET_DATE) }
                    if (editor.currency_locked) {
                        FieldRow(key = chrome?.currency_key.orEmpty(), value = selectedLabel(editor.currencies))
                    } else {
                        ChoiceLine(chrome?.currency_key.orEmpty(), editor.currencies) { choose(TallyEditorState.Sheet.SHEET_CURRENCY) }
                    }
                    TallyNote(editor.rate_line)
                    ChoiceLine(chrome?.method_key.orEmpty(), editor.methods) { choose(TallyEditorState.Sheet.SHEET_METHOD) }
                }
                if (form.method == TallySplitMethod.TALLY_SPLIT_METHOD_BY_LINE) {
                    items(form.lines, key = { "line-" + it.line_key }) { line ->
                        Column(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                            EditableFieldRow(
                                key = "",
                                value = line.description,
                                reload = reload,
                                placeholder = chrome?.line_placeholder.orEmpty(),
                                onEdit = {
                                    onEvent(
                                        TallyEditorEvent(
                                            line_changed = TallyEditorEvent.LineChanged(line_key = line.line_key, description = it, amount_text = line.amount_text),
                                        ),
                                    )
                                },
                            )
                            EditableFieldRow(
                                key = chrome?.amount_key.orEmpty(),
                                value = line.amount_text,
                                reload = reload,
                                onEdit = {
                                    onEvent(
                                        TallyEditorEvent(
                                            line_changed = TallyEditorEvent.LineChanged(line_key = line.line_key, description = line.description, amount_text = it),
                                        ),
                                    )
                                },
                            )
                            Row(
                                Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                form.entries.forEach { entry ->
                                    val id = entry.person?.party_id.orEmpty()
                                    QuietButton(
                                        label = entry.person?.initials?.ifEmpty { null } ?: entry.person?.name.orEmpty(),
                                        ink = if (id in line.party_ids) "text" else "textFaint",
                                        testTag = "tally-line-party-${line.line_key}-$id",
                                    ) {
                                        onEvent(TallyEditorEvent(line_party = TallyEditorEvent.LinePartyToggled(line_key = line.line_key, party_id = id)))
                                    }
                                }
                                val remove = chrome?.remove_line.orEmpty()
                                if (remove.isNotEmpty()) {
                                    IconKey("X", remove, "tally-line-remove-${line.line_key}", bordered = false) {
                                        onEvent(TallyEditorEvent(line_removed = TallyEditorEvent.LineRemoved(line_key = line.line_key)))
                                    }
                                }
                            }
                            TallyNote(line.issue, ink = "net")
                        }
                    }
                    item(key = "add-line") {
                        val add = chrome?.add_line.orEmpty()
                        if (add.isNotEmpty()) {
                            QuietButton(label = add, testTag = "tally-line-add", modifier = Modifier.padding(horizontal = KitGeometry.GUTTER)) {
                                onEvent(TallyEditorEvent(line_added = TallyEditorEvent.LineAdded()))
                            }
                        }
                    }
                } else {
                    items(form.entries, key = { "e-" + it.person?.party_id.orEmpty() }) { entry ->
                        val id = entry.person?.party_id.orEmpty()
                        val typed = form.method != TallySplitMethod.TALLY_SPLIT_METHOD_EQUALLY
                        CentraidRow(
                            title = entry.person?.name.orEmpty(),
                            meta = entry.issue,
                            trailing = money(entry.share),
                            hueKey = entry.person?.hue.orEmpty(),
                            dimmed = !entry.included,
                            testTag = "tally-entry-$id",
                            onTap = { onEvent(TallyEditorEvent(entry_toggled = TallyEditorEvent.EntryToggled(party_id = id))) },
                        )
                        if (typed && entry.included) {
                            EditableFieldRow(
                                key = entry.unit_label,
                                value = entry.text,
                                reload = reload,
                                testTag = "tally-entry-text-$id",
                                onEdit = { onEvent(TallyEditorEvent(entry_changed = TallyEditorEvent.EntryChanged(party_id = id, text = it))) },
                            )
                        }
                    }
                }
                item(key = "reconcile") {
                    TallyNote(editor.reconcile_line, ink = if (editor.reconcile_problem) "net" else "textSoft")
                    val remaining = editor.remaining
                    if (remaining != null) TallyNote(listOf(editor.remaining_label, money(remaining)).filter { it.isNotEmpty() }.joinToString(" "))
                    editor.issues.forEach { TallyNote(it, ink = "net") }
                }
            }
        }
    }
    val sheetData = data
    val up = state.sheet
    if (sheetData != null) {
        val (title, options) = when (up) {
            TallyEditorState.Sheet.SHEET_PAYER -> chrome?.payer_key.orEmpty() to sheetData.payers
            TallyEditorState.Sheet.SHEET_GROUP -> chrome?.group_key.orEmpty() to sheetData.groups
            TallyEditorState.Sheet.SHEET_CATEGORY -> chrome?.category_key.orEmpty() to sheetData.categories
            TallyEditorState.Sheet.SHEET_DATE -> chrome?.date_key.orEmpty() to sheetData.dates
            TallyEditorState.Sheet.SHEET_CURRENCY -> chrome?.currency_key.orEmpty() to sheetData.currencies
            TallyEditorState.Sheet.SHEET_METHOD -> chrome?.method_key.orEmpty() to sheetData.methods
            else -> "" to emptyList()
        }
        if (options.isNotEmpty()) {
            OptionSheet(
                title = title,
                options = options.filter { it.enabled }.map { SheetOption(key = it.key, label = it.label, selected = it.selected) },
                onPick = { key ->
                    val event = when (up) {
                        TallyEditorState.Sheet.SHEET_PAYER -> TallyEditorEvent(payer = TallyEditorEvent.PayerPicked(party_id = key))
                        TallyEditorState.Sheet.SHEET_GROUP -> TallyEditorEvent(group = TallyEditorEvent.GroupPicked(group_id = key))
                        TallyEditorState.Sheet.SHEET_CATEGORY -> TallyEditorEvent(category = TallyEditorEvent.CategoryPicked(category = key))
                        TallyEditorState.Sheet.SHEET_DATE -> TallyEditorEvent(date = TallyEditorEvent.DatePicked(day = key))
                        TallyEditorState.Sheet.SHEET_CURRENCY -> TallyEditorEvent(currency = TallyEditorEvent.CurrencyPicked(currency = key))
                        // The choice carries its enum (`TallyChoice.method`): sent back as it came.
                        else -> TallyEditorEvent(
                            method = TallyEditorEvent.MethodPicked(
                                method = options.firstOrNull { it.key == key }?.method ?: TallySplitMethod.TALLY_SPLIT_METHOD_UNSPECIFIED,
                            ),
                        )
                    }
                    onEvent(event)
                },
                onDismiss = { onEvent(TallyEditorEvent(sheet_closed = TallyEditorEvent.SheetClosed())) },
            )
        }
    }
    val confirm = state.confirm
    if (confirm != null) {
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(TallyEditorEvent(confirmed = TallyEditorEvent.Confirmed())) },
            onDismiss = { onEvent(TallyEditorEvent(dismissed = TallyEditorEvent.Dismissed())) },
        )
    }
}

private fun selectedLabel(choices: List<TallyChoice>): String = choices.firstOrNull { it.selected }?.label.orEmpty()

@Composable
private fun ChoiceLine(key: String, choices: List<TallyChoice>, onTap: () -> Unit) {
    if (key.isEmpty() || choices.isEmpty()) return
    ChoiceFieldRow(key = key, value = selectedLabel(choices), onTap = onTap, testTag = "tally-choice-$key")
}

// ---------------------------------------------------------------------------
// tally.settle_up
// ---------------------------------------------------------------------------

@Composable
internal fun TallySettleUpScreen(
    state: TallySettleUpState,
    parentTitle: String,
    onEvent: (TallySettleUpEvent) -> Unit,
    onBack: () -> Unit,
) {
    PushedPage(title = state.title, parentTitle = state.chrome?.back?.ifEmpty { null } ?: parentTitle, onBack = onBack, status = refusal(state.write)) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
            onRetry = { onEvent(TallySettleUpEvent(refreshed = TallySettleUpEvent.Refreshed())) },
            retryLabel = state.chrome?.retry.orEmpty().ifEmpty { dev.centraid.android.kit.KitWords.RETRY },
        ) { settle ->
            val empty = settle.empty
            LazyColumn {
                item(key = "lede") { TallyNote(state.lede) }
                if (settle.suggestions.isEmpty() && empty != null) item(key = "empty") { EmptyStateView(empty, onAction = null) }
                items(settle.suggestions, key = { "s-" + it.key }) { row ->
                    TallyTransferLine(row) { onEvent(TallySettleUpEvent(picked = TallySettleUpEvent.SuggestionPicked(key = row.key))) }
                }
            }
        }
    }
    val draft = state.draft
    if (draft != null) {
        val dismiss = { onEvent(TallySettleUpEvent(dismissed = TallySettleUpEvent.DraftDismissed())) }
        SheetRoom(
            title = draft.transfer?.line.orEmpty(),
            onDismiss = dismiss,
            primary = if (draft.can_record && draft.record_label.isNotEmpty()) {
                SheetPrimary(label = draft.record_label, testTag = "tally-record") {
                    onEvent(TallySettleUpEvent(record = TallySettleUpEvent.RecordTapped()))
                }
            } else {
                null
            },
            status = refusal(state.write),
        ) {
            EditableFieldRow(
                key = draft.amount_key,
                value = draft.amount_text,
                reload = draft.transfer?.key,
                testTag = "tally-record-amount",
                onEdit = { onEvent(TallySettleUpEvent(amount = TallySettleUpEvent.AmountChanged(text = it))) },
            )
            TallyNote(draft.issue, ink = "net")
            TallyNote(draft.foot)
            if (draft.cancel_label.isNotEmpty()) {
                QuietButton(label = draft.cancel_label, testTag = "tally-record-cancel", modifier = Modifier.padding(horizontal = KitGeometry.GUTTER)) {
                    dismiss()
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// tally.recurring
// ---------------------------------------------------------------------------

@Composable
internal fun TallyRecurringScreen(
    state: TallyRecurringState,
    parentTitle: String,
    onEvent: (TallyRecurringEvent) -> Unit,
    onBack: () -> Unit,
) {
    PushedPage(title = state.title, parentTitle = state.chrome?.back?.ifEmpty { null } ?: parentTitle, onBack = onBack) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
            onRetry = { onEvent(TallyRecurringEvent(refreshed = TallyRecurringEvent.Refreshed())) },
            retryLabel = state.chrome?.retry.orEmpty().ifEmpty { dev.centraid.android.kit.KitWords.RETRY },
        ) { recurring ->
            val empty = recurring.empty
            if (recurring.templates.isEmpty() && empty != null) {
                EmptyStateView(empty, onAction = null)
            } else {
                LazyColumn {
                    items(recurring.templates, key = { it.template_id }) { template ->
                        CentraidRow(
                            title = template.title,
                            meta = listOf(template.schedule, template.meta).filter { it.isNotEmpty() }.joinToString(" · "),
                            trailing = money(template.amount),
                            chips = listOfNotNull(template.status),
                            a11y = spoken(template.accessibility_label, template.amount),
                            testTag = "tally-template-${template.template_id}",
                        )
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// tally.spending — month stepping
// ---------------------------------------------------------------------------

@Composable
internal fun TallySpendingScreen(
    state: TallySpendingState,
    parentTitle: String,
    onEvent: (TallySpendingEvent) -> Unit,
    onBack: () -> Unit,
) {
    val chrome = state.chrome
    PushedPage(title = chrome?.title.orEmpty(), parentTitle = parentTitle, onBack = onBack) {
        Column {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (state.previous_enabled) {
                    IconKey("ChevronLeft", chrome?.previous.orEmpty(), "tally-month-previous") {
                        onEvent(TallySpendingEvent(month_stepped = TallySpendingEvent.MonthStepped(months = -1)))
                    }
                }
                Text(
                    state.month_label,
                    style = centraidType("smallStrong"),
                    color = centraidColor("text"),
                    modifier = Modifier.weight(1f).padding(horizontal = 8.dp).semantics { heading() },
                )
                if (state.next_enabled) {
                    IconKey("ChevronRight", chrome?.next.orEmpty(), "tally-month-next") {
                        onEvent(TallySpendingEvent(month_stepped = TallySpendingEvent.MonthStepped(months = 1)))
                    }
                }
            }
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
                onRetry = { onEvent(TallySpendingEvent(refreshed = TallySpendingEvent.Refreshed())) },
                retryLabel = chrome?.retry.orEmpty().ifEmpty { dev.centraid.android.kit.KitWords.RETRY },
            ) { spending ->
                val empty = spending.empty
                if (spending.currencies.isEmpty() && empty != null) {
                    EmptyStateView(empty, onAction = null)
                } else {
                    LazyColumn {
                        spending.currencies.forEach { currency ->
                            item(key = "c-" + currency.currency) {
                                TallySection(listOf(currency.currency, money(currency.total)).filter { it.isNotEmpty() }.joinToString(" · "))
                                currency.facts.forEach { fact ->
                                    FieldRow(key = fact.label, value = money(fact.amount), note = fact.note)
                                }
                            }
                            items(currency.categories, key = { "cat-" + currency.currency + it.category }) { category ->
                                Column {
                                    CentraidRow(
                                        title = category.label,
                                        trailing = money(category.total),
                                        testTag = "tally-category-${category.category}",
                                    )
                                    ShareBar(category.share_permille)
                                }
                            }
                        }
                        item(key = "note") { TallyNote(spending.note) }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// tally.search
// ---------------------------------------------------------------------------

@Composable
internal fun TallySearchScreen(
    state: TallySearchState,
    parentTitle: String,
    onEvent: (TallySearchEvent) -> Unit,
    onBack: () -> Unit,
) {
    val chrome = state.chrome
    PushedPage(title = chrome?.title.orEmpty(), parentTitle = parentTitle, onBack = onBack) {
        Column {
            CentraidSearchField(
                field = state.field_ ?: centraid.screen.v1.SearchField(open_ = true),
                placeholder = chrome?.placeholder.orEmpty(),
                onTerm = { onEvent(TallySearchEvent(term = TallySearchEvent.TermChanged(term = it))) },
                onClose = { onEvent(TallySearchEvent(cleared = TallySearchEvent.Cleared())) },
                closeLabel = chrome?.close.orEmpty().ifEmpty { dev.centraid.android.kit.KitWords.CLOSE_SEARCH },
            )
            val resting = state.resting
            if (resting != null) {
                EmptyStateView(resting, onAction = null)
            } else {
                ReadStateView(
                    content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
                    onRetry = { onEvent(TallySearchEvent(refreshed = TallySearchEvent.Refreshed())) },
                    retryLabel = chrome?.retry.orEmpty().ifEmpty { dev.centraid.android.kit.KitWords.RETRY },
                ) { search ->
                    val empty = search.empty
                    if (search.results.isEmpty() && empty != null) {
                        EmptyStateView(empty, onAction = null)
                    } else {
                        LazyColumn {
                            item(key = "count") { StatusLine(search.count_label) }
                            items(search.results, key = { it.row_key }) { row ->
                                TallyLedgerLine(row) {
                                    onEvent(TallySearchEvent(expense = TallySearchEvent.ExpensePicked(expense_id = row.expense_id)))
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
