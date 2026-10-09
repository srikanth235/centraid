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
/// | tally | `expense` | the expense page |
/// | tally | `friend` | the friend page |
/// | tasks | `task` | the task's detail |
/// | tasks | `project` | the project's list |
/// | notes | `note` | the note's editor |
/// | docs | `document` | the document page |
/// | people | `person` | the person page |
/// | agenda | `event` | the event's detail (`qualifier` is the occurrence) |
/// | photos | `photo` | the lightbox, with the answer's other photos as neighbours |
///
/// An entity this table has no row for opens the app's home instead
/// ([appHome]); a tap that reached nothing would read as a broken card.
enum ChatRouting {
    static func route(
        for card: Centraid_Screen_V1_ChatCard,
        among cards: [Centraid_Screen_V1_ChatCard]
    ) -> ShellModel.Route? {
        let parent = chatTitle
        switch (card.app, card.entity) {
        case ("tally", "expense"):
            return TallyScreens.expenseRoute(card.id, parent: parent)
        case ("tally", "friend"):
            return TallyScreens.friendRoute(card.id, card.title, parent: parent)
        case ("tasks", "task"):
            return TasksScreens.detailRoute(card.id)
        case ("tasks", "project"):
            return TasksScreens.projectRoute(card.id, title: card.title)
        case ("notes", "note"):
            return NotesScreens.editorRoute(card.id)
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

    /// An app's own front door, for a card whose entity has no row route.
    static func appHome(_ app: String) -> ShellModel.Route? {
        switch app {
        case "tally": return TallyScreens.homeRoute
        case "tasks": return TasksScreens.homeRoute
        case "notes": return NotesScreens.libraryRoute()
        case "docs": return DocsScreens.driveRoute
        case "people": return PeopleScreens.homeRoute
        case "agenda": return AgendaScreens.homeRoute
        case "photos": return .photos
        default: return nil
        }
    }

    /// The app an opened route belongs to (`tally.home` is Tally), or nil. The
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
    static let scopable = ["agenda", "docs", "notes", "people", "photos", "tally", "tasks"]

    private static var chatTitle: String {
        #if canImport(CentraidShared)
        ChatCopy.shared.TITLE
        #else
        ""
        #endif
    }
}
