import Foundation

import CentraidShared

extension ShellModel.Route {
    /// A ROUTE THE SHARED SIDE CHOSE, PRESENTED HERE (`ScreenOpening`: a screen
    /// id and the event that screen opens by). WHICH screen is never decided in
    /// this file; it only maps the id onto the `Route` its screen is pushed as.
    /// Every registered app's screen is `.screen`, through the app's `present`;
    /// a screen Rust owns is `.rust`.
    static func opening(_ opening: ScreenOpening) -> ShellModel.Route {
        AppRegistry.present(opening.screenId, opening.event.data)
    }
}
