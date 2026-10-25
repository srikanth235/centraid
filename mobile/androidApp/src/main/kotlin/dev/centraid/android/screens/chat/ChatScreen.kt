package dev.centraid.android.screens.chat

import android.graphics.BitmapFactory
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import centraid.core.v1.ChatAttachment
import centraid.core.v1.ChatCard
import centraid.core.v1.ChatDocumentSheet
import centraid.core.v1.ChatEvent
import centraid.core.v1.ChatMessage
import centraid.core.v1.ChatModelStep
import centraid.core.v1.ChatPending
import centraid.core.v1.ChatState
import centraid.core.v1.ChatThreadItem
import centraid.core.v1.Route
import centraid.core.v1.Confirm
import dev.centraid.android.kit.SearchField
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.CentraidSearchField
import dev.centraid.android.kit.ConfirmSheet
import dev.centraid.android.kit.InkButton
import dev.centraid.android.kit.KitGeometry
import dev.centraid.android.kit.KitProgressBar
import dev.centraid.android.kit.OutlineButton
import dev.centraid.android.kit.SheetOutline
import dev.centraid.android.kit.SheetRoom
import dev.centraid.android.kit.SheetPrimary
import dev.centraid.android.kit.SheetRow
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * THE CHAT TAB (#1135, lane I), drawn from Rust's `ChatState`. Android's twin of iOS's `ChatView`:
 * a header (the drawer's key, the chat's title and where it runs, a menu), the thread or the
 * model's step, the composer, and the drawer of past chats over it. It owns no word, no count and
 * no decision: every label is in [ChatState], every tap is a [ChatEvent], and a card's tap is
 * answered by Rust with a page to push.
 *
 * Local state is only what is still the IME's or a dialog's: the draft, and the rename field.
 */
@Composable
internal fun ChatScreen(
    state: ChatState,
    onEvent: (ChatEvent) -> Unit,
    onOpenRoute: (Route) -> Unit,
    /** The member chose a scope from the composer's menu: the chat starts in it. */
    onScope: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    var draft by remember { mutableStateOf("") }
    // The message whose Copy was just pressed: its button says `copied_label` for a moment.
    var copied by remember { mutableStateOf<Long?>(null) }
    LaunchedEffect(copied) {
        if (copied != null) {
            kotlinx.coroutines.delay(1500)
            copied = null
        }
    }
    // The chat being renamed: its id and the title the field starts from.
    var renaming by remember { mutableStateOf<Pair<String, String>?>(null) }
    var deleting by remember { mutableStateOf<String?>(null) }
    var deletingAll by remember { mutableStateOf(false) }
    Box(modifier.fillMaxSize().background(centraidColor("bg")).testTag("chat")) {
        Column(Modifier.fillMaxSize().imePadding()) {
            ChatHeader(
                state,
                onDrawer = { onEvent(ChatEvent(drawer = ChatEvent.DrawerToggled(opened = true))) },
                onNewChat = { onEvent(ChatEvent(new_chat = ChatEvent.NewChat())) },
                onRename = { renaming = state.thread_id to state.title },
                onDelete = { deleting = state.thread_id },
            )
            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (state.phase == ChatState.Phase.PHASE_READY) {
                    ChatThread(state, onEvent, copied, onCopied = { copied = it }, onSuggest = {
                        onEvent(ChatEvent(sent = ChatEvent.Sent(text = it)))
                    })
                } else {
                    ChatModelStepView(state, onEvent)
                }
            }
            if (state.phase == ChatState.Phase.PHASE_READY) {
                state.vision_step?.let { VisionBanner(it, onDownload = { onEvent(ChatEvent(download = ChatEvent.DownloadTapped(vision = true))) }) }
                ChatComposer(
                    state,
                    draft = draft,
                    onDraft = { draft = it },
                    onSend = {
                        val text = draft.trim()
                        if (text.isNotEmpty()) {
                            draft = ""
                            onEvent(ChatEvent(sent = ChatEvent.Sent(text = text)))
                        }
                    },
                    onEvent = onEvent,
                    onOpenRoute = onOpenRoute,
                    onScope = onScope,
                )
            }
        }
        if (state.drawer_open) {
            ChatDrawer(
                state,
                onEvent,
                onDelete = { deleting = it },
                onRename = { id, title -> renaming = id to title },
                onDeleteAll = { deletingAll = true },
            )
        }
        val sheet = state.document_sheet
        if (sheet != null && sheet.open_) {
            DocumentSheet(
                sheet,
                onPick = { doc ->
                    onEvent(
                        ChatEvent(
                            attached = ChatEvent.Attached(
                                vault_document = ChatEvent.VaultDocument(doc_id = doc.doc_id),
                                label = doc.title,
                            ),
                        ),
                    )
                },
                onClose = { onEvent(ChatEvent(documents_closed = ChatEvent.DocumentsClosed())) },
            )
        }
    }
    val rename = renaming
    if (rename != null) {
        val (id, current) = rename
        RenameSheet(
            state,
            initial = current,
            onSave = { title ->
                renaming = null
                onEvent(ChatEvent(thread_renamed = ChatEvent.ThreadRenamed(thread_id = id, title = title)))
            },
            onDismiss = { renaming = null },
        )
    }
    val target = deleting
    if (target != null) {
        ConfirmSheet(
            confirm = Confirm(title = state.delete_title, body = state.delete_body, confirm_label = state.delete_label, destructive = true),
            onConfirm = {
                deleting = null
                onEvent(ChatEvent(thread_deleted = ChatEvent.ThreadDeleted(thread_id = target)))
            },
            onDismiss = { deleting = null },
            cancelLabel = state.cancel_label,
        )
    }
    if (deletingAll) {
        ConfirmSheet(
            confirm = Confirm(
                title = state.delete_all_title,
                body = state.delete_all_body,
                confirm_label = state.delete_all_label,
                destructive = true,
            ),
            onConfirm = {
                deletingAll = false
                onEvent(ChatEvent(all_threads_deleted = ChatEvent.AllThreadsDeleted()))
            },
            onDismiss = { deletingAll = false },
            cancelLabel = state.cancel_label,
        )
    }
}

// ---------------------------------------------------------------- the header --

@Composable
private fun KeyButton(iconKey: String, label: String, tag: String, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        Modifier
            .size(KitGeometry.ROW_MIN)
            .clip(CircleShape)
            .clickable(enabled = enabled, onClick = onClick)
            .testTag(tag)
            .semantics {
                contentDescription = label
                role = Role.Button
            },
        contentAlignment = Alignment.Center,
    ) {
        CentraidIcon(iconKey = iconKey, tint = centraidColor(if (enabled) "text" else "textDisabled"), size = 18.dp)
    }
}

@Composable
private fun ChatHeader(
    state: ChatState,
    onDrawer: () -> Unit,
    onNewChat: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val hasMenu = state.can_new_chat || state.can_manage_thread
    Column {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            KeyButton("Menu", state.drawer_label, "chat-drawer", onClick = onDrawer)
            Column(Modifier.weight(1f), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    state.title,
                    style = centraidType("smallStrong"),
                    color = centraidColor("text"),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.semantics { heading() }.testTag("chat-title"),
                )
                Text(
                    state.subtitle,
                    style = centraidType("mono"),
                    color = centraidColor("textFaint"),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.testTag("chat-subtitle"),
                )
            }
            Box {
                KeyButton("MoreVert", state.menu_label, "chat-menu", enabled = hasMenu) { menu = true }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = centraidColor("bgElev")) {
                    if (state.can_new_chat) {
                        DropdownMenuItem(
                            text = { Text(state.new_chat_label, style = centraidType("body"), color = centraidColor("text")) },
                            onClick = { menu = false; onNewChat() },
                            modifier = Modifier.testTag("chat-menu-new"),
                        )
                    }
                    if (state.can_manage_thread) {
                        DropdownMenuItem(
                            text = { Text(state.rename_label, style = centraidType("body"), color = centraidColor("text")) },
                            onClick = { menu = false; onRename() },
                            modifier = Modifier.testTag("chat-menu-rename"),
                        )
                        DropdownMenuItem(
                            text = { Text(state.delete_label, style = centraidType("body"), color = centraidColor("net")) },
                            onClick = { menu = false; onDelete() },
                            modifier = Modifier.testTag("chat-menu-delete"),
                        )
                    }
                }
            }
        }
        Box(Modifier.fillMaxWidth().size(width = 0.dp, height = KitGeometry.HAIRLINE).background(centraidColor("line")))
    }
}

// ----------------------------------------------------------------- the thread --

@Composable
private fun ChatThread(
    state: ChatState,
    onEvent: (ChatEvent) -> Unit,
    copied: Long?,
    onCopied: (Long) -> Unit,
    onSuggest: (String) -> Unit,
) {
    val list = rememberLazyListState()
    val last = state.messages.lastOrNull()
    // FOLLOW THE ANSWER as it is written: the foot of the thread stays in view.
    LaunchedEffect(state.messages.size, last?.text?.length, last?.cards?.size) {
        if (state.messages.isNotEmpty()) list.scrollToItem(state.messages.size - 1)
    }
    if (state.messages.isEmpty()) {
        Column(
            Modifier.fillMaxSize().padding(KitGeometry.GUTTER),
            verticalArrangement = Arrangement.Center,
        ) {
            Text(state.empty_line, style = centraidType("body"), color = centraidColor("textSoft"))
            Spacer(Modifier.size(12.dp))
            state.suggestions.forEachIndexed { index, suggestion ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp)
                        .clip(RoundedCornerShape(KitGeometry.RADIUS))
                        .border(KitGeometry.HAIRLINE, centraidColor("lineStrong"), RoundedCornerShape(KitGeometry.RADIUS))
                        .clickable { onSuggest(suggestion) }
                        .heightIn(min = KitGeometry.ROW_MIN)
                        .padding(horizontal = 12.dp, vertical = 8.dp)
                        .testTag("chat-suggestion-$index"),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(suggestion, style = centraidType("body"), color = centraidColor("text"), modifier = Modifier.weight(1f))
                    CentraidIcon("ArrowRight", tint = centraidColor("textSoft"), size = 16.dp)
                }
            }
        }
        return
    }
    LazyColumn(
        state = list,
        modifier = Modifier.fillMaxSize().testTag("chat-thread"),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = KitGeometry.GUTTER, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        itemsIndexed(state.messages, key = { _, message -> message.id }) { index, message ->
            MessageRow(
                message,
                state,
                isLast = index == state.messages.lastIndex,
                copied = copied == message.id,
                onCopied = { onCopied(message.id) },
                onEvent = onEvent,
            )
        }
        if (state.streaming && state.activity.isNotEmpty()) {
            item(key = "activity") {
                Text(
                    state.activity,
                    style = centraidType("mono"),
                    color = centraidColor("textFaint"),
                    modifier = Modifier.testTag("chat-activity"),
                )
            }
        }
        if (state.error.isNotEmpty()) {
            item(key = "error") { ErrorLine(state, onRetry = { onEvent(ChatEvent(regenerated = ChatEvent.Regenerated())) }) }
        }
        if (state.card_gone_line.isNotEmpty()) {
            item(key = "gone") {
                Text(
                    state.card_gone_line,
                    style = centraidType("mono"),
                    color = centraidColor("textSoft"),
                    modifier = Modifier.testTag("chat-card-gone"),
                )
            }
        }
    }
}

@Composable
private fun ErrorLine(state: ChatState, onRetry: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.testTag("chat-error")) {
        Text(state.error, style = centraidType("small"), color = centraidColor("net"), modifier = Modifier.weight(1f))
        if (state.can_retry) {
            ActionButton("Refresh", state.retry_label, "chat-retry", onRetry)
        }
    }
}

@Composable
private fun ActionButton(iconKey: String, label: String, tag: String, onClick: () -> Unit) {
    Row(
        Modifier
            .heightIn(min = 32.dp)
            .clip(RoundedCornerShape(KitGeometry.RADIUS))
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp)
            .testTag(tag)
            .semantics { role = Role.Button },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        CentraidIcon(iconKey, tint = centraidColor("textSoft"), size = 14.dp)
        Text(label, style = centraidType("small"), color = centraidColor("textSoft"))
    }
}

@Composable
private fun MessageRow(
    message: ChatMessage,
    state: ChatState,
    isLast: Boolean,
    copied: Boolean,
    onCopied: () -> Unit,
    onEvent: (ChatEvent) -> Unit,
) {
    if (message.role == ChatMessage.Role.ROLE_USER) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Column(
                Modifier
                    .widthIn(max = 320.dp)
                    .clearAndSetSemantics { contentDescription = message.accessibility_label }
                    .testTag("chat-message-user"),
                horizontalAlignment = Alignment.End,
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                message.attachments.forEach { AttachmentChip(it, state.remove_attachment_label, onRemove = null) }
                Text(
                    message.text,
                    style = centraidType("body"),
                    color = centraidColor("text"),
                    modifier = Modifier
                        .clip(RoundedCornerShape(KitGeometry.RADIUS * 1.5f))
                        .background(centraidColor("bgElev"))
                        .border(KitGeometry.HAIRLINE, centraidColor("lineStrong"), RoundedCornerShape(KitGeometry.RADIUS * 1.5f))
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
        }
        return
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (message.text.isNotEmpty()) {
            MarkdownText(message.text, message.streaming, message.accessibility_label)
        }
        message.cards.forEachIndexed { index, card ->
            CardRow(card) { onEvent(ChatEvent(card_tapped = ChatEvent.CardTapped(message_id = message.id, index = index))) }
        }
        val pending = message.pending
        if (pending != null && !message.streaming) {
            PendingCard(
                pending,
                onConfirm = { onEvent(ChatEvent(pending_confirmed = ChatEvent.PendingConfirmed(pending_id = pending.pending_id))) },
                onCancel = { onEvent(ChatEvent(pending_cancelled = ChatEvent.PendingCancelled(pending_id = pending.pending_id))) },
            )
        }
        if (message.note.isNotEmpty()) {
            Text(message.note, style = centraidType("mono"), color = centraidColor("textFaint"), modifier = Modifier.testTag("chat-note"))
        }
        if (!message.streaming && (message.text.isNotEmpty() || message.cards.isNotEmpty())) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (message.text.isNotEmpty()) {
                    ActionButton("Copy", if (copied) state.copied_label.ifEmpty { state.copy_label } else state.copy_label, "chat-copy") {
                        onCopied()
                        onEvent(ChatEvent(copied = ChatEvent.Copied(message_id = message.id)))
                    }
                }
                if (isLast && state.can_retry && state.error.isEmpty()) {
                    ActionButton("Refresh", state.retry_label, "chat-retry") {
                        onEvent(ChatEvent(regenerated = ChatEvent.Regenerated()))
                    }
                }
            }
        }
    }
}

@Composable
private fun MarkdownText(text: String, streaming: Boolean, spoken: String) {
    Column(
        Modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = spoken }.testTag("chat-message-answer"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        ChatMarkdown.blocks(text, streaming).forEach { block ->
            when (block) {
                is ChatMarkdown.Block.Paragraph ->
                    Text(block.text, style = centraidType("body"), color = centraidColor("text"))
                is ChatMarkdown.Block.Heading ->
                    Text(block.text, style = centraidType("body"), color = centraidColor("text"))
                is ChatMarkdown.Block.Item -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(block.marker, style = centraidType("body"), color = centraidColor("textSoft"), modifier = Modifier.widthIn(min = 16.dp))
                    Text(block.text, style = centraidType("body"), color = centraidColor("text"), modifier = Modifier.weight(1f))
                }
            }
        }
    }
}

@Composable
private fun CardRow(card: ChatCard, onOpen: () -> Unit) {
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    Row(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(centraidColor("bgElev"))
            .border(KitGeometry.HAIRLINE, centraidColor("line"), shape)
            .clickable(onClick = onOpen)
            .heightIn(min = KitGeometry.ROW_MIN)
            .padding(horizontal = 12.dp, vertical = 8.dp)
            .semantics {
                contentDescription = listOf(card.title, card.subtitle, card.meta).filter { it.isNotEmpty() }.joinToString(", ")
                role = Role.Button
            }
            .testTag("chat-card"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(card.title, style = centraidType("smallStrong"), color = centraidColor("text"), maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (card.subtitle.isNotEmpty()) {
                Text(card.subtitle, style = centraidType("small"), color = centraidColor("textSoft"), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (card.meta.isNotEmpty()) {
                Text(card.meta, style = centraidType("mono"), color = centraidColor("textFaint"), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        CentraidIcon("ChevronRight", tint = centraidColor("textFaint"), size = 16.dp)
    }
}

/** THE WRITE THE MODEL PROPOSED: its lines, and the two taps that decide it. */
@Composable
private fun PendingCard(pending: ChatPending, onConfirm: () -> Unit, onCancel: () -> Unit) {
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    val asking = pending.state == ChatPending.State.STATE_WAITING || pending.state == ChatPending.State.STATE_WORKING
    Column(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(centraidColor("bgElev"))
            .border(KitGeometry.HAIRLINE, centraidColor(if (pending.destructive) "net" else "line"), shape)
            .padding(12.dp)
            .semantics { contentDescription = pending.accessibility_label }
            .testTag("chat-pending"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        pending.steps.forEach { step ->
            Text(step.summary, style = centraidType("small"), color = centraidColor(if (step.destructive) "net" else "text"))
        }
        if (pending.more_line.isNotEmpty()) {
            Text(pending.more_line, style = centraidType("small"), color = centraidColor("textSoft"))
        }
        if (asking) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 4.dp)) {
                val working = pending.state == ChatPending.State.STATE_WORKING
                if (pending.destructive) {
                    OutlineButton(pending.confirm_label, testTag = "chat-confirm", ink = "net", enabled = !working, onPress = onConfirm)
                } else {
                    InkButton(pending.confirm_label, Modifier.widthIn(max = 160.dp), testTag = "chat-confirm", enabled = !working, onPress = onConfirm)
                }
                OutlineButton(pending.cancel_label, testTag = "chat-cancel", enabled = !working, onPress = onCancel)
            }
        } else if (pending.settled_line.isNotEmpty()) {
            Text(pending.settled_line, style = centraidType("mono"), color = centraidColor("textSoft"), modifier = Modifier.testTag("chat-settled"))
        }
    }
}

// ----------------------------------------------------------------- the composer --

@Composable
private fun ChatComposer(
    state: ChatState,
    draft: String,
    onDraft: (String) -> Unit,
    onSend: () -> Unit,
    onEvent: (ChatEvent) -> Unit,
    onOpenRoute: (Route) -> Unit,
    onScope: (String) -> Unit,
) {
    var attachMenu by remember { mutableStateOf(false) }
    val shape = RoundedCornerShape(KitGeometry.RADIUS * 2)
    Column(
        Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        // THE SCOPE PILL: which app this chat reads. Choosing starts a chat in that scope.
        if (state.scopes.isNotEmpty() && state.messages.isEmpty()) ScopePill(state, onScope)
        if (state.pending.isNotEmpty()) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                state.pending.forEach { chip ->
                    AttachmentChip(chip, state.remove_attachment_label) {
                        onEvent(ChatEvent(attachment_removed = ChatEvent.AttachmentRemoved(id = chip.id)))
                    }
                }
            }
        }
        Row(
            Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(centraidColor("bgElev"))
                .border(KitGeometry.HAIRLINE, centraidColor("line"), shape)
                .padding(start = 4.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            Box {
                KeyButton("Plus", state.attach_label, "chat-attach", enabled = state.can_attach) { attachMenu = true }
                DropdownMenu(expanded = attachMenu, onDismissRequest = { attachMenu = false }, containerColor = centraidColor("bgElev")) {
                    val photoRoute = state.attach_photo_route
                    if (photoRoute != null) {
                        DropdownMenuItem(
                            text = { Text(state.attach_vault_photo_label, style = centraidType("body"), color = centraidColor("text")) },
                            onClick = { attachMenu = false; onOpenRoute(photoRoute) },
                            modifier = Modifier.testTag("chat-attach-vault-photo"),
                        )
                    }
                    DropdownMenuItem(
                        text = { Text(state.attach_library_photo_label, style = centraidType("body"), color = centraidColor("text")) },
                        onClick = { attachMenu = false; onEvent(ChatEvent(library_photo_tapped = ChatEvent.LibraryPhotoTapped())) },
                        modifier = Modifier.testTag("chat-attach-library-photo"),
                    )
                    DropdownMenuItem(
                        text = { Text(state.attach_document_label, style = centraidType("body"), color = centraidColor("text")) },
                        onClick = { attachMenu = false; onEvent(ChatEvent(documents_opened = ChatEvent.DocumentsOpened())) },
                        modifier = Modifier.testTag("chat-attach-document"),
                    )
                }
            }
            Box(Modifier.weight(1f).padding(vertical = 10.dp, horizontal = 4.dp)) {
                if (draft.isEmpty()) {
                    Text(
                        state.composer_placeholder,
                        style = centraidType("body"),
                        color = centraidColor("textGhost"),
                        modifier = Modifier.clearAndSetSemantics { },
                    )
                }
                BasicTextField(
                    value = draft,
                    onValueChange = onDraft,
                    textStyle = centraidType("body").copy(color = centraidColor("text")),
                    cursorBrush = SolidColor(centraidColor("text")),
                    maxLines = 6,
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                    modifier = Modifier.fillMaxWidth().testTag("chat-composer").semantics { contentDescription = state.composer_placeholder },
                )
            }
            if (state.streaming) {
                SendKey("Stop", state.stop_label, filled = true, tag = "chat-stop") {
                    onEvent(ChatEvent(stopped = ChatEvent.Stopped()))
                }
            } else {
                val ready = draft.isNotBlank() && !state.vision_blocked
                SendKey("PaperPlaneTilt", state.send_label, filled = ready, tag = "chat-send", enabled = ready, onClick = onSend)
            }
        }
    }
}

@Composable
private fun ScopePill(state: ChatState, onScope: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val name = state.scopes.firstOrNull { it.app == state.scope_app }?.name ?: state.scope_all_label
    Box {
        Row(
            Modifier
                .heightIn(min = 32.dp)
                .clip(CircleShape)
                .border(KitGeometry.HAIRLINE, centraidColor("lineStrong"), CircleShape)
                .clickable { open = true }
                .padding(horizontal = 12.dp)
                .testTag("chat-scope")
                .semantics {
                    contentDescription = state.scope_label + ", " + name
                    role = Role.Button
                },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(name, style = centraidType("smallStrong"), color = centraidColor("text"), maxLines = 1)
            CentraidIcon("ChevronDown", tint = centraidColor("textSoft"), size = 14.dp)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, containerColor = centraidColor("bgElev")) {
            DropdownMenuItem(
                text = { Text(state.scope_all_label, style = centraidType("body"), color = centraidColor("text")) },
                onClick = { open = false; onScope("") },
                modifier = Modifier.testTag("chat-scope-all"),
            )
            state.scopes.forEach { option ->
                DropdownMenuItem(
                    text = { Text(option.name, style = centraidType("body"), color = centraidColor("text")) },
                    onClick = { open = false; onScope(option.app) },
                    modifier = Modifier.testTag("chat-scope-${option.app}"),
                )
            }
        }
    }
}

@Composable
private fun SendKey(iconKey: String, label: String, filled: Boolean, tag: String, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        Modifier
            .size(KitGeometry.ROW_MIN)
            .clip(CircleShape)
            .background(if (filled) centraidColor("accent") else androidx.compose.ui.graphics.Color.Transparent)
            .border(KitGeometry.HAIRLINE, if (filled) androidx.compose.ui.graphics.Color.Transparent else centraidColor("lineStrong"), CircleShape)
            .clickable(enabled = enabled, onClick = onClick)
            .testTag(tag)
            .semantics {
                contentDescription = label
                role = Role.Button
            },
        contentAlignment = Alignment.Center,
    ) {
        CentraidIcon(iconKey, tint = centraidColor(if (filled) "onAccent" else "textDisabled"), size = 18.dp)
    }
}

@Composable
private fun AttachmentChip(chip: ChatAttachment, removeLabel: String, onRemove: (() -> Unit)?) {
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    val thumbnail = remember(chip.thumbnail_path) {
        chip.thumbnail_path.takeIf { it.isNotEmpty() }?.let { runCatching { BitmapFactory.decodeFile(it) }.getOrNull() }
    }
    Row(
        Modifier
            .heightIn(min = 36.dp)
            .clip(shape)
            .border(KitGeometry.HAIRLINE, centraidColor("lineStrong"), shape)
            .padding(end = 4.dp)
            .testTag("chat-chip"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(36.dp).background(centraidColor("skel")), contentAlignment = Alignment.Center) {
            if (thumbnail != null) {
                Image(
                    thumbnail.asImageBitmap(),
                    contentDescription = null, // decorative: the chip's label beside it names the attachment
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
            } else {
                CentraidIcon(
                    if (chip.kind == ChatAttachment.Kind.KIND_DOCUMENT) "FileText" else "Image",
                    tint = centraidColor("textSoft"),
                    size = 16.dp,
                )
            }
        }
        Text(
            chip.label,
            style = centraidType("smallStrong"),
            color = centraidColor("text"),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(horizontal = 8.dp).widthIn(max = 140.dp),
        )
        if (onRemove != null) {
            Box(
                Modifier
                    .size(32.dp)
                    .clip(CircleShape)
                    .clickable(onClick = onRemove)
                    .testTag("chat-chip-remove")
                    .semantics { contentDescription = removeLabel; role = Role.Button },
                contentAlignment = Alignment.Center,
            ) { CentraidIcon("X", tint = centraidColor("textSoft"), size = 14.dp) }
        }
    }
}

// --------------------------------------------------------- the model's step --

@Composable
private fun ChatModelStepView(state: ChatState, onEvent: (ChatEvent) -> Unit) {
    val step = state.model_step ?: return
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    Column(
        Modifier.fillMaxSize().padding(KitGeometry.GUTTER),
        verticalArrangement = Arrangement.Center,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .clip(shape)
                .background(centraidColor("bgElev"))
                .border(KitGeometry.HAIRLINE, centraidColor("line"), shape)
                .padding(16.dp)
                .testTag("chat-model-step"),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (step.size_line.isNotEmpty()) {
                Text(step.size_line, style = centraidType("smallStrong"), color = centraidColor("text"))
            }
            if (step.note_line.isNotEmpty()) {
                Text(step.note_line, style = centraidType("small"), color = centraidColor("textSoft"))
            }
            if (state.phase == ChatState.Phase.PHASE_DOWNLOADING && step.progress_known) {
                KitProgressBar(step.progress, ink = "net")
            }
            if (step.status_line.isNotEmpty()) {
                Text(step.status_line, style = centraidType("small"), color = centraidColor("textSoft"))
            }
            if (step.action_label.isNotEmpty()) {
                InkButton(step.action_label, testTag = "chat-download") {
                    onEvent(ChatEvent(download = ChatEvent.DownloadTapped(vision = false)))
                }
            }
            if (state.error.isNotEmpty()) {
                Text(state.error, style = centraidType("small"), color = centraidColor("net"), modifier = Modifier.testTag("chat-error"))
            }
        }
    }
}

@Composable
private fun VisionBanner(step: ChatModelStep, onDownload: () -> Unit) {
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)
            .background(centraidColor("bgSunken"))
            .padding(12.dp)
            .testTag("chat-vision"),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (step.size_line.isNotEmpty()) Text(step.size_line, style = centraidType("small"), color = centraidColor("textSoft"))
        if (step.progress_known) KitProgressBar(step.progress, ink = "net")
        if (step.status_line.isNotEmpty()) {
            Text(step.status_line, style = centraidType("small"), color = centraidColor(if (step.action_label.isNotEmpty()) "net" else "textSoft"))
        }
        if (step.action_label.isNotEmpty()) {
            OutlineButton(step.action_label, testTag = "chat-vision-download", onPress = onDownload)
        }
    }
}

// ------------------------------------------------------------------ documents --

@Composable
private fun DocumentSheet(
    sheet: ChatDocumentSheet,
    onPick: (centraid.core.v1.ChatDocumentRow) -> Unit,
    onClose: () -> Unit,
) {
    SheetRoom(title = sheet.title, onDismiss = onClose) {
        if (sheet.loaded && sheet.rows.isEmpty()) {
            Text(
                sheet.empty_line,
                style = centraidType("body"),
                color = centraidColor("textSoft"),
                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
            )
        }
        sheet.rows.forEachIndexed { index, row ->
            SheetRow(label = row.title, detail = row.subtitle, iconKey = "FileText", testTag = "chat-document-$index", onTap = { onPick(row) })
        }
    }
}

@Composable
private fun RenameSheet(state: ChatState, initial: String, onSave: (String) -> Unit, onDismiss: () -> Unit) {
    var title by remember { mutableStateOf(initial) }
    SheetRoom(
        title = state.rename_title,
        onDismiss = onDismiss,
        primary = SheetPrimary(label = state.save_label, enabled = title.isNotBlank(), testTag = "chat-rename-save") { onSave(title) },
        outlines = listOf(SheetOutline(label = state.cancel_label, testTag = "chat-rename-cancel", onPress = onDismiss)),
    ) {
        BasicTextField(
            value = title,
            onValueChange = { title = it },
            singleLine = true,
            textStyle = centraidType("body").copy(color = centraidColor("text")),
            cursorBrush = SolidColor(centraidColor("text")),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
                .border(KitGeometry.HAIRLINE, centraidColor("lineStrong"), RoundedCornerShape(KitGeometry.RADIUS))
                .padding(12.dp)
                .testTag("chat-rename-field"),
        )
    }
}

// ------------------------------------------------------------------- the drawer --

/** THE PAST CHATS, sliding in from the left over the thread: the lesser of 320dp and 84% of the width. */
@Composable
private fun ChatDrawer(
    state: ChatState,
    onEvent: (ChatEvent) -> Unit,
    onDelete: (String) -> Unit,
    onRename: (String, String) -> Unit,
    onDeleteAll: () -> Unit,
) {
    val close = { onEvent(ChatEvent(drawer = ChatEvent.DrawerToggled(opened = false))) }
    androidx.activity.compose.BackHandler(onBack = { close() })
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val width: Dp = minOf(320.dp, maxWidth * 0.84f)
        Box(
            Modifier
                .fillMaxSize()
                .background(centraidColor("scrim"))
                .clickable(onClick = { close() })
                .testTag("chat-drawer-scrim"),
        )
        Column(
            Modifier
                .width(width)
                .fillMaxHeight()
                .background(centraidColor("bg"))
                .testTag("chat-drawer-panel"),
        ) {
            Text(
                state.drawer_label,
                style = centraidType("title"),
                color = centraidColor("text"),
                modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp).semantics { heading() },
            )
            val search = state.drawer_search
            if (search != null && search.open_) {
                CentraidSearchField(
                    field = SearchField(open_ = true, term = search.term, corrected = search.corrected),
                    placeholder = state.drawer_search_placeholder,
                    onTerm = { onEvent(ChatEvent(drawer_search_term = ChatEvent.DrawerSearchTerm(term = it))) },
                    onClose = { onEvent(ChatEvent(drawer_search_closed = ChatEvent.DrawerSearchClosed())) },
                    label = state.drawer_search_placeholder,
                    closeLabel = state.close_label,
                    testTag = "chat-drawer-search",
                )
            } else {
                ActionRow("Search", state.drawer_search_placeholder, "chat-drawer-search-open") {
                    onEvent(ChatEvent(drawer_search_opened = ChatEvent.DrawerSearchOpened()))
                }
            }
            ActionRow("Plus", state.new_chat_label, "chat-drawer-new") {
                onEvent(ChatEvent(new_chat = ChatEvent.NewChat()))
            }
            LazyColumn(Modifier.weight(1f)) {
                if (state.threads.isEmpty() && state.threads_empty_line.isNotEmpty()) {
                    item(key = "empty") {
                        Text(
                            state.threads_empty_line,
                            style = centraidType("small"),
                            color = centraidColor("textSoft"),
                            modifier = Modifier.padding(KitGeometry.GUTTER),
                        )
                    }
                }
                itemsIndexed(state.threads, key = { _, row -> row.thread_id }) { _, row ->
                    ThreadRow(
                        row,
                        onOpen = { onEvent(ChatEvent(thread_opened = ChatEvent.ThreadOpened(thread_id = row.thread_id, title = row.title))) },
                        onRename = { onRename(row.thread_id, row.title) },
                        onDelete = { onDelete(row.thread_id) },
                        state = state,
                    )
                }
            }
            if (state.can_delete_all) {
                Text(
                    state.delete_all_label,
                    style = centraidType("smallStrong"),
                    color = centraidColor("net"),
                    modifier = Modifier
                        .fillMaxWidth()
                        .heightIn(min = KitGeometry.ROW_MIN)
                        .clickable(onClick = onDeleteAll)
                        .padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp)
                        .testTag("chat-drawer-delete-all"),
                )
            }
        }
    }
}

@Composable
private fun ActionRow(iconKey: String, label: String, tag: String, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .clickable(onClick = onClick)
            .padding(horizontal = KitGeometry.GUTTER)
            .testTag(tag)
            .semantics { role = Role.Button },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        CentraidIcon(iconKey, tint = centraidColor("textSoft"), size = 16.dp)
        Text(label, style = centraidType("smallStrong"), color = centraidColor("text"))
    }
}

@Composable
private fun ThreadRow(
    row: ChatThreadItem,
    onOpen: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
    state: ChatState,
) {
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier
            .fillMaxWidth()
            .background(if (row.current) centraidColor("bgSunken") else androidx.compose.ui.graphics.Color.Transparent)
            .clickable(onClick = onOpen)
            .heightIn(min = KitGeometry.ROW_MIN)
            .semantics { contentDescription = row.accessibility_label; role = Role.Button }
            .testTag("chat-thread-row"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(width = 3.dp, height = 28.dp).background(if (row.current) centraidColor("text") else androidx.compose.ui.graphics.Color.Transparent))
        Column(Modifier.weight(1f).padding(horizontal = 13.dp, vertical = 8.dp)) {
            Text(row.title, style = centraidType("smallStrong"), color = centraidColor("text"), maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (row.ago.isNotEmpty()) Text(row.ago, style = centraidType("mono"), color = centraidColor("textFaint"))
        }
        Box {
            KeyButton("MoreVert", state.menu_label, "chat-thread-menu") { menu = true }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = centraidColor("bgElev")) {
                DropdownMenuItem(
                    text = { Text(state.rename_label, style = centraidType("body"), color = centraidColor("text")) },
                    onClick = { menu = false; onRename() },
                )
                DropdownMenuItem(
                    text = { Text(state.delete_label, style = centraidType("body"), color = centraidColor("net")) },
                    onClick = { menu = false; onDelete() },
                )
            }
        }
    }
}
