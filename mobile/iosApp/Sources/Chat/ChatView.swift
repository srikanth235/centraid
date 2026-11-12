import SwiftUI
import UIKit


/// THE CHAT TAB (`chat.home`, `chat_screens.proto`).
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
/// **THE HEADER IS THE CHAT'S OWN** (R-CHAT-2): the open chat's title with the
/// vault beside it, the Chats key at the trailing edge and, only inside a chat
/// already begun, New chat's pencil beside it. The tab opens to a ready new
/// conversation. It replaces the vault lockup this tab used to stack above a
/// "Chat" title — the vault is named on the second line, and switching it is Home's.
///
/// **THE CHATS PAGE** is a page of its own, a chevron back to the chat, drawn in
/// place of the thread and the composer with no band under it (so nothing overlaps
/// it). Past chats are newest first with how long ago; the open one is marked; a swipe
/// reveals Delete, which asks first; search is the foot's key, as in every app.
///
/// **ONE FILLED INK ELEMENT.** The composer's Send (Stop while a turn runs) is
/// the only one. Everything else is ink over paper: outlined actions, raised
/// cards, a chip. The model step's one action (and the photo reader's
/// "Download") is outlined in `net`, because it is the only moment Centraid
/// reaches the network.
///
/// **THE COMPOSER IS ONE CARD** (`ChatComposerCard`): the waiting attachments
/// and any notice about them on top, the field, and one row of controls — attach,
/// the chat's scope, send. The status line ("Looking in Agenda…") sits just above
/// it while a turn runs.
struct ChatView: View {
    @ObservedObject var chat: ChatModel
    /// Whether the composer has focus. Home hides the band (and the lockup)
    /// while it does, so the composer takes the keyboard's top edge as the
    /// system's own search does.
    @Binding var typing: Bool
    /// Push a route Rust built (Photos' picker, for "Photo from vault").
    let onOpenRoute: (Centraid_Core_V1_Route) -> Void
    /// A scope chosen from the composer's menu: an app id, or empty for every app.
    let onSetScope: (String) -> Void
    /// Set on a chat PAGE (`chat.ask`, `chat.thread`): the control that pops it. The tab has none.
    var onBack: (() -> Void)? = nil

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The words in the composer survive a tab switch and the app being killed (`SceneStorage`),
    /// and clear only when Rust says it took the send (`acceptedSend`), never when Send is
    /// pressed (#1188 C9).
    @SceneStorage("chat.draft") private var draft = ""
    /// The number of the send waiting on Rust's answer, and the words it carried.
    @State private var lastToken: UInt64 = 0
    @State private var sendingToken: UInt64 = 0
    @State private var sendingText = ""
    @FocusState private var focused: Bool
    /// The on-screen keyboard is up. Focus alone is not enough: with a hardware
    /// keyboard the field has focus and no keyboard shows, so the band stays.
    @State private var keyboardUp = false
    /// A chat the member is renaming, with the name being typed.
    @State private var renaming = false
    @State private var renameText = ""
    /// A chat the member asked to delete, until they confirm or cancel.
    @State private var deleting: DeleteTarget?
    @State private var deletingAll = false
    /// The card last tapped: if Rust finds its row gone (`card_gone_line`), the line shows under it.
    @State private var tappedCard: String?
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
                    onBack: onBack,
                    onChats: {
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
            // Behind the Chats page the chat is not there for a screen reader.
            .accessibilityHidden(state.drawerOpen)

            if state.drawerOpen {
                ChatsPage(
                    state: state,
                    onBack: { chat.toggleDrawer(false) },
                    onOpen: { chat.openThread($0.threadID, title: $0.title) },
                    onDelete: { deleting = DeleteTarget(id: $0.threadID, title: $0.title) },
                    onDeleteAll: { deletingAll = true },
                    onSearchOpen: { chat.openDrawerSearch() },
                    onSearchTerm: { chat.drawerSearch($0) },
                    onSearchClose: { chat.closeDrawerSearch() }
                )
                .transition(reduceMotion ? .opacity : .move(edge: .trailing).combined(with: .opacity))
                .zIndex(1)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .kitAnimation(ChatMotion.entry, value: state.drawerOpen)
        // THE BAND STEPS ASIDE while the on-screen keyboard is up and while the Chats page is up.
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            keyboardUp = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            keyboardUp = false
        }
        .onChange(of: state.acceptedSend) { _, accepted in
            guard sendingToken != 0, accepted == sendingToken else { return }
            if draft.trimmingCharacters(in: .whitespacesAndNewlines) == sendingText { draft = "" }
            sendingToken = 0
            sendingText = ""
        }
        .onChange(of: keyboardUp) { _, up in typing = (up && focused) || state.drawerOpen }
        .onChange(of: focused) { _, now in typing = (now && keyboardUp) || state.drawerOpen }
        .onChange(of: state.drawerOpen) { _, open in typing = (focused && keyboardUp) || open }
        .onDisappear { typing = false }
        .accessibilityIdentifier("chat")
        // A RENAME IS A SHEET HOLDING THE FIELD, Save its one ink button.
        .sheet(isPresented: $renaming) {
            SheetRoom(
                title: state.renameTitle,
                primary: SheetPrimary(label: state.saveLabel) {
                    chat.renameThread(state.threadID, title: renameText)
                    renaming = false
                }
            ) {
                TextField(state.renameTitle, text: $renameText)
                    .chatType("body")
                    .foregroundStyle(Theme.color("text", scheme))
                    .padding(.horizontal, 12)
                    .frame(minHeight: CentraidGeometry.targetMinCoarse)
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.radius("md", scheme))
                            .strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline)
                    )
                    .accessibilityIdentifier("chat-rename-field")
            }
        }
        // DESTRUCTIVE ASKS FIRST, in the kit's confirm (D1), never an alert.
        .sheet(item: $deleting) { target in
            ConfirmSheet(
                .with {
                    $0.title = state.deleteTitle
                    $0.body = target.title + "\n" + state.deleteBody
                    $0.confirmLabel = state.deleteLabel
                    $0.destructive = true
                },
                cancelLabel: state.cancelLabel,
                onConfirm: {
                    chat.deleteThread(target.id)
                    deleting = nil
                },
                onDismiss: { deleting = nil }
            )
        }
        .sheet(isPresented: $deletingAll) {
            ConfirmSheet(
                .with {
                    $0.title = state.deleteAllTitle
                    $0.body = state.deleteAllBody
                    $0.confirmLabel = state.deleteAllLabel
                    $0.destructive = true
                },
                cancelLabel: state.cancelLabel,
                onConfirm: {
                    chat.deleteAllThreads()
                    deletingAll = false
                },
                onDismiss: { deletingAll = false }
            )
        }
    }

    // MARK: The thread

    private func thread(_ state: Centraid_Core_V1_ChatState) -> some View {
        let lastAnswer = state.messages.last(where: { $0.role == .assistant })?.id
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    if state.messages.isEmpty {
                        ChatEmpty(state: state, onPick: { send($0, fromDraft: false) })
                    }
                    ForEach(state.messages, id: \.id) { message in
                        ChatMessageRow(
                            message: message,
                            state: state,
                            isLast: message.id == lastAnswer,
                            copied: copied == message.id,
                            goneCard: state.cardGoneLine.isEmpty ? nil : tappedCard,
                            onCopy: { copy(message.id) },
                            onRetry: { chat.regenerate() },
                            onOpenCard: { _, index in open(at: index, of: message) },
                            onConfirmPending: { chat.confirmPending($0) },
                            onCancelPending: { chat.cancelPending($0) },
                            onUndoPending: { chat.undoPending($0, index: $1) }
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
    private func follow(_ state: Centraid_Core_V1_ChatState) -> [Int] {
        let last = state.messages.last
        return [
            last?.text.count ?? 0, last?.cards.count ?? 0, last?.pending.state.rawValue ?? 0,
            state.activity.count, state.error.count,
        ]
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

    private func composer(_ state: Centraid_Core_V1_ChatState) -> some View {
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
            // THE NEXT QUESTIONS, as chips above the composer in a live thread (#1173): the
            // empty thread lists them in the page itself. A tap asks, like any sent line.
            if !state.messages.isEmpty, !state.suggestions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(state.suggestions.enumerated()), id: \.offset) { index, text in
                            ChatSuggestionChip(text: text, identifier: "chat-suggestion-\(index)") { send(text, fromDraft: false) }
                        }
                    }
                }
                .accessibilityIdentifier("chat-suggestion-chips")
            }
            ChatComposerCard(
                chat: chat,
                state: state,
                draft: $draft,
                focused: $focused,
                onSend: { send($0, fromDraft: true) },
                onSetScope: onSetScope,
                onOpenRoute: onOpenRoute
            )
        }
        .padding(.horizontal, CentraidGeometry.pageMargin)
        .padding(.vertical, 8)
        .kitAnimation(ChatMotion.state, value: state.streaming)
        .kitAnimation(ChatMotion.state, value: state.activity)
    }

    /// A suggestion's tap asks without touching the draft; the composer's Send keeps the words
    /// in the field until `acceptedSend` reaches the number it sent.
    private func send(_ text: String, fromDraft: Bool) {
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty else { return }
        guard fromDraft else {
            chat.sendText(line)
            return
        }
        lastToken += 1
        sendingToken = lastToken
        sendingText = line
        chat.sendText(line, token: lastToken)
    }

    /// A card was tapped. Rust asks the vault whether its row is still there, and answers with the
    /// page to open or the line that says it is gone.
    private func open(at index: Int, of message: Centraid_Core_V1_ChatMessage) {
        tappedCard = "\(message.id)-\(index)"
        chat.cardTapped(message: message.id, index: index)
    }

    private func copy(_ id: UInt64) {
        chat.copy(id)
        copied = id
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
            if copied == id { copied = nil }
        }
    }
}

// MARK: - Suggestion chips

/// A NEXT QUESTION, small: the board's pill in the meta size (13 on the board), white with the
/// strong hairline, 7 over 12 of padding, sitting just above the composer.
private struct ChatSuggestionChip: View {
    let text: String
    let identifier: String
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        Button(action: action) {
            Text(verbatim: text)
                .kitScaledFont(CentraidScale.metaSize)
                .foregroundStyle(Theme.color("text", scheme))
                .lineLimit(1)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(Capsule().fill(Theme.color("bgElev", scheme)))
                .overlay(Capsule().strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline))
                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier(identifier)
    }
}

// MARK: - Motion

/// design/tokens.toml (motion), lowered for this screen: entry at 280 ms on the entry
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

/// THE CHAT'S HEADER: the open chat's title and where it runs in the middle, the
/// Chats key and, inside a chat begun, New chat at the trailing edge. Ink on paper and
/// outlined, never filled: the composer's Send is this screen's one filled
/// element.
private struct ChatHeader: View {
    let state: Centraid_Core_V1_ChatState
    let onBack: (() -> Void)?
    let onChats: () -> Void
    let onNewChat: () -> Void
    let onRename: () -> Void
    let onDelete: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        // THE BOARD'S HEADER (Chat.dc.html): the title and the vault line, round glass keys at the
        // trailing edge, and no rule under it. Rename and Delete are a long press on the title.
        HStack(alignment: .center, spacing: 10) {
            if let onBack {
                KitIconKey(
                    iconKey: "ChevronLeft",
                    label: state.closeLabel,
                    glass: true,
                    identifier: "chat-back",
                    action: onBack
                )
            }
            VStack(alignment: .center, spacing: 0) {
                Text(verbatim: state.title)
                    .centraidType("smallStrong")
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("chat-title")
                // THE ASSISTANT'S AVATAR is the bare app mark (#1173), small, before the line.
                HStack(spacing: 5) {
                    CentraidMark(size: 16)
                    Text(verbatim: state.subtitle)
                        .centraidType("mono")
                        .foregroundStyle(Theme.color("textFaint", scheme))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .accessibilityIdentifier("chat-subtitle")
            }
            .frame(maxWidth: .infinity)
            .accessibilityElement(children: .combine)
            .contextMenu {
                if state.canManageThread {
                    Button(state.renameLabel, action: onRename)
                        .accessibilityIdentifier("chat-menu-rename")
                    Button(state.deleteLabel, role: .destructive, action: onDelete)
                        .accessibilityIdentifier("chat-menu-delete")
                }
            }

            // CHATS, then NEW CHAT only inside a chat already begun: a fresh conversation has
            // nothing to start over from.
            KitIconKey(
                iconKey: "History",
                label: state.drawerLabel,
                glass: true,
                identifier: "chat-chats",
                action: onChats
            )
            if state.canNewChat {
                KitIconKey(
                    iconKey: "PenLine",
                    label: state.newChatLabel,
                    glass: true,
                    identifier: "chat-new",
                    action: onNewChat
                )
            }
        }
        .padding(.horizontal, CentraidGeometry.pageMargin - 8)
        .padding(.top, 8)
        .padding(.bottom, 4)
    }
}

// MARK: - The Chats page

/// THE PAST CHATS, a page of their own over the thread: a chevron back to the chat, the list
/// newest first, and the search key at the foot where every app keeps it. No band is drawn
/// under it, so nothing overlaps; the open chat is marked by an ink rule and a sunken ground,
/// and Delete is a swipe away and asks first.
private struct ChatsPage: View {
    let state: Centraid_Core_V1_ChatState
    let onBack: () -> Void
    let onOpen: (Centraid_Core_V1_ChatThreadItem) -> Void
    let onDelete: (Centraid_Core_V1_ChatThreadItem) -> Void
    let onDeleteAll: () -> Void
    let onSearchOpen: () -> Void
    let onSearchTerm: (String) -> Void
    let onSearchClose: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                KitIconKey(
                    iconKey: "ChevronLeft",
                    label: state.closeLabel,
                    glass: true,
                    identifier: "chat-chats-back",
                    action: onBack
                )
                // THE TITLE IS IN THE TOP ROW beside the chevron (#1173, round 9).
                Text(state.drawerLabel)
                    .kitType(.section)
                    .foregroundStyle(Surface.ink)
                    .lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("kit-header-title")
                Spacer(minLength: 0)
            }
            .padding(.horizontal, CentraidGeometry.pageMargin - 8)
            .padding(.top, 8)
            .padding(.bottom, 8)

            if !state.threadsError.isEmpty {
                // A rename or delete the vault refused: the list below is the vault as it is.
                Text(verbatim: state.threadsError)
                    .kitType(.meta)
                    .foregroundStyle(StateColor.red.text)
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.bottom, 4)
                    .accessibilityIdentifier("chat-chats-error")
            }
            if state.threads.isEmpty {
                Text(verbatim: state.threadsEmptyLine)
                    .kitType(.meta)
                    .foregroundStyle(Surface.meta)
                    .padding(.horizontal, CentraidGeometry.pageMargin)
                    .padding(.top, 8)
                    .accessibilityIdentifier("chat-chats-empty")
                Spacer(minLength: 0)
            } else {
                List {
                    ForEach(state.threads, id: \.threadID) { row in
                        Button { onOpen(row) } label: {
                            ChatThreadRow(row: row, currentLabel: state.currentLabel)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(KitRowPress())
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Color.clear)
                            .listRowSeparator(.hidden)
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button(role: .destructive) {
                                    onDelete(row)
                                } label: {
                                    Text(verbatim: state.deleteLabel)
                                }
                                .tint(Theme.color("net", scheme))
                            }
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(row.accessibilityLabel)
                            .accessibilityAction(named: state.deleteLabel) { onDelete(row) }
                            .accessibilityIdentifier("chat-thread-row")
                    }
                    if state.canDeleteAll {
                        Button(action: onDeleteAll) {
                            Text(verbatim: state.deleteAllLabel)
                                .kitScaledFont(CentraidScale.metaSize, weight: .semibold)
                                .foregroundStyle(StateColor.red.text)
                                .padding(.horizontal, CentraidGeometry.pageMargin)
                                .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .accessibilityIdentifier("chat-chats-delete-all")
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .accessibilityIdentifier("chat-chats-list")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Surface.plainPage.ignoresSafeArea())
        // THE SEARCH KEY AT THE FOOT, as a pushed page keeps it: the field takes its place.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            SearchFoot(
                search: SearchSlot(
                    field: state.drawerSearch.kitField,
                    placeholder: state.drawerSearchPlaceholder,
                    onOpen: onSearchOpen,
                    onTerm: onSearchTerm,
                    onClose: onSearchClose
                ),
                identifier: "chat-chats-search"
            )
        }
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityIdentifier("chat-chats-page")
    }
}

/// ONE PAST CHAT: its title over how long ago it moved. The open one carries an
/// ink rule on its leading edge and a sunken ground; nothing is filled.
private struct ChatThreadRow: View {
    let row: Centraid_Core_V1_ChatThreadItem
    let currentLabel: String

    var body: some View {
        HStack(spacing: 0) {
            Rectangle()
                .fill(row.current ? Surface.ink : Color.clear)
                .frame(width: 2)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: row.title)
                    .kitScaledFont(CentraidScale.rowSize, weight: .semibold)
                    .foregroundStyle(Surface.ink)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                if !row.ago.isEmpty {
                    Text(verbatim: row.ago)
                        .kitType(.meta)
                        .foregroundStyle(Surface.meta)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
        }
        .background(row.current ? Surface.fill : Color.clear)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Surface.line)
                .frame(height: CentraidGeometry.hairline)
        }
    }
}

// MARK: - The empty thread

private struct ChatEmpty: View {
    let state: Centraid_Core_V1_ChatState
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
    let message: Centraid_Core_V1_ChatMessage
    let state: Centraid_Core_V1_ChatState
    /// The last answer in the thread: Retry is drawn on it.
    let isLast: Bool
    let copied: Bool
    /// `"<message id>-<card index>"` of the card whose row was gone when tapped.
    let goneCard: String?
    let onCopy: () -> Void
    let onRetry: () -> Void
    let onOpenCard: (Centraid_Core_V1_ChatCard, Int) -> Void
    /// Confirm and Cancel on the proposed write's card, by its id.
    let onConfirmPending: (String) -> Void
    let onCancelPending: (String) -> Void
    /// One write's Undo on an applied card: the card's id and the write's index.
    let onUndoPending: (String, Int) -> Void

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
                        // THE MEMBER'S WORDS ARE AN INK PILL (#1173): ink fill, the page's colour as text.
                        // In the dark it is the raised grey of the border role with white text, not the
                        // light ink inverted (ChatDark.dc.html).
                        .foregroundStyle(scheme == .dark ? Color.white : Color(CentraidAsset.surfacePage))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                        .background(
                            RoundedRectangle(cornerRadius: CentraidScale.cardRadius * 1.25, style: .continuous)
                                .fill(Color(scheme == .dark ? CentraidAsset.surfaceBorder : CentraidAsset.textInk))
                        )
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(message.accessibilityLabel)
                .accessibilityIdentifier("chat-message-user")
            }
        } else {
            VStack(alignment: .leading, spacing: 8) {
                // A PROPOSED WRITE IS TOLD BY ITS CARD: the board draws no sentence over it, and the
                // sentence ("Proposed: …") says what the card's rows say.
                if !message.text.isEmpty, !(message.hasPending && !message.streaming) {
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
                        ChatCardRow(card: card, state: state, onOpen: { onOpenCard(card, index) })
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
                // THE WRITE THE MODEL PROPOSED, once the answer has stopped streaming.
                if message.hasPending, !message.streaming {
                    ChatPendingCard(
                        pending: message.pending,
                        onConfirm: { onConfirmPending(message.pending.pendingID) },
                        onCancel: { onCancelPending(message.pending.pendingID) },
                        onUndo: { onUndoPending(message.pending.pendingID, $0) }
                    )
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

    /// COPY AND TRY AGAIN, QUIET: the board's thread draws no buttons under an answer, so these are
    /// two small icon keys in the faint ink (the words are their spoken labels), 44 to press.
    private var actions: some View {
        HStack(spacing: 0) {
            if !message.text.isEmpty {
                KitIconKey(
                    iconKey: copied ? "Check" : "Copy",
                    label: copied ? copiedLabel : state.copyLabel,
                    tint: "textFaint",
                    identifier: "chat-copy",
                    action: onCopy
                )
            }
            if isLast, state.canRetry {
                KitIconKey(
                    iconKey: "Refresh",
                    label: state.retryLabel,
                    tint: "textFaint",
                    identifier: "chat-retry",
                    action: onRetry
                )
            }
        }
        .padding(.leading, -12)
    }

    private var copiedLabel: String { state.copiedLabel }
}

/// An outlined action under an answer: the kit's outline button, glyph first.
private struct ChatActionButton: View {
    let iconKey: String
    let label: String
    let identifier: String
    let action: () -> Void

    var body: some View {
        KitOutlineButton(label: label, iconKey: iconKey, action: action)
            .accessibilityIdentifier(identifier)
    }
}

/// One failed turn: a sentence and the way to ask again.
private struct ChatErrorLine: View {
    let state: Centraid_Core_V1_ChatState
    let onRetry: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(state.error)
                .chatType("small")
                .foregroundStyle(Theme.color("net", scheme))
                .accessibilityIdentifier("chat-error")
            if state.canRetry {
                ChatActionButton(iconKey: "Refresh", label: state.retryLabel, identifier: "chat-error-retry", action: onRetry)
            }
        }
    }
}

// MARK: - Result cards

/// ONE ROW THE ANSWER FOUND (#1173), drawn in the colour of the app it is from: a white
/// card with a bar down its left edge in that app's colour, the row's title in ink, its
/// subtitle and meta under it, and the app's name in the app's colour at the right. Anything
/// shown from another app uses that app's colour.
private struct ChatCardRow: View {
    let card: Centraid_Core_V1_ChatCard
    let state: Centraid_Core_V1_ChatState
    let onOpen: () -> Void
    @Environment(\.colorScheme) private var scheme

    private var appName: String { state.scopes.first { $0.app == card.app }?.name ?? "" }

    /// The first letters of the first two words of a name.
    private static func initials(_ name: String) -> String {
        String(name.split(separator: " ").prefix(2).compactMap(\.first)).uppercased()
    }

    private var spoken: String {
        [card.title, card.subtitle, card.meta, appName].filter { !$0.isEmpty }.joined(separator: ", ")
    }

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 12) {
                if card.app == "people" {
                    // A PERSON WEARS INITIALS, as the board's card does, in the app's colour.
                    Text(verbatim: Self.initials(card.title))
                        .kitScaledFont(CentraidScale.metaSize, weight: .semibold)
                        .foregroundStyle(AppAccent(card.app).text)
                        .frame(width: 32, height: 32)
                        .background(Circle().fill(AppAccent(card.app).fill.opacity(0.16)))
                        .accessibilityHidden(true)
                } else {
                    Capsule()
                        .fill(AppAccent(card.app).fill)
                        .frame(width: 4)
                        .padding(.vertical, 2)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: card.title)
                        .kitScaledFont(CentraidScale.rowSize, weight: .semibold)
                        .foregroundStyle(Color(CentraidAsset.textInk))
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    if !card.subtitle.isEmpty {
                        Text(verbatim: card.subtitle)
                            .kitScaledFont(CentraidScale.metaSize)
                            .foregroundStyle(Color(CentraidAsset.textMeta))
                            .lineLimit(1)
                    }
                    if !card.meta.isEmpty {
                        Text(verbatim: card.meta)
                            .kitScaledFont(CentraidScale.metaSize)
                            .foregroundStyle(Color(CentraidAsset.textMeta))
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if !appName.isEmpty {
                    Text(verbatim: appName)
                        .kitScaledFont(CentraidScale.metaSize, weight: .semibold)
                        .foregroundStyle(AppAccent(card.app).text)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous)
                    .fill(Color(CentraidAsset.surfaceCard))
            )
            .overlay(
                RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous)
                    .strokeBorder(Color(CentraidAsset.surfaceBorder), lineWidth: CentraidGeometry.hairline)
            )
            .contentShape(RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous))
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

// MARK: - A proposed write

/// A WRITE THE MODEL PROPOSED (#1173), as the "Proposed change" card under its answer: a badge,
/// one line for each row it changes in the core's words, then the way to say yes and "Not now";
/// once answered, the one clause that says how it ended. The card wears the colour of the app
/// whose row it changes (`pending.app`; the shell's teal when it spans apps). NOTHING the model
/// wrote reaches the vault before the member confirms: Rust holds the write until
/// `PendingConfirmed`, and this card only sends the event. A card that asks twice draws its
/// confirm in the red state colour. There is no toast and no Undo: an applied card says "Done."
/// and stays.
private struct ChatPendingCard: View {
    let pending: Centraid_Core_V1_ChatPending
    let onConfirm: () -> Void
    let onCancel: () -> Void
    let onUndo: (Int) -> Void
    @Environment(\.colorScheme) private var scheme

    /// Confirm and Cancel are drawn while the card waits or the core works.
    private var asking: Bool { pending.state == .waiting || pending.state == .working }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            // THE BOARD'S CARD IS NEUTRAL: a grey "PROPOSED CHANGE", then each row with the empty ring
            // of a thing not yet done in front of it; the app's colour is in the row it names.
            VStack(alignment: .leading, spacing: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(verbatim: pending.title)
                        .kitScaledFont(CentraidScale.metaSize, weight: .semibold)
                        .textCase(.uppercase)
                        .tracking(0.4)
                        .foregroundStyle(Color(CentraidAsset.textMeta))
                    ForEach(Array(pending.steps.enumerated()), id: \.offset) { _, step in
                        HStack(alignment: .center, spacing: 10) {
                            Circle()
                                .strokeBorder(Theme.color("textFaint", scheme), lineWidth: 1.6)
                                .frame(width: 20, height: 20)
                            // THE ROW'S NAME, then its second line ("Reminders · today, 10:45"); a step
                            // the core did not name by title keeps its composed sentence.
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: step.title.isEmpty ? step.summary : step.title)
                                    .kitScaledFont(CentraidScale.rowSize, weight: .semibold)
                                    .foregroundStyle(step.destructive ? Color(CentraidAsset.stateRedText) : Color(CentraidAsset.textInk))
                                    .multilineTextAlignment(.leading)
                                if !step.subtitle.isEmpty {
                                    Text(verbatim: step.subtitle)
                                        .kitScaledFont(CentraidScale.metaSize)
                                        .foregroundStyle(Color(CentraidAsset.textMeta))
                                        .multilineTextAlignment(.leading)
                                }
                            }
                        }
                    }
                    if !pending.moreLine.isEmpty {
                        Text(verbatim: pending.moreLine)
                            .kitScaledFont(CentraidScale.metaSize)
                            .foregroundStyle(Color(CentraidAsset.textMeta))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                // ONE ELEMENT FOR THE LINES, read as the core's label. NO IDENTIFIER ON THE CARD
                // ITSELF: one on a container replaces its children's (#1047), the buttons' included.
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(pending.accessibilityLabel)
                .accessibilityIdentifier("chat-pending")
                if asking {
                    HStack(spacing: 8) {
                        Button(action: onConfirm) {
                            Text(verbatim: pending.confirmLabel)
                                .kitScaledFont(CentraidScale.rowSize, weight: .semibold)
                                .foregroundStyle(Color.white)
                                .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
                                .background(
                                    Capsule().fill(Color(pending.destructive ? CentraidAsset.stateRed : CentraidAsset.shell))
                                )
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("chat-pending-confirm")
                        Button(action: onCancel) {
                            Text(verbatim: pending.cancelLabel)
                                .kitScaledFont(CentraidScale.rowSize, weight: .semibold)
                                .foregroundStyle(Color(CentraidAsset.textInk))
                                .frame(maxWidth: .infinity, minHeight: CentraidGeometry.targetMinCoarse)
                                .overlay(Capsule().strokeBorder(Color(CentraidAsset.surfaceBorder), lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("chat-pending-cancel")
                    }
                    .disabled(pending.state == .working)
                } else if !pending.settledLine.isEmpty {
                    Text(verbatim: pending.settledLine)
                        .kitScaledFont(CentraidScale.metaSize)
                        .foregroundStyle(Color(CentraidAsset.textMeta))
                        .accessibilityIdentifier("chat-pending-settled")
                }
                // ONE LINE FOR EACH WRITE THE CARD MADE: "Made by Chat" with Undo, then "Undone" or
                // the core's sentence (and no key once it was refused or taken).
                ForEach(Array(pending.undo.enumerated()), id: \.offset) { index, line in
                    HStack(spacing: 8) {
                        Text(verbatim: line.sentence)
                            .kitScaledFont(CentraidScale.metaSize)
                            .foregroundStyle(line.refused ? StateColor.red.text : Color(CentraidAsset.textMeta))
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if !line.actionLabel.isEmpty {
                            Button(action: { onUndo(index) }) {
                                Text(verbatim: line.actionLabel)
                                    .kitScaledFont(CentraidScale.rowSize, weight: .semibold)
                                    .foregroundStyle(Color(CentraidAsset.textInk))
                                    .padding(.horizontal, 14)
                                    .frame(minHeight: CentraidGeometry.targetMinCoarse)
                                    .overlay(Capsule().strokeBorder(Color(CentraidAsset.surfaceBorder), lineWidth: 1))
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("chat-pending-undo-\(index)")
                        }
                    }
                    .accessibilityElement(children: .contain)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous)
                .fill(Color(CentraidAsset.surfaceCard))
        )
        .overlay(
            RoundedRectangle(cornerRadius: CentraidScale.cardRadius, style: .continuous)
                .strokeBorder(Color(CentraidAsset.surfaceBorder), lineWidth: CentraidGeometry.hairline)
        )
    }
}

// MARK: - The composer card

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
    let state: Centraid_Core_V1_ChatState
    @Binding var draft: String
    var focused: FocusState<Bool>.Binding
    let onSend: (String) -> Void
    let onSetScope: (String) -> Void
    let onOpenRoute: (Centraid_Core_V1_Route) -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let radius: CGFloat = 28

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
            // THE BOARD'S ONE PILL ROW: attach, the field, the scope chip and Send, on a line.
            HStack(spacing: 6) {
                attachMenu
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
                .padding(.leading, 4)
                .frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
                .accessibilityIdentifier("chat-field")
                ChatScopePill(app: state.scopeApp, state: state, onSetScope: onSetScope)
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
                        iconKey: "ArrowUp",
                        spoken: state.sendLabel,
                        filled: !trimmed.isEmpty && !state.visionBlocked,
                        identifier: "chat-send",
                        action: { onSend(trimmed) }
                    )
                    .disabled(trimmed.isEmpty || state.visionBlocked)
                }
            }
        }
        .padding(6)
        .frame(maxWidth: .infinity, alignment: .leading)
        // THE COMPOSER FLOATS (#1173): Liquid Glass on iOS 26, the solid card before it and under
        // Reduce Transparency or Increase Contrast, by the band's one ground.
        .modifier(BandGround(
            shape: RoundedRectangle(cornerRadius: Self.radius, style: .continuous),
            solid: "bgElev",
            interactive: false
        ))
        .kitAnimation(ChatMotion.state, value: state.pending.count)
        .kitAnimation(ChatMotion.state, value: state.hasVisionStep)
        .sheet(isPresented: Binding(
            get: { state.documentSheet.open },
            set: { if !$0 { chat.closeDocuments() } }
        )) {
            ChatDocumentSheet(
                sheet: state.documentSheet,
                closeLabel: state.closeLabel,
                onPicked: { docID, title in chat.attachDocument(docID: docID, title: title) },
                onClose: { chat.closeDocuments() }
            )
        }
    }

    /// A CIRCLE OUTLINED WITH A PLUS: never filled.
    private var attachMenu: some View {
        Menu {
            if state.hasAttachPhotoRoute {
                Button(state.attachVaultPhotoLabel) { onOpenRoute(state.attachPhotoRoute) }
                    .accessibilityIdentifier("chat-attach-vault-photo")
            }
            Button(state.attachLibraryPhotoLabel) { chat.libraryPhotoTapped() }
                .accessibilityIdentifier("chat-attach-library-photo")
            Button(state.attachDocumentLabel) { chat.openDocuments() }
                .accessibilityIdentifier("chat-attach-document")
        } label: {
            // DISABLED IS THE INK, not a faded container. The board's key is a filled sunken circle.
            CentraidIconView(
                iconKey: "Plus",
                tint: Theme.color(state.canAttach ? "text" : "textDisabled", scheme),
                size: 20
            )
                .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                .background(Circle().fill(Theme.color("bgSunken", scheme)))
                .contentShape(Circle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .disabled(!state.canAttach)
        .accessibilityLabel(state.attachLabel)
        .accessibilityIdentifier("chat-attach")
    }
}

/// THE CHAT'S SCOPE, as a pill that opens a menu: every app, or one.
private struct ChatScopePill: View {
    let app: String
    let state: Centraid_Core_V1_ChatState
    let onSetScope: (String) -> Void
    @Environment(\.colorScheme) private var scheme

    /// The words are Rust's: "All apps" and each scope's app name (`ChatState.scopes`).
    private func name(_ id: String) -> String {
        id.isEmpty ? state.scopeAllLabel : (state.scopes.first { $0.app == id }?.name ?? id)
    }

    var body: some View {
        Menu {
            Button(state.scopeAllLabel) { onSetScope("") }
                .accessibilityIdentifier("chat-scope-all")
            ForEach(state.scopes, id: \.app) { option in
                Button(option.name) { onSetScope(option.app) }
                    .accessibilityIdentifier("chat-scope-\(option.app)")
            }
        } label: {
            HStack(spacing: 6) {
                if !app.isEmpty {
                    AppMark(appID: app, size: 20)
                }
                Text(name(app))
                    .kitScaledFont(CentraidScale.metaSize, weight: .semibold)
                    .foregroundStyle(Theme.color("text", scheme))
                    .lineLimit(1)
            }
            .padding(.horizontal, 10)
            .frame(minHeight: 32)
            .background(Capsule().fill(Theme.color("bgElev", scheme)))
            .overlay(Capsule().strokeBorder(Theme.color("lineStrong", scheme), lineWidth: CentraidGeometry.hairline))
            .frame(minHeight: CentraidGeometry.targetMinCoarse)
            .contentShape(Capsule())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .accessibilityLabel(state.scopeLabel + ", " + name(app))
        .accessibilityIdentifier("chat-scope")
    }
}

/// ONE ATTACHMENT, as a chip: a thumbnail (a photograph) or a document mark, the
/// name, and — in the composer — the way to take it out. Outlined, never filled.
private struct ChatAttachmentChip: View {
    let attachment: Centraid_Core_V1_ChatAttachment
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
                KitIconKey(
                    iconKey: "X",
                    label: removeLabel + ", " + attachment.label,
                    tint: "textSoft",
                    identifier: "chat-attachment-remove",
                    action: onRemove
                )
                .padding(.trailing, -8)
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
    let step: Centraid_Core_V1_ChatModelStep
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
                        .foregroundStyle(Theme.color("textSoft", scheme))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("chat-vision-line")
                    ChatDownloadButton(label: step.actionLabel, action: onDownload)
                    .accessibilityIdentifier("chat-vision-download")
                } else {
                    Text(step.statusLine)
                        .centraidType("small")
                        .foregroundStyle(Theme.color("textSoft", scheme))
                        .accessibilityIdentifier("chat-vision-status")
                    Spacer(minLength: 0)
                }
            }
            if step.actionLabel.isEmpty, step.statusLine.hasPrefix("Download") {
                ProgressTrack(fraction: step.progressKnown ? Double(step.progress) : nil)
                    .kitAnimation(ChatMotion.state, value: step.progress)
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
            // THE BOARD'S SEND: a round dark-teal key with a white up arrow. With nothing to send
            // it is a quiet disc with a legible soft arrow (never the filled key faded: the white
            // arrow vanished into the pale disc), so it still reads as Send, and the filled key
            // stays the one filled element.
            CentraidIconView(iconKey: iconKey, tint: filled ? Color.white : Theme.color("textSoft", scheme), size: 18)
                .frame(width: CentraidGeometry.targetMinCoarse, height: CentraidGeometry.targetMinCoarse)
                .background(Circle().fill(filled ? Color(CentraidAsset.shell) : Theme.color("lineStrong", scheme)))
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
    let state: Centraid_Core_V1_ChatState
    let onDownload: () -> Void
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var step: Centraid_Core_V1_ChatModelStep { state.modelStep }

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
                        .foregroundStyle(Theme.color("net", scheme))
                        .accessibilityIdentifier("chat-error")
                }
                ChatDownloadButton(label: step.actionLabel, action: onDownload)
                    .accessibilityIdentifier("chat-download")
            case .downloading:
                Text(step.statusLine)
                    .chatType("labelOn")
                    .foregroundStyle(Theme.color("text", scheme))
                    .accessibilityIdentifier("chat-model-status")
                ProgressTrack(fraction: step.progressKnown ? Double(step.progress) : nil)
                    .kitAnimation(ChatMotion.state, value: step.progress)
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
/// THE DOWNLOAD'S ONE ACTION, in the shell's teal as the composer's send is: red is the error
/// colour and a download is no error (#1173).
private struct ChatDownloadButton: View {
    let label: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(verbatim: label)
                .kitScaledFont(CentraidScale.rowSize, weight: .semibold)
                .foregroundStyle(Color.white)
                .padding(.horizontal, 20)
                .frame(minHeight: CentraidGeometry.targetMinCoarse)
                .background(Capsule().fill(Color(CentraidAsset.shell)))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

private struct ProgressTrack: View {
    let fraction: Double?
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.color("bgSunken", scheme))
                Capsule()
                    .fill(Color(CentraidAsset.shell))
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
/// `centraidType` scales each role on the system text style nearest its size;
/// the chat's reading text and composer take every role's size as the BODY rung
/// of Dynamic Type instead, scaled by `UIFontMetrics` at the member's category,
/// with the role's own line height scaled by the same factor. It starts from
/// `Theme.baseFont`, the face at the token's size, so nothing scales twice.
private struct ChatTypeModifier: ViewModifier {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.dynamicTypeSize) private var size
    let role: String

    func body(content: Content) -> some View {
        let style = Theme.style(role, scheme)
        let base = Theme.baseFont(role, scheme)
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


extension Centraid_Core_V1_ChatDrawerSearch {
    /// The kit's search field draws the drawer's search; it reads these three facts and no more.
    var kitField: KitSearchField {
        var field = KitSearchField()
        field.open = open
        field.term = term
        field.corrected = corrected
        field.correctedLabel = correctedLabel
        return field
    }
}
