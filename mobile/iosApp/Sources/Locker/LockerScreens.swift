import SwiftUI

import CentraidShared

/// LOCKER, REGISTERED (#1047, D-5; #1135). Its screens are Rust's
/// (`crates/screens`, module `locker`): there is no bridge, port or route
/// parameter to register. A tile, a search hit, a chat card or Home arrives as a
/// Rust `Route` that `ShellModel.open` pushes; `RustScreenHost` draws it from
/// `ScreenStore`.
///
/// What the platform does for the lock is generic effects `ScreenStore` performs
/// (`OwnerCheck`, `PickBytes`, `SaveFile`, the clipboard with its deadline) and
/// the app's foreground/background, which it reports (`CentraidApp`).
enum LockerScreens: AppScreens {
    static let appID = AppIds.shared.LOCKER

    @MainActor
    static func register(into shell: ShellModel) {}

}
