package dev.centraid.android.screens.money

import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import centraid.screen.v1.MoneyAccountsEvent
import centraid.screen.v1.MoneyAccountsState
import centraid.screen.v1.MoneyCategoriesEvent
import centraid.screen.v1.MoneyCategoriesState
import centraid.screen.v1.MoneyImportEvent
import centraid.screen.v1.MoneyImportState
import centraid.screen.v1.MoneyRulesEvent
import centraid.screen.v1.MoneyRulesState
import dev.centraid.android.kit.ChoiceFieldRow
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.ChoiceStack
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.FieldRow
import dev.centraid.android.kit.InkButton
import dev.centraid.android.kit.KitChip
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.OptionSheet
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.SheetOption
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.screenContentOf

// ---------------------------------------------------------------------------
// money.import: pick a statement, read the plan, publish
// ---------------------------------------------------------------------------

/**
 * `money.import`: the file, the account a CSV goes into, then the plan the core
 * made of it, each statement with its verdicts; nothing is written until the
 * last button. Choose is the machine's intent: the route opens the OS picker.
 */
@Composable
internal fun MoneyImportScreen(state: MoneyImportState, onEvent: (MoneyImportEvent) -> Unit, onBack: () -> Unit) {
    val chrome = state.chrome
    PushedPage(
        title = chrome?.title.orEmpty(),
        parentTitle = chrome?.back_label.orEmpty(),
        onBack = onBack,
        status = state.status?.sentence.orEmpty(),
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
            onRetry = { onEvent(MoneyImportEvent(refreshed = MoneyImportEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
        ) { plan ->
            val empty = plan.empty
            if (empty != null) {
                EmptyStateView(empty, onAction = { onEvent(MoneyImportEvent(add_account = MoneyImportEvent.AddAccount())) })
            } else {
                LazyColumn {
                    item(key = "lede") { MoneyNote(plan.lede) }
                    item(key = "file") {
                        FieldRow(key = plan.file_label, value = plan.file_value, note = plan.file_note)
                        if (plan.choose_label.isNotEmpty()) {
                            OutlineButton(
                                label = plan.choose_label,
                                testTag = "money-import-choose",
                                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp),
                            ) { onEvent(MoneyImportEvent(choose = MoneyImportEvent.ChooseTapped())) }
                        }
                    }
                    if (plan.needs_account) {
                        item(key = "account") {
                            ChoiceFieldRow(
                                key = plan.account_label,
                                value = plan.account_value,
                                testTag = "money-import-account",
                                onTap = { onEvent(MoneyImportEvent(account_sheet_opened = MoneyImportEvent.AccountSheetOpened())) },
                            )
                        }
                    }
                    if (plan.refusal.isNotEmpty()) item(key = "refusal") { MoneyNote(plan.refusal, ink = "net") }
                    plan.statements.forEach { statement ->
                        item(key = "${statement.key}-head") { MoneySection(statement.title) }
                        item(key = "${statement.key}-body") {
                            MoneyNote(statement.refusal, ink = "net")
                            MoneyNote(statement.span)
                            statement.totals.forEach { MoneyFigureRow(it) }
                            statement.counts.forEach { FieldRow(key = it.label, value = it.detail) }
                            statement.warnings.forEach { MoneyNote(it) }
                            statement.checkpoint?.let { MoneyFigureRow(it) }
                            MoneyNote(statement.checkpoint_label)
                            statement.question?.let { question ->
                                MoneyHeading(question.prompt)
                                MoneyNote(question.samples.joinToString(", "))
                                Row(Modifier.padding(horizontal = KitGeometry.GUTTER)) {
                                    question.options.forEach { option ->
                                        KitChip(
                                            label = option.label,
                                            selected = option.selected,
                                            modifier = Modifier.padding(end = 8.dp),
                                            onClick = { onEvent(MoneyImportEvent(date_order = MoneyImportEvent.DateOrderAnswered(order = option.key))) },
                                        )
                                    }
                                }
                            }
                            if (statement.sign_options.isNotEmpty()) {
                                MoneyHeading(statement.sign_label)
                                Row(Modifier.padding(horizontal = KitGeometry.GUTTER)) {
                                    statement.sign_options.forEach { option ->
                                        KitChip(
                                            label = option.label,
                                            selected = option.selected,
                                            modifier = Modifier.padding(end = 8.dp),
                                            onClick = { onEvent(MoneyImportEvent(sign = MoneyImportEvent.SignChosen(choice = option.key))) },
                                        )
                                    }
                                }
                            }
                            if (statement.has_proposed) {
                                MoneyToggleRow(statement.keep_proposed_label, state.keep_proposed, "money-import-keep") {
                                    onEvent(MoneyImportEvent(keep_proposed = MoneyImportEvent.KeepProposedToggled()))
                                }
                            }
                        }
                        items(statement.rows, key = { "${statement.key}-${it.key}" }) { line ->
                            CentraidRow(
                                title = line.title.ifEmpty { line.line_label },
                                meta = listOf(line.line_label.takeIf { line.title.isNotEmpty() }.orEmpty(), line.meta, line.reason)
                                    .filter { it.isNotEmpty() }.joinToString(" · "),
                                trailing = if (line.has_amount) money(line.amount) else "",
                                chips = listOf(line.chip).filterNotNull(),
                                a11y = spoken(line.accessibility_label, if (line.has_amount) line.amount else null),
                                testTag = "money-import-${statement.key}-${line.key}",
                            )
                        }
                        statement.more.forEach { more -> item(key = "${statement.key}-more-$more") { MoneyNote(more) } }
                    }
                    item(key = "publish") {
                        val gutter = Modifier.padding(horizontal = KitGeometry.GUTTER)
                        if (plan.publish_label.isNotEmpty()) {
                            // PUBLISH AND DISCARD ARE ALTERNATIVES: one stack,
                            // the note that says what publishing does between
                            // them.
                            ChoiceStack(Modifier.padding(vertical = 8.dp)) {
                                InkButton(
                                    label = plan.publish_label,
                                    testTag = "money-import-publish",
                                    modifier = gutter,
                                ) { onEvent(MoneyImportEvent(publish = MoneyImportEvent.Publish())) }
                                MoneyNote(plan.publish_note)
                                if (plan.discard_label.isNotEmpty()) {
                                    OutlineButton(
                                        label = plan.discard_label,
                                        testTag = "money-import-discard",
                                        modifier = gutter,
                                    ) { onEvent(MoneyImportEvent(discard = MoneyImportEvent.Discard())) }
                                }
                            }
                        } else if (plan.discard_label.isNotEmpty()) {
                            OutlineButton(
                                label = plan.discard_label,
                                testTag = "money-import-discard",
                                modifier = gutter,
                            ) { onEvent(MoneyImportEvent(discard = MoneyImportEvent.Discard())) }
                        }
                        if (plan.done_label.isNotEmpty()) {
                            InkButton(
                                label = plan.done_label,
                                testTag = "money-import-done",
                                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                            ) { onEvent(MoneyImportEvent(done = MoneyImportEvent.Done())) }
                        }
                    }
                }
            }
        }
    }
    if (state.sheet == MoneyImportState.Sheet.SHEET_ACCOUNT) {
        val plan = state.data_
        OptionSheet(
            title = plan?.account_sheet_title.orEmpty(),
            options = plan?.account_options.orEmpty().map { SheetOption(key = it.key, label = it.label, detail = it.detail, selected = it.selected) },
            onPick = { key -> onEvent(MoneyImportEvent(account_picked = MoneyImportEvent.AccountPicked(account_id = key))) },
            onDismiss = { onEvent(MoneyImportEvent(sheet_closed = MoneyImportEvent.SheetClosed())) },
        )
    }
}

// ---------------------------------------------------------------------------
// money.accounts
// ---------------------------------------------------------------------------

@Composable
internal fun MoneyAccountsScreen(state: MoneyAccountsState, onEvent: (MoneyAccountsEvent) -> Unit, onBack: () -> Unit) {
    val chrome = state.chrome
    val data = state.data_
    PushedPage(
        title = chrome?.title.orEmpty(),
        parentTitle = chrome?.back_label.orEmpty(),
        onBack = onBack,
        trailing = data?.add_label?.takeIf { it.isNotEmpty() }?.let { label ->
            RoomAction("Plus", label, "money-account-add") { onEvent(MoneyAccountsEvent(add = MoneyAccountsEvent.AddTapped())) }
        },
        status = state.status?.sentence.orEmpty().ifEmpty { refusal(state.write) },
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, data, state.denied),
            onRetry = { onEvent(MoneyAccountsEvent(refreshed = MoneyAccountsEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
        ) { accounts ->
            val empty = accounts.empty
            if (empty != null) {
                EmptyStateView(empty, onAction = { onEvent(MoneyAccountsEvent(add = MoneyAccountsEvent.AddTapped())) })
            } else {
                LazyColumn {
                    if (accounts.net_worth.isNotEmpty()) {
                        item(key = "worth") {
                            MoneySection(accounts.net_worth_label)
                            accounts.net_worth.forEach { MoneyFigureRow(it) }
                            MoneyNote(accounts.net_worth_note)
                        }
                    }
                    accounts.sections.forEach { section ->
                        item(key = "section-${section.title}") { MoneySection(section.title) }
                        items(section.rows, key = { "a-${it.account_id}" }) { row ->
                            CentraidRow(
                                title = row.name,
                                meta = listOf(row.meta, row.checkpoint_line).filter { it.isNotEmpty() }.joinToString(" · "),
                                trailing = if (row.has_balance) money(row.balance) else row.balance_note,
                                a11y = spoken(row.accessibility_label, if (row.has_balance) row.balance else null),
                                testTag = "money-account-${row.account_id}",
                                onTap = { onEvent(MoneyAccountsEvent(account = MoneyAccountsEvent.AccountPicked(account_id = row.account_id))) },
                            )
                            if (row.has_delta) {
                                MoneyFigureRow(
                                    centraid.screen.v1.MoneyFigure(
                                        label = row.checkpoint_line,
                                        amount = row.delta,
                                        tone = row.checkpoint_tone,
                                    ),
                                )
                            }
                        }
                    }
                    items(accounts.definitions.size, key = { "def-$it" }) { index ->
                        FieldRow(key = accounts.definitions[index].label, value = accounts.definitions[index].detail)
                    }
                }
            }
        }
    }
    val editor = state.editor
    if (editor != null && state.sheet == MoneyAccountsState.Sheet.SHEET_EDITOR) {
        SheetRoom(
            title = editor.title,
            onDismiss = { onEvent(MoneyAccountsEvent(sheet_closed = MoneyAccountsEvent.SheetClosed())) },
            primary = SheetPrimary(label = editor.save_label, enabled = editor.can_save, testTag = "money-account-save") {
                onEvent(MoneyAccountsEvent(save = MoneyAccountsEvent.Save()))
            },
            status = state.status?.takeIf { it.refused }?.sentence.orEmpty(),
            expanded = true,
        ) {
            val reload = editor.account_id.ifEmpty { "new" }
            EditableFieldRow(
                key = editor.name_label,
                value = editor.name,
                reload = reload,
                testTag = "money-account-name",
                onEdit = { onEvent(MoneyAccountsEvent(name = MoneyAccountsEvent.NameEdited(text = it))) },
            )
            MoneyHeading(editor.kind_label)
            Row(Modifier.padding(horizontal = KitGeometry.GUTTER)) {
                editor.kind_options.forEach { option ->
                    KitChip(
                        label = option.label,
                        selected = option.selected,
                        modifier = Modifier.padding(end = 8.dp),
                        onClick = { onEvent(MoneyAccountsEvent(kind_picked = MoneyAccountsEvent.KindPicked(kind = option.key))) },
                    )
                }
            }
            if (editor.currency_label.isNotEmpty()) {
                EditableFieldRow(
                    key = editor.currency_label,
                    value = editor.currency,
                    reload = reload,
                    testTag = "money-account-currency",
                    onEdit = { onEvent(MoneyAccountsEvent(currency = MoneyAccountsEvent.CurrencyEdited(text = it))) },
                )
            }
            EditableFieldRow(
                key = editor.external_ref_label,
                value = editor.external_ref,
                reload = reload,
                testTag = "money-account-number",
                onEdit = { onEvent(MoneyAccountsEvent(external_ref = MoneyAccountsEvent.ExternalRefEdited(text = it))) },
            )
            MoneyNote(editor.external_ref_note)
            if (editor.remove_number_label.isNotEmpty()) {
                OutlineButton(
                    label = editor.remove_number_label,
                    ink = "net",
                    enabled = editor.can_remove_number,
                    testTag = "money-account-remove-number",
                    modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp),
                ) { onEvent(MoneyAccountsEvent(remove_number = MoneyAccountsEvent.RemoveNumberTapped())) }
            }
            MoneyToggleRow(editor.on_budget_label, editor.on_budget, "money-account-budget") {
                onEvent(MoneyAccountsEvent(on_budget = MoneyAccountsEvent.OnBudgetToggled()))
            }
            if (editor.closed_label.isNotEmpty()) {
                MoneyToggleRow(editor.closed_label, editor.closed, "money-account-closed") {
                    onEvent(MoneyAccountsEvent(closed = MoneyAccountsEvent.ClosedToggled()))
                }
            }
            MoneyNote(editor.issue, ink = "net")
        }
    }
    state.confirm?.let { confirm ->
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(MoneyAccountsEvent(confirm_accepted = MoneyAccountsEvent.ConfirmAccepted())) },
            onDismiss = { onEvent(MoneyAccountsEvent(confirm_dismissed = MoneyAccountsEvent.ConfirmDismissed())) },
        )
    }
}

// ---------------------------------------------------------------------------
// money.rules
// ---------------------------------------------------------------------------

@Composable
internal fun MoneyRulesScreen(state: MoneyRulesState, onEvent: (MoneyRulesEvent) -> Unit, onBack: () -> Unit) {
    val chrome = state.chrome
    val data = state.data_
    PushedPage(
        title = chrome?.title.orEmpty(),
        parentTitle = chrome?.back_label.orEmpty(),
        onBack = onBack,
        trailing = data?.add_label?.takeIf { it.isNotEmpty() }?.let { label ->
            RoomAction("Plus", label, "money-rule-add") { onEvent(MoneyRulesEvent(add = MoneyRulesEvent.AddTapped())) }
        },
        status = state.status?.sentence.orEmpty().ifEmpty { refusal(state.write) },
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, data, state.denied),
            onRetry = { onEvent(MoneyRulesEvent(refreshed = MoneyRulesEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
        ) { rules ->
            val empty = rules.empty
            if (empty != null) {
                EmptyStateView(empty, onAction = { onEvent(MoneyRulesEvent(add = MoneyRulesEvent.AddTapped())) })
            } else {
                LazyColumn {
                    item(key = "limit") { MoneyNote(rules.limit_line) }
                    items(rules.rows, key = { "r-${it.rule_id}" }) { row ->
                        CentraidRow(
                            title = row.title,
                            meta = row.meta,
                            a11y = row.accessibility_label,
                            testTag = "money-rule-${row.rule_id}",
                            onTap = { onEvent(MoneyRulesEvent(rule = MoneyRulesEvent.RulePicked(rule_id = row.rule_id))) },
                        )
                    }
                    if (rules.apply_label.isNotEmpty()) {
                        item(key = "apply") {
                            OutlineButton(
                                label = rules.apply_label,
                                testTag = "money-rules-apply",
                                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
                            ) { onEvent(MoneyRulesEvent(apply = MoneyRulesEvent.ApplyTapped())) }
                        }
                    }
                }
            }
        }
    }
    val editor = state.editor
    if (editor != null && state.sheet != MoneyRulesState.Sheet.SHEET_NONE) {
        if (state.sheet == MoneyRulesState.Sheet.SHEET_CATEGORY) {
            OptionSheet(
                title = data?.category_sheet_title.orEmpty(),
                options = data?.category_options.orEmpty().map { SheetOption(key = it.key, label = it.label, detail = it.detail, selected = it.selected) },
                onPick = { key -> onEvent(MoneyRulesEvent(category = MoneyRulesEvent.CategoryPicked(category_id = key))) },
                onDismiss = { onEvent(MoneyRulesEvent(sheet_closed = MoneyRulesEvent.SheetClosed())) },
            )
        } else if (state.sheet == MoneyRulesState.Sheet.SHEET_ACCOUNT) {
            OptionSheet(
                title = data?.account_sheet_title.orEmpty(),
                options = data?.account_options.orEmpty().map { SheetOption(key = it.key, label = it.label, detail = it.detail, selected = it.selected) },
                onPick = { key -> onEvent(MoneyRulesEvent(account = MoneyRulesEvent.AccountPicked(account_id = key))) },
                onDismiss = { onEvent(MoneyRulesEvent(sheet_closed = MoneyRulesEvent.SheetClosed())) },
            )
        } else {
            SheetRoom(
                title = editor.title,
                onDismiss = { onEvent(MoneyRulesEvent(sheet_closed = MoneyRulesEvent.SheetClosed())) },
                primary = SheetPrimary(label = editor.save_label, enabled = editor.can_save, testTag = "money-rule-save") {
                    onEvent(MoneyRulesEvent(save = MoneyRulesEvent.Save()))
                },
                status = state.status?.takeIf { it.refused }?.sentence.orEmpty(),
                expanded = true,
            ) {
                MoneyHeading(editor.kind_label)
                Row(Modifier.padding(horizontal = KitGeometry.GUTTER)) {
                    editor.kind_options.forEach { option ->
                        KitChip(
                            label = option.label,
                            selected = option.selected,
                            modifier = Modifier.padding(end = 8.dp),
                            onClick = { onEvent(MoneyRulesEvent(kind_picked = MoneyRulesEvent.KindPicked(kind = option.key))) },
                        )
                    }
                }
                val reload = editor.rule_id.ifEmpty { "new" }
                EditableFieldRow(
                    key = editor.pattern_label,
                    value = editor.pattern,
                    reload = reload,
                    testTag = "money-rule-pattern",
                    onEdit = { onEvent(MoneyRulesEvent(pattern = MoneyRulesEvent.PatternEdited(text = it))) },
                )
                MoneyNote(editor.pattern_note)
                ChoiceFieldRow(
                    key = editor.category_row_label,
                    value = editor.category_label.ifEmpty { editor.clear_category_label },
                    testTag = "money-rule-category",
                    onTap = { onEvent(MoneyRulesEvent(category_sheet = MoneyRulesEvent.CategorySheetOpened())) },
                )
                EditableFieldRow(
                    key = editor.name_label,
                    value = editor.display_name,
                    reload = reload,
                    testTag = "money-rule-name",
                    onEdit = { onEvent(MoneyRulesEvent(name = MoneyRulesEvent.NameEdited(text = it))) },
                )
                ChoiceFieldRow(
                    key = editor.account_row_label,
                    value = editor.account_label.ifEmpty { editor.clear_account_label },
                    testTag = "money-rule-account",
                    onTap = { onEvent(MoneyRulesEvent(account_sheet = MoneyRulesEvent.AccountSheetOpened())) },
                )
                if (editor.limits_enabled) {
                    EditableFieldRow(
                        key = editor.amount_min_label,
                        value = editor.amount_min_text,
                        reload = reload,
                        testTag = "money-rule-amount-min",
                        onEdit = { onEvent(MoneyRulesEvent(amount_min = MoneyRulesEvent.AmountMinEdited(text = it))) },
                    )
                    EditableFieldRow(
                        key = editor.amount_max_label,
                        value = editor.amount_max_text,
                        reload = reload,
                        testTag = "money-rule-amount-max",
                        onEdit = { onEvent(MoneyRulesEvent(amount_max = MoneyRulesEvent.AmountMaxEdited(text = it))) },
                    )
                }
                MoneyNote(editor.amount_note)
                MoneyNote(editor.issue, ink = "net")
                // APPLY AND DELETE ARE ALTERNATIVES: one stack.
                if (editor.apply_label.isNotEmpty() || editor.delete_label.isNotEmpty()) {
                    val gutter = Modifier.padding(horizontal = KitGeometry.GUTTER)
                    ChoiceStack(Modifier.padding(vertical = 4.dp)) {
                        if (editor.apply_label.isNotEmpty()) {
                            OutlineButton(
                                label = editor.apply_label,
                                testTag = "money-rule-apply",
                                modifier = gutter,
                            ) { onEvent(MoneyRulesEvent(apply = MoneyRulesEvent.ApplyTapped())) }
                        }
                        if (editor.delete_label.isNotEmpty()) {
                            OutlineButton(
                                label = editor.delete_label,
                                ink = "net",
                                testTag = "money-rule-delete",
                                modifier = gutter,
                            ) { onEvent(MoneyRulesEvent(delete = MoneyRulesEvent.DeleteTapped())) }
                        }
                    }
                }
            }
        }
    }
    state.confirm?.let { confirm ->
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(MoneyRulesEvent(confirm_accepted = MoneyRulesEvent.ConfirmAccepted())) },
            onDismiss = { onEvent(MoneyRulesEvent(confirm_dismissed = MoneyRulesEvent.ConfirmDismissed())) },
        )
    }
}

// ---------------------------------------------------------------------------
// money.categories
// ---------------------------------------------------------------------------

@Composable
internal fun MoneyCategoriesScreen(state: MoneyCategoriesState, onEvent: (MoneyCategoriesEvent) -> Unit, onBack: () -> Unit) {
    val chrome = state.chrome
    val data = state.data_
    PushedPage(
        title = chrome?.title.orEmpty(),
        parentTitle = chrome?.back_label.orEmpty(),
        onBack = onBack,
        trailing = data?.add_label?.takeIf { it.isNotEmpty() }?.let { label ->
            RoomAction("Plus", label, "money-category-add") { onEvent(MoneyCategoriesEvent(add = MoneyCategoriesEvent.AddTapped())) }
        },
        status = state.status?.sentence.orEmpty().ifEmpty { refusal(state.write) },
    ) {
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, data, state.denied),
            onRetry = { onEvent(MoneyCategoriesEvent(refreshed = MoneyCategoriesEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty().ifEmpty { KitWords.RETRY },
        ) { categories ->
            val empty = categories.empty
            if (empty != null) {
                EmptyStateView(empty, onAction = null)
            } else {
                LazyColumn {
                    categories.groups.forEach { group ->
                        item(key = "g-${group.group_id}") { MoneySection(group.label) }
                        items(group.rows, key = { "c-${it.category_id}" }) { row ->
                            CentraidRow(
                                title = row.label,
                                meta = row.meta,
                                dimmed = row.archived,
                                a11y = row.accessibility_label,
                                testTag = "money-category-row-${row.category_id}",
                                onTap = { onEvent(MoneyCategoriesEvent(category = MoneyCategoriesEvent.CategoryPicked(category_id = row.category_id))) },
                            )
                        }
                    }
                }
            }
        }
    }
    val categories = state.data_
    val close = { onEvent(MoneyCategoriesEvent(sheet_closed = MoneyCategoriesEvent.SheetClosed())) }
    when (state.sheet) {
        MoneyCategoriesState.Sheet.SHEET_ADD -> if (categories != null) {
            SheetRoom(
                title = categories.add_title,
                onDismiss = close,
                primary = SheetPrimary(label = categories.save_label, enabled = categories.can_save, testTag = "money-category-save") {
                    onEvent(MoneyCategoriesEvent(save = MoneyCategoriesEvent.Save()))
                },
            ) {
                EditableFieldRow(
                    key = categories.name_label,
                    value = state.name_draft,
                    reload = "add",
                    testTag = "money-category-name",
                    onEdit = { onEvent(MoneyCategoriesEvent(name = MoneyCategoriesEvent.NameEdited(text = it))) },
                )
                MoneyNote(categories.issue, ink = "net")
                MoneyHeading(categories.group_label)
                categories.group_options.forEach { option ->
                    CentraidRow(
                        title = option.label,
                        trailing = if (option.selected) "✓" else "",
                        testTag = "money-category-group-${option.key}",
                        onTap = { onEvent(MoneyCategoriesEvent(group = MoneyCategoriesEvent.GroupPicked(group_id = option.key))) },
                    )
                }
            }
        }
        MoneyCategoriesState.Sheet.SHEET_ROW -> if (categories != null) {
            OptionSheet(
                title = categories.row_title,
                options = categories.row_actions.filter { it.enabled }.map { SheetOption(key = it.key, label = it.label, iconKey = it.icon_key) },
                onPick = { key -> onEvent(MoneyCategoriesEvent(row_action = MoneyCategoriesEvent.RowActionPicked(key = key))) },
                onDismiss = close,
            )
        }
        MoneyCategoriesState.Sheet.SHEET_MERGE -> if (categories != null) {
            OptionSheet(
                title = categories.merge_title,
                options = categories.merge_options.map { SheetOption(key = it.key, label = it.label, detail = it.detail) },
                onPick = { key -> onEvent(MoneyCategoriesEvent(merge_into = MoneyCategoriesEvent.MergeIntoPicked(category_id = key))) },
                onDismiss = close,
            )
        }
        else -> Unit
    }
    state.confirm?.let { confirm ->
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(MoneyCategoriesEvent(confirm_accepted = MoneyCategoriesEvent.ConfirmAccepted())) },
            onDismiss = { onEvent(MoneyCategoriesEvent(confirm_dismissed = MoneyCategoriesEvent.ConfirmDismissed())) },
        )
    }
}
