import Foundation

import CentraidShared

extension ShellModel.Route {
    /// A ROUTE THE SHARED SIDE CHOSE, PRESENTED HERE (`ScreenOpening`: a screen
    /// id and the event that screen opens by). WHICH screen is never decided in
    /// this file; it only maps the id onto the `Route` its screen is pushed as.
    /// The photographs are not registry screens and have cases of their own;
    /// every registered app's screen is `.screen`, through the app's `present`.
    static func opening(_ opening: ScreenOpening) -> ShellModel.Route {
        switch opening.screenId {
        case PhotosScreens.grid:
            return .photos
        case PhotosScreens.shelf:
            return .photoShelf(opening.event.data)
        case PhotosScreens.lightbox:
            return .photoLightbox(opening.assetId, opening.neighbours)
        default:
            return AppRegistry.present(opening.screenId, opening.event.data)
        }
    }

    /// An app's front door, by its catalogue id; nil for an app with none.
    static func home(of app: String) -> ShellModel.Route? {
        RowRoutes.shared.appHomeRoute(app: app).map { .opening($0) }
    }
}

extension ShellModel {
    /// A MOVE THE SHARED SIDE CHOSE (`ScreenMove`: an app's `<App>Routing`
    /// answer to the event a view just forwarded), applied: the top dropped,
    /// then each opening pushed. One assignment, so the stack never shows the
    /// half-move. Nil moves nothing.
    @MainActor
    func apply(_ move: ScreenMove?) {
        guard let move else { return }
        var next = path
        if move.dropsTop, !next.isEmpty { next.removeLast() }
        next.append(contentsOf: move.openings.map { Route.opening($0) })
        path = next
    }

    /// A push the shared side chose, as `apply` takes it.
    @MainActor
    func push(_ opening: ScreenOpening?) {
        guard let opening else { return }
        path.append(.opening(opening))
    }

    /// The screen id of the entry under the top, empty when it is Home or not
    /// a registered screen — what `NotesRouting.close` asks.
    var screenBelowTop: String {
        guard path.count >= 2, case let .screen(id, _) = path[path.count - 2] else { return "" }
        return id
    }
}
