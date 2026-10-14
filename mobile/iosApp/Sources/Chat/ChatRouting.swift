import Foundation

#if canImport(CentraidShared)
import CentraidShared
#endif

/// WHERE A RESULT CARD GOES WHEN IT IS TAPPED.
///
/// A card is a reference (`app`, `entity`, `id`, `qualifier`) to one real row.
/// This maps it onto the route the app's own screens already use — the same
/// `Route` a Home tile or a row inside the app pushes — so a tap lands on the
/// real row and the back control returns to Chat.
///
/// Every entity the assistant can name has a row route today:
///
/// | app | entity | route |
/// | --- | --- | --- |
/// | tasks | `task` | the task's detail |
/// | tasks | `project` | the project's list |
/// | notes | `note` | the note's editor |
/// | docs | `document` | the document page |
/// | people | `person` | the person page |
/// | agenda | `event` | the event's detail (`qualifier` is the occurrence) |
/// | photos | `photo` | the lightbox, with the answer's other photos as neighbours |
/// | notes | `notebook` | the library under that notebook (a container found by name, #1097) |
/// | photos | `album` | the album's shelf |
/// | docs | `folder` | the folder's page |
/// | chat | `thread` | not a route: Chat is a tab. `ShellModel.openChatThread` switches to it and opens the thread (Home's search, #1097) |
///
/// A notebook, album or folder arrives with its id and its name (the
/// card's `title`), which is all each route needs.
///
/// An entity this table has no row for opens the app's home instead
/// ([appHome]); a tap that reached nothing would read as a broken card.
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
        let parent = parent ?? chatTitle
        switch (card.app, card.entity) {
        case ("tasks", "task"):
            return TasksScreens.detailRoute(card.id)
        case ("tasks", "project"):
            return TasksScreens.projectRoute(card.id, title: card.title)
        case ("notes", "note"):
            return NotesScreens.editorRoute(card.id)
        case ("notes", "notebook"):
            return NotesScreens.libraryRoute(notebookID: card.id, notebookName: card.title)
        case ("photos", "album"):
            return .photoShelf(albumShelf(card.id, card.title))
        case ("docs", "folder"):
            return DocsScreens.folderRoute(card.id, card.title, parent: parent)
        case ("docs", "document"):
            return DocsScreens.documentRoute(card.id, card.title, parent: parent)
        case ("people", "person"):
            return PeopleScreens.personRoute(card.id, name: card.title)
        case ("agenda", "event"):
            return AgendaScreens.detailRoute(
                eventID: card.id,
                instanceKey: card.qualifier,
                originalStartLocal: nil,
                day: ""
            )
        case ("photos", "photo"):
            // The answer's own photographs, in the order it showed them, so a
            // swipe in the lightbox walks the answer.
            let neighbours = cards.filter { $0.app == "photos" && $0.entity == "photo" }.map(\.id)
            return .photoLightbox(card.id, neighbours.isEmpty ? [card.id] : neighbours)
        default:
            return appHome(card.app)
        }
    }

    /// An album's shelf: the library under that album, its name riding along so
    /// the head has words before the page read lands (`ShellModel.placeShelf`'s rule).
    static func albumShelf(_ identifier: String, _ name: String) -> Data {
        var shelf = Centraid_Screen_V1_PhotoShelf()
        shelf.album = .with {
            $0.collectionID = identifier
            $0.name = name
        }
        return (try? shelf.serializedData()) ?? Data()
    }

    /// Whether a reference names one of the member's conversations (Home's
    /// search offers them, #1097, R-1097-24). A thread opens in the Chat tab
    /// and is no `Route`, so a caller asks this before it asks `route(for:)`.
    static func isThread(_ card: Centraid_Screen_V1_ChatCard) -> Bool {
        card.app == "chat" && card.entity == "thread"
    }

    /// An app's own front door, for a card whose entity has no row route.
    static func appHome(_ app: String) -> ShellModel.Route? {
        switch app {
        case "tasks": return TasksScreens.homeRoute
        case "notes": return NotesScreens.libraryRoute()
        case "docs": return DocsScreens.driveRoute
        case "people": return PeopleScreens.homeRoute
        case "agenda": return AgendaScreens.homeRoute
        case "photos": return .photos
        default: return nil
        }
    }

    /// The app an opened route belongs to (`tasks.home` is Tasks), or nil. The
    /// Chat tab scopes itself to the app the member last had open.
    static func app(of route: ShellModel.Route) -> String? {
        switch route {
        case let .screen(identifier, _):
            let app = identifier.split(separator: ".").first.map(String.init) ?? ""
            return app.isEmpty ? nil : app
        case .photos, .photoShelf, .photoLightbox, .photoPicker, .places, .photosPeople,
             .photoFaceReview, .photosMemories, .photoDuplicates, .photoDuplicateReview, .photoEditor:
            return "photos"
        }
    }

    /// Locker is not something the assistant can read (it has no scope), so a
    /// visit to it never scopes the chat.
    static func scopes(_ app: String) -> Bool {
        scopable.contains(app)
    }

    /// The apps a chat can be scoped to, in the order the composer's menu lists them.
    static let scopable = ["agenda", "docs", "notes", "people", "photos", "tasks"]

    private static var chatTitle: String {
        #if canImport(CentraidShared)
        ChatCopy.shared.TITLE
        #else
        ""
        #endif
    }
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
