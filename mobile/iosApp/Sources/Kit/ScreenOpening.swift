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
