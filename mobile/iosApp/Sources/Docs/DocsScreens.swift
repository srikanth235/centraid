import SwiftUI

import CentraidShared

/// DOCS, REGISTERED (K5; #1135). Its screens are Rust's (`crates/screens`,
/// module `docs`): the drive, a folder's page, a document, its version history,
/// its editor and its trash have no bridge, port or route parameter to register.
/// A tile, a search hit, a chat card or a row arrives as a Rust `Route` that
/// `ShellModel.open` pushes; `RustScreenHost` draws it from `ScreenStore`.
///
/// What stays here is the platform's half of two effects: the file picker, the
/// scanner and the stage door (`PickFile`, `DocsFiles`), and the folder picker
/// and its persisted access (`FollowFolder`, `StopFollowing`, `DocsFollow`).
enum DocsScreens: AppScreens {
    static let appID = AppIds.shared.DOCS

    /// Streams a picked file into the core (`PickFile`).
    static let stageBridge = StageFileBridge()

    /// FOLLOWING A FOLDER (#1127): what the vault is told when the member follows or stops one.
    static let followBridge = DocsFollowBridge()

    @MainActor
    static func register(into shell: ShellModel) {
        DocsFollow.shared.shell = shell
        // No screen state to carry: the port only attaches the two bridges to the session.
        shell.register(ScreenPort(
            id: "docs.files",
            send: { _ in },
            attach: {
                stageBridge.attach(session: $0)
                followBridge.attach(session: $0)
            },
            observe: { _ in }
        ))
    }


    /// THE FILE PICKER, THE SCANNER AND THE FOLDER PICKER, at the root: a pick
    /// can be asked for wherever the member is.
    @MainActor
    static func global(_ shell: ShellModel) -> AnyView? {
        AnyView(ZStack {
            DocsFilesRoot()
            DocsFollowRoot()
        })
    }
}
