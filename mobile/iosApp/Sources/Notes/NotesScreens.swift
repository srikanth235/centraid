import SwiftUI

import CentraidShared

/// NOTES, REGISTERED (K5; #1135). Its screens are Rust's (`crates/screens`,
/// module `notes`): there is no bridge, port or route parameter to register.
/// A row, a search hit, a chat card or Home's tile arrives as a Rust `Route` that
/// `ShellModel.open` pushes; `RustScreenHost` draws it from `ScreenStore`.
enum NotesScreens: AppScreens {
    static let appID = AppIds.shared.NOTES

    @MainActor
    static func register(into shell: ShellModel) {}

}
