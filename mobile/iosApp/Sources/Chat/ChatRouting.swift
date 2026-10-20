import Foundation

import CentraidShared

/// WHERE A RESULT CARD GOES WHEN IT IS TAPPED.
///
/// A card is a reference (`app`, `entity`, `id`, `qualifier`) to one real row.
/// WHICH SCREEN IT OPENS IS THE SHARED TABLE'S (`RowRoutes`, whose header is
/// the (app, entity) → screen table): Android routes Home's search by the same
/// rows, so a tap lands on the real row on both shells. This file only asks
/// it and presents the answer (`ShellModel.Route.opening`), so the back
/// control returns to Chat.
///
/// An entity the table has no row for opens the app's home instead
/// ([ShellModel.Route.home]); a tap that reached nothing would read as a broken
/// card. A conversation is no route at all: Chat is a tab, and
/// `ShellModel.openChatThread` switches to it (Home's search, #1097).
///
/// HOME'S SEARCH ROUTES THROUGH HERE TOO (R-CHROME-6): its rows carry the same
/// reference (`HomeSearchRow.target`), so a hit opens exactly where a card does,
/// with `parent` naming the page a pushed page's back returns to.
enum ChatRouting {
    static func route(
        for card: Centraid_Screen_V1_ChatCard,
        among cards: [Centraid_Screen_V1_ChatCard],
        parent: String? = nil
    ) -> ShellModel.Route? {
        RowRoutes.shared.route(row: card.row, parent: parent ?? chatTitle, among: cards.map(\.row))
            .map { .opening($0) }
    }

    /// Whether a reference names one of the member's conversations (Home's
    /// search offers them, #1097, R-1097-24). A thread opens in the Chat tab
    /// and is no `Route`, so a caller asks this before it asks `route(for:)`.
    static func isThread(_ card: Centraid_Screen_V1_ChatCard) -> Bool {
        RowRoutes.shared.isThread(row: card.row)
    }

    /// The app an opened route belongs to (`tasks.detail` is the `tasks` scope, a domain), or nil. The
    /// Chat tab scopes itself to the app the member last had open.
    static func app(of route: ShellModel.Route) -> String? {
        switch route {
        case let .screen(identifier, _):
            let app = identifier.split(separator: ".").first.map(String.init) ?? ""
            return app.isEmpty ? nil : app
        case .photos, .photoShelf, .photoLightbox, .photoPicker, .places,
             .photosMemories, .photoDuplicates, .photoDuplicateReview, .photoEditor:
            return AppIds.shared.PHOTOS
        }
    }

    /// Locker is not something the assistant can read (it has no scope), so a
    /// visit to it never scopes the chat.
    static func scopes(_ app: String) -> Bool {
        scopable.contains(app)
    }

    /// The apps a chat can be scoped to, in the order the composer's menu lists
    /// them: the machine's list (`ChatMachine.SCOPABLE_APPS`), which a spec ties
    /// to the core's.
    static var scopable: [String] { ChatMachine.shared.SCOPABLE_APPS }

    /// The scopes the composer's menu offers: the machine's `SCOPE_MENU` (the
    /// scopable apps a member can open, #1128), not every scope a thread may hold.
    static var scopeMenu: [String] { ChatMachine.shared.SCOPE_MENU }

    private static var chatTitle: String { ChatCopy.shared.TITLE }
}

extension ShellModel {
    /// OPEN ONE ROW BY ITS REFERENCE: the shell's one router for a row reference
    /// (`ChatRouting`), pushed over the stack. A search result that is a container
    /// (#1097) opens through here; `parent` is the pushing page's title.
    @MainActor
    func openRow(_ card: Centraid_Screen_V1_ChatCard, parent: String) {
        // A CONVERSATION OPENS IN THE CHAT TAB, not as a page pushed over this one.
        if ChatRouting.isThread(card) {
            openChatThread(card.id, title: card.title)
            return
        }
        guard let route = ChatRouting.route(for: card, among: [], parent: parent) else { return }
        path.append(route)
    }
}

extension Centraid_Screen_V1_ChatCard {
    /// The card as the shared table reads it: its routing fields, in plain strings.
    var row: RowRef {
        RowRef(app: app, entity: entity, id: id, title: title, qualifier: qualifier)
    }
}
