import SwiftUI

import CentraidShared

/// AGENDA, REGISTERED (K5; #1135). Its screens are Rust's (`crates/screens`,
/// module `agenda`): there is no bridge, port or route parameter to register.
/// A tile, a search hit, a chat card or Notes' "Send to Agenda" arrives as a
/// Rust `Route` that `ShellModel.open` pushes; `RustScreenHost` draws it from
/// `ScreenStore`.
enum AgendaScreens: AppScreens {
    static let appID = AppIds.shared.AGENDA

    @MainActor
    static func register(into shell: ShellModel) {}

}
