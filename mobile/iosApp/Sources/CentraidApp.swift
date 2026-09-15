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
    /// THE ONLY THING THAT OPENS AND CLOSES A TAIL ON THIS PLATFORM
    /// (#1025 S2, D-1025-S7-40).
    ///
    /// `active` opens it, `inactive` and `background` close it. There is no
    /// timer beside this and none anywhere in the shell: a seat becomes current
    /// by connecting and staying on the log stream, so "the member is looking
    /// at the app" is the whole of the schedule.
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
            // THE SWITCHER MASK. Leaving the foreground clears the decrypted
            // cache, unmounts replica sessions and paints an opaque mask
            // (`docs/mobile-offline.md:253`) — the mask is not cosmetic, it is
            // the visible half of a lock that has already happened.
            .overlay { if shell.masked { Color.black.ignoresSafeArea() } }
            // THE FIRST ACTIVATION IS NOT A CHANGE (#1025 S2, D-1025-S7-40).
            // `onChange` fires on transitions and a cold launch arrives already
            // `active`, so the first foreground would open no tail at all —
            // which is the one launch a member is most likely to be watching.
            .task { shell.foreground() }
            // THE TAIL FOLLOWS THE MEMBER (#1025 S2, D-1025-S7-40).
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .active:
                    shell.foreground()
                // `inactive` IS ALREADY LEAVING. The switcher mask is painted
                // here for the same reason the tail closes here: a phone in the
                // app switcher is not a phone the member is looking at.
                case .inactive, .background:
                    shell.leftTheForeground()
                @unknown default:
                    shell.leftTheForeground()
                }
            }
        }
    }
}

#endif

// `HomeView` lives in `HomeView.swift`: Home is the graded springboard
// (#1020, wave A), not a list of links, and it is too large to sit in the
// composition root.
