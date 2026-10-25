import Foundation

import CentraidShared

/// WHAT IS LEFT OF THE CHAT'S ROUTING ON iOS (#1135).
///
/// A chat card's tap is Rust's now (`ChatEvent.card_tapped`; the page opens through an `OpenRoute`
/// effect, from `kit::rows`). What remains is for Home's search, which still routes a search hit
/// by the shared table until the shell lane moves it: `isThread`, `route` and `app(of:)`. Delete
/// this file with that port.
enum ChatRouting {
    static func route(
        for card: Centraid_Screen_V1_ChatCard,
        among cards: [Centraid_Screen_V1_ChatCard],
        parent: String? = nil
    ) -> ShellModel.Route? {
        RowRoutes.shared.route(row: card.row, parent: parent ?? "", among: cards.map(\.row))
            .map { .opening($0) }
    }

    /// Whether a reference names one of the member's conversations (Home's search offers them,
    /// #1097). A thread opens in the Chat tab and is no `Route`.
    static func isThread(_ card: Centraid_Screen_V1_ChatCard) -> Bool {
        RowRoutes.shared.isThread(row: card.row)
    }

    /// The app id an opened route names, or nil. The Chat tab scopes itself to the app the member
    /// last had open; Rust keeps the ids that are scopes and drops the rest (`chat::scope_of`).
    static func app(of route: ShellModel.Route) -> String? {
        switch route {
        case let .screen(identifier, _):
            let app = identifier.split(separator: ".").first.map(String.init) ?? ""
            return app.isEmpty ? nil : app
        case let .rust(entry):
            return RustScreens.tab(for: entry.route)
        }
    }
}

extension Centraid_Screen_V1_ChatCard {
    /// The card as the shared table reads it: its routing fields, in plain strings.
    var row: RowRef {
        RowRef(app: app, entity: entity, id: id, title: title, qualifier: qualifier)
    }
}
