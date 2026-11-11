package dev.centraid.android.screens.money

import dev.centraid.android.kit.SearchAskRow
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Switch
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.semantics.toggleableState
import dev.centraid.android.kit.SheetPage
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.kitSwitchColors
import dev.centraid.android.kit.rememberEditorText
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.width
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
import centraid.core.v1.FilterMenuCleared
import centraid.core.v1.FilterMenuPicked
import centraid.core.v1.MoneyHomeEvent
import centraid.core.v1.MoneyHomeState
import centraid.core.v1.MoneyRecurringEvent
import centraid.core.v1.MoneyRecurringState
import centraid.core.v1.MoneySearchEvent
import centraid.core.v1.MoneySearchState
import centraid.core.v1.MoneyTargetEvent
import centraid.core.v1.MoneyTargetState
import centraid.core.v1.MoneyTransactionEvent
import centraid.core.v1.MoneyTransactionState
import dev.centraid.android.kit.SearchField
import centraid.core.v1.Route
import dev.centraid.android.kit.AppBand
import dev.centraid.android.kit.AppBandTab
import dev.centraid.android.kit.AppPlace
import dev.centraid.android.kit.BandSearchField
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.ChoiceStack
import dev.centraid.android.kit.EarlierEntryCard
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.FieldRow
import dev.centraid.android.kit.IconKey
import dev.centraid.android.kit.InkButton
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.StateColor
import dev.centraid.android.kit.KitSegment
import dev.centraid.android.kit.KitSegmented
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.kitCard
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.RoomFilter
import dev.centraid.android.kit.RoomSubtitle
import dev.centraid.android.kit.RoomSearch
import dev.centraid.android.kit.SheetOption
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.ShowMoreFooter
import dev.centraid.android.kit.StatusChipView
import dev.centraid.android.kit.StatusLine
import dev.centraid.android.kit.toneInk
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

// ---------------------------------------------------------------------------
// money.home: Activity (home) · Spending · Cash flow, More as a sheet
// ---------------------------------------------------------------------------

@Composable
internal fun MoneyHomeScreen(
    state: MoneyHomeState,
    onEvent: (MoneyHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onHome: () -> Unit,
) {
    val chrome = state.chrome
    // The Plus and the day-one action go where Rust says: an import.
    val addStatement: () -> Unit = { chrome?.import_route?.let(onOpen) }
    AppPlace(
        app = "money",
        title = chrome?.title.orEmpty(),
        // THE HEADER'S ONE ACTION is the app's create verb: rows enter by import (R-CHROME-1).
        trailing = chrome?.add_label?.takeIf { it.isNotEmpty() }?.let { label ->
            RoomAction("Plus", label, "money-add") { addStatement() }
        },
        // A DOOR, NOT A FIELD (R-CHROME-2): Money's search is a page of its own.
        search = chrome?.search_placeholder?.takeIf { it.isNotEmpty() && state.page?.refused == null }?.let { placeholder ->
            RoomSearch(
                field = SearchField(),
                placeholder = placeholder,
                onTerm = {},
                onClose = {},
                onOpen = { chrome?.search_route?.let(onOpen) },
            )
        },
        // THE HEADER'S FILTER BUTTON is account and category, no sort (R-CHROME-3): Rust's menu, a
        // pick or the clear row an event, what is checked the next state's.
        filter = state.filter_menu?.let { menu ->
            RoomFilter(
                menu = menu,
                onPick = { section, option ->
                    onEvent(MoneyHomeEvent(filter_menu_picked = FilterMenuPicked(section_key = section, option_key = option)))
                },
                onClear = { onEvent(MoneyHomeEvent(filter_menu_cleared = FilterMenuCleared())) },
            )
        },
        // THE MONTH IN VIEW stays under the title and opens its sheet.
        subtitle = state.subtitle?.let { subtitle ->
            RoomSubtitle(
                subtitle = subtitle,
                onTap = { onEvent(MoneyHomeEvent(month_tapped = MoneyHomeEvent.MonthTapped())) },
            )
        },
        statusLine = { StatusLine(state.status) },
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
            page = state.page!!,
            onRetry = { onEvent(MoneyHomeEvent(refreshed = MoneyHomeEvent.Refreshed())) },
            onEmptyAction = addStatement,
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
        ) {
            val home = state.data_ ?: return@ReadStateView
            if (state.destination == MoneyHomeState.Destination.DESTINATION_CASHFLOW) {
                LazyColumn { cashflow(state) }
            } else {
                // ACTIVITY (home) AND SPENDING are pages of cards on the page colour.
                LazyColumn(
                    contentPadding = PaddingValues(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (state.destination == MoneyHomeState.Destination.DESTINATION_SPENDING) {
                        spending(state, onEvent, onOpen)
                    } else {
                        activity(state, onEvent, onOpen)
                    }
                }
            }
        }
    }
    val data = state.data_
    val close = { onEvent(MoneyHomeEvent(sheet_closed = MoneyHomeEvent.SheetClosed())) }
    when (state.sheet) {
        MoneyHomeState.Sheet.SHEET_MORE -> OptionSheet(
            title = chrome?.more_title.orEmpty(),
            options = chrome?.more_rows.orEmpty().map { SheetOption(key = it.route?.screen.orEmpty(), label = it.label, iconKey = it.icon_key, detail = it.meta) },
            onPick = { key ->
                // The sheet closes behind the page the row opens.
                onEvent(MoneyHomeEvent(more_opened = MoneyHomeEvent.MoreOpened()))
                chrome?.more_rows.orEmpty().firstOrNull { it.route?.screen == key }?.route?.let(onOpen)
            },
            onDismiss = close,
        )
        MoneyHomeState.Sheet.SHEET_MONTH -> OptionSheet(
            title = chrome?.month_sheet_title.orEmpty(),
            options = data?.month_options.orEmpty().map { SheetOption(key = it.key, label = it.label, selected = it.selected) },
            onPick = { key -> onEvent(MoneyHomeEvent(month_picked = MoneyHomeEvent.MonthPicked(month = key))) },
            onDismiss = close,
        )
        else -> Unit
    }
}

/**
 * SPENDING: the chart card (spent so far, Week / Day, the bars and the sentence under the
 * selected one), the categories with their progress, then the notes and the recurring row.
 */
private fun LazyListScope.spending(
    state: MoneyHomeState,
    onEvent: (MoneyHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
) {
    val spending = state.data_?.spending ?: return
    items(spending.bars.size, key = { "bars-$it" }) { index ->
        val bars = spending.bars[index]
        val hero = spending.heroes.getOrNull(index) ?: spending.heroes.firstOrNull()
        Column(Modifier.fillMaxWidth().kitCard().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (bars.heading.isNotEmpty()) KitText(bars.heading, KitType.Group, Surface.meta)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                Column(
                    Modifier.weight(1f).semantics(mergeDescendants = true) {}.testTag("money-hero"),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    KitText(hero?.spent_label.orEmpty(), KitType.Meta, Surface.meta)
                    KitText(hero?.spent.orEmpty(), KitType.Title, Surface.ink, maxLines = 1)
                }
                KitSegmented(
                    segments = bars.modes.map { KitSegment(id = it.key, label = it.label, selected = it.selected) },
                    modifier = Modifier.width(140.dp),
                    testTag = "money-bars-mode",
                    onPick = { key -> onEvent(MoneyHomeEvent(bars_mode_picked = MoneyHomeEvent.BarsModePicked(key = key))) },
                )
            }
            MoneyBarsChart(bars) { picked ->
                onEvent(MoneyHomeEvent(bar_picked = MoneyHomeEvent.BarPicked(index = picked)))
            }
        }
    }
    spending.tables.forEach { table ->
        item(key = "table-${table.currency}") {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (table.heading.isNotEmpty()) KitText(table.heading, KitType.Group, Surface.meta, Modifier.padding(horizontal = 4.dp))
                MoneyCardStack {
                    table.rows.forEachIndexed { index, line ->
                        if (index > 0) MoneyHairline()
                        MoneyCategoryProgressRow(line) { line.route?.let(onOpen) }
                    }
                    table.more?.let { more ->
                        MoneyHairline()
                        MoneyRestRow(more, pending = false, testTag = "money-categories-more") {
                            onEvent(MoneyHomeEvent(categories_expanded = MoneyHomeEvent.CategoriesExpanded()))
                        }
                    }
                    table.uncategorised?.let { none ->
                        MoneyHairline()
                        MoneyRestRow(none, pending = true, testTag = "money-needs-category") {
                            onEvent(MoneyHomeEvent(category_picked = MoneyHomeEvent.CategoryPicked(key = none.key)))
                        }
                    }
                }
            }
        }
    }
    if (spending.recurring_label.isNotEmpty()) {
        item(key = "recurring") {
            MoneyCardStack {
                CentraidRow(
                    title = spending.recurring_label,
                    meta = spending.recurring_meta,
                    testTag = "money-recurring",
                    onTap = { spending.recurring_route?.let(onOpen) },
                )
            }
        }
    }
    spending.notes.forEach { note ->
        item(key = "note-$note") { KitText(note, KitType.Meta, Surface.meta, Modifier.padding(horizontal = 4.dp)) }
    }
    items(spending.definitions.size, key = { "def-$it" }) { index ->
        val fact = spending.definitions[index]
        Column(Modifier.padding(horizontal = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            KitText(fact.label, KitType.Meta, Surface.body)
            KitText(fact.detail, KitType.Meta, Surface.meta)
        }
    }
    if (spending.window_note.isNotEmpty()) {
        item(key = "window") { KitText(spending.window_note, KitType.Meta, Surface.meta, Modifier.padding(horizontal = 4.dp)) }
    }
}

/**
 * ACTIVITY, home: the month's overview card, the review banner, then each day's rows in a card
 * under its heading and what it came to.
 */
private fun LazyListScope.activity(
    state: MoneyHomeState,
    onEvent: (MoneyHomeEvent) -> Unit,
    onOpen: (Route) -> Unit,
) {
    val activity = state.data_?.activity ?: return
    items(activity.heroes.size, key = { "hero-$it" }) { index ->
        MoneyOverviewCard(activity.heroes[index], activity.days_left_label, activity.in_out_net.getOrNull(index))
    }
    if (activity.needs_title.isNotEmpty()) {
        item(key = "needs") {
            // THE FILTER THAT LISTS THESE ROWS is the state's own `needs_key`.
            MoneyReviewBanner(
                count = activity.needs_count,
                title = activity.needs_title,
                review = activity.review_label,
                spokenLabel = activity.needs_label,
            ) {
                onEvent(MoneyHomeEvent(category_picked = MoneyHomeEvent.CategoryPicked(key = activity.needs_key)))
            }
        }
    }
    activity.sections.forEach { section ->
        item(key = "day-${section.day}") {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                MoneyDayHeading(section)
                MoneyCardStack {
                    section.rows.forEachIndexed { index, row ->
                        if (index > 0) MoneyHairline(inset = 64.dp)
                        MoneyTxnRow(row) { row.route?.let(onOpen) }
                    }
                }
            }
        }
    }
    item(key = "window") {
        Column {
            if (activity.window.isNotEmpty()) KitText(activity.window, KitType.Meta, Surface.meta, Modifier.padding(horizontal = 4.dp))
            ShowMoreFooter(visible = activity.more, loading = false, onMore = { onEvent(MoneyHomeEvent(show_more = MoneyHomeEvent.ShowMore())) })
        }
    }
}

private fun LazyListScope.cashflow(state: MoneyHomeState) {
    val flow = state.data_?.cashflow ?: return
    flow.series.forEach { series ->
        item(key = "series-${series.currency}") {
            Column {
                MoneySection(series.heading)
                MoneyCashflowChart(
                    months = series.months,
                    summary = MoneyGeometry.chartSummary(series.months.map { it.accessibility_label }),
                )
                MoneyLegend(incoming = series.in_label, outgoing = series.out_label, partial = series.partial_label)
                Row(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Box(Modifier.weight(1f))
                    listOf(series.in_label, series.out_label, series.net_label).forEach { label ->
                        Text(label, style = centraidType("annotLabel"), color = centraidColor("textSoft"), modifier = Modifier.width(68.dp), textAlign = androidx.compose.ui.text.style.TextAlign.End)
                    }
                }
            }
        }
        // NEWEST FIRST under the chart, which runs oldest to newest.
        items(MoneyGeometry.newestFirst(series.months), key = { "m-${series.currency}-${it.month}" }) { month ->
            MoneyMonthRow(month, testTag = "money-month-${month.month}")
        }
    }
    flow.definitions.forEach { fact -> item(key = "def-${fact.label}") { FieldRow(key = fact.label, value = fact.detail) } }
    item(key = "window") { MoneyNote(flow.window_note) }
}

// ---------------------------------------------------------------------------
// money.transaction
// ---------------------------------------------------------------------------

@Composable
internal fun MoneyTransactionScreen(
    state: MoneyTransactionState,
    onEvent: (MoneyTransactionEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onBack: () -> Unit,
) {
    val chrome = state.chrome
    val data = state.data_
    PushedPage(
        title = chrome?.title.orEmpty(),
        parentTitle = chrome?.back_label.orEmpty(),
        onBack = onBack,
        statusLine = {
            // "{title} moved to trash" with Undo over the removed page (#1185), and a refusal's sentence.
            StatusLine(state.status, actTag = "money-status-action") {
                onEvent(MoneyTransactionEvent(status_acted = MoneyTransactionEvent.StatusActed()))
            }
        },
    ) {
        // THE PAGE STAYS OPEN ON THE GONE FAILURE after Move to trash; the line above carries Undo.
        ReadStateView(
            page = state.page!!,
            onRetry = { onEvent(MoneyTransactionEvent(refreshed = MoneyTransactionEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
        ) {
            val tx = state.data_ ?: return@ReadStateView
            LazyColumn {
                item(key = "head") {
                    Column(
                        Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        KitText(tx.title, KitType.Title, Surface.ink, Modifier.semantics { heading() })
                        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            KitText(tx.amount, KitType.Title, moneyInk(tx.amount_positive, tx.amount_tone), maxLines = 1)
                            KitText(tx.direction_label, KitType.Meta, Surface.meta, Modifier.padding(bottom = 4.dp))
                        }
                        Row { tx.chips.forEach { StatusChipView(it, Modifier.padding(end = 6.dp)) } }
                    }
                }
                item(key = "facts") {
                    MoneyPageCard {
                        tx.facts.forEachIndexed { index, fact ->
                            if (index > 0) MoneyHairline()
                            FieldRow(key = fact.label, value = fact.detail)
                        }
                    }
                }
                tx.notes.forEach { note -> item(key = "note-$note") { MoneyNote(note) } }
                tx.transfer_offer?.let { offer ->
                    item(key = "offer-transfer") { OfferCard(offer, "transfer", onEvent) }
                }
                tx.rule_offer?.let { offer ->
                    item(key = "offer-rule") { OfferCard(offer, "rule", onEvent) }
                }
                tx.with_offer?.let { offer ->
                    item(key = "offer-with") { OfferCard(offer, "with", onEvent) }
                }
                // ATTACHMENTS (#1185): the kit's section, after the offers; Rust makes every word and row.
                tx.attachments?.let { section ->
                    item(key = "attachments") {
                        dev.centraid.android.screens.agenda.AgendaAttachmentsView(
                            section = section,
                            prefix = "money-transaction",
                            onEvent = { onEvent(MoneyTransactionEvent(attachment = it)) },
                            onOpen = onOpen,
                        )
                    }
                }
                // LINKED TO (#1185): the kit's section, after the attachments; Rust makes every word and row.
                tx.links?.let { section ->
                    item(key = "links") {
                        dev.centraid.android.kit.LinkSectionView(section, { link -> onEvent(MoneyTransactionEvent(link = link)) }, onOpen)
                    }
                }
                // EVERY RECORD KEEPS ITS EARLIER VALUES (#1185): the last content row, above the actions.
                state.earlier?.let { entry -> item(key = "earlier") { EarlierEntryCard(entry, onOpen) } }
                item(key = "origin") { dev.centraid.android.kit.OriginLineView(state.origin) }
                // THE ACTIONS ARE ALTERNATIVES: one stack; a destructive one is outlined in `net`.
                item(key = "actions") {
                    ChoiceStack(Modifier.padding(horizontal = KitGeometry.GUTTER).padding(top = 24.dp)) {
                        tx.actions.forEach { action ->
                            OutlineButton(
                                label = action.label,
                                testTag = "money-action-${action.key}",
                                ink = if (action.destructive) "net" else "text",
                                enabled = action.enabled,
                            ) { onEvent(MoneyTransactionEvent(action = MoneyTransactionEvent.ActionPicked(key = action.key))) }
                        }
                    }
                }
            }
        }
    }
    val data2 = state.data_
    state.with_picker?.takeIf { it.open_ }?.let { picker ->
        dev.centraid.android.kit.LinkPickerSheet(picker) { link -> onEvent(MoneyTransactionEvent(with_link = link)) }
    }
    state.link_picker?.takeIf { it.open_ }?.let { picker ->
        dev.centraid.android.kit.LinkPickerSheet(picker) { link -> onEvent(MoneyTransactionEvent(link = link)) }
    }
    when (state.sheet) {
        MoneyTransactionState.Sheet.SHEET_CATEGORY -> MoneyChoiceSheet(
            title = data2?.category_sheet_title.orEmpty(),
            choices = data2?.category_options.orEmpty(),
            tagPrefix = "money-category-option",
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
}

/** An offer the app proposes: words, and the member's two choices. Nothing is written until Accept. */
@Composable
private fun OfferCard(offer: centraid.core.v1.MoneyOffer, key: String, onEvent: (MoneyTransactionEvent) -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
            .clip(androidx.compose.foundation.shape.RoundedCornerShape(dev.centraid.design.CentraidScale.cardRadius.dp))
            .background(StateColor.Amber.tint)
            .padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        KitText(offer.title, KitType.Row, Surface.ink)
        if (offer.body.isNotEmpty()) KitText(offer.body, KitType.Row, Surface.ink)
        if (offer.detail.isNotEmpty()) KitText(offer.detail, KitType.Meta, Surface.meta)
        Row {
            OutlineButton(label = offer.accept_label, testTag = "money-offer-accept-$key") {
                onEvent(MoneyTransactionEvent(offer_accepted = MoneyTransactionEvent.OfferAccepted(key = key)))
            }
            OutlineButton(label = offer.dismiss_label, testTag = "money-offer-dismiss-$key", modifier = Modifier.padding(start = 8.dp)) {
                onEvent(MoneyTransactionEvent(offer_dismissed = MoneyTransactionEvent.OfferDismissed(key = key)))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// money.target
// ---------------------------------------------------------------------------

/**
 * `money.target` as a SHEET over Money (`Route.sheet`), the way MoneyTarget.dc.html draws it: the
 * X, the title, the figures, the amount with "Use average" inside the field, the carry switch, the
 * next month's effect, and Save pinned at the foot with Remove under it.
 */
@Composable
internal fun MoneyTargetScreen(state: MoneyTargetState, onEvent: (MoneyTargetEvent) -> Unit, onBack: () -> Unit) {
    val chrome = state.chrome
    val data = state.data_
    // SAVED OR REMOVED: Rust says the screen is done, the sheet closes.
    LaunchedEffect(state.finished) { if (state.finished) onBack() }
    SheetPage(
        title = chrome?.title.orEmpty(),
        onDismiss = onBack,
        foot = {
            StatusLine(state.status)
            if (data != null) {
                Column(
                    Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    InkButton(
                        label = data.save_label,
                        enabled = data.can_save,
                        testTag = "money-target-save",
                    ) { onEvent(MoneyTargetEvent(save = MoneyTargetEvent.Save())) }
                    if (data.remove_label.isNotEmpty()) {
                        Box(
                            Modifier
                                .fillMaxWidth()
                                .heightIn(min = 50.dp)
                                .clickable { onEvent(MoneyTargetEvent(remove = MoneyTargetEvent.Remove())) }
                                .testTag("money-target-remove"),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(data.remove_label, style = centraidType("sheetKey"), color = StateColor.Red.text)
                        }
                    }
                }
            }
        },
    ) {
        ReadStateView(
            page = state.page!!,
            onRetry = { onEvent(MoneyTargetEvent(refreshed = MoneyTargetEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
        ) {
            val target = state.data_ ?: return@ReadStateView
            LazyColumn {
                item(key = "head") {
                    Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER + 2.dp, vertical = 8.dp)) {
                        KitText(target.title, KitType.Section, Surface.ink, maxLines = 2)
                        KitText(target.month_label, KitType.Row, Surface.meta)
                    }
                }
                item(key = "figures") { MoneyFigureCard(target.figures) }
                item(key = "amount") {
                    TargetAmountField(state, target, onEvent)
                    MoneyNote(target.issue, ink = "net")
                    MoneyNote(target.exponent_hint)
                }
                item(key = "carry") { TargetCarryCard(target, state.carry, onEvent) }
                item(key = "preview") {
                    MoneyFigureCard(listOf(centraid.core.v1.MoneyFigure(label = target.preview_label, amount = target.preview)))
                    MoneyNote(target.preview_note)
                }
            }
        }
    }
}

/** THE AMOUNT, on a card with the accent's ring: the currency, the figure, and "Use average" inside. */
@Composable
private fun TargetAmountField(state: MoneyTargetState, target: centraid.core.v1.MoneyTargetData, onEvent: (MoneyTargetEvent) -> Unit) {
    val accent = appAccent()
    val editor = rememberEditorText(state.amount_text, "${state.month}-${state.category_id}")
    val text = editor.text
    val label = "${target.amount_label} · ${target.currency_label}"
    Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)) {
        KitText(target.amount_label, KitType.Meta, Surface.meta, Modifier.padding(start = 4.dp, bottom = 6.dp))
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 52.dp)
                .clip(RoundedCornerShape(KitGeometry.RADIUS))
                .background(Surface.card)
                .border(1.5.dp, accent.fill, RoundedCornerShape(KitGeometry.RADIUS))
                .padding(start = 14.dp, end = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            KitText(target.currency_label, KitType.Row, Surface.meta)
            BasicTextField(
                value = text.value,
                onValueChange = { next ->
                    if (editor.edited(next)) onEvent(MoneyTargetEvent(amount = MoneyTargetEvent.AmountEdited(text = next)))
                },
                singleLine = true,
                textStyle = centraidType("title").copy(color = Surface.ink),
                cursorBrush = SolidColor(Surface.ink),
                modifier = Modifier
                    .weight(1f)
                    .testTag("money-target-amount")
                    .semantics { contentDescription = label },
            )
            Box(
                Modifier
                    .heightIn(min = KitGeometry.ROW_MIN)
                    .clickable { onEvent(MoneyTargetEvent(use_average = MoneyTargetEvent.UseAverage())) }
                    .padding(horizontal = 6.dp)
                    .testTag("money-target-average"),
                contentAlignment = Alignment.Center,
            ) {
                Text(target.use_average_label, style = centraidType("sheetKey"), color = accent.text)
            }
        }
    }
}

/** THE CARRY SWITCH, with its sentence under the label, on a card. */
@Composable
private fun TargetCarryCard(target: centraid.core.v1.MoneyTargetData, carry: Boolean, onEvent: (MoneyTargetEvent) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
            .kitCard()
            .clickable { onEvent(MoneyTargetEvent(carry = MoneyTargetEvent.CarryToggled())) }
            .padding(horizontal = 14.dp, vertical = 8.dp)
            .heightIn(min = KitGeometry.ROW_MIN)
            .testTag("money-target-carry")
            .semantics(mergeDescendants = true) {
                role = Role.Switch
                toggleableState = if (carry) ToggleableState.On else ToggleableState.Off
                contentDescription = target.carry_label
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Column(Modifier.weight(1f)) {
            KitText(target.carry_label, KitType.Row, Surface.ink)
            KitText(target.carry_note, KitType.Meta, Surface.meta)
        }
        Switch(checked = carry, onCheckedChange = null, colors = kitSwitchColors())
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
            page = state.page!!,
            onRetry = { onEvent(MoneyRecurringEvent(refreshed = MoneyRecurringEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
        ) {
            val recurring = state.data_ ?: return@ReadStateView
                LazyColumn {
                    item(key = "rows") {
                        MoneyPageCard {
                            recurring.rows.forEachIndexed { index, row ->
                                if (index > 0) MoneyHairline()
                                CentraidRow(
                                    title = row.merchant,
                                    meta = listOf(row.meta, row.detail).filter { it.isNotEmpty() }.joinToString(" · "),
                                    trailing = money(row.amount),
                                    chips = row.chips.map { it },
                                    a11y = spoken(row.accessibility_label, row.amount),
                                    testTag = "money-recurring-${row.key}",
                                )
                            }
                        }
                    }
                    items(recurring.definitions.size, key = { "def-$it" }) { index ->
                        MoneyNote("${recurring.definitions[index].label}. ${recurring.definitions[index].detail}")
                    }
                    item(key = "window") { MoneyNote(recurring.window_note) }
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
    onOpen: (Route) -> Unit,
    onBack: () -> Unit,
) {
    val chrome = state.chrome
    PushedPage(title = chrome?.title.orEmpty(), parentTitle = chrome?.back_label.orEmpty(), onBack = onBack) {
        androidx.compose.foundation.layout.Column {
            // THE BODY TAKES THE HEIGHT the field at the foot does not (R-CHROME-2). The resting page and a
            // term that matched nothing are the page's empty state; the second keeps the Ask row under it.
            ReadStateView(
                page = state.page!!,
                onRetry = { onEvent(MoneySearchEvent(refreshed = MoneySearchEvent.Refreshed())) },
                retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
                modifier = Modifier.weight(1f),
                emptyExtra = { state.data_?.ask?.let { ask -> SearchAskRow(ask, onOpen) } },
            ) {
                val search = state.data_ ?: return@ReadStateView
                LazyColumn(
                    contentPadding = PaddingValues(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    item(key = "count") {
                        KitText(search.count_label, KitType.Meta, Surface.meta, Modifier.padding(horizontal = 4.dp).testTag("money-search-count"))
                    }
                    item(key = "rows") {
                        MoneyCardStack {
                            search.rows.forEachIndexed { index, row ->
                                if (index > 0) MoneyHairline(inset = 64.dp)
                                MoneyTxnRow(row) { row.route?.let(onOpen) }
                            }
                        }
                    }
                    // THE ASK ROW closes the answer (#1097).
                    item(key = "ask") { SearchAskRow(search.ask, onOpen) }
                }
            }
            // THE FIELD IS AT THE FOOT, over the keyboard, like every app's search (R-CHROME-2); its
            // close only clears the query, so it keeps the keyboard.
            BandSearchField(
                field = SearchField(open_ = true, term = state.term),
                placeholder = state.placeholder,
                onTerm = { onEvent(MoneySearchEvent(term = MoneySearchEvent.TermChanged(term = it))) },
                onClose = { onEvent(MoneySearchEvent(cleared = MoneySearchEvent.Cleared())) },
                closeLabel = state.clear_label.ifEmpty { KitWords.CLOSE_SEARCH },
                testTag = "money-search",
                keepsFocusOnClose = true,
            )
        }
    }
}
