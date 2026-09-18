import SwiftUI

/// The iOS composition root (#1020, D-1020-E1).
///
/// **The views own nothing.** Every one of them takes a finished state message
/// and forwards events; the state machines are in `CentraidShared`, and this
/// file is the only one that knows the stack.
///
/// ONE ROOT STACK, NO TAB BAR — apps are covers over Home. That is a product
/// ruling, not a SwiftUI preference.
// THE ENTRY POINT IS THE iOS APP'S, NOT THE TEST HOST'S (#1020).
//
// `Sources` is a LIBRARY target, so an unguarded `@main` emits `_main` into it
// and `swift test` — reason 3 in `Package.swift`'s header — fails linking the
// XCTest runner with a duplicate symbol. The app entry belongs to the platform
// that has an app; the macOS host build is only ever the fixture test's.
#if os(iOS)
@main
struct CentraidApp: App {
    @StateObject private var shell = ShellModel()
    /// WHAT THE SCENE PHASE STILL DECIDES (#1029 §1).
    ///
    /// It used to open and close the TAIL: `active` connected to the gateway's
    /// log stream and held it, `inactive` and `background` closed it. There is
    /// no gateway and no stream — the vault is on this phone and it is already
    /// current — so arriving and leaving are no longer sync occasions.
    ///
    /// What is left is the SWITCHER MASK, which was never about the network:
    /// a phone in the app switcher must not show a member's rows in a snapshot
    /// the OS keeps (`docs/mobile-offline.md:253`).
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            NavigationStack(path: $shell.path) {
                HomeView(shell: shell)
                    .navigationDestination(for: ShellModel.Route.self) { route in
                        Group {
                            switch route {
                            case .tally:
                                TallyListView(shell: shell)
                            case .photos:
                                PhotosGridView(shell: shell)
                            case let .note(identifier):
                                NotesEditorView(shell: shell, noteIdentifier: identifier)
                            }
                        }
                        // A SCREEN READS BECAUSE IT WAS OPENED. The machine
                        // emits its first `ReadPage` from `Opened` and from
                        // nothing else, so a cover that was pushed and never
                        // told would sit loading for ever (#1025 S5, lane L5).
                        // `.task` and not `.onAppear`: a pop back onto this
                        // cover re-runs it, and a screen a member returned to
                        // should re-read rather than show the page it had when
                        // they left.
                        .task { shell.opened(route) }
                    }
            }
            // THE SWITCHER MASK. Leaving the foreground paints an opaque mask
            // (`docs/mobile-offline.md:253`) — not cosmetic: it is the visible
            // half of a lock that has already happened.
            .overlay { if shell.masked { Color.black.ignoresSafeArea() } }
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                // `inactive` IS ALREADY LEAVING: a phone in the app switcher is
                // not a phone the member is looking at, and the snapshot the OS
                // takes is of whatever is on screen at that moment.
                case .active:
                    shell.unmask()
                case .inactive, .background:
                    shell.mask()
                @unknown default:
                    shell.mask()
                }
            }
        }
    }
}

#endif

// `HomeView` lives in `HomeView.swift`: Home is the graded springboard
// (#1020, wave A), not a list of links, and it is too large to sit in the
// composition root.
