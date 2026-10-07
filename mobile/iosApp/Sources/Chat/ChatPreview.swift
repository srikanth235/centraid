#if DEBUG
import Foundation

/// A DEBUG-ONLY FIXTURE FOR THE READY STATES, for a machine whose core has no
/// engine to bring the chat to `READY`. Launch with
/// `SIMCTL_CHILD_CENTRAID_CHAT_PREVIEW=empty|thread|streaming|error|markdown|drawer`; the model
/// then holds that state instead of the bridge's. It exists so the thread, the
/// cards and the composer can be looked at; it proves nothing about the core,
/// and a release build compiles it out.
enum ChatPreview {
    static var mode: String? {
        let value = ProcessInfo.processInfo.environment["CENTRAID_CHAT_PREVIEW"] ?? ""
        return value.isEmpty ? nil : value
    }

    static func state(_ mode: String) -> Data {
        var state = Centraid_Screen_V1_ChatState()
        state.phase = .ready
        state.title = "New chat"
        state.subtitle = "Sample · on this phone"
        state.drawerLabel = "Chats"
        state.menuLabel = "Chat options"
        state.renameLabel = "Rename"
        state.deleteLabel = "Delete"
        state.deleteAllLabel = "Delete all chats"
        state.cancelLabel = "Cancel"
        state.saveLabel = "Save"
        state.renameTitle = "Rename chat"
        state.deleteTitle = "Delete this chat?"
        state.deleteBody = "Its messages are removed from this vault. This cannot be undone."
        state.deleteAllTitle = "Delete all chats?"
        state.deleteAllBody = "Every chat in this vault is removed. This cannot be undone."
        state.cardGoneLine = "This item is gone."
        state.currentLabel = "Open chat"
        state.composerPlaceholder = "Ask your vault"
        state.sendLabel = "Send"
        state.stopLabel = "Stop"
        state.newChatLabel = "New chat"
        state.retryLabel = "Retry"
        state.copyLabel = "Copy"
        func message(_ id: UInt64, _ role: Centraid_Screen_V1_ChatMessage.Role, _ text: String, cards: [Centraid_Screen_V1_ChatCard] = [], streaming: Bool = false) -> Centraid_Screen_V1_ChatMessage {
            var m = Centraid_Screen_V1_ChatMessage()
            m.id = id; m.role = role; m.text = text; m.cards = cards; m.streaming = streaming
            m.accessibilityLabel = (role == .user ? "You said" : "Centraid said") + ": " + text
            return m
        }
        func card(_ app: String, _ entity: String, _ id: String, _ title: String, _ subtitle: String, _ meta: String = "") -> Centraid_Screen_V1_ChatCard {
            var c = Centraid_Screen_V1_ChatCard()
            c.app = app; c.entity = entity; c.id = id; c.title = title; c.subtitle = subtitle; c.meta = meta
            return c
        }
        let spend = [
            card("tally", "expense", "e1", "Cabin deposit", "$240.00", "2026-09-21 · Tahoe weekend"),
            card("tally", "expense", "e2", "Groceries at Safeway", "$86.40", "2026-09-22 · Tahoe weekend"),
            card("tally", "expense", "e3", "Gas", "$54.10", "2026-09-22 · Tahoe weekend"),
        ]
        func row(_ id: String, _ title: String, _ ago: String, current: Bool = false) -> Centraid_Screen_V1_ChatThreadItem {
            var r = Centraid_Screen_V1_ChatThreadItem()
            r.threadID = id; r.title = title; r.ago = ago; r.current = current
            r.accessibilityLabel = title + ", " + ago
            return r
        }
        switch mode {
        case "markdown":
            state.title = "What did we spend at Tahoe?"
            state.threadID = "t1"
            state.canManageThread = true
            state.messages = [
                message(1, .user, "What did we spend at Tahoe?"),
                message(
                    2, .assistant,
                    "You spent **$380.50** across three *expenses*:\n\n- Cabin deposit, `$240.00`\n- Groceries at Safeway, $86.40\n- Gas, $54.10\n\n1. Pay the cabin\n2. Split the rest",
                    cards: spend
                ),
            ]
            state.canNewChat = true
        case "drawer":
            state.title = "What did we spend at Tahoe?"
            state.threadID = "t1"
            state.canManageThread = true
            state.canNewChat = true
            state.drawerOpen = true
            state.threads = [
                row("t1", "What did we spend at Tahoe?", "5 min ago", current: true),
                row("t2", "What is on my packing list?", "Yesterday"),
                row("t3", "Who should I call this week?", "3 days ago"),
            ]
            state.messages = [message(1, .user, "What did we spend at Tahoe?"), message(2, .assistant, "You spent $380.50 across three expenses.", cards: spend)]
        case "empty":
            state.emptyLine = "Ask about anything in your vault."
            state.suggestions = ["What did we spend at Tahoe?", "What is on my packing list?", "What is on my calendar this week?"]
            state.scopeApp = "tally"
        case "streaming":
            state.messages = [
                message(1, .user, "What did we spend at Tahoe?"),
                message(2, .assistant, "You spent about $380 at Tah", streaming: true),
            ]
            state.streaming = true
            state.activity = "Looking in Tally"
            state.canNewChat = true
        case "error":
            state.messages = [message(1, .user, "What did we spend at Tahoe?")]
            state.error = "The model stopped. Retry."
            state.canRetry = true
            state.canNewChat = true
        default:
            state.messages = [
                message(1, .user, "What did we spend at Tahoe?"),
                message(2, .assistant, "You spent $380.50 across three expenses.", cards: spend),
            ]
            state.canRetry = true
            state.canNewChat = true
        }
        return (try? state.serializedData()) ?? Data()
    }
}
#endif
