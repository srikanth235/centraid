import SwiftUI

import CentraidShared

/// MONEY, REGISTERED (#1099; #1135). Its screens are Rust's (`crates/screens`,
/// module `money`): there is no bridge, port or route parameter to register. A
/// tile, a search hit or a chat card arrives as a Rust `Route` that
/// `ShellModel.open` pushes; `RustScreenHost` draws it from `ScreenStore`.
/// Inside Money a row carries the `Route` of the page it opens.
///
/// What the platform does for an import is a generic `PickBytes` effect
/// `ScreenStore` performs.
enum MoneyScreens: AppScreens {
    static let appID = AppIds.shared.MONEY

    @MainActor
    static func register(into shell: ShellModel) {}

}
