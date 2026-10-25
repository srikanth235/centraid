import SwiftUI

import CentraidShared

/// HEALTH, REGISTERED (#1129, #1135). Its screens are Rust's (`crates/screens`, module
/// `health`): `health.home` (Today · Trends · Workouts, More a sheet) and, pushed from it,
/// `health.metric`, `health.workout` and `health.connect` have no bridge, port or route
/// parameter to register. A row, a chat card or Home's tile arrives as a Rust `Route`
/// that `ShellModel.open` pushes; `RustScreenHost` draws it from `ScreenStore`.
///
/// What stays here is the platform's half of one effect: reading HealthKit (`HealthRead`,
/// answered by `HealthKitReader.snapshot`), asked by Rust at the member's Connect tap and by a
/// following pass. The Android twin is `kit/ScreenEffects.kt`.
enum HealthScreens: AppScreens {
    static let appID = AppIds.shared.HEALTH

    @MainActor
    static func register(into shell: ShellModel) {}

}
