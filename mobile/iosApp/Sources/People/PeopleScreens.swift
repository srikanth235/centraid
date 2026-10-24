import SwiftUI

import CentraidShared

/// PEOPLE, REGISTERED (K5; #1135). Its screens are Rust's (`crates/screens`,
/// module `people`): there is no bridge, port or route parameter to register.
/// A tile, a row, a search hit or a chat card arrives as a Rust `Route` the
/// shared side built (`PeopleEntry`), spelled as a `ScreenOpening` under
/// `RustScreens.id`, and `AppRegistry.present` pushes it as a `.rust` entry that
/// `RustScreenHost` draws from `ScreenStore`. A channel's call, mail and map
/// are Rust's effects (`OpenUrl`, `OpenMap`), performed by `ScreenStore`.
enum PeopleScreens: AppScreens {
    static let appID = AppIds.shared.PEOPLE

    @MainActor
    static func register(into shell: ShellModel) {}

    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? { .home(of: appID) }
}
