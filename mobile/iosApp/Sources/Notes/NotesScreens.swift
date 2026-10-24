import SwiftUI

import CentraidShared

/// NOTES, REGISTERED (K5; #1135). Its screens are Rust's (`crates/screens`,
/// module `notes`): there is no bridge, port or route parameter to register.
/// A row, a search hit, a chat card or Home's tile arrives as a Rust `Route` the
/// shared side built (`NotesEntry`), spelled as a `ScreenOpening` under
/// `RustScreens.id`, and `AppRegistry.present` pushes it as a `.rust` entry that
/// `RustScreenHost` draws from `ScreenStore`.
enum NotesScreens: AppScreens {
    static let appID = AppIds.shared.NOTES

    @MainActor
    static func register(into shell: ShellModel) {}

    /// WHERE THE TILE LEADS: the shared `NotesEntry.tile` — the Notes place over
    /// its shelf, a new note on an empty vault, nowhere while the read is out.
    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? {
        NotesEntry.shared.tileOpening(tile: tile.encoded.kotlin).map { .opening($0) }
    }
}
