package dev.centraid.android.screens.people

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.unit.dp
import centraid.screen.v1.Autosave
import centraid.screen.v1.PeopleEditorEvent
import centraid.screen.v1.PeopleEditorState
import centraid.screen.v1.WriteState
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EditorRoom
import dev.centraid.android.kit.EmptyStateView
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.kit.StatusLine
import dev.centraid.android.kit.hueColor
import dev.centraid.android.kit.screenContentOf
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * THE PROFILE EDITOR (#1029 app port) in the kit's `EditorRoom`: autosave,
 * close = done. Hue and cadence are inline choices (the cadence is its own
 * write, saved on the tap). The words typed stay local (`EditableFieldRow`)
 * and take the machine's value back only on the baseline while CLEAN.
 */
@Composable
public fun PeopleEditorScreen(
    state: PeopleEditorState,
    onEvent: (PeopleEditorEvent) -> Unit,
    onClose: () -> Unit,
    onDeparted: () -> Unit,
) {
    val chrome = state.chrome
    val draft = state.draft
    val reload = if (state.autosave?.phase == Autosave.Phase.PHASE_CLEAN) Pair(state.party_id, state.baseline) else null
    val write = state.write
    EditorRoom(
        title = chrome?.title.orEmpty(),
        status = if (draft != null) state.autosave else null,
        closeLabel = chrome?.close_label?.takeIf { it.isNotEmpty() } ?: KitWords.DONE,
        onClose = onClose,
        onDeparted = onDeparted,
    ) {
        StatusLine(if (write?.phase == WriteState.Phase.PHASE_REFUSED) write.failure?.sentence.orEmpty() else "")
        val gone = state.gone
        if (gone != null) {
            EmptyStateView(gone, onAction = null)
            return@EditorRoom
        }
        ReadStateView(
            content = screenContentOf(state.loading, state.failure, draft, state.denied),
            onRetry = { onEvent(PeopleEditorEvent(refreshed = PeopleEditorEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty(),
            skeleton = { RowSkeleton(rows = 4, meta = false, label = chrome?.loading.orEmpty()) },
        ) { profile ->
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).testTag("people-editor")) {
                EditableFieldRow(
                    key = chrome?.name_field.orEmpty(),
                    value = profile.display_name,
                    reload = reload,
                    style = "title",
                    testTag = "people-editor-name",
                    onEdit = { onEvent(PeopleEditorEvent(name = PeopleEditorEvent.NameChanged(it))) },
                )
                EditableFieldRow(
                    key = chrome?.role_field.orEmpty(),
                    value = profile.role,
                    reload = reload,
                    placeholder = chrome?.role_placeholder.orEmpty(),
                    testTag = "people-editor-role",
                    onEdit = { onEvent(PeopleEditorEvent(role = PeopleEditorEvent.RoleChanged(it))) },
                )
                EditableFieldRow(
                    key = chrome?.nickname_field.orEmpty(),
                    value = profile.nickname,
                    reload = reload,
                    testTag = "people-editor-nickname",
                    onEdit = { onEvent(PeopleEditorEvent(nickname = PeopleEditorEvent.NicknameChanged(it))) },
                )
                EditableFieldRow(
                    key = chrome?.met_field.orEmpty(),
                    value = profile.met,
                    reload = reload,
                    singleLine = false,
                    testTag = "people-editor-met",
                    onEdit = { onEvent(PeopleEditorEvent(met = PeopleEditorEvent.MetChanged(it))) },
                )
                if (state.hues.isNotEmpty()) {
                    Label(chrome?.colour_field.orEmpty())
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        state.hues.forEach { hue ->
                            Box(
                                Modifier
                                    .size(36.dp)
                                    .clip(CircleShape)
                                    .border(
                                        if (hue.selected) 2.dp else 0.dp,
                                        centraidColor(if (hue.selected) "text" else "bg"),
                                        CircleShape,
                                    )
                                    .padding(4.dp)
                                    .clip(CircleShape)
                                    .background(hueColor(hue.hue_key))
                                    .clickable { onEvent(PeopleEditorEvent(hue = PeopleEditorEvent.HuePicked(hue.hue_key))) }
                                    .testTag("people-hue-${hue.hue_key}")
                                    .clearAndSetSemantics {
                                        contentDescription = hue.accessibility_label
                                        role = Role.Button
                                        selected = hue.selected
                                    },
                            )
                        }
                    }
                }
                if (state.cadences.isNotEmpty()) {
                    Label(chrome?.cadence_field.orEmpty())
                    state.cadences.forEach { cadence ->
                        SheetRow(
                            label = cadence.label,
                            selected = cadence.selected,
                            testTag = "people-cadence-${cadence.days}",
                            onTap = { onEvent(PeopleEditorEvent(cadence = PeopleEditorEvent.CadencePicked(cadence.days))) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun Label(text: String) {
    if (text.isEmpty()) return
    Text(
        text,
        style = centraidType("eyebrow"),
        color = centraidColor("textSoft"),
        modifier = Modifier.padding(start = KitGeometry.GUTTER, end = KitGeometry.GUTTER, top = 12.dp),
    )
}
