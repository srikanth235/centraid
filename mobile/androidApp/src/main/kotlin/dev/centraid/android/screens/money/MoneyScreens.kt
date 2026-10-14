package dev.centraid.android.screens.money

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.screen.v1.MoneyHomeEvent
import centraid.screen.v1.MoneyHomeState
import centraid.screen.v1.MoneyRecurringEvent
import centraid.screen.v1.MoneyRecurringState
import centraid.screen.v1.MoneySearchEvent
import centraid.screen.v1.MoneySearchState
import centraid.screen.v1.MoneyTargetEvent
import centraid.screen.v1.MoneyTargetState
import centraid.screen.v1.MoneyTransactionEvent
import centraid.screen.v1.MoneyTransactionState
import centraid.screen.v1.SearchField
import dev.centraid.android.kit.AppBand
import dev.centraid.android.kit.AppBandTab
import dev.centraid.android.kit.AppPlace
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.CentraidSearchField
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.FieldRow
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.InkButton
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.QuietButton
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.RoomChip
import dev.centraid.android.kit.RoomSearch
import dev.centraid.android.kit.SearchContainerRow
import dev.centraid.android.kit.SheetOption
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.ShowMoreFooter
import dev.centraid.android.kit.StatusChipView
import dev.centraid.android.kit.StatusLine
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

// ---------------------------------------------------------------------------
// money.home: Spending · Activity · Cash flow, More as a sheet
// ---------------------------------------------------------------------------

@Composable
internal fun MoneyHomeScreen(state: MoneyHomeState, onEvent: (MoneyHomeEvent) -> Unit, onHome: () -> Unit) {
    val chrome = state.chrome
    val addStatement = { onEvent(MoneyHomeEvent(add = MoneyHomeEvent.AddStatement())) }
    AppPlace(
        app = "money",
        title = chrome?.title.orEmpty(),
        // THE HEADER'S ONE ACTION is the app's create verb: rows enter by import (R-CHROME-1).
        trailing = chrome?.add_label?.takeIf { it.isNotEmpty() }?.let { label ->
            RoomAction("Plus", label, "money-add") { addStatement() }
        },
        // A DOOR, NOT A FIELD (R-CHROME-2): Money's search is a page of its own.
        search = chrome?.search_placeholder?.takeIf { it.isNotEmpty() && state.denied == null }?.let { placeholder ->
            RoomSearch(
                field = SearchField(),
                placeholder = placeholder,
                onTerm = {},
                onClose = {},
                onOpen = { onEvent(MoneyHomeEvent(search_opened = MoneyHomeEvent.SearchOpened())) },
            )
        },
        // THE FILTER ROW is month, account and category; no sort chip (R-CHROME-3).
        chips = state.chips.map { chip ->
            RoomChip(
                testTag = "money-chip-${chip.key}",
                label = chip.label,
                selected = chip.active,
                chevron = true,
                onPress = { onEvent(MoneyHomeEvent(chip = MoneyHomeEvent.ChipTapped(key = chip.key))) },
            )
        },
        band = {
            AppBand(
                app = "money",
                tabs = state.band.map {
                    AppBandTab(key = it.key, label = it.label, iconKey = it.icon_key, selected = it.current)
                },
                onSelect = { key -> onEvent(MoneyHomeEvent(band = MoneyHomeEvent.BandPicked(key = key))) },
                onHome = onHome,
            )
        },
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
            onRetry = { onEvent(MoneyHomeEvent(refreshed = MoneyHomeEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
        ) { home ->
            LazyColumn {
                if (home.shows_month) item(key = "month") { MonthStepper(state, onEvent) }
                when (state.destination) {
                    MoneyHomeState.Destination.DESTINATION_ACTIVITY -> activity(state, onEvent, addStatement)
                    MoneyHomeState.Destination.DESTINATION_CASHFLOW -> cashflow(state, addStatement)
                    else -> spending(state, onEvent, addStatement)
                }
            }
        }
    }
    val data = state.data_
    val close = { onEvent(MoneyHomeEvent(sheet_closed = MoneyHomeEvent.SheetClosed())) }
    when (state.sheet) {
        MoneyHomeState.Sheet.SHEET_MORE -> OptionSheet(
            title = chrome?.more_title.orEmpty(),
            options = chrome?.more_rows.orEmpty().map { SheetOption(key = it.key, label = it.label, iconKey = it.icon_key, detail = it.meta) },
            onPick = { key -> onEvent(MoneyHomeEvent(more = MoneyHomeEvent.MorePicked(key = key))) },
            onDismiss = close,
        )
        MoneyHomeState.Sheet.SHEET_MONTH -> OptionSheet(
            title = chrome?.month_sheet_title.orEmpty(),
            options = data?.month_options.orEmpty().map { SheetOption(key = it.key, label = it.label, selected = it.selected) },
            onPick = { key -> onEvent(MoneyHomeEvent(month_picked = MoneyHomeEvent.MonthPicked(month = key))) },
            onDismiss = close,
        )
        MoneyHomeState.Sheet.SHEET_ACCOUNT -> OptionSheet(
            title = chrome?.account_sheet_title.orEmpty(),
            options = data?.activity?.account_options.orEmpty()
                .map { SheetOption(key = it.key, label = it.label, detail = it.detail, selected = it.selected) },
            onPick = { key -> onEvent(MoneyHomeEvent(account_picked = MoneyHomeEvent.AccountPicked(account_id = key))) },
            onDismiss = close,
        )
        MoneyHomeState.Sheet.SHEET_CATEGORY -> OptionSheet(
            title = chrome?.category_sheet_title.orEmpty(),
            options = data?.activity?.category_options.orEmpty()
                .map { SheetOption(key = it.key, label = it.label, detail = it.detail, selected = it.selected) },
            onPick = { key -> onEvent(MoneyHomeEvent(category_picked = MoneyHomeEvent.CategoryPicked(key = key))) },
            onDismiss = close,
        )
        else -> Unit
    }
}

@Composable
private fun MonthStepper(state: MoneyHomeState, onEvent: (MoneyHomeEvent) -> Unit) {
    val chrome = state.chrome
    val home = state.data_ ?: return
    Row(
        Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconKey("ChevronLeft", chrome?.previous_month_label.orEmpty(), "money-month-previous") {
            onEvent(MoneyHomeEvent(month_stepped = MoneyHomeEvent.MonthStepped(months = -1)))
        }
        Text(
            home.month_label,
            style = centraidType("smallStrong"),
            color = centraidColor("text"),
            modifier = Modifier.weight(1f).padding(horizontal = 8.dp).semantics { heading() },
        )
        IconKey("ChevronRight", chrome?.next_month_label.orEmpty(), "money-month-next", enabled = home.can_step_next) {
            onEvent(MoneyHomeEvent(month_stepped = MoneyHomeEvent.MonthStepped(months = 1)))
        }
    }
}

private fun LazyListScope.spending(state: MoneyHomeState, onEvent: (MoneyHomeEvent) -> Unit, addStatement: () -> Unit) {
    val spending = state.data_?.spending ?: return
    val empty = spending.empty
    if (empty != null) {
        item(key = "empty") { EmptyStateView(empty, onAction = addStatement) }
        return
    }
    items(spending.heroes.size, key = { "hero-$it" }) { index -> MoneyHeroView(spending.heroes[index]) }
    item(key = "days") { MoneyNote(spending.days_left_label) }
    items(spending.in_out_net.size, key = { "net-$it" }) { index ->
        spending.in_out_net[index].figures.forEach { MoneyFigureRow(it) }
    }
    spending.tables.forEach { table ->
        item(key = "table-${table.currency}") { MoneySection(table.heading) }
        items(table.rows, key = { "c-${table.currency}-${it.category_id}" }) { line ->
            CentraidRow(
                title = line.label,
                meta = if (line.has_plan) money(line.planned) else "",
                trailing = money(if (line.has_plan) line.left else line.spent),
                trailingTone = if (line.over) {
                    centraid.screen.v1.StatusChip.Tone.TONE_NET
                } else {
                    centraid.screen.v1.StatusChip.Tone.TONE_NEUTRAL
                },
                a11y = spoken(line.accessibility_label, if (line.has_plan) line.left else line.spent),
                testTag = "money-category-${line.category_id}",
                onTap = {
                    onEvent(MoneyHomeEvent(category_line = MoneyHomeEvent.CategoryLinePicked(category_id = line.category_id, currency = table.currency)))
                },
            )
        }
    }
    spending.notes.forEach { note -> item(key = "note-$note") { MoneyNote(note) } }
    if (spending.recurring_label.isNotEmpty()) {
        item(key = "recurring") {
            CentraidRow(
                title = spending.recurring_label,
                meta = spending.recurring_meta,
                testTag = "money-recurring",
                onTap = { onEvent(MoneyHomeEvent(recurring = MoneyHomeEvent.RecurringOpened())) },
            )
        }
    }
    items(spending.definitions.size, key = { "def-$it" }) { index ->
        val fact = spending.definitions[index]
        FieldRow(key = fact.label, value = fact.detail)
    }
    item(key = "window") { MoneyNote(spending.window_note) }
}

private fun LazyListScope.activity(state: MoneyHomeState, onEvent: (MoneyHomeEvent) -> Unit, addStatement: () -> Unit) {
    val activity = state.data_?.activity ?: return
    val empty = activity.empty
    if (empty != null) {
        item(key = "empty") { EmptyStateView(empty, onAction = addStatement) }
        return
    }
    if (activity.needs_label.isNotEmpty()) {
        item(key = "needs") {
            MoneyNote(activity.needs_label)
            activity.needs_category.forEach { MoneyFigureRow(it) }
        }
    }
    activity.sections.forEach { section ->
        item(key = "day-${section.day}") { MoneySection(section.heading) }
        items(section.rows, key = { "t-${it.txn_id}" }) { row ->
            MoneyRowView(row) { onEvent(MoneyHomeEvent(transaction = MoneyHomeEvent.TransactionPicked(txn_id = row.txn_id))) }
        }
    }
    item(key = "window") {
        MoneyNote(activity.window)
        ShowMoreFooter(visible = activity.more, loading = false, onMore = { onEvent(MoneyHomeEvent(show_more = MoneyHomeEvent.ShowMore())) })
    }
}

private fun LazyListScope.cashflow(state: MoneyHomeState, addStatement: () -> Unit) {
    val flow = state.data_?.cashflow ?: return
    val empty = flow.empty
    if (empty != null) {
        item(key = "empty") { EmptyStateView(empty, onAction = addStatement) }
        return
    }
    flow.series.forEach { series ->
        item(key = "series-${series.currency}") { MoneySection(series.heading) }
        items(series.months, key = { "m-${series.currency}-${it.month}" }) { month ->
            CentraidRow(
                title = month.label,
                meta = listOf(month.rate_label, if (month.partial) dev.centraid.design.copy.MoneyCopy.PARTIAL_MONTH else "")
                    .filter { it.isNotEmpty() }.joinToString(" · "),
                trailing = money(month.net),
                trailingTone = month.net_tone,
                dimmed = month.partial,
                a11y = spoken(month.accessibility_label, month.net),
                testTag = "money-month-${month.month}",
            )
            MoneyFigureRow(centraid.screen.v1.MoneyFigure(label = dev.centraid.design.copy.MoneyCopy.IN, amount = month.incoming))
            MoneyFigureRow(centraid.screen.v1.MoneyFigure(label = dev.centraid.design.copy.MoneyCopy.OUT, amount = month.outgoing))
        }
    }
    flow.definitions.forEach { fact -> item(key = "def-${fact.label}") { FieldRow(key = fact.label, value = fact.detail) } }
    item(key = "window") { MoneyNote(flow.window_note) }
}

// ---------------------------------------------------------------------------
// money.transaction
// ---------------------------------------------------------------------------

@Composable
internal fun MoneyTransactionScreen(state: MoneyTransactionState, onEvent: (MoneyTransactionEvent) -> Unit, onBack: () -> Unit) {
    val chrome = state.chrome
    val data = state.data_
    val status = state.status
    PushedPage(
        title = chrome?.title.orEmpty(),
        parentTitle = chrome?.back_label.orEmpty(),
        onBack = onBack,
        status = status?.sentence.orEmpty().ifEmpty { refusal(state.write) },
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, data, state.denied),
            onRetry = { onEvent(MoneyTransactionEvent(refreshed = MoneyTransactionEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
        ) { tx ->
            LazyColumn {
                item(key = "head") {
                    Text(
                        tx.direction_label,
                        style = centraidType("annotLabel"),
                        color = centraidColor("textSoft"),
                        modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp),
                    )
                    Text(
                        money(tx.amount),
                        style = centraidType("display"),
                        color = dev.centraid.android.kit.toneInk(tx.amount_tone, neutral = "text"),
                        modifier = Modifier.padding(horizontal = KitGeometry.GUTTER),
                    )
                    Text(
                        tx.title,
                        style = centraidType("title"),
                        color = centraidColor("text"),
                        modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp).semantics { heading() },
                    )
                    Row(Modifier.padding(horizontal = KitGeometry.GUTTER)) { tx.chips.forEach { StatusChipView(it, Modifier.padding(end = 6.dp)) } }
                }
                items(tx.facts.size, key = { "fact-$it" }) { index -> FieldRow(key = tx.facts[index].label, value = tx.facts[index].detail) }
                tx.notes.forEach { note -> item(key = "note-$note") { MoneyNote(note) } }
                tx.transfer_offer?.let { offer ->
                    item(key = "offer-transfer") { OfferCard(offer, "transfer", onEvent) }
                }
                tx.rule_offer?.let { offer ->
                    item(key = "offer-rule") { OfferCard(offer, "rule", onEvent) }
                }
                items(tx.actions, key = { "act-${it.key}" }) { action ->
                    CentraidRow(
                        title = action.label,
                        dimmed = !action.enabled,
                        testTag = "money-action-${action.key}",
                        onTap = if (action.enabled) {
                            { onEvent(MoneyTransactionEvent(action = MoneyTransactionEvent.ActionPicked(key = action.key))) }
                        } else {
                            null
                        },
                    )
                }
            }
        }
    }
    val data2 = state.data_
    when (state.sheet) {
        MoneyTransactionState.Sheet.SHEET_CATEGORY -> OptionSheet(
            title = data2?.category_sheet_title.orEmpty(),
            options = data2?.category_options.orEmpty().map { SheetOption(key = it.key, label = it.label, detail = it.detail, selected = it.selected) },
            onPick = { key -> onEvent(MoneyTransactionEvent(category = MoneyTransactionEvent.CategoryPicked(category_id = key))) },
            onDismiss = { onEvent(MoneyTransactionEvent(sheet_closed = MoneyTransactionEvent.SheetClosed())) },
        )
        MoneyTransactionState.Sheet.SHEET_NAME -> SheetRoom(
            title = data2?.name_sheet_title.orEmpty(),
            onDismiss = { onEvent(MoneyTransactionEvent(sheet_closed = MoneyTransactionEvent.SheetClosed())) },
            primary = SheetPrimary(label = data2?.save_label.orEmpty(), testTag = "money-name-save") {
                onEvent(MoneyTransactionEvent(name_saved = MoneyTransactionEvent.NameSaved()))
            },
        ) {
            EditableFieldRow(
                key = "",
                value = state.name_draft,
                reload = state.txn_id,
                placeholder = data2?.name_placeholder.orEmpty(),
                testTag = "money-name",
                onEdit = { onEvent(MoneyTransactionEvent(name_edited = MoneyTransactionEvent.NameEdited(text = it))) },
            )
        }
        else -> Unit
    }
    state.confirm?.let { confirm ->
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(MoneyTransactionEvent(confirm_accepted = MoneyTransactionEvent.ConfirmAccepted())) },
            onDismiss = { onEvent(MoneyTransactionEvent(confirm_dismissed = MoneyTransactionEvent.ConfirmDismissed())) },
        )
    }
}

/** An offer the app proposes: words, and the member's two choices. Nothing is written until Accept. */
@Composable
private fun OfferCard(offer: centraid.screen.v1.MoneyOffer, key: String, onEvent: (MoneyTransactionEvent) -> Unit) {
    MoneySection(offer.title)
    MoneyNote(offer.body, ink = "text")
    MoneyNote(offer.detail)
    Row(Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp)) {
        QuietButton(label = offer.accept_label, testTag = "money-offer-accept-$key") {
            onEvent(MoneyTransactionEvent(offer_accepted = MoneyTransactionEvent.OfferAccepted(key = key)))
        }
        QuietButton(label = offer.dismiss_label, testTag = "money-offer-dismiss-$key", modifier = Modifier.padding(start = 8.dp)) {
            onEvent(MoneyTransactionEvent(offer_dismissed = MoneyTransactionEvent.OfferDismissed(key = key)))
        }
    }
}

// ---------------------------------------------------------------------------
// money.target
// ---------------------------------------------------------------------------

@Composable
internal fun MoneyTargetScreen(state: MoneyTargetState, onEvent: (MoneyTargetEvent) -> Unit, onBack: () -> Unit) {
    val chrome = state.chrome
    val data = state.data_
    PushedPage(
        title = data?.title.orEmpty().ifEmpty { chrome?.title.orEmpty() },
        parentTitle = chrome?.back_label.orEmpty(),
        onBack = onBack,
        status = refusal(state.write),
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, data, state.denied),
            onRetry = { onEvent(MoneyTargetEvent(refreshed = MoneyTargetEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
        ) { target ->
            LazyColumn {
                item(key = "month") { MoneyNote(target.month_label) }
                item(key = "amount") {
                    EditableFieldRow(
                        key = "${target.amount_label} · ${target.currency_label}",
                        value = state.amount_text,
                        reload = "${state.month}-${state.category_id}",
                        testTag = "money-target-amount",
                        onEdit = { onEvent(MoneyTargetEvent(amount = MoneyTargetEvent.AmountEdited(text = it))) },
                    )
                    MoneyNote(target.issue, ink = "net")
                    MoneyNote(target.exponent_hint)
                }
                items(target.figures.size, key = { "fig-$it" }) { index -> MoneyFigureRow(target.figures[index]) }
                item(key = "average") {
                    QuietButton(
                        label = target.use_average_label,
                        testTag = "money-target-average",
                        modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp),
                    ) { onEvent(MoneyTargetEvent(use_average = MoneyTargetEvent.UseAverage())) }
                }
                item(key = "carry") {
                    MoneyToggleRow(target.carry_label, state.carry, "money-target-carry") {
                        onEvent(MoneyTargetEvent(carry = MoneyTargetEvent.CarryToggled()))
                    }
                    MoneyNote(target.carry_note)
                }
                item(key = "preview") {
                    MoneyHeading(target.preview_label)
                    MoneyFigureRow(centraid.screen.v1.MoneyFigure(label = target.preview_label, amount = target.preview))
                    MoneyNote(target.preview_note)
                }
                item(key = "save") {
                    InkButton(
                        label = target.save_label,
                        enabled = target.can_save,
                        testTag = "money-target-save",
                        modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                    ) { onEvent(MoneyTargetEvent(save = MoneyTargetEvent.Save())) }
                    if (target.remove_label.isNotEmpty()) {
                        QuietButton(
                            label = target.remove_label,
                            ink = "net",
                            testTag = "money-target-remove",
                            modifier = Modifier.padding(horizontal = KitGeometry.GUTTER),
                        ) { onEvent(MoneyTargetEvent(remove = MoneyTargetEvent.Remove())) }
                    }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// money.recurring
// ---------------------------------------------------------------------------

@Composable
internal fun MoneyRecurringScreen(state: MoneyRecurringState, onEvent: (MoneyRecurringEvent) -> Unit, onBack: () -> Unit) {
    val chrome = state.chrome
    PushedPage(title = chrome?.title.orEmpty(), parentTitle = chrome?.back_label.orEmpty(), onBack = onBack) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
            onRetry = { onEvent(MoneyRecurringEvent(refreshed = MoneyRecurringEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
        ) { recurring ->
            val empty = recurring.empty
            if (empty != null) {
                EmptyStateView(empty, onAction = null)
            } else {
                LazyColumn {
                    items(recurring.rows, key = { it.key }) { row ->
                        CentraidRow(
                            title = row.merchant,
                            meta = listOf(row.meta, row.detail).filter { it.isNotEmpty() }.joinToString(" · "),
                            trailing = money(row.amount),
                            chips = row.chips,
                            a11y = spoken(row.accessibility_label, row.amount),
                            testTag = "money-recurring-${row.key}",
                        )
                    }
                    items(recurring.definitions.size, key = { "def-$it" }) { index ->
                        FieldRow(key = recurring.definitions[index].label, value = recurring.definitions[index].detail)
                    }
                    item(key = "window") { MoneyNote(recurring.window_note) }
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// money.search
// ---------------------------------------------------------------------------

@Composable
internal fun MoneySearchScreen(
    state: MoneySearchState,
    onEvent: (MoneySearchEvent) -> Unit,
    onBack: () -> Unit,
    onOpenContainer: (centraid.screen.v1.ChatCard) -> Unit = {},
) {
    val chrome = state.chrome
    PushedPage(title = chrome?.title.orEmpty(), parentTitle = chrome?.back_label.orEmpty(), onBack = onBack) {
        androidx.compose.foundation.layout.Column {
            CentraidSearchField(
                field = state.field_ ?: SearchField(open_ = true),
                placeholder = state.placeholder,
                onTerm = { onEvent(MoneySearchEvent(term = MoneySearchEvent.TermChanged(term = it))) },
                onClose = { onEvent(MoneySearchEvent(cleared = MoneySearchEvent.Cleared())) },
                closeLabel = state.clear_label.ifEmpty { KitWords.CLOSE_SEARCH },
            )
            val resting = state.resting
            if (resting != null) {
                EmptyStateView(resting, onAction = null)
            } else {
                ReadStateView(
                    content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
                    onRetry = { onEvent(MoneySearchEvent(refreshed = MoneySearchEvent.Refreshed())) },
                    retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
                ) { search ->
                    val empty = search.empty
                    if (search.rows.isEmpty() && empty != null) {
                        EmptyStateView(empty, onAction = null)
                    } else {
                        LazyColumn {
                            items(state.field_?.containers.orEmpty(), key = { "c-${it.entity}-${it.id}" }) { container ->
                                SearchContainerRow(container, onOpen = onOpenContainer)
                            }
                            item(key = "count") { StatusLine(search.count_label) }
                            items(search.rows, key = { "t-${it.txn_id}" }) { row ->
                                MoneyRowView(row) { onEvent(MoneySearchEvent(transaction = MoneySearchEvent.TransactionPicked(txn_id = row.txn_id))) }
                            }
                        }
                    }
                }
            }
        }
    }
}
