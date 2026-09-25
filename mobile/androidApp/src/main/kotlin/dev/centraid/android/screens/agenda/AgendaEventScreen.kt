package dev.centraid.android.screens.agenda

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import centraid.screen.v1.AgendaEventData
import centraid.screen.v1.AgendaEventEvent
import centraid.screen.v1.AgendaEventState
import centraid.screen.v1.AgendaGone
import centraid.screen.v1.AgendaParkedCard
import centraid.screen.v1.AgendaScopeChoice
import centraid.screen.v1.EmptyState
import centraid.screen.v1.SectionHead
import centraid.screen.v1.WriteState
import dev.centraid.android.kit.CentraidRow
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.FieldRow
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.PushedPage
import dev.centraid.android.kit.QuietButton
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.SectionHeader
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.kit.StatusChipView
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * `agenda.event`: one occurrence, pushed from the list. RSVP is a row of
 * choices; Edit is an intent the route turns into the editor; Cancel asks a
 * confirm (a one-off) or the scope sheet (a series). Gone and parked are
 * cards; every word is the state's. The call link is the shell's: [onCall]
 * hands `call_uri` to whatever app on the phone opens it.
 */
@Composable
internal fun AgendaEventScreen(
    state: AgendaEventState,
    onEvent: (AgendaEventEvent) -> Unit,
    onBack: () -> Unit,
    onCall: (String) -> Unit,
) {
    val chrome = state.chrome
    val write = state.write
    PushedPage(
        title = chrome?.title.orEmpty(),
        parentTitle = chrome?.back.orEmpty(),
        onBack = onBack,
        status = if (write?.phase == WriteState.Phase.PHASE_REFUSED) write.failure?.sentence.orEmpty() else "",
    ) {
        val gone = state.gone
        if (gone != null) {
            GoneCard(gone, onBack)
            return@PushedPage
        }
        Column(Modifier.fillMaxSize()) {
            val parked = state.parked
            if (parked != null) {
                ParkedCard(
                    parked,
                    onRetry = { onEvent(AgendaEventEvent(parked_retried = AgendaEventEvent.ParkedRetried())) },
                    onDismiss = { onEvent(AgendaEventEvent(parked_dismissed = AgendaEventEvent.ParkedDismissed())) },
                )
            }
            ReadStateView(
                content = screenContentOf(state.loading, state.failure, state.data_, state.denied),
                onRetry = { onEvent(AgendaEventEvent(refreshed = AgendaEventEvent.Refreshed())) },
                retryLabel = chrome?.retry?.ifEmpty { null } ?: KitWords.RETRY,
                skeleton = { RowSkeleton(rows = 5, label = chrome?.loading?.ifEmpty { null } ?: KitWords.OPENING) },
                modifier = Modifier.weight(1f),
            ) { data -> EventBody(data, onEvent, onCall) }
        }
    }
    if (state.sheet == AgendaEventState.Sheet.SHEET_CANCEL_SCOPE && chrome != null) {
        ScopeSheet(
            title = chrome.scope_title,
            body = chrome.scope_body,
            scopes = state.cancel_scopes,
            commit = if (state.cancel_armed) chrome.scope_commit else "",
            destructive = true,
            keep = chrome.scope_keep,
            onPick = { onEvent(AgendaEventEvent(scope = AgendaEventEvent.ScopePicked(scope = it.scope))) },
            onCommit = { onEvent(AgendaEventEvent(confirmed = AgendaEventEvent.Confirmed())) },
            onDismiss = { onEvent(AgendaEventEvent(sheet_closed = AgendaEventEvent.SheetClosed())) },
        )
    }
    val confirm = state.confirm
    if (confirm != null) {
        ConfirmSheet(
            confirm = confirm,
            onConfirm = { onEvent(AgendaEventEvent(confirmed = AgendaEventEvent.Confirmed())) },
            onDismiss = { onEvent(AgendaEventEvent(confirm_dismissed = AgendaEventEvent.ConfirmDismissed())) },
            cancelLabel = chrome?.confirm_keep?.ifEmpty { null } ?: KitWords.CANCEL,
        )
    }
}

@Composable
private fun EventBody(data: AgendaEventData, onEvent: (AgendaEventEvent) -> Unit, onCall: (String) -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).testTag("agenda-event")) {
        Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)) {
            Text(
                data.title,
                style = centraidType("title"),
                color = centraidColor(if (data.is_past) "textSoft" else "text"),
                modifier = Modifier.semantics { heading() },
            )
            if (data.date_label.isNotEmpty()) Text(data.date_label, style = centraidType("body"), color = centraidColor("text"))
            if (data.when_label.isNotEmpty()) Text(data.when_label, style = centraidType("small"), color = centraidColor("textSoft"))
            val chip = data.chip
            if (chip != null) StatusChipView(chip, Modifier.padding(top = 6.dp))
        }
        if (data.calendar_name.isNotEmpty()) {
            CentraidRow(title = data.calendar_name, hueKey = data.calendar_hue_key, testTag = "agenda-event-calendar")
        }
        data.facts.forEach { FieldRow(key = it.label, value = it.detail) }
        if (data.call_uri.isNotEmpty() && data.call_label.isNotEmpty()) {
            QuietButton(
                label = data.call_label,
                testTag = "agenda-event-call",
                ink = "accent",
                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER),
            ) { onCall(data.call_uri) }
        }
        if (data.notes.isNotEmpty()) {
            Text(
                data.notes,
                style = centraidType("body"),
                color = centraidColor("text"),
                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
            )
        }
        val rsvp = data.rsvp
        if (rsvp != null) {
            Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)) {
                Text(rsvp.question, style = centraidType("smallStrong"), color = centraidColor("textSoft"))
                Row(Modifier.padding(top = 8.dp)) {
                    rsvp.choices.forEach { choice ->
                        QuietButton(
                            label = choice.label,
                            testTag = "agenda-rsvp-${choice.partstat}",
                            ink = if (choice.selected) "accent" else if (choice.enabled) "text" else "textFaint",
                            modifier = Modifier.padding(end = 8.dp),
                        ) {
                            if (choice.enabled) onEvent(AgendaEventEvent(rsvp = AgendaEventEvent.RsvpPicked(partstat = choice.partstat)))
                        }
                    }
                }
                if (rsvp.note.isNotEmpty()) {
                    Text(rsvp.note, style = centraidType("annotLabel"), color = centraidColor("textFaint"), modifier = Modifier.padding(top = 4.dp))
                }
            }
        }
        if (data.guests.isNotEmpty()) {
            SectionHeader(SectionHead(title = data.guest_heading))
            data.guests.forEach { guest ->
                CentraidRow(
                    title = guest.name,
                    meta = guest.reply_label,
                    hueKey = guest.hue_key,
                    a11y = guest.accessibility_label,
                    testTag = "agenda-guest-${guest.party_id}",
                )
            }
        }
        Row(Modifier.padding(KitGeometry.GUTTER)) {
            data.actions.forEach { action ->
                QuietButton(
                    label = action.label,
                    testTag = "agenda-action-${action.key}",
                    ink = if (!action.enabled) "textFaint" else if (action.destructive) "net" else "text",
                    modifier = Modifier.padding(end = 8.dp),
                ) {
                    if (action.enabled) onEvent(AgendaEventEvent(action = AgendaEventEvent.ActionPicked(key = action.key)))
                }
            }
        }
    }
}

/** The scope sheet, shared by cancel and save: a scope is chosen, then committed. */
@Composable
internal fun ScopeSheet(
    title: String,
    body: String,
    scopes: List<AgendaScopeChoice>,
    commit: String,
    destructive: Boolean,
    keep: String,
    onPick: (AgendaScopeChoice) -> Unit,
    onCommit: () -> Unit,
    onDismiss: () -> Unit,
) {
    SheetRoom(
        title = title,
        onDismiss = onDismiss,
        primary = if (commit.isNotEmpty()) SheetPrimary(commit, destructive = destructive, onPress = onCommit) else null,
    ) {
        if (body.isNotEmpty()) {
            Text(body, style = centraidType("body"), color = centraidColor("textSoft"), modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp))
        }
        scopes.forEach { scope ->
            if (scope.enabled) {
                SheetRow(
                    label = scope.label,
                    detail = scope.note,
                    selected = scope.selected,
                    testTag = "agenda-scope-${scope.scope.value}",
                    onTap = { onPick(scope) },
                )
            } else {
                CentraidRow(title = scope.label, meta = scope.note, dimmed = true, testTag = "agenda-scope-${scope.scope.value}")
            }
        }
        if (keep.isNotEmpty()) {
            SheetRow(label = keep, testTag = "agenda-scope-keep", onTap = onDismiss)
        }
    }
}

@Composable
internal fun GoneCard(gone: AgendaGone, onAction: () -> Unit) {
    EmptyStateView(EmptyState(headline = gone.title, body = gone.body, action_label = gone.action_label), onAction = onAction)
}

@Composable
private fun ParkedCard(parked: AgendaParkedCard, onRetry: () -> Unit, onDismiss: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(KitGeometry.GUTTER).testTag("agenda-parked")) {
        Text(parked.title, style = centraidType("smallStrong"), color = centraidColor("net"))
        if (parked.body.isNotEmpty()) Text(parked.body, style = centraidType("small"), color = centraidColor("textSoft"))
        Row(Modifier.padding(top = 8.dp)) {
            if (parked.retry_label.isNotEmpty()) QuietButton(parked.retry_label, testTag = "agenda-parked-retry", modifier = Modifier.padding(end = 8.dp), onPress = onRetry)
            if (parked.dismiss_label.isNotEmpty()) QuietButton(parked.dismiss_label, testTag = "agenda-parked-dismiss", onPress = onDismiss)
        }
    }
}

