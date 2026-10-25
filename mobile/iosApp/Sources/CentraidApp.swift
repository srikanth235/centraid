import SwiftUI

/// The iOS composition root (#1020, D-1020-E1).
///
/// **The views own nothing.** Every one of them takes a finished state message
/// and forwards events; the state machines are in `CentraidShared`, and this
/// file is the only one that knows the stack.
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
    /// WHAT THE SCENE PHASE DECIDES (#1029 §1; #1080).
    ///
    /// The SWITCHER MASK, which was never about the network: a phone in the
    /// app switcher must not show a member's rows in a snapshot the OS keeps.
    /// And the two BACKUP occasions: arriving runs a pass, and leaving arms the
    /// background windows and runs one more under the grace iOS gives a
    /// leaving app (`ShellModel.becameActive`, `ShellModel.wentToBackground`).
    @Environment(\.scenePhase) private var scenePhase

    /// REGISTER THE BACKGROUND HANDLERS BEFORE ANYTHING SUBMITS ONE (#1029 W18-1).
    ///
    /// iOS requires every `BGTaskScheduler` launch handler to be installed
    /// before the app finishes launching, and raises
    /// `NSInternalInconsistencyException` — which **terminates the app**, rather
    /// than failing the task — for a submit whose identifier has no handler.
    /// `ShellModel.shared` is what eventually submits, and an `init` body runs
    /// before any of this type's property-wrapper storage is read, so this is
    /// the one place in the app that is unambiguously launch.
    init() {
        BackgroundPasses.register()
    }

    /// The navigation root: bare paper until the shelf has answered, then the
    /// gate or Home. Its own property so the stack's modifier chain stays small
    /// enough for the type checker.
    @ViewBuilder private var root: some View {
        switch shell.holdsNoVault {
        case .some(true):
            FirstLaunchView(shell: shell)
        case .some(false):
            // BARE PAPER UNTIL THE LOCKUP LANDS. The shelf says it holds a
            // vault a moment before the session publishes that vault's
            // lockup, and Home drawn in that moment said "No vault yet" for a
            // frame between first launch and the springboard. A shelf that
            // holds a vault always has one in front, so an empty lockup is
            // only ever that moment.
            if shell.homeVaultID.isEmpty {
                BarePaper()
            } else {
                HomeView(shell: shell)
            }
        case .none:
            BarePaper()
        }
    }

    var body: some Scene {
        WindowGroup {
            NavigationStack(path: $shell.path) {
                // THE FIRST-LAUNCH GATE: a device that holds no vault opens
                // onto the way to make one, not onto a Home with nothing to
                // read. The shelf's answer, never a count taken here.
                root
                    .navigationDestination(for: ShellModel.Route.self) { route in
                        Group {
                            switch route {
                            // EVERY REGISTERED APP'S SCREENS (K5): the view
                            // is the one its `AppScreens.register` handed over.
                            case let .screen(identifier, parameter):
                                RegisteredScreen(shell: shell, identifier: identifier, parameter: parameter)
                            // A SCREEN RUST OWNS, drawn from its view state.
                            case let .rust(entry):
                                RustScreenHost(shell: shell, entry: entry)
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
                        //
                        // KEYED ON THE ROUTE. A route SWAPPED IN PLACE — Notes'
                        // band places, the editor's Done — keeps this
                        // destination's view and its task, so an unkeyed
                        // `.task` never told the new screen it opened and it
                        // sat on its skeleton for ever. `id: route` makes the
                        // swap a new task (`NavigationAndMountSpec`).
                        .task(id: route) { shell.opened(route) }
                        // THE ASSISTANT'S DOOR for a search's Ask row (#1097, R-1097-30, #1135).
                        .environment(\.askChat, { shell.askChat($0.question, scope: $0.scope) })
                        // THE IMPORT'S LINE on every route, at the foot (DESIGN.md's
                        // one status line): above the app's band where the page
                        // has one, at the page's own foot where it does not.
                        .modifier(ShellLineHost(shell: shell))
                    }
            }
            // THE ROOT'S TINT (DESIGN.md "The controls (mobile)"): `link`
            // ink on every platform control, not system blue.
            .kitRootTint()

            // EVERY APP'S ROOT WATCHER (#1047): Docs' filed-document push and
            // its picker, Locker's prompt and lifecycle.
            .background { AppGlobals(shell: shell) }
            // IOS'S CONTACT PICKER, for an import over limited access.
            .modifier(ContactAccessPickerHost(shell: shell))
            // THE QUESTION A HELD ACCOUNT OR CALENDAR LEAVES (#1127, R-1127-9).
            .modifier(PhoneFollowQuestionHost(shell: shell))
            // THE 24 WORDS (#1047 E2): `words.make` and `words.enter`, one
            // sheet at the root so Locker's wall can raise it from any depth.
            // A swipe is allowed only where the machine has a way out to hear.
            .sheet(item: Binding(
                get: { shell.wordsSheet },
                set: { if $0 == nil { shell.wordsSwipedAway() } }
            )) { sheet in
                switch sheet {
                case .make:
                    VaultWordsView(data: shell.vaultWordsState, send: { shell.sendVaultWords($0) })
                        .interactiveDismissDisabled(!shell.vaultWordsSwipeable)
                case .enter:
                    WordsEntryView(data: shell.wordsEntryState, send: { shell.sendWordsEntry($0) })
                        .interactiveDismissDisabled(!shell.wordsEntrySwipeable)
                // words.show's swipe is its Dismissed, always heard.
                case .show:
                    WordsShowView(data: shell.wordsShowState, send: { shell.sendWordsShow($0) })
                case .pair:
                    PairLaptopView(data: shell.pairLaptopState, send: { shell.sendPairLaptop($0) })
                        .interactiveDismissDisabled(!shell.pairLaptopSwipeable)
                }
            }
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
                    shell.screens?.lifecycle(foreground: true)
                    // AND DRAIN. The amendment's foreground half (#1029 W18-6):
                    // the phone backs up while the member is in the app, not
                    // only in the windows iOS grants. `ShelfDrain` refuses a
                    // second pass while one runs, so an `inactive` → `active`
                    // flicker costs nothing.
                    shell.becameActive()
                // `.background` ONLY, never `.inactive` (R-1047-L1's rule for
                // the lock, applied to the mask): the Locker's own Face ID
                // prompt makes the scene inactive, and a mask there blacked out
                // the screen behind the prompt. What `.inactive` alone covered
                // was the live card while the member's own finger holds the
                // switcher open — nothing the OS keeps.
                case .background:
                    shell.mask()
                    // LEAVING THE FOREGROUND RELOCKS THE LOCKER: the core does it,
                    // and every open screen hears it (`.background`, never `.inactive`).
                    shell.screens?.lifecycle(foreground: false)
                    LockerEntry.shared.setOpen(opened: false)
                    // words.show drops its words on leaving (#1047 E5).
                    shell.leftForeground()
                    // AND ARM THE NIGHT (#1080): resubmit both background
                    // windows and run one pass under the background task's
                    // grace, so what it seals is handed to the OS to carry
                    // while the app is suspended.
                    shell.wentToBackground()
                case .inactive:
                    break
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
