import SwiftUI

/// The iOS composition root (#1020, D-1020-E1).
///
/// **The views own nothing.** Every one of them takes a finished state message
/// and forwards events; the state machines are in `CentraidShared`, and this
/// file is the only one that knows the stack.
///
/// ONE ROOT STACK, NO TAB BAR — apps are covers over Home, which is v0's own
/// ruling (`apps/mobile/src/navigation.ts:1-3`) and not a SwiftUI preference.
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

    var body: some Scene {
        WindowGroup {
            NavigationStack(path: $shell.path) {
                HomeView(shell: shell)
                    .navigationDestination(for: ShellModel.Route.self) { route in
                        switch route {
                        case .tally:
                            TallyListView(shell: shell)
                        case .photos:
                            PhotosGridView(shell: shell)
                        case let .note(identifier):
                            NotesEditorView(shell: shell, noteIdentifier: identifier)
                        }
                    }
            }
            // THE SWITCHER MASK. Leaving the foreground clears the decrypted
            // cache, unmounts replica sessions and paints an opaque mask
            // (`docs/mobile-offline.md:253`) — the mask is not cosmetic, it is
            // the visible half of a lock that has already happened.
            .overlay { if shell.masked { Color.black.ignoresSafeArea() } }
        }
    }
}

#endif

// `HomeView` lives in `HomeView.swift`: Home is the graded springboard
// (#1020, wave A), not a list of links, and it is too large to sit in the
// composition root.
