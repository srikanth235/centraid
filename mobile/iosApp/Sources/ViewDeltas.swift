import Foundation

/// A STREAMING ANSWER'S NEXT WORDS APPLIED TO THE VIEW HELD (#1188 C14). The delta is dropped (nil)
/// unless it was made against the revision this view holds and the message it grows is there; the
/// next full view repairs a dropped one. Rust's `chat::delta` and the Android store do the same,
/// over the same cases (`mobile/fixtures/chat-deltas.txt`).
enum ViewDeltas {
    static func apply(_ delta: Centraid_Core_V1_ViewDelta, to held: Centraid_Core_V1_ViewState) -> Centraid_Core_V1_ViewState? {
        guard held.revision == delta.base,
            case .chat(var chat)? = held.kind,
            case .chatAppend(let add)? = delta.kind,
            let at = chat.messages.lastIndex(where: { $0.id == add.messageID })
        else { return nil }
        chat.messages[at].text += add.text
        chat.activity = add.activity
        var view = held
        view.kind = .chat(chat)
        view.revision = delta.revision
        return view
    }
}
