package dev.centraid.android.screens.people

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import centraid.core.v1.PeopleHeroAction
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.kitCard
import dev.centraid.android.theme.centraidDark
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import centraid.core.v1.PeopleKindChoice
import centraid.core.v1.PeoplePersonData
import centraid.core.v1.PeoplePersonEvent
import centraid.core.v1.PeoplePersonSheet
import centraid.core.v1.PeoplePersonState
import centraid.core.v1.PhoneSaysTaken
import centraid.core.v1.PeopleSheetFrame
import centraid.core.v1.Route
import centraid.core.v1.StatusChip
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.FailureView
import dev.centraid.android.kit.FieldRow
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.EarlierEntryCard
import dev.centraid.android.kit.PhoneSaysLine
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RoomAction
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.ScreenContent
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.kit.StatusChipView
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

private typealias Which = PeoplePersonEvent.SheetOpened.Which

/**
 * `people.person` (#1135): a `PushedPage` back to People. Facts, channels, dates,
 * notes and the touch log, each section's verb opening its write sheet; the
 * confirm is Rust's `Confirm`. A channel's tap is an event: Rust asks this shell
 * to call, mail, map or copy it (`OpenUrl`, `OpenMap`, `ClipboardSet`). Edit is
 * the [Route] Rust built; `done` is the host's pop.
 */
@Composable
public fun PeoplePersonScreen(
    state: PeoplePersonState,
    onEvent: (PeoplePersonEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onBack: () -> Unit,
    onPhoneSays: (PhoneSaysTaken) -> Unit,
) {
    val chrome = state.chrome
    val data = state.data_
    fun open(which: Which) = onEvent(PeoplePersonEvent(sheet_opened = PeoplePersonEvent.SheetOpened(which = which)))
    PushedPage(
        title = data?.name ?: state.name_hint,
        parentTitle = chrome?.back.orEmpty(),
        onBack = onBack,
        trailing = state.edit?.takeIf { data != null && !chrome?.edit.isNullOrEmpty() }?.let { route ->
            RoomAction("Pencil", chrome?.edit.orEmpty(), "people-person-edit") { onOpen(route) }
        },
        status = state.status?.sentence.orEmpty(),
    ) {
        val gone = state.gone
        if (gone != null) {
            EmptyStateView(gone, onAction = null)
        } else {
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, data, state.denied),
                onRetry = { onEvent(PeoplePersonEvent(refreshed = PeoplePersonEvent.Refreshed())) },
                retryLabel = chrome?.retry.orEmpty(),
                skeleton = { RowSkeleton(label = chrome?.loading.orEmpty()) },
            ) { person -> PersonBody(person, state, onEvent, onOpen, onPhoneSays, ::open) }
        }
    }

    state.sheet?.let { sheet -> PersonSheet(sheet, onEvent) }
    state.confirm?.let { confirm ->
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(PeoplePersonEvent(confirmed = PeoplePersonEvent.Confirmed())) },
            onDismiss = { onEvent(PeoplePersonEvent(dismissed = PeoplePersonEvent.Dismissed())) },
        )
    }
}

@Composable
private fun PersonBody(
    person: PeoplePersonData,
    state: PeoplePersonState,
    onEvent: (PeoplePersonEvent) -> Unit,
    onOpen: (Route) -> Unit,
    onPhoneSays: (PhoneSaysTaken) -> Unit,
    open: (Which) -> Unit,
) {
    val chrome = state.chrome
    LazyColumn(Modifier.testTag("people-person")) {
        item(key = "hero") { Hero(person, onPhoneSays) }
        if (person.hero.isNotEmpty()) {
            item(key = "hero-actions") {
                HeroActions(person.hero) { key ->
                    onEvent(PeoplePersonEvent(hero = PeoplePersonEvent.HeroTapped(key)))
                }
            }
        }
        items(person.facts, key = { "f-" + it.label }) { fact -> FieldRow(fact.label, fact.value_) }
        person.nickname_phone_says?.let { line ->
            item(key = "nickname-phone-says") { PhoneSaysLine(line, onPhoneSays, Modifier.padding(horizontal = KitGeometry.GUTTER)) }
        }

        person.channels_head?.let { head ->
            item(key = "channels-head") { SectionHeader(head.toKit()) { open(Which.WHICH_CHANNEL) } }
        }
        if (person.channels.isEmpty() && person.channels_empty.isNotEmpty()) {
            item(key = "channels-empty") { RailEmpty(person.channels_empty) }
        }
        items(person.channels, key = { "c-" + it.channel_id }) { channel ->
            CentraidRow(
                title = channel.value_,
                meta = listOf(channel.kind_label, channel.label, channel.preferred_label, channel.duplicate_note)
                    .filter { it.isNotEmpty() }
                    .joinToString(" · "),
                a11y = channel.accessibility_label,
                testTag = "people-channel-${channel.channel_id}",
                onTap = { onEvent(PeoplePersonEvent(channel = PeoplePersonEvent.ChannelTapped(channel.channel_id))) },
            ) {
                if (channel.action_label.isNotEmpty()) {
                    OutlineButton(
                        channel.action_label,
                        testTag = "people-channel-act-${channel.channel_id}",
                        modifier = Modifier.padding(start = 8.dp),
                    ) { onEvent(PeoplePersonEvent(channel = PeoplePersonEvent.ChannelTapped(channel.channel_id))) }
                }
                if (channel.remove_label.isNotEmpty()) {
                    OutlineButton(
                        channel.remove_label,
                        testTag = "people-channel-remove-${channel.channel_id}",
                        ink = "net",
                        modifier = Modifier.padding(start = 8.dp),
                    ) {
                        onEvent(PeoplePersonEvent(remove_channel = PeoplePersonEvent.RemoveChannelTapped(channel.channel_id)))
                    }
                }
            }
        }

        if (person.channels_phone_says.isNotEmpty()) {
            item(key = "channels-phone-says") {
                Column(Modifier.padding(horizontal = KitGeometry.GUTTER)) {
                    person.channels_phone_says.forEach { PhoneSaysLine(it, onPhoneSays) }
                }
            }
        }

        person.dates_head?.let { head -> item(key = "dates-head") { SectionHeader(head.toKit()) { open(Which.WHICH_DATE) } } }
        if (person.dates.isEmpty() && person.dates_empty.isNotEmpty()) {
            item(key = "dates-empty") { RailEmpty(person.dates_empty) }
        }
        items(person.dates, key = { "d-" + it.date_id }) { date ->
            CentraidRow(
                title = date.label,
                meta = listOf(date.day_label, date.reminder_label).filter { it.isNotEmpty() }.joinToString(" · "),
                trailing = date.when_label,
                a11y = date.accessibility_label,
                testTag = "people-date-${date.date_id}",
            ) {
                if (date.toggleable && date.toggle_label.isNotEmpty()) {
                    OutlineButton(
                        date.toggle_label,
                        testTag = "people-reminder-${date.date_id}",
                        modifier = Modifier.padding(start = 8.dp),
                    ) { onEvent(PeoplePersonEvent(reminder = PeoplePersonEvent.ReminderToggled(date.date_id))) }
                }
            }
        }

        person.birthday_phone_says?.let { line ->
            item(key = "birthday-phone-says") { PhoneSaysLine(line, onPhoneSays, Modifier.padding(horizontal = KitGeometry.GUTTER)) }
        }

        if (person.relations.isNotEmpty()) {
            person.relations_head?.let { head -> item(key = "relations-head") { SectionHeader(head.toKit()) } }
            items(person.relations, key = { "r-" + it.party_id + it.meta }) { relation ->
                CentraidRow(
                    title = relation.name,
                    meta = relation.meta,
                    a11y = relation.accessibility_label,
                    testTag = "people-relation-${relation.party_id}",
                )
            }
        }

        if (person.vault.isNotEmpty()) {
            item(key = "vault") { VaultCard(person, onOpen) }
        }

        person.notes_head?.let { head -> item(key = "notes-head") { SectionHeader(head.toKit()) { open(Which.WHICH_NOTE) } } }
        if (person.notes.isEmpty() && person.notes_empty.isNotEmpty()) {
            item(key = "notes-empty") { RailEmpty(person.notes_empty) }
        }
        items(person.notes, key = { "n-" + it.annotation_id }) { note ->
            CentraidRow(title = note.text, meta = note.when_label, testTag = "people-note-${note.annotation_id}")
        }

        person.touches_head?.takeIf { !person.is_me }?.let { head ->
            item(key = "touches-head") { SectionHeader(head.toKit()) { open(Which.WHICH_LOG_TOUCH) } }
        }
        if (!person.is_me && person.touches.isEmpty() && person.touches_empty.isNotEmpty()) {
            item(key = "touches-empty") { RailEmpty(person.touches_empty) }
        }
        items(if (person.is_me) emptyList() else person.touches, key = { "t-" + it.interaction_id }) { touch ->
            CentraidRow(
                title = listOf(touch.kind_label, touch.text).filter { it.isNotEmpty() }.joinToString(" · "),
                meta = touch.when_label,
                a11y = touch.accessibility_label,
                testTag = "people-touch-${touch.interaction_id}",
            )
        }

        // EVERY RECORD KEEPS ITS EARLIER VALUES (#1185): the entry at the foot, when Rust has one.
        state.earlier?.let { entry -> item(key = "earlier") { EarlierEntryCard(entry, onOpen) } }

        if (chrome != null && !person.is_me) {
            item(key = "foot") {
                Column(Modifier.padding(top = 16.dp, bottom = 24.dp)) {
                    SheetRow(
                        person.star_label,
                        iconKey = "Star",
                        selected = person.starred,
                        testTag = "people-person-star",
                        onTap = { onEvent(PeoplePersonEvent(star = PeoplePersonEvent.StarToggled())) },
                    )
                    SheetRow(chrome.merge, iconKey = "dupe", testTag = "people-person-merge", onTap = { open(Which.WHICH_MERGE) })
                    SheetRow(
                        chrome.move_to_trash,
                        iconKey = "Trash",
                        destructive = true,
                        testTag = "people-person-trash",
                        onTap = { onEvent(PeoplePersonEvent(trash_tapped = PeoplePersonEvent.TrashTapped())) },
                    )
                }
            }
        }
    }
}

/** THE HERO: a centred avatar, the name, the role and the cadence line; the owner's own card says "My card". */
@Composable
private fun Hero(person: PeoplePersonData, onPhoneSays: (PhoneSaysTaken) -> Unit) {
    val accent = appAccent("people")
    Column(
        Modifier
            .fillMaxWidth()
            .background(
                Brush.verticalGradient(listOf(accent.wash(centraidDark()), Color.Transparent)),
            )
            .padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Avatar(person.avatar, size = 96)
        KitText(
            person.name,
            KitType.Hero,
            Surface.ink,
            modifier = Modifier.padding(top = 10.dp).semantics { heading() },
        )
        PhoneSaysLine(person.name_phone_says, onPhoneSays, centered = true)
        if (person.role.isNotEmpty()) KitText(person.role, KitType.Row, Surface.body)
        PhoneSaysLine(person.role_phone_says, onPhoneSays, centered = true)
        val line = if (person.is_me) person.my_card_label else person.cadence_line
        if (line.isNotEmpty()) KitText(line, KitType.Meta, Surface.meta, modifier = Modifier.padding(top = 4.dp))
        person.due_chip?.let { chip ->
            Box(Modifier.padding(top = 6.dp)) {
                StatusChipView(
                    StatusChip(label = chip.label, tone = StatusChip.Tone.fromValue(chip.tone.value) ?: StatusChip.Tone.TONE_UNSPECIFIED),
                )
            }
        }
    }
}

/**
 * MESSAGE, CALL, MAIL, LOG TOUCH: round keys over their small lower-case words. Rust sent only the
 * ones the person's data allows; Log a touch is the one filled in the app's colour.
 */
@Composable
private fun HeroActions(actions: List<PeopleHeroAction>, onTap: (String) -> Unit) {
    val accent = appAccent("people")
    Row(
        Modifier.fillMaxWidth().padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp, Alignment.CenterHorizontally),
    ) {
        actions.forEach { action ->
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Box(
                    Modifier
                        .size(52.dp)
                        .clip(CircleShape)
                        .background(if (action.primary) accent.fill else Surface.card)
                        .then(if (action.primary) Modifier else Modifier.border(KitGeometry.HAIRLINE, Surface.border, CircleShape))
                        .clickable { onTap(action.key) }
                        .testTag("people-person-hero-${action.key}")
                        .clearAndSetSemantics {
                            contentDescription = action.accessibility_label
                            role = Role.Button
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    CentraidIcon(iconKey = action.icon_key, tint = if (action.primary) Color.White else Surface.ink, size = 20.dp)
                }
                KitText(action.label, KitType.Meta, Surface.body, modifier = Modifier.padding(top = 4.dp).clearAndSetSemantics { })
            }
        }
    }
}

/** IN YOUR VAULT: what else is about this person, each kind word in its own app's colour. */
@Composable
private fun VaultCard(person: PeoplePersonData, onOpen: (Route) -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 10.dp)
            .kitCard()
            .padding(bottom = 8.dp)
            .testTag("people-vault"),
    ) {
        KitText(
            person.vault_head?.title.orEmpty(),
            KitType.Meta,
            Surface.meta,
            modifier = Modifier.padding(start = 14.dp, end = 14.dp, top = 10.dp, bottom = 4.dp).semantics { heading() },
        )
        person.vault.forEach { row ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .clickable { row.route?.let(onOpen) }
                    .padding(horizontal = 14.dp, vertical = 6.dp)
                    .testTag("people-vault-${row.id}")
                    .clearAndSetSemantics {
                        contentDescription = row.accessibility_label
                        role = Role.Button
                    },
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                KitText(row.kind_label, KitType.Row, appAccent(row.app_key).text)
                KitText(
                    listOf(row.title, row.when_label).filter { it.isNotEmpty() }.joinToString(" · "),
                    KitType.Row,
                    Surface.ink,
                    modifier = Modifier.weight(1f),
                )
            }
        }
        if (person.vault_more.isNotEmpty()) {
            KitText(person.vault_more, KitType.Meta, Surface.meta, modifier = Modifier.padding(start = 14.dp, top = 2.dp))
        }
    }
}

/** The four write sheets and the merge choices: each one a `SheetRoom` over its frame. */
@Composable
private fun PersonSheet(sheet: PeoplePersonSheet, onEvent: (PeoplePersonEvent) -> Unit) {
    val close = { onEvent(PeoplePersonEvent(sheet_closed = PeoplePersonEvent.SheetClosed())) }
    val text = { value: String -> onEvent(PeoplePersonEvent(text = PeoplePersonEvent.TextChanged(value))) }
    val second = { value: String -> onEvent(PeoplePersonEvent(second_text = PeoplePersonEvent.SecondTextChanged(value))) }
    val flag = { onEvent(PeoplePersonEvent(flag = PeoplePersonEvent.FlagToggled())) }
    val kind = { key: String -> onEvent(PeoplePersonEvent(kind_picked = PeoplePersonEvent.KindPicked(key))) }
    sheet.log_touch?.let { s ->
        FramedSheet(s.frame, onEvent) {
            Kinds(s.kinds, kind)
            // THE SHEET'S IDENTITY is the reload: a fresh sheet takes Rust's words once.
            EditableFieldRow(
                key = s.note_label,
                value = s.note,
                reload = s.frame?.title,
                placeholder = s.note_placeholder,
                singleLine = false,
                testTag = "people-sheet-note",
                onEdit = text,
            )
            if (s.hint.isNotEmpty()) RailEmpty(s.hint)
        }
    }
    sheet.note?.let { s ->
        FramedSheet(s.frame, onEvent) {
            EditableFieldRow(
                key = "",
                value = s.text,
                reload = s.frame?.title,
                placeholder = s.placeholder,
                singleLine = false,
                testTag = "people-sheet-text",
                onEdit = text,
            )
        }
    }
    sheet.date?.let { s ->
        FramedSheet(s.frame, onEvent) {
            EditableFieldRow(
                key = s.label_field,
                value = s.label,
                reload = s.frame?.title,
                testTag = "people-sheet-date-label",
                onEdit = text,
            )
            EditableFieldRow(
                key = s.month_day_field,
                value = s.month_day,
                reload = s.frame?.title,
                placeholder = s.month_day_placeholder,
                testTag = "people-sheet-month-day",
                onEdit = second,
            )
            if (s.month_day_invalid.isNotEmpty()) {
                Text(
                    s.month_day_invalid,
                    style = centraidType("annotLabel"),
                    color = centraidColor("net"),
                    modifier = Modifier.padding(horizontal = KitGeometry.GUTTER),
                )
            }
            SheetRow(s.reminder_label, selected = s.reminder_on, testTag = "people-sheet-reminder", onTap = flag)
        }
    }
    sheet.channel?.let { s ->
        FramedSheet(s.frame, onEvent) {
            Kinds(s.kinds, kind)
            EditableFieldRow(
                key = s.value_field,
                value = s.value_,
                reload = s.frame?.title,
                testTag = "people-sheet-channel-value",
                onEdit = text,
            )
            EditableFieldRow(
                key = s.label_field,
                value = s.label,
                reload = s.frame?.title,
                testTag = "people-sheet-channel-label",
                onEdit = second,
            )
            SheetRow(s.preferred_label, selected = s.preferred, testTag = "people-sheet-preferred", onTap = flag)
        }
    }
    sheet.merge?.let { s ->
        SheetRoom(title = s.title, onDismiss = close) {
            if (s.body.isNotEmpty()) RailEmpty(s.body)
            when (val content = screenContentOf(s.loading, s.failure, s.choices)) {
                is ScreenContent.Loading -> RowSkeleton(rows = 3)
                is ScreenContent.Failure -> FailureView(content.sentence, content.remedy, onRetry = null)
                is ScreenContent.Gate -> Unit
                is ScreenContent.Data -> {
                    val empty = content.value.empty
                    if (content.value.choices.isEmpty() && empty != null) {
                        RailEmpty(empty.headline)
                    }
                    content.value.choices.forEach { choice ->
                        CentraidRow(
                            title = choice.name,
                            meta = choice.role,
                            hueKey = choice.avatar?.hue_key.orEmpty(),
                            testTag = "people-merge-${choice.party_id}",
                            onTap = { onEvent(PeoplePersonEvent(merge_picked = PeoplePersonEvent.MergePicked(choice.party_id))) },
                        )
                    }
                }
            }
            SheetRow(s.cancel_label, testTag = "people-merge-cancel", onTap = close)
        }
    }
}

@Composable
private fun FramedSheet(
    frame: PeopleSheetFrame?,
    onEvent: (PeoplePersonEvent) -> Unit,
    content: @Composable () -> Unit,
) {
    val f = frame ?: PeopleSheetFrame()
    SheetRoom(
        title = f.title,
        onDismiss = { onEvent(PeoplePersonEvent(sheet_closed = PeoplePersonEvent.SheetClosed())) },
        status = f.failure?.sentence.orEmpty(),
        // THE ONE INK BUTTON is drawn always, and pressable only while Rust says it can act.
        primary = SheetPrimary(label = f.submit_label, testTag = "people-sheet-submit", enabled = f.submit_enabled) {
            onEvent(PeoplePersonEvent(submitted = PeoplePersonEvent.SheetSubmitted()))
        },
    ) { content() }
}

@Composable
private fun Kinds(kinds: List<PeopleKindChoice>, onPick: (String) -> Unit) {
    kinds.forEach { choice ->
        SheetRow(choice.label, selected = choice.selected, testTag = "people-kind-${choice.key}", onTap = { onPick(choice.key) })
    }
}
