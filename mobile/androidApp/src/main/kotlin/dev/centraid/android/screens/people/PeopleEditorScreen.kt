package dev.centraid.android.screens.people

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.kitCard
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import centraid.core.v1.PeopleEditorEvent
import centraid.core.v1.PeopleEditorState
import dev.centraid.android.kit.EditableFieldRow
import dev.centraid.android.kit.EditorRoom
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitWords
import dev.centraid.android.kit.ReadStateView
import dev.centraid.android.kit.RowSkeleton
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.kit.StatusLine
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * `people.editor` (#1135) in the kit's `EditorRoom`: autosave, close = done.
 * The cadence is an inline choice, its own write saved on the tap. The words
 * typed stay local (`EditableFieldRow`) and take Rust's value back only on the
 * baseline while CLEAN. Rust flushes the autosave when it sees the page leave.
 */
@Composable
public fun PeopleEditorScreen(
    state: PeopleEditorState,
    onEvent: (PeopleEditorEvent) -> Unit,
    onClose: () -> Unit,
) {
    val chrome = state.chrome
    val draft = state.draft
    val autosave = state.autosave
    val clean = autosave != null && !autosave.refused && autosave.edit_seq == autosave.saved_seq
    val reload: Any? = if (clean) Pair(autosave?.base_revision_id, autosave?.saved_seq) else null
    EditorRoom(
        title = chrome?.title.orEmpty(),
        status = if (draft != null) autosave else null,
        closeLabel = chrome?.close_label?.takeIf { it.isNotEmpty() } ?: KitWords.DONE,
        onClose = onClose,
        onDeparted = {},
    ) {
        StatusLine(state.status?.sentence.orEmpty())
        ReadStateView(
            page = state.page!!,
            onRetry = { onEvent(PeopleEditorEvent(refreshed = PeopleEditorEvent.Refreshed())) },
            retryLabel = chrome?.retry.orEmpty(),
            skeleton = { RowSkeleton(rows = 4, meta = false, label = chrome?.loading.orEmpty()) },
        ) {
            val profile = draft ?: return@ReadStateView
            Column(
                Modifier.fillMaxWidth().background(Surface.page).verticalScroll(rememberScrollState()).testTag("people-editor"),
            ) {
                // THE FOUR FIELDS ARE ONE WHITE CARD on the page (#1173).
                Column(Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp).kitCard()) {
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
                }
                if (state.cadences.isNotEmpty()) {
                    Label(chrome?.cadence_field.orEmpty())
                    // THE CHOSEN CADENCE IS FILLED in the app's colour under a white label; the
                    // others are white pills with a hairline.
                    val accent = appAccent("people")
                    Row(
                        Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = KitGeometry.GUTTER + 4.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        state.cadences.forEach { cadence ->
                            Box(
                                Modifier
                                    .heightIn(min = KitGeometry.ROW_MIN)
                                    .clip(CircleShape)
                                    .background(if (cadence.selected) accent.fill else Surface.card)
                                    .then(
                                        if (cadence.selected) Modifier else Modifier.border(KitGeometry.HAIRLINE, Surface.border, CircleShape),
                                    )
                                    .clickable { onEvent(PeopleEditorEvent(cadence = PeopleEditorEvent.CadencePicked(cadence.days))) }
                                    .padding(horizontal = 16.dp)
                                    .testTag("people-cadence-${cadence.days}")
                                    .semantics {
                                        selected = cadence.selected
                                        role = Role.RadioButton
                                    },
                                contentAlignment = Alignment.Center,
                            ) {
                                KitText(cadence.label, KitType.Row, if (cadence.selected) Color.White else Surface.ink, maxLines = 1)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun Label(text: String) {
    if (text.isEmpty()) return
    KitText(
        text,
        KitType.Group,
        Surface.meta,
        modifier = Modifier
            .padding(start = KitGeometry.GUTTER + 4.dp, end = KitGeometry.GUTTER, top = 22.dp, bottom = 8.dp)
            .semantics { heading() },
    )
}
