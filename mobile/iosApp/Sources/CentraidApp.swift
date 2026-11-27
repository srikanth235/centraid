import SwiftUI

/// The iOS composition root (#1020, D-1020-E1; #1135).
///
/// **The views own nothing.** Every one of them draws a `ViewState` Rust made and
/// forwards events; the screens, the vaults, the passes and the imports are Rust's
/// (`crates/screens`), and this file is the only one that knows the stack.
///
/// ONE ROOT STACK, NO TAB BAR — apps are covers over Home. That is a product
/// ruling, not a SwiftUI preference.
#if os(iOS)
@main
struct CentraidApp: App {
    /// THE APPLICATION DELEGATE, FOR THE ONE CALLBACK SwiftUI HAS NO SCENE
    /// FOR (#1080): `handleEventsForBackgroundURLSession`, which is how iOS
    /// hands back finished background uploads. See `AppDelegate.swift`.
    @UIApplicationDelegateAdaptor(CentraidAppDelegate.self) private var appDelegate
    /// THE PROCESS'S ONE SHELL, not a fresh one: a background relaunch may
    /// already have made it (`ShellModel.shared`).
    @StateObject private var shell = ShellModel.shared
    /// WHAT THE SCENE PHASE DECIDES (#1029 §1; #1080): the SWITCHER MASK, which
    /// was never about the network (a phone in the app switcher must not show a
    /// member's rows in a snapshot the OS keeps), and the app's lifecycle, which
    /// Rust hears (`AppLifecycle`: the Locker relocks, the pass service runs its
    /// background pass under the grace iOS gives a leaving app).
    @Environment(\.scenePhase) private var scenePhase

    /// REGISTER THE BACKGROUND HANDLERS BEFORE ANYTHING SUBMITS ONE (#1029 W18-1).
    ///
    /// iOS requires every `BGTaskScheduler` launch handler to be installed
    /// before the app finishes launching, and raises
    /// `NSInternalInconsistencyException` — which **terminates the app**, rather
    /// than failing the task — for a submit whose identifier has no handler.
    init() {
        BackgroundPasses.register()
    }

    var body: some Scene {
        WindowGroup {
            NavigationStack(path: $shell.path) {
                ShellRoot(shell: shell)
                    .navigationDestination(for: ShellModel.Route.self) { route in
                        Group {
                            switch route {
                            // A SCREEN RUST OWNS, drawn from its view state.
                            case let .rust(entry):
                                RustScreenHost(shell: shell, entry: entry)
                            }
                        }
                    }
            }
            .id(shell.stackEpoch)
            // A SCREEN RUST SAYS IS A SHEET (`Route.sheet`), over the page that opened it.
            .sheet(item: $shell.sheet) { entry in
                RustScreenHost(shell: shell, entry: entry)
                    .kitRootTint()
            }
            .kitRootTint()
            .onOpenURL { shell.handleOpenURL($0) }
            // THE SWITCHER MASK. Leaving the foreground paints an opaque mask
            // — not cosmetic: the snapshot iOS keeps for the app switcher is
            // taken once the scene reaches `.background`, of whatever is on
            // screen at that moment, and the mask is what it captures.
            .overlay { if shell.masked { Color.black.ignoresSafeArea() } }
            // THE MEMBER'S APPEARANCE (R-CHROME-7): nil follows the phone.
            .preferredColorScheme(shell.preferredScheme ?? ShellModel.uiTestScheme)
            // THE SYSTEM TEXT SIZE, CAPPED ONCE (design/behaviour.md § Accessibility): every
            // role but `band` follows it up to `xxxLarge`, here and nowhere else.
            .dynamicTypeSize(...Theme.textSizeCap)
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .active:
                    shell.unmask()
                    shell.lifecycle(foreground: true)
                    Task { await shell.rooms?.drainShareInbox() }
                // `.background` ONLY, never `.inactive` (R-1047-L1's rule for
                // the lock, applied to the mask): the Locker's own Face ID
                // prompt makes the scene inactive, and a mask there blacked out
                // the screen behind the prompt.
                case .background:
                    shell.mask()
                    shell.lifecycle(foreground: false)
                case .inactive:
                    break
                @unknown default:
                    shell.mask()
                }
            }
        }
    }
}

private struct ShellRoot: View {
    @ObservedObject var shell: ShellModel

    var body: some View {
        if let rooms = shell.rooms {
            RoomHostView(store: rooms)
        } else if shell.vaultDamaged {
            VaultDamagedView()
        } else {
            BarePaper()
        }
    }
}
#endif
