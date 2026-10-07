import SwiftUI
import UIKit

#if canImport(CentraidShared)
import CentraidShared
#endif

/// THE CHAT TAB (`chat`, `screen.proto`'s Chat section).
///
/// **THIS VIEW DECIDES NOTHING.** Which phase the chat is in, what the thread
/// holds, which suggestions to offer, whether Stop or Send is drawn, every
/// label — all of it arrives in `ChatState`. What is local here is what a
/// keystroke is before it is sent (the draft), where the thread is scrolled,
/// and that a Copy was just pressed.
///
/// It is a tab, not an app: Home draws it in place of the springboard with the
/// band still at the foot, and a card pushes the real row's route onto the
/// shell's stack, so back returns here.
///
/// **THE HEADER IS THE CHAT'S OWN** (R-CHAT-2): the drawer's control on the
/// left, the open chat's title with the vault beside it in the middle, and a
/// menu on the right (New chat, Rename, Delete). It replaces the vault lockup
/// this tab used to stack above a "Chat" title — the vault is named on the second
/// line, and switching it is Home's.
///
/// **THE DRAWER** slides in from the left over the thread and the composer and
/// stops short of the band, so Home is always one press away and the Chat tab
/// pressed again only shuts it. Past chats are newest first with how long ago;
/// the open one is marked; a swipe reveals Delete, which asks first.
///
/// **ONE FILLED INK ELEMENT.** The composer's Send (Stop while a turn runs) is
/// the only one. Everything else is ink over paper: outlined actions, raised
/// cards, a chip. The model step's one action (and the photo reader's
/// "Download") is outlined in `net`, because it is the only moment Centraid
/// reaches the network.
///
/// **THE COMPOSER IS ONE CARD** (`ChatComposerCard`): the waiting attachments
/// and any notice about them on top, the field, and one row of controls — attach,
/// the chat's scope, send. The status line ("Looking in Tally…") sits just above
/// it while a turn runs.
struct ChatView: View {
    @ObservedObject var chat: ChatModel
    /// Whether the composer has focus. Home hides the band (and the lockup)
    /// while it does, so the composer takes the keyboard's top edge as the
    /// system's own search does.
    @Binding var typing: Bool
    let onOpenCard: (Centraid_Screen_V1_ChatCard, [Centraid_Screen_V1_ChatCard]) -> Void
    /// A scope chosen from the composer's menu: an app id, or empty for every app.
    let onSetScope: (String) -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var draft = ""
    @FocusState private var focused: Bool
    /// A chat the member is renaming, with the name being typed.
    @State private var renaming = false
    @State private var renameText = ""
    /// A chat the member asked to delete, until they confirm or cancel.
    @State private var deleting: DeleteTarget?
    @State private var deletingAll = false
    /// The card whose row was gone when it was tapped, for the moment its line shows.
    @State private var goneCard: String?
    /// The thread's foot is on screen: new text follows it. A member who has
    /// scrolled up to read is not pulled back down.
    @State private var pinned = true
    /// The message whose Copy was just pressed, for the one beat "Copied" shows.
    @State private var copied: UInt64?

    private static let bottomID = "chat-bottom"

    var body: some View {
        let state = chat.state
        ZStack(alignment: .leading) {
            VStack(alignment: .leading, spacing: 0) {
                ChatHeader(
                    state: state,
                    onDrawer: {
                        focused = false
                        chat.toggleDrawer(true)
                    },
                    onNewChat: {
                        draft = ""
                        chat.newChat()
                    },
                    onRename: {
                        renameText = state.title
                        renaming = true
                    },
                    onDelete: { deleting = DeleteTarget(id: state.threadID, title: state.title) }
                )
                switch state.phase {
                case .ready:
                    thread(state)
                    composer(state)
                case .needsModel, .downloading, .loading, .unavailable:
                    ChatModelStepView(state: state, onDownload: { chat.downloadTapped() })
                    Spacer(minLength: 0)
                case .checking, .unspecified, .UNRECOGNIZED:
                    Spacer(minLength: 0)
                }
            }
            // Behind the drawer the chat is not there for a screen reader.
            .accessibilityHidden(state.drawerOpen)

            if state.drawerOpen {
                ChatDrawer(
                    state: state,
                    onClose: { chat.toggleDrawer(false) },
                    onNewChat: {
                        draft = ""
                        chat.newChat()
                    },
                    onOpen: { chat.openThread($0) },
                    onDelete: { deleting = DeleteTarget(id: $0.threadID, title: $0.title) },
                    onDeleteAll: { deletingAll = true }
                )
                .transition(reduceMotion ? .opacity : .move(edge: .leading).combined(with: .opacity))
                .zIndex(1)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .animation(reduceMotion ? nil : ChatMotion.entry, value: state.drawerOpen)
        .onChange(of: focused) { _, now in typing = now }
        .onDisappear { typing = false }
        .accessibilityIdentifier("chat")
        .alert(state.renameTitle, isPresented: $renaming) {
            TextField(state.renameTitle, text: $renameText)
            Button(state.saveLabel) {
                chat.renameThread(state.threadID, title: renameText)
            }
            Button(state.cancelLabel, role: .cancel) {}
        }
        .alert(
            state.deleteTitle,
            isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
            presenting: deleting
        ) { target in
            Button(state.deleteLabel, role: .destructive) {
                chat.deleteThread(target.id)
                deleting = nil
            }
            Button(state.cancelLabel, role: .cancel) { deleting = nil }
        } message: { target in
            Text(target.title + "\n" + state.deleteBody)
        }
        .alert(state.deleteAllTitle, isPresented: $deletingAll) {
            Button(state.deleteAllLabel, role: .destructive) {
                chat.deleteAllThreads()
                deletingAll = false
            }
            Button(state.cancelLabel, role: .cancel) { deletingAll = false }
        } message: {
            Text(state.deleteAllBody)
        }
    }

    // MARK: The thread

    private func thread(_ state: Centraid_Screen_V1_ChatState) -> some View {
        let lastAnswer = state.messages.last(where: { $0.role == .assistant })?.id
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if state.messages.isEmpty {
                        ChatEmpty(state: state, onPick: { send($0) })
                    }
                    ForEach(state.messages, id: \.id) { message in
                        ChatMessageRow(
                            message: message,
                            state: state,
                            isLast: message.id == lastAnswer,
                            copied: copied == message.id,
                            goneCard: goneCard,
                            onCopy: { copy(message.id) },
                            onRetry: { chat.regenerate() },
                            onOpenCard: { card, index in open(card, at: index, of: message) }
                        )
                    }
                    if !state.error.isEmpty, !state.streaming {
                        ChatErrorLine(state: state, onRetry: { chat.regenerate() })
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(Self.bottomID)
                        .onAppear { pinned = true }
                        .onDisappear { pinned = false }
                }
                .padding(.horizontal, CentraidGeometry.pageMargin)
                .padding(.top, 16)
                .padding(.bottom, 8)
            }
            // DRAGGING THE THREAD DOWN DISMISSES THE KEYBOARD, and so does a tap
            // anywhere outside the composer: while the composer has focus the band
            // steps aside, so this is the way back to Home.
            .scrollDismissesKeyboard(.interactively)
            // A thread shorter than the screen does not scroll, so the system's
            // own interactive dismissal has nothing to drag: a downward drag
            // anywhere on the thread dismisses too.
            .simultaneousGesture(
                DragGesture(minimumDistance: 12).onEnded { drag in
                    if drag.translation.height > 24 { focused = false }
                }
            )
            .simultaneousGesture(TapGesture().onEnded { focused = false })
            .accessibilityIdentifier("chat-thread")
            // A send, a retry or a new chat changes how many messages there
            // are: that is the member's own act, so it always goes to the foot.
            .onChange(of: state.messages.count) { _, _ in
                pinned = true
                scrollToFoot(proxy)
            }
            // Streaming text, cards and the activity line follow the foot only
            // while the member is at it.
            .onChange(of: follow(state)) { _, _ in
                if pinned { scrollToFoot(proxy, animated: false) }
            }
            .onChange(of: focused) { _, now in
                if now, pinned { scrollToFoot(proxy) }
            }
        }
    }

    /// Everything that makes the thread grow without adding a message.
    private func follow(_ state: Centraid_Screen_V1_ChatState) -> [Int] {
        let last = state.messages.last
        return [last?.text.count ?? 0, last?.cards.count ?? 0, state.activity.count, state.error.count]
    }

    private func scrollToFoot(_ proxy: ScrollViewProxy, animated: Bool = true) {
        DispatchQueue.main.async {
            if animated, !reduceMotion {
                withAnimation(ChatMotion.entry) { proxy.scrollTo(Self.bottomID, anchor: .bottom) }
            } else {
                proxy.scrollTo(Self.bottomID, anchor: .bottom)
            }
        }
    }

    // MARK: The composer

    private func composer(_ state: Centraid_Screen_V1_ChatState) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // THE STATUS LINE, just above the card while a turn runs: what the
            // model is doing, in muted ink. It replaces the thread's "…".
            if state.streaming, !state.activity.isEmpty {
                Text(state.activity + "…")
                    .chatType("mono")
                    .foregroundStyle(Theme.color("textFaint", scheme))
                    .padding(.horizontal, 4)
                    .transition(.opacity)
                    .accessibilityIdentifier("chat-activity")
            }
            ChatComposerCard(
                chat: chat,
                state: state,
                draft: $draft,
                focused: $focused,
                onSend: { send($0) },
                onSetScope: onSetScope
            )
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .animation(reduceMotion ? nil : ChatMotion.state, value: state.streaming)
        .animation(reduceMotion ? nil : ChatMotion.state, value: state.activity)
    }

    private func send(_ text: String) {
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty else { return }
        draft = ""
        chat.send(line)
    }

    /// A card was tapped: ask the vault whether its row is still there. A card
    /// is a snapshot with no reference to its row, so a row deleted since the
    /// answer is said to be gone instead of opening an empty screen.
    private func open(_ card: Centraid_Screen_V1_ChatCard, at index: Int, of message: Centraid_Screen_V1_ChatMessage) {
        chat.cardLive(card) { live in
            if live {
                onOpenCard(card, message.cards)
            } else {
                let key = "\(message.id)-\(index)"
                goneCard = key
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                    if goneCard == key { goneCard = nil }
                }
            }
        }
    }

    private func copy(_ id: UInt64) {
        chat.copy(id)
        copied = id
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
            if copied == id { copied = nil }
        }
    }
}

// MARK: - Motion

/// DESIGN.md invariant 5, lowered for this screen: entry at 280 ms on the entry
/// curve, a state change at 140 ms. Reduced motion drops both at the call site.
enum ChatMotion {
    static let entry = Animation.timingCurve(0.2, 0.7, 0.2, 1, duration: 0.28)
    static let state = Animation.timingCurve(0.2, 0.7, 0.2, 1, duration: 0.14)
}

// MARK: - Header

/// WHAT THE MEMBER ASKED TO DELETE, until they say yes.
private struct DeleteTarget: Identifiable {
    let id: String
    let title: String
}

/// THE CHAT'S HEADER: the drawer's control on the left, the open chat's title
/// and where it runs in the middle, and a menu on the right. Ink on paper and
/// outlined, never filled: the composer's Send is this screen's one filled
/// element.
private struct ChatHeader: View {
    let state: Centraid_Screen_V1_ChatState
    let onDrawer: () -> Void
    let onNewChat: () -> Void
    let onRename: () -> Void
    let onDelete: () -> Void
    @Environment(\.colorScheme) private var scheme

    private var hasMenu: Bool { state.canNewChat || state.canManageThread }

    var body: some View {
        HStack(alignment: .center, spacing: 4) {
            Button(action: onDrawer) {
                CentraidIconView(iconKey: "Menu", tint: Theme.color("text", scheme), size: 22)
                    .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(state.drawerLabel)
            .accessibilityIdentifier("chat-drawer")

            VStack(alignment: .center, spacing: 0) {
                Text(verbatim: state.title)
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("chat-title")
                Text(verbatim: state.subtitle)
                    .centraidType("mono")
                    .foregroundStyle(Theme.color("textFaint", scheme))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .accessibilityIdentifier("chat-subtitle")
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)

            Menu {
                if state.canNewChat {
                    Button(state.newChatLabel, action: onNewChat)
                        .accessibilityIdentifier("chat-menu-new")
                }
                if state.canManageThread {
                    Button(state.renameLabel, action: onRename)
                        .accessibilityIdentifier("chat-menu-rename")
                    Button(state.deleteLabel, role: .destructive, action: onDelete)
                        .accessibilityIdentifier("chat-menu-delete")
                }
            } label: {
                CentraidIconView(iconKey: "MoreVert", tint: Theme.color("text", scheme), size: 22)
                    .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                    .contentShape(Rectangle())
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .disabled(!hasMenu)
            .opacity(hasMenu ? 1 : 0.4)
            .accessibilityLabel(state.menuLabel)
            .accessibilityIdentifier("chat-menu")
        }
        .padding(.horizontal, CentraidGeometry.pageMargin - 8)
        .padding(.top, 8)
        .padding(.bottom, 4)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Theme.color("line", scheme))
                .frame(height: CentraidGeometry.hairline)
        }
    }
}

// MARK: - The drawer

/// THE PAST CHATS, sliding in from the left over the thread.
///
/// Width is the lesser of 320 and 84% of the screen, so a sliver of the chat
/// stays to tap away to; the scrim is the system's own `scrim` role. The new-chat
/// row is outlined, the open chat is marked by an ink rule and a sunken ground,
/// and Delete is a swipe away and asks first. Entry is the 280 ms curve, which
/// the caller's transition and animation own and reduced motion replaces with a
/// fade.
private struct ChatDrawer: View {
    let state: Centraid_Screen_V1_ChatState
    let onClose: () -> Void
    let onNewChat: () -> Void
    let onOpen: (String) -> Void
    let onDelete: (Centraid_Screen_V1_ChatThreadItem) -> Void
    let onDeleteAll: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        GeometryReader { proxy in
            let width = min(320, proxy.size.width * 0.84)
            ZStack(alignment: .leading) {
                Theme.color("scrim", scheme)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture(perform: onClose)
                    .accessibilityHidden(true)
                panel(width: width)
            }
        }
    }

    private func panel(width: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: state.drawerLabel)
                .centraidType("title")
                .foregroundStyle(Theme.color("text", scheme))
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 12)
                .accessibilityAddTraits(.isHeader)

            Button(action: onNewChat) {
                HStack(spacing: 8) {
                    CentraidIconView(iconKey: "Plus", tint: Theme.color("text", scheme), size: 16)
                    Text(verbatim: state.newChatLabel)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
                .overlay(
                    RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                        .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)
            .padding(.bottom, 12)
            .accessibilityIdentifier("chat-drawer-new")

            if state.threads.isEmpty {
                Text(verbatim: state.threadsEmptyLine)
                    .centraidType("small")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
                    .accessibilityIdentifier("chat-drawer-empty")
                Spacer(minLength: 0)
            } else {
                List {
                    ForEach(state.threads, id: \.threadID) { row in
                        ChatThreadRow(row: row, currentLabel: state.currentLabel)
                            .contentShape(Rectangle())
                            .onTapGesture { onOpen(row.threadID) }
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button(role: .destructive) {
                                    onDelete(row)
                                } label: {
                                    Text(verbatim: state.deleteLabel)
                                }
                                .tint(Theme.color("danger", scheme))
                            }
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(row.accessibilityLabel)
                            .accessibilityAddTraits(.isButton)
                            .accessibilityAction(named: state.deleteLabel) { onDelete(row) }
                            .accessibilityIdentifier("chat-thread-row")
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .accessibilityIdentifier("chat-drawer-list")

                Button(action: onDeleteAll) {
                    Text(verbatim: state.deleteAllLabel)
                        .centraidType("smallStrong")
                        .foregroundStyle(Theme.color("danger", scheme))
                        .padding(.horizontal, 12)
                        .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .overlay(alignment: .top) {
                    Rectangle()
                        .fill(Theme.color("line", scheme))
                        .frame(height: CentraidGeometry.hairline)
                }
                .accessibilityIdentifier("chat-drawer-delete-all")
            }
        }
        .frame(width: width, alignment: .leading)
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.color("bg", scheme).ignoresSafeArea(edges: .top))
        .overlay(alignment: .trailing) {
            Rectangle()
                .fill(Theme.color("line", scheme))
                .frame(width: CentraidGeometry.hairline)
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityIdentifier("chat-drawer-panel")
    }
}

/// ONE PAST CHAT: its title over how long ago it moved. The open one carries an
/// ink rule on its leading edge and a sunken ground; nothing is filled.
private struct ChatThreadRow: View {
    let row: Centraid_Screen_V1_ChatThreadItem
    let currentLabel: String
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        HStack(spacing: 0) {
            Rectangle()
                .fill(row.current ? Theme.color("text", scheme) : Color.clear)
                .frame(width: 2)
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: row.title)
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                if !row.ago.isEmpty {
                    Text(verbatim: row.ago)
                        .centraidType("mono")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        }
        .background(row.current ? Theme.color("bgSunken", scheme) : Color.clear)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Theme.color("line", scheme))
                .frame(height: CentraidGeometry.hairline)
        }
    }
}

// MARK: - The empty thread

private struct ChatEmpty: View {
    let state: Centraid_Screen_V1_ChatState
    let onPick: (String) -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !state.emptyLine.isEmpty {
                Text(state.emptyLine)
                    .chatType("body")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .accessibilityIdentifier("chat-empty")
            }
            ForEach(Array(state.suggestions.enumerated()), id: \.offset) { index, text in
                Button { onPick(text) } label: {
                    HStack(spacing: 8) {
                        Text(text)
                            .chatType("small")
                            .foregroundStyle(Theme.color("text", scheme))
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        CentraidIconView(iconKey: "ArrowRight", tint: Theme.color("textSoft", scheme), size: 16)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .frame(minHeight: CentraidGeometry.targetMinCoarse)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                            .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("chat-suggestion-\(index)")
            }
        }
    }
}

// MARK: - Messages

private struct ChatMessageRow: View {
    let message: Centraid_Screen_V1_ChatMessage
    let state: Centraid_Screen_V1_ChatState
    /// The last answer in the thread: Retry is drawn on it.
    let isLast: Bool
    let copied: Bool
    /// `"<message id>-<card index>"` of the card whose row was gone when tapped.
    let goneCard: String?
    let onCopy: () -> Void
    let onRetry: () -> Void
    let onOpenCard: (Centraid_Screen_V1_ChatCard, Int) -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if message.role == .user {
            HStack(spacing: 0) {
                Spacer(minLength: 56)
                VStack(alignment: .trailing, spacing: 8) {
                    // WHAT THE MEMBER ATTACHED: a marker and a thumbnail, never
                    // the photograph again.
                    ForEach(message.attachments, id: \.id) { attachment in
                        ChatAttachmentChip(attachment: attachment)
                    }
                    Text(verbatim: message.text)
                        .chatType("body")
                        .foregroundStyle(Theme.color("text", scheme))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(
                            RoundedRectangle(cornerRadius: Theme.radius("lg", scheme))
                                .fill(Theme.color("bgElev", scheme))
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.radius("lg", scheme))
                                .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
                        )
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(message.accessibilityLabel)
                .accessibilityIdentifier("chat-message-user")
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                if !message.text.isEmpty {
                    // THE ANSWER'S MARKDOWN as styling, never as its markers.
                    ChatMarkdownText(
                        text: message.text,
                        streaming: message.streaming,
                        spoken: message.accessibilityLabel
                    )
                    .accessibilityIdentifier("chat-message-answer")
                }
                ForEach(Array(message.cards.enumerated()), id: \.offset) { index, card in
                    VStack(alignment: .leading, spacing: 4) {
                        ChatCardRow(card: card, onOpen: { onOpenCard(card, index) })
                            .accessibilityIdentifier("chat-card-\(index)")
                        if goneCard == "\(message.id)-\(index)" {
                            Text(verbatim: state.cardGoneLine)
                                .chatType("mono")
                                .foregroundStyle(Theme.color("textSoft", scheme))
                                .padding(.horizontal, 4)
                                .accessibilityIdentifier("chat-card-gone")
                        }
                    }
                }
                if !message.note.isEmpty {
                    Text(verbatim: message.note)
                        .chatType("mono")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                        .accessibilityIdentifier("chat-note")
                }
                if !message.streaming, !message.text.isEmpty || !message.cards.isEmpty {
                    actions
                }
            }
        }
    }

    private var actions: some View {
        HStack(spacing: 8) {
            if !message.text.isEmpty {
                ChatActionButton(
                    iconKey: "Copy",
                    label: copied ? copiedLabel : state.copyLabel,
                    identifier: "chat-copy",
                    action: onCopy
                )
            }
            if isLast, state.canRetry {
                ChatActionButton(
                    iconKey: "Refresh",
                    label: state.retryLabel,
                    identifier: "chat-retry",
                    action: onRetry
                )
            }
        }
    }

    private var copiedLabel: String { ChatWords.copied.isEmpty ? state.copyLabel : ChatWords.copied }
}

/// A small outlined action under an answer: ink on paper, 44 tall to touch.
private struct ChatActionButton: View {
    let iconKey: String
    let label: String
    let identifier: String
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                CentraidIconView(iconKey: iconKey, tint: Theme.color("textSoft", scheme), size: 14)
                Text(label)
                    .centraidType("control")
                    .foregroundStyle(Theme.color("textSoft", scheme))
            }
            .padding(.horizontal, 10)
            .frame(minHeight: 32)
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                    .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
            )
            .frame(minHeight: CentraidGeometry.targetMinCoarse)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
    }
}

/// One failed turn: a sentence and the way to ask again.
private struct ChatErrorLine: View {
    let state: Centraid_Screen_V1_ChatState
    let onRetry: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(state.error)
                .chatType("small")
                .foregroundStyle(Theme.color("danger", scheme))
                .accessibilityIdentifier("chat-error")
            if state.canRetry {
                ChatActionButton(iconKey: "Refresh", label: state.retryLabel, identifier: "chat-error-retry", action: onRetry)
            }
        }
    }
}

// MARK: - Result cards

/// ONE ROW THE ANSWER FOUND, drawn compactly: the app's mark, the row's title,
/// its subtitle and meta, and the trailing arrow that says it opens. Raised
/// paper, darker than the page in light; the app's hue lives in the mark alone.
private struct ChatCardRow: View {
    let card: Centraid_Screen_V1_ChatCard
    let onOpen: () -> Void
    @Environment(\.colorScheme) private var scheme

    private var appName: String { CentraidCatalog.byID[card.app]?.name ?? card.app.capitalized }

    private var spoken: String {
        [card.title, card.subtitle, card.meta, appName].filter { !$0.isEmpty }.joined(separator: ", ")
    }

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 12) {
                AppMark(appID: card.app, size: 32)
                VStack(alignment: .leading, spacing: 0) {
                    Text(verbatim: card.title)
                        .chatType("smallStrong")
                        .foregroundStyle(Theme.color("text", scheme))
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    if !card.subtitle.isEmpty {
                        Text(verbatim: card.subtitle)
                            .chatType("mono")
                            .foregroundStyle(Theme.color("textSoft", scheme))
                            .lineLimit(1)
                    }
                    if !card.meta.isEmpty {
                        Text(verbatim: card.meta)
                            .chatType("mono")
                            .foregroundStyle(Theme.color("textFaint", scheme))
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                CentraidIconView(iconKey: "ChevronRight", tint: Theme.color("textFaint", scheme), size: 16)
            }
            .padding(12)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: Theme.radius("lg", scheme))
                    .fill(Theme.color("bgElev", scheme))
            )
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radius("lg", scheme))
                    .strokeBorder(Theme.color("line", scheme), lineWidth: CentraidGeometry.hairline)
            )
            .contentShape(RoundedRectangle(cornerRadius: Theme.radius("lg", scheme)))
        }
        .buttonStyle(ChatCardPress())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
        .accessibilityAddTraits(.isButton)
    }
}

private struct ChatCardPress: ButtonStyle {
    @Environment(\.colorScheme) private var scheme

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .overlay(
                RoundedRectangle(cornerRadius: Theme.radius("lg", scheme))
                    .fill(configuration.isPressed ? Theme.color("bgPress", scheme) : Color.clear)
            )
    }
}

// MARK: - The composer card

/// WHAT THE COMPOSER OPENS FROM THE ATTACH MENU.
private enum ChatAttachSheet: String, Identifiable {
    case vaultPhoto
    case library
    case document

    var id: String { rawValue }
}

/// THE COMPOSER: ONE ROUNDED CARD OF RAISED PAPER above the band or the
/// keyboard.
///
/// Top to bottom — the waiting attachments, then the photo reader's step when
/// a photo is waiting for it, then the field (it grows to four lines), then one
/// row: the attach menu (a circle outlined with a plus), the chat's scope (a
/// pill that opens a menu), a spacer, and Send. Send is the screen's one filled
/// element; it becomes a filled Stop while a turn runs. The row leaves room
/// where a microphone would go: system dictation is on the keyboard.
private struct ChatComposerCard: View {
    @ObservedObject var chat: ChatModel
    let state: Centraid_Screen_V1_ChatState
    @Binding var draft: String
    var focused: FocusState<Bool>.Binding
    let onSend: (String) -> Void
    let onSetScope: (String) -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var sheet: ChatAttachSheet?

    private static let radius: CGFloat = 20

    var body: some View {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        VStack(alignment: .leading, spacing: 8) {
            if !state.pending.isEmpty {
                // Two at most: a photograph and a document.
                HStack(spacing: 8) {
                    ForEach(state.pending, id: \.id) { attachment in
                        ChatAttachmentChip(
                            attachment: attachment,
                            removeLabel: state.removeAttachmentLabel,
                            onRemove: { chat.removeAttachment(attachment.id) }
                        )
                    }
                    Spacer(minLength: 0)
                }
            }
            if state.hasVisionStep {
                ChatVisionBanner(step: state.visionStep, onDownload: { chat.visionDownloadTapped() })
            }
            TextField(
                text: $draft,
                prompt: Text(state.composerPlaceholder).foregroundStyle(Theme.color("textGhost", scheme)),
                axis: .vertical
            ) {
                Text(state.composerPlaceholder)
            }
            .focused(focused)
            .lineLimit(1...4)
            .chatType("body")
            .foregroundStyle(Theme.color("text", scheme))
            .tint(Theme.color("text", scheme))
            .padding(.horizontal, 4)
            .frame(minHeight: 28, alignment: .topLeading)
            .accessibilityIdentifier("chat-field")

            HStack(spacing: 8) {
                attachMenu
                ChatScopePill(app: state.scopeApp, label: state.scopeApp, onSetScope: onSetScope)
                Spacer(minLength: 0)
                if state.streaming {
                    ChatSendButton(
                        iconKey: "Stop",
                        spoken: state.stopLabel,
                        filled: true,
                        identifier: "chat-stop",
                        action: { chat.stop() }
                    )
                } else {
                    ChatSendButton(
                        iconKey: "PaperPlaneTilt",
                        spoken: state.sendLabel,
                        filled: !trimmed.isEmpty && !state.visionBlocked,
                        identifier: "chat-send",
                        action: { onSend(trimmed) }
                    )
                    .disabled(trimmed.isEmpty || state.visionBlocked)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Self.radius, style: .continuous)
                .fill(Theme.color("bgElev", scheme))
        )
        .overlay(
            RoundedRectangle(cornerRadius: Self.radius, style: .continuous)
                .strokeBorder(Theme.color("line", scheme), lineWidth: CentraidGeometry.hairline)
        )
        .animation(reduceMotion ? nil : ChatMotion.state, value: state.pending.count)
        .animation(reduceMotion ? nil : ChatMotion.state, value: state.hasVisionStep)
        .sheet(item: $sheet) { which in
            switch which {
            case .vaultPhoto:
                ChatVaultPhotoSheet(chat: chat) { assetID, thumbnail in
                    chat.attachVaultPhoto(assetID: assetID, thumbnail: thumbnail)
                }
            case .document:
                ChatDocumentSheet(chat: chat) { docID, title in
                    chat.attachDocument(docID: docID, title: title)
                }
            case .library:
                LibraryPhotoPicker { data in
                    guard let data else { return }
                    DispatchQueue.global(qos: .userInitiated).async {
                        guard let prepared = LibraryPhoto.prepare(data) else { return }
                        DispatchQueue.main.async {
                            chat.attachLibraryPhoto(jpeg: prepared.jpeg, thumbnail: prepared.thumbnail)
                        }
                    }
                }
                .ignoresSafeArea()
            }
        }
    }

    /// A CIRCLE OUTLINED WITH A PLUS: never filled.
    private var attachMenu: some View {
        Menu {
            Button(state.attachVaultPhotoLabel) { sheet = .vaultPhoto }
                .accessibilityIdentifier("chat-attach-vault-photo")
            Button(state.attachLibraryPhotoLabel) { sheet = .library }
                .accessibilityIdentifier("chat-attach-library-photo")
            Button(state.attachDocumentLabel) { sheet = .document }
                .accessibilityIdentifier("chat-attach-document")
        } label: {
            CentraidIconView(iconKey: "Plus", tint: Theme.color("text", scheme), size: 18)
                .frame(width: 36, height: 36)
                .overlay(Circle().strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline))
                .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                .contentShape(Circle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .disabled(!state.canAttach)
        .opacity(state.canAttach ? 1 : 0.4)
        .accessibilityLabel(state.attachLabel)
        .accessibilityIdentifier("chat-attach")
    }
}

/// THE CHAT'S SCOPE, as a pill that opens a menu: every app, or one.
private struct ChatScopePill: View {
    let app: String
    let label: String
    let onSetScope: (String) -> Void
    @Environment(\.colorScheme) private var scheme

    private func name(_ id: String) -> String {
        id.isEmpty ? ChatWords.scopeAll : (CentraidCatalog.byID[id]?.name ?? id.capitalized)
    }

    var body: some View {
        Menu {
            Button(ChatWords.scopeAll) { onSetScope("") }
                .accessibilityIdentifier("chat-scope-all")
            ForEach(ChatRouting.scopable, id: \.self) { id in
                Button(name(id)) { onSetScope(id) }
                    .accessibilityIdentifier("chat-scope-\(id)")
            }
        } label: {
            HStack(spacing: 6) {
                if !app.isEmpty {
                    AppMark(appID: app, size: 20)
                }
                Text(name(app))
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(1)
                CentraidIconView(iconKey: "ChevronDown", tint: Theme.color("textSoft", scheme), size: 14)
            }
            .padding(.horizontal, 12)
            .frame(height: 32)
            .overlay(Capsule().strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline))
            .frame(minHeight: CentraidGeometry.targetMinCoarse)
            .contentShape(Capsule())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .accessibilityLabel(ChatWords.scopeLabel + ", " + name(app))
        .accessibilityIdentifier("chat-scope")
    }
}

/// ONE ATTACHMENT, as a chip: a thumbnail (a photograph) or a document mark, the
/// name, and — in the composer — the way to take it out. Outlined, never filled.
private struct ChatAttachmentChip: View {
    let attachment: Centraid_Screen_V1_ChatAttachment
    var removeLabel: String = ""
    var onRemove: (() -> Void)?
    @Environment(\.colorScheme) private var scheme

    private var isPhoto: Bool { attachment.kind == .photo }

    var body: some View {
        HStack(spacing: 8) {
            ZStack {
                Theme.color("skel", scheme)
                if isPhoto, !attachment.thumbnailPath.isEmpty {
                    ContentImage(path: attachment.thumbnailPath)
                } else {
                    CentraidIconView(
                        iconKey: isPhoto ? "Image" : "FileText",
                        tint: Theme.color("textSoft", scheme),
                        size: 18
                    )
                }
            }
            .frame(width: 32, height: 32)
            .clipShape(RoundedRectangle(cornerRadius: Theme.radius("sm", scheme)))
            Text(verbatim: attachment.label)
                .centraidType("smallStrong")
                .foregroundStyle(Theme.color("text", scheme))
                .lineLimit(1)
                .frame(maxWidth: 160, alignment: .leading)
            if let onRemove {
                Button(action: onRemove) {
                    CentraidIconView(iconKey: "X", tint: Theme.color("textSoft", scheme), size: 14)
                        .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.trailing, -8)
                .accessibilityLabel(removeLabel + ", " + attachment.label)
                .accessibilityIdentifier("chat-attachment-remove")
            }
        }
        .padding(.leading, 4)
        .padding(.trailing, 12)
        .padding(.vertical, 4)
        .overlay(
            RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
        )
        .accessibilityElement(children: onRemove == nil ? .ignore : .contain)
        .accessibilityLabel(attachment.label)
        .accessibilityIdentifier("chat-attachment")
    }
}

/// THE PHOTO READER'S STEP, as a compact notice inside the composer card: one
/// line and one action. The second download is the only other moment Centraid
/// reaches the network, so its words and its action are in `net`.
private struct ChatVisionBanner: View {
    let step: Centraid_Screen_V1_ChatModelStep
    let onDownload: () -> Void
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if !step.actionLabel.isEmpty {
                    // The offer: the size line, or the line that says the last
                    // attempt stopped, and the one action.
                    Text(step.statusLine.isEmpty ? step.sizeLine : step.statusLine)
                        .centraidType("small")
                        .foregroundStyle(Theme.color(step.statusLine.isEmpty ? "textSoft" : "danger", scheme))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("chat-vision-line")
                    Button(action: onDownload) {
                        Text(step.actionLabel)
                            .centraidType("smallStrong")
                            .foregroundStyle(Theme.color("net", scheme))
                            .padding(.horizontal, 12)
                            .frame(height: 32)
                            .overlay(
                                RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                                    .strokeBorder(Theme.color("net", scheme), lineWidth: CentraidGeometry.hairline)
                            )
                            .frame(minHeight: CentraidGeometry.targetMinCoarse)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("chat-vision-download")
                } else {
                    Text(step.statusLine)
                        .centraidType("small")
                        .foregroundStyle(Theme.color(step.progressKnown || step.statusLine.hasPrefix("Download") ? "net" : "textSoft", scheme))
                        .accessibilityIdentifier("chat-vision-status")
                    Spacer(minLength: 0)
                }
            }
            if step.actionLabel.isEmpty, step.statusLine.hasPrefix("Download") {
                ProgressTrack(fraction: step.progressKnown ? Double(step.progress) : nil)
                    .animation(reduceMotion ? nil : ChatMotion.state, value: step.progress)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 4)
        .background(
            RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                .fill(Theme.color("bgSunken", scheme))
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-vision-step")
    }
}

// MARK: - The composer's one filled element

private struct ChatSendButton: View {
    let iconKey: String
    let spoken: String
    /// Ink fill when there is something to send (or a turn to stop); an outline
    /// with a ghost mark when there is not, so there is never more than one
    /// filled element on the screen.
    let filled: Bool
    let identifier: String
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: action) {
            CentraidIconView(
                iconKey: iconKey,
                tint: Theme.color(filled ? "onAccent" : "textDisabled", scheme),
                size: 20
            )
            .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
            .background(Circle().fill(filled ? Theme.color("accent", scheme) : Color.clear))
            .overlay(
                Circle().strokeBorder(
                    filled ? Color.clear : Theme.color("lineStrong", scheme),
                    lineWidth: CentraidGeometry.hairline
                )
            )
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(spoken)
        .accessibilityIdentifier(identifier)
    }
}

// MARK: - The model step

/// THE DOWNLOAD, LOAD AND UNAVAILABLE STEPS — a slip of raised paper in place
/// of the thread. The model file is a step on the way to a chat, not a screen
/// of its own, so the header stays and so does the band.
///
/// The one action and the progress are in `net`: this is the only time
/// Centraid fetches anything, and `net` is the colour of what leaves the device.
private struct ChatModelStepView: View {
    let state: Centraid_Screen_V1_ChatState
    let onDownload: () -> Void
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var step: Centraid_Screen_V1_ChatModelStep { state.modelStep }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch state.phase {
            case .needsModel:
                if !step.sizeLine.isEmpty {
                    Text(step.sizeLine)
                        .chatType("labelOn")
                        .foregroundStyle(Theme.color("text", scheme))
                        .accessibilityIdentifier("chat-model-size")
                }
                Text(step.noteLine)
                    .chatType("body")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .accessibilityIdentifier("chat-model-note")
                if !state.error.isEmpty {
                    Text(state.error)
                        .chatType("small")
                        .foregroundStyle(Theme.color("danger", scheme))
                        .accessibilityIdentifier("chat-error")
                }
                KitOutlineButton(label: step.actionLabel, tone: "net", action: onDownload)
                    .accessibilityIdentifier("chat-download")
            case .downloading:
                Text(step.statusLine)
                    .chatType("labelOn")
                    .foregroundStyle(Theme.color("net", scheme))
                    .accessibilityIdentifier("chat-model-status")
                ProgressTrack(fraction: step.progressKnown ? Double(step.progress) : nil)
                    .animation(reduceMotion ? nil : ChatMotion.state, value: step.progress)
            case .loading, .unavailable:
                Text(step.statusLine)
                    .chatType("body")
                    .foregroundStyle(Theme.color("textSoft", scheme))
                    .accessibilityIdentifier("chat-model-status")
            default:
                EmptyView()
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Theme.radius("lg", scheme))
                .fill(Theme.color("bgElev", scheme))
        )
        .overlay(
            RoundedRectangle(cornerRadius: Theme.radius("lg", scheme))
                .strokeBorder(Theme.color("line", scheme), lineWidth: CentraidGeometry.hairline)
        )
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.top, 24)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-model-step")
    }
}

/// A hairline-thin track with a `net` fill: how much of the file has arrived.
/// Unknown size draws the empty track; the status line carries the words.
private struct ProgressTrack: View {
    let fraction: Double?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.color("bgSunken", scheme))
                Capsule()
                    .fill(Theme.color("net", scheme))
                    .frame(width: proxy.size.width * CGFloat(min(max(fraction ?? 0, 0), 1)))
            }
        }
        .frame(height: 4)
        .overlay(Capsule().strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline))
        .accessibilityHidden(true)
    }
}

// MARK: - Dynamic Type

/// A TYPE ROLE THAT FOLLOWS THE MEMBER'S TEXT SIZE.
///
/// `centraidType` draws each role at its emitted point size; the chat's reading
/// text and composer take that size as the BODY rung of Dynamic Type instead,
/// scaled by `UIFontMetrics` at the member's category, with the role's own line
/// height scaled by the same factor.
private struct ChatTypeModifier: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var size
    let role: String

    func body(content: Content) -> some View {
        let style = Theme.style(role, scheme)
        let base = Theme.uiFont(role, scheme)
        let traits = UITraitCollection(preferredContentSizeCategory: Self.category(size))
        let font = UIFontMetrics(forTextStyle: .body).scaledFont(for: base, compatibleWith: traits)
        let scale = font.pointSize / base.pointSize
        let delta = max(0, style.lineHeight * scale - font.lineHeight)
        return content
            .font(Font(font))
            .lineSpacing(delta)
            .padding(.vertical, delta / 2)
    }

    private static func category(_ size: DynamicTypeSize) -> UIContentSizeCategory {
        ChatTypeScale.category(size)
    }
}

/// A DYNAMIC TYPE SIZE AS UIKIT'S CATEGORY, once, for the chat's reading text
/// and the Markdown styling beside it.
enum ChatTypeScale {
    static func category(_ size: DynamicTypeSize) -> UIContentSizeCategory {
        switch size {
        case .xSmall: return .extraSmall
        case .small: return .small
        case .medium: return .medium
        case .large: return .large
        case .xLarge: return .extraLarge
        case .xxLarge: return .extraExtraLarge
        case .xxxLarge: return .extraExtraExtraLarge
        case .accessibility1: return .accessibilityMedium
        case .accessibility2: return .accessibilityLarge
        case .accessibility3: return .accessibilityExtraLarge
        case .accessibility4: return .accessibilityExtraExtraLarge
        case .accessibility5: return .accessibilityExtraExtraExtraLarge
        @unknown default: return .large
        }
    }
}

extension View {
    func chatType(_ role: String) -> some View {
        modifier(ChatTypeModifier(role: role))
    }
}

/// The chat's own words that arrive outside `ChatState` (a transient label, a
/// picker's title).
enum ChatWords {
    #if canImport(CentraidShared)
    static var copied: String { ChatCopy.shared.COPIED }
    static var tab: String { ChatCopy.shared.TAB_LABEL }
    static var close: String { ChatCopy.shared.CLOSE }
    static var pickPhoto: String { ChatCopy.shared.ATTACH_PICK_PHOTO }
    static var pickDocument: String { ChatCopy.shared.ATTACH_PICK_DOCUMENT }
    static var noPhotos: String { ChatCopy.shared.ATTACH_NO_PHOTOS }
    static var noDocuments: String { ChatCopy.shared.ATTACH_NO_DOCUMENTS }
    static var scopeAll: String { ChatCopy.shared.SCOPE_ALL }
    static var scopeLabel: String { ChatCopy.shared.SCOPE_LABEL }
    #else
    static var copied: String { "" }
    static var tab: String { "" }
    static var close: String { "" }
    static var pickPhoto: String { "" }
    static var pickDocument: String { "" }
    static var noPhotos: String { "" }
    static var noDocuments: String { "" }
    static var scopeAll: String { "" }
    static var scopeLabel: String { "" }
    #endif
}
