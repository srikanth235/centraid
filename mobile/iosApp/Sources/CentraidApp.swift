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
                        // KEYED ON THE ROUTE: a route swapped in place is a new task.
                        .task(id: route) { shell.opened(route) }
                        // THE ASSISTANT'S DOOR for a search's Ask row (#1097, R-1097-30, #1135).
                        .environment(\.askChat, { shell.askChat($0) })
                        // THE IMPORT'S LINE on every route, at the foot (DESIGN.md's
                        // one status line): above the app's band where the page
                        // has one, at the page's own foot where it does not.
                        .modifier(ShellLineHost(shell: shell))
                    }
            }
            // THE ROOT'S TINT (DESIGN.md "The controls (mobile)"): `link`
            // ink on every platform control, not system blue.
            .kitRootTint()
            // THE PICKERS A SCREEN CAN ASK FOR WHEREVER THE MEMBER IS: Docs' file
            // picker and scanner (`PickFile`), and its folder picker (`FollowFolder`).
            .background {
                ZStack {
                    DocsFilesRoot()
                    DocsFollowRoot()
                }
                .frame(width: 0, height: 0)
                .accessibilityHidden(true)
            }
            // IOS'S CONTACT PICKER, for an import over limited access.
            .modifier(ContactAccessPickerHost(shell: shell))
            // THE SWITCHER MASK. Leaving the foreground paints an opaque mask
            // — not cosmetic: the snapshot iOS keeps for the app switcher is
            // taken once the scene reaches `.background`, of whatever is on
            // screen at that moment, and the mask is what it captures.
            .overlay { if shell.masked { Color.black.ignoresSafeArea() } }
            // THE MEMBER'S APPEARANCE (R-CHROME-7): nil follows the phone.
            .preferredColorScheme(shell.preferredScheme)
            // THE SYSTEM TEXT SIZE, CAPPED ONCE (DESIGN.md, Dynamic Type): every
            // role but `band` follows it up to `xxxLarge`, here and nowhere else.
            .dynamicTypeSize(...Theme.textSizeCap)
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .active:
                    shell.unmask()
                    shell.lifecycle(foreground: true)
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

/// THE NAVIGATION ROOT: bare paper until Home has drawn, then the first-launch
/// gate (Rust's, while the phone holds no vault) or Home. Its own view, so a
/// Home update redraws the root and the stack's modifier chain stays small
/// enough for the type checker.
private struct ShellRoot: View {
    @ObservedObject var shell: ShellModel

    var body: some View {
        if let store = shell.screens {
            StoreRoot(shell: shell, store: store)
        } else {
            BarePaper()
        }
    }
}

private struct StoreRoot: View {
    @ObservedObject var shell: ShellModel
    @ObservedObject var store: ScreenStore

    var body: some View {
        if let home = store.homeView {
            if home.hasFirstLaunch {
                // THE FIRST-LAUNCH GATE: nothing of Home stands behind it.
                FirstLaunchView(gate: home.firstLaunch, store: store)
                    .onAppear { shell.path = [] }
            } else {
                HomeView(shell: shell)
            }
        } else {
            BarePaper()
        }
    }
}
#endif

// `HomeView` lives in `HomeView.swift`: Home is the graded springboard
// (#1020, wave A), not a list of links, and it is too large to sit in the
// composition root.
