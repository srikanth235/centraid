import SwiftUI

import CentraidShared

/// HEALTH, REGISTERED (#1129, #1135). Its screens are Rust's (`crates/screens`, module
/// `health`): `health.home` (Today · Trends · Workouts, More a sheet) and, pushed from it,
/// `health.metric`, `health.workout` and `health.connect` have no bridge, port or route
/// parameter to register. A row, a chat card or Home's tile arrives as a Rust `Route` (a row's
/// own, or the shared side's `HealthEntry`), spelled as a `ScreenOpening` under
/// `RustScreens.id`, and `AppRegistry.present` pushes it as a `.rust` entry that
/// `RustScreenHost` draws from `ScreenStore`.
///
/// What stays here is the platform's half of one effect: reading HealthKit (`HealthRead`,
/// answered by `HealthKitReader.snapshot`), asked by Rust at the member's Connect tap and by a
/// following pass. The Android twin is `kit/ScreenEffects.kt`.
enum HealthScreens: AppScreens {
    static let appID = AppIds.shared.HEALTH

    @MainActor
    static func register(into shell: ShellModel) {}

    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? { .home(of: appID) }
}
