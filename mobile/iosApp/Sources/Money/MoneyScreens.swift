import SwiftUI

import CentraidShared

/// MONEY, REGISTERED (#1099; #1135). Its screens are Rust's (`crates/screens`,
/// module `money`): there is no bridge, port or route parameter to register. A
/// tile, a search hit or a chat card arrives as a Rust `Route` the shared side
/// built (`MoneyEntry`), spelled as a `ScreenOpening` under `RustScreens.id`, and
/// `AppRegistry.present` pushes it as a `.rust` entry that `RustScreenHost`
/// draws from `ScreenStore`. Inside Money a row carries the `Route` of the page
/// it opens.
///
/// What the platform does for an import is a generic `PickFile` effect
/// `ScreenStore` performs.
enum MoneyScreens: AppScreens {
    static let appID = AppIds.shared.MONEY

    @MainActor
    static func register(into shell: ShellModel) {}

    /// The tile opens Money's home, on Spending.
    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? {
        var route = Centraid_Core_V1_Route()
        route.screen = "money.home"
        var home = Centraid_Core_V1_MoneyHomeRoute()
        home.destination = .spending
        route.moneyHome = home
        return .rust(RustEntry.make(route))
    }
}
