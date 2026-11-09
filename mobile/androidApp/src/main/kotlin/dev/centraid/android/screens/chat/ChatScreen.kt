package dev.centraid.android.screens.chat

import android.graphics.BitmapFactory
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import dev.centraid.android.kit.KitText
import dev.centraid.android.kit.KitType
import dev.centraid.android.kit.StateColor
import dev.centraid.android.kit.Surface
import dev.centraid.android.kit.kitTextStyle
import androidx.compose.foundation.border
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
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
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.height
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
import androidx.compose.ui.res.dimensionResource
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
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
import dev.centraid.android.R
import dev.centraid.android.kit.CentraidMark
import dev.centraid.android.kit.RoomSearch
import dev.centraid.android.kit.SearchField
import dev.centraid.android.kit.SearchFoot
import dev.centraid.android.kit.appAccent
import dev.centraid.android.kit.centraidResource
import dev.centraid.android.kit.tokenSp
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.CentraidSearchField
import dev.centraid.android.kit.ConfirmSheet
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
 * a header (the chat's title and where it runs, the Chats key and, inside a saved chat, New
 * chat's pencil), the thread or the model's step, the composer, and the Chats page of past chats
 * over it. It owns no word, no count and
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
                onChats = { onEvent(ChatEvent(drawer = ChatEvent.DrawerToggled(opened = true))) },
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
                // THE NEXT QUESTIONS, as chips above the composer in a live thread (#1173): the
                // empty thread lists them in the page itself. A tap asks, like any sent line.
                if (state.messages.isNotEmpty() && state.suggestions.isNotEmpty()) {
                    SuggestionChips(state.suggestions) { onEvent(ChatEvent(sent = ChatEvent.Sent(text = it))) }
                }
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
            ChatsPage(
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

/** The suggestions as a row of pills above the composer: white, hairline-edged, scrolling sideways. */
@Composable
private fun SuggestionChips(suggestions: List<String>, onPick: (String) -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = KitGeometry.GUTTER, vertical = 4.dp)
            .testTag("chat-suggestion-chips"),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        suggestions.forEachIndexed { index, suggestion ->
            // THE BOARD'S SMALL PILL (13 in the meta size, 7 over 12 of padding) inside a 44 target.
            Box(
                Modifier
                    .heightIn(min = KitGeometry.ROW_MIN)
                    .clip(CircleShape)
                    .clickable { onPick(suggestion) }
                    .testTag("chat-suggestion-$index")
                    .semantics { role = Role.Button },
                contentAlignment = Alignment.Center,
            ) {
                Box(
                    Modifier
                        .clip(CircleShape)
                        .background(Surface.card)
                        .border(KitGeometry.HAIRLINE, centraidColor("lineStrong"), CircleShape)
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                ) {
                    KitText(suggestion, KitType.Meta, Surface.ink, maxLines = 1)
                }
            }
        }
    }
}

// ---------------------------------------------------------------- the header --

@Composable
private fun KeyButton(iconKey: String, label: String, tag: String, enabled: Boolean = true, plate: Boolean = false, onClick: () -> Unit) {
    Box(
        Modifier
            .size(KitGeometry.ROW_MIN)
            .clip(CircleShape)
            // THE BOARD'S ROUND KEYS: a white plate with the strong hairline.
            .then(if (plate) Modifier.background(centraidColor("bgElev")).border(KitGeometry.HAIRLINE, centraidColor("lineStrong"), CircleShape) else Modifier)
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

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChatHeader(
    state: ChatState,
    onChats: () -> Unit,
    onNewChat: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
) {
    // THE BOARD'S HEADER: the title and the vault line, round keys at the trailing edge (Chats,
    // then New chat only inside a saved chat), no rule under it. Rename and Delete are a long
    // press on the title.
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Box(Modifier.weight(1f)) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .combinedClickable(enabled = state.can_manage_thread, onClick = {}, onLongClick = { menu = true }),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(
                    state.title,
                    style = centraidType("smallStrong"),
                    color = centraidColor("text"),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.semantics { heading() }.testTag("chat-title"),
                )
                // THE ASSISTANT'S AVATAR is the bare app mark (#1173), small, before the line.
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                    CentraidMark(size = 16.dp)
                    Text(
                        state.subtitle,
                        style = centraidType("mono"),
                        color = centraidColor("textFaint"),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.testTag("chat-subtitle"),
                    )
                }
            }
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = centraidColor("bgElev")) {
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
        KeyButton("History", state.drawer_label, "chat-chats", plate = true, onClick = onChats)
        if (state.can_new_chat) {
            KeyButton("PenLine", state.new_chat_label, "chat-new", plate = true, onClick = onNewChat)
        }
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

/** COPY AND TRY AGAIN, QUIET: the board's thread draws no buttons under an answer, so each is a small icon key in the faint ink; the words are its spoken label. */
@Composable
private fun ActionButton(iconKey: String, label: String, tag: String, onClick: () -> Unit) {
    Box(
        Modifier
            .size(KitGeometry.ROW_MIN)
            .clip(CircleShape)
            .clickable(onClick = onClick)
            .testTag(tag)
            .semantics {
                contentDescription = label
                role = Role.Button
            },
        contentAlignment = Alignment.Center,
    ) {
        CentraidIcon(iconKey, tint = centraidColor("textFaint"), size = 18.dp)
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
                // THE MEMBER'S WORDS ARE AN INK PILL (#1173): ink fill, the page's colour as text.
                Text(
                    message.text,
                    style = centraidType("body"),
                    // In the dark it is the raised grey of the border role with white text, not the
                    // light ink inverted (ChatDark.dc.html).
                    color = if (androidx.compose.foundation.isSystemInDarkTheme()) Color.White else centraidResource(R.color.centraid_surface_page),
                    modifier = Modifier
                        .clip(RoundedCornerShape(dimensionResource(R.dimen.centraid_radius_card) * 1.25f))
                        .background(centraidResource(if (androidx.compose.foundation.isSystemInDarkTheme()) R.color.centraid_surface_border else R.color.centraid_text_ink))
                        .padding(horizontal = 16.dp, vertical = 10.dp),
                )
            }
        }
        return
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        // A proposed write is told by its card; the sentence over it said the same.
        if (message.text.isNotEmpty() && !(message.pending != null && !message.streaming)) {
            MarkdownText(message.text, message.streaming, message.accessibility_label)
        }
        message.cards.forEachIndexed { index, card ->
            CardRow(card, appName = state.scopes.firstOrNull { it.app == card.app }?.name.orEmpty()) { onEvent(ChatEvent(card_tapped = ChatEvent.CardTapped(message_id = message.id, index = index))) }
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
            Row(horizontalArrangement = Arrangement.spacedBy(0.dp)) {
                if (message.text.isNotEmpty()) {
                    ActionButton(if (copied) "Check" else "Copy", if (copied) state.copied_label.ifEmpty { state.copy_label } else state.copy_label, "chat-copy") {
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

/**
 * ONE ROW THE ANSWER FOUND (#1173), drawn in the colour of the app it is from: a white card
 * with a bar down its left edge in that app's colour, the title in ink, the subtitle and meta
 * under it, and the app's name in the app's colour at the right.
 */
@Composable
private fun CardRow(card: ChatCard, appName: String, onOpen: () -> Unit) {
    val shape = RoundedCornerShape(dimensionResource(R.dimen.centraid_radius_card))
    Row(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(centraidResource(R.color.centraid_surface_card))
            .border(KitGeometry.HAIRLINE, centraidResource(R.color.centraid_surface_border), shape)
            .clickable(onClick = onOpen)
            .heightIn(min = KitGeometry.ROW_MIN)
            .height(IntrinsicSize.Min)
            .padding(horizontal = 14.dp, vertical = 12.dp)
            .semantics {
                contentDescription = listOf(card.title, card.subtitle, card.meta, appName).filter { it.isNotEmpty() }.joinToString(", ")
                role = Role.Button
            }
            .testTag("chat-card"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        if (card.app == "people") {
            // A PERSON WEARS INITIALS, as the board's card does, in the app's colour.
            Box(
                Modifier.size(32.dp).clip(CircleShape).background(appAccent(card.app).fill.copy(alpha = 0.16f)),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    card.title.split(" ").filter { it.isNotEmpty() }.take(2).joinToString("") { it.take(1) }.uppercase(),
                    color = appAccent(card.app).text,
                    fontSize = tokenSp(R.dimen.centraid_text_meta),
                    fontWeight = FontWeight.SemiBold,
                )
            }
        } else {
            Box(
                Modifier
                    .width(4.dp)
                    .fillMaxHeight()
                    .clip(CircleShape)
                    .background(appAccent(card.app).fill),
            )
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                card.title,
                color = centraidResource(R.color.centraid_text_ink),
                fontSize = tokenSp(R.dimen.centraid_text_row),
                fontWeight = FontWeight.SemiBold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (card.subtitle.isNotEmpty()) {
                Text(card.subtitle, color = centraidResource(R.color.centraid_text_meta), fontSize = tokenSp(R.dimen.centraid_text_meta), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (card.meta.isNotEmpty()) {
                Text(card.meta, color = centraidResource(R.color.centraid_text_meta), fontSize = tokenSp(R.dimen.centraid_text_meta), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (appName.isNotEmpty()) {
            Text(
                appName,
                color = appAccent(card.app).text,
                fontSize = tokenSp(R.dimen.centraid_text_meta),
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
            )
        }
    }
}

/**
 * A WRITE THE MODEL PROPOSED (#1173), as the "Proposed change" card under its answer: a badge,
 * one line for each row it changes in the core's words, then the way to say yes and "Not now".
 * The card wears the colour of the app whose row it changes (`pending.app`; the shell's teal
 * when it spans apps). Nothing the model wrote reaches the vault before the member confirms:
 * Rust holds the write until `PendingConfirmed`, and this card only sends the event.
 */
@Composable
private fun PendingCard(pending: ChatPending, onConfirm: () -> Unit, onCancel: () -> Unit) {
    val shape = RoundedCornerShape(dimensionResource(R.dimen.centraid_radius_card))
    val asking = pending.state == ChatPending.State.STATE_WAITING || pending.state == ChatPending.State.STATE_WORKING
    val working = pending.state == ChatPending.State.STATE_WORKING
    Row(
        Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(centraidResource(R.color.centraid_surface_card))
            .border(KitGeometry.HAIRLINE, centraidResource(R.color.centraid_surface_border), shape)
            .height(IntrinsicSize.Min)
            .padding(horizontal = 14.dp, vertical = 14.dp)
            .semantics { contentDescription = pending.accessibility_label }
            .testTag("chat-pending"),
    ) {
        // THE BOARD'S CARD IS NEUTRAL: a grey "PROPOSED CHANGE", then each row with the empty ring
        // of a thing not yet done in front of it.
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                pending.title.uppercase(),
                color = centraidResource(R.color.centraid_text_meta),
                fontSize = tokenSp(R.dimen.centraid_text_meta),
                fontWeight = FontWeight.SemiBold,
                letterSpacing = 0.4.sp,
            )
            pending.steps.forEach { step ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Box(Modifier.size(20.dp).border(1.6.dp, centraidColor("textFaint"), CircleShape))
                    // THE ROW'S NAME, then its second line ("Reminders · today, 10:45"); a step the
                    // core did not name by title keeps its composed sentence.
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            step.title.ifEmpty { step.summary },
                            color = centraidResource(if (step.destructive) R.color.centraid_state_red_text else R.color.centraid_text_ink),
                            fontSize = tokenSp(R.dimen.centraid_text_row),
                            fontWeight = FontWeight.SemiBold,
                        )
                        if (step.subtitle.isNotEmpty()) {
                            Text(step.subtitle, color = centraidResource(R.color.centraid_text_meta), fontSize = tokenSp(R.dimen.centraid_text_meta))
                        }
                    }
                }
            }
            if (pending.more_line.isNotEmpty()) {
                Text(pending.more_line, color = centraidResource(R.color.centraid_text_meta), fontSize = tokenSp(R.dimen.centraid_text_meta))
            }
            if (asking) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 4.dp)) {
                    Box(
                        Modifier
                            .weight(1f)
                            .heightIn(min = KitGeometry.ROW_MIN)
                            .clip(CircleShape)
                            .background(centraidResource(if (pending.destructive) R.color.centraid_state_red else R.color.centraid_shell))
                            .clickable(enabled = !working, onClick = onConfirm)
                            .semantics { role = Role.Button }
                            .testTag("chat-confirm"),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(pending.confirm_label, color = Color.White, fontSize = tokenSp(R.dimen.centraid_text_row), fontWeight = FontWeight.SemiBold)
                    }
                    Box(
                        Modifier
                            .weight(1f)
                            .heightIn(min = KitGeometry.ROW_MIN)
                            .clip(CircleShape)
                            .border(1.dp, centraidResource(R.color.centraid_surface_border), CircleShape)
                            .clickable(enabled = !working, onClick = onCancel)
                            .semantics { role = Role.Button }
                            .testTag("chat-cancel"),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(pending.cancel_label, color = centraidResource(R.color.centraid_text_ink), fontSize = tokenSp(R.dimen.centraid_text_row), fontWeight = FontWeight.SemiBold)
                    }
                }
            } else if (pending.settled_line.isNotEmpty()) {
                Text(pending.settled_line, color = centraidResource(R.color.centraid_text_meta), fontSize = tokenSp(R.dimen.centraid_text_meta), modifier = Modifier.testTag("chat-settled"))
            }
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
    val shape = CircleShape
    Column(
        Modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
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
                // THE COMPOSER FLOATS (#1173): Material's tonal elevation, the one shadow on the screen.
                .shadow(3.dp, shape)
                .clip(shape)
                .background(centraidResource(R.color.centraid_surface_card))
                .padding(6.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Box {
                Box(Modifier.size(KitGeometry.ROW_MIN).clip(CircleShape).background(centraidColor("bgSunken"))) {
                    KeyButton("Plus", state.attach_label, "chat-attach", enabled = state.can_attach) { attachMenu = true }
                }
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
            if (state.scopes.isNotEmpty()) ScopePill(state, onScope)
            if (state.streaming) {
                SendKey("Stop", state.stop_label, filled = true, tag = "chat-stop") {
                    onEvent(ChatEvent(stopped = ChatEvent.Stopped()))
                }
            } else {
                val ready = draft.isNotBlank() && !state.vision_blocked
                SendKey("ArrowUp", state.send_label, filled = ready, tag = "chat-send", enabled = ready, onClick = onSend)
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
                .background(centraidColor("bgElev"))
                .border(KitGeometry.HAIRLINE, centraidColor("lineStrong"), CircleShape)
                .clickable { open = true }
                .padding(horizontal = 10.dp)
                .testTag("chat-scope")
                .semantics {
                    contentDescription = state.scope_label + ", " + name
                    role = Role.Button
                },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Text(name, color = centraidColor("text"), fontSize = tokenSp(R.dimen.centraid_text_meta), fontWeight = FontWeight.SemiBold, maxLines = 1)
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
    // THE BOARD'S SEND: a round dark-teal key with a white up arrow; with nothing to send, a quiet
    // disc with a legible soft arrow (the faded key lost its arrow), so it still reads as Send.
    Box(
        Modifier
            .size(KitGeometry.ROW_MIN)
            .clip(CircleShape)
            .background(if (filled) centraidResource(R.color.centraid_shell) else centraidColor("lineStrong"))
            .clickable(enabled = enabled, onClick = onClick)
            .testTag(tag)
            .semantics {
                contentDescription = label
                role = Role.Button
            },
        contentAlignment = Alignment.Center,
    ) {
        CentraidIcon(iconKey, tint = if (filled) Color.White else centraidColor("textSoft"), size = 18.dp)
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
                KitProgressBar(step.progress, fill = centraidResource(R.color.centraid_shell))
            }
            if (step.status_line.isNotEmpty()) {
                Text(step.status_line, style = centraidType("small"), color = centraidColor("textSoft"))
            }
            if (step.action_label.isNotEmpty()) {
                DownloadButton(step.action_label, testTag = "chat-download") {
                    onEvent(ChatEvent(download = ChatEvent.DownloadTapped(vision = false)))
                }
            }
            if (state.error.isNotEmpty()) {
                Text(state.error, style = centraidType("small"), color = centraidColor("net"), modifier = Modifier.testTag("chat-error"))
            }
        }
    }
}

/** THE DOWNLOAD'S ONE ACTION, in the shell's teal as the composer's send is: red is the error colour. */
@Composable
private fun DownloadButton(label: String, testTag: String, onPress: () -> Unit) {
    Box(
        Modifier
            .heightIn(min = KitGeometry.ROW_MIN)
            .clip(CircleShape)
            .background(centraidResource(R.color.centraid_shell))
            .clickable(onClick = onPress)
            .padding(horizontal = 20.dp)
            .semantics { role = Role.Button }
            .testTag(testTag),
        contentAlignment = Alignment.Center,
    ) {
        Text(label, color = Color.White, fontSize = tokenSp(R.dimen.centraid_text_row), fontWeight = FontWeight.SemiBold)
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
        if (step.progress_known) KitProgressBar(step.progress, fill = centraidResource(R.color.centraid_shell))
        if (step.status_line.isNotEmpty()) {
            Text(step.status_line, style = centraidType("small"), color = centraidColor("textSoft"))
        }
        if (step.action_label.isNotEmpty()) {
            DownloadButton(step.action_label, testTag = "chat-vision-download", onPress = onDownload)
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

// ------------------------------------------------------------------ the Chats page --

/**
 * THE PAST CHATS, a page of their own over the thread: a chevron back to the chat, the list newest
 * first, and the search key at the foot where every app keeps it. No band is drawn under it.
 */
@Composable
private fun ChatsPage(
    state: ChatState,
    onEvent: (ChatEvent) -> Unit,
    onDelete: (String) -> Unit,
    onRename: (String, String) -> Unit,
    onDeleteAll: () -> Unit,
) {
    val close = { onEvent(ChatEvent(drawer = ChatEvent.DrawerToggled(opened = false))) }
    androidx.activity.compose.BackHandler(onBack = { close() })
    Column(
        Modifier
            .fillMaxSize()
            .background(Surface.plainPage)
            .testTag("chat-chats-page"),
    ) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)) {
            KeyButton("ChevronLeft", state.close_label, "chat-chats-back", plate = true, onClick = close)
        }
        Text(
            state.drawer_label,
            style = kitTextStyle(KitType.Title),
            color = Surface.ink,
            modifier = Modifier.padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp).semantics { heading() },
        )
        LazyColumn(Modifier.weight(1f)) {
            if (state.threads.isEmpty() && state.threads_empty_line.isNotEmpty()) {
                item(key = "empty") {
                    Text(
                        state.threads_empty_line,
                        style = kitTextStyle(KitType.Meta),
                        color = Surface.meta,
                        modifier = Modifier.padding(KitGeometry.GUTTER).testTag("chat-chats-empty"),
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
            if (state.can_delete_all) {
                item(key = "delete-all") {
                    Text(
                        state.delete_all_label,
                        style = kitTextStyle(KitType.Meta).copy(fontWeight = FontWeight.SemiBold),
                        color = StateColor.Red.text,
                        modifier = Modifier
                            .fillMaxWidth()
                            .heightIn(min = KitGeometry.ROW_MIN)
                            .clickable(onClick = onDeleteAll)
                            .padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp)
                            .testTag("chat-chats-delete-all"),
                    )
                }
            }
        }
        val search = state.drawer_search
        SearchFoot(
            RoomSearch(
                field = SearchField(
                    open_ = search?.open_ == true,
                    term = search?.term.orEmpty(),
                    corrected = search?.corrected.orEmpty(),
                    corrected_label = search?.corrected_label.orEmpty(),
                ),
                placeholder = state.drawer_search_placeholder,
                onTerm = { onEvent(ChatEvent(drawer_search_term = ChatEvent.DrawerSearchTerm(term = it))) },
                onClose = { onEvent(ChatEvent(drawer_search_closed = ChatEvent.DrawerSearchClosed())) },
                label = state.drawer_search_placeholder,
                closeLabel = state.close_label,
                onOpen = { onEvent(ChatEvent(drawer_search_opened = ChatEvent.DrawerSearchOpened())) },
            ),
            testTag = "chat-chats-search",
        )
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
            .background(if (row.current) Surface.fill else androidx.compose.ui.graphics.Color.Transparent)
            .clickable(onClick = onOpen)
            .heightIn(min = KitGeometry.ROW_MIN)
            .semantics { contentDescription = row.accessibility_label; role = Role.Button }
            .testTag("chat-thread-row"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(width = 3.dp, height = 28.dp).background(if (row.current) Surface.ink else androidx.compose.ui.graphics.Color.Transparent))
        Column(Modifier.weight(1f).padding(horizontal = 13.dp, vertical = 8.dp)) {
            Text(row.title, style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold), color = Surface.ink, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (row.ago.isNotEmpty()) KitText(row.ago, KitType.Meta, Surface.meta)
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
