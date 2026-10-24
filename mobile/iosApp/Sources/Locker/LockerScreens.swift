import SwiftUI

import CentraidShared

/// LOCKER, REGISTERED (#1047, D-5; #1135). Its screens are Rust's
/// (`crates/screens`, module `locker`): there is no bridge, port or route
/// parameter to register. A tile, a search hit, a chat card or Home arrives as a
/// Rust `Route` the shared side built (`LockerEntry`), spelled as a
/// `ScreenOpening` under `RustScreens.id`, and `AppRegistry.present` pushes it
/// as a `.rust` entry that `RustScreenHost` draws from `ScreenStore`.
///
/// What the platform does for the lock is generic effects `ScreenStore` performs
/// (`OwnerCheck`, `PickBytes`, `SaveFile`, the clipboard with its deadline) and
/// the app's foreground/background, which it reports (`CentraidApp`).
enum LockerScreens: AppScreens {
    static let appID = AppIds.shared.LOCKER

    @MainActor
    static func register(into shell: ShellModel) {}

    /// The tile opens Locker's home; Rust asks the owner check as it appears.
    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? {
        var route = Centraid_Core_V1_Route()
        route.screen = "locker.home"
        var home = Centraid_Core_V1_LockerHomeRoute()
        home.destination = .items
        route.lockerHome = home
        return .rust(RustEntry.make(route))
    }
}
