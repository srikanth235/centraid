import SwiftUI

enum RustScreens {
    static let homeTab = "home"
    static let chatTab = "chat"
    static let backupTab = "backup"
}

struct RustEntry: Hashable, Identifiable {
    let token: Int
    var id: Int { token }
    let route: Centraid_Core_V1_Route
    var tab: String = RustScreens.homeTab

    @MainActor private static var last = 0

    @MainActor static func make(_ route: Centraid_Core_V1_Route, tab: String = RustScreens.homeTab) -> RustEntry {
        last += 1
        return RustEntry(token: last, route: route, tab: tab)
    }
}

struct RustScreenHost: View {
    @ObservedObject var shell: ShellModel
    let entry: RustEntry

    var body: some View {
        Group {
            if let store = shell.screens, let instance = shell.rustInstances[entry.token] {
                RustScreenView(shell: shell, store: store, instance: instance, entry: entry)
            } else {
                BarePaper()
            }
        }
        .task(id: shell.screens != nil) { await shell.openRust(entry) }
    }
}

struct RustScreenView: View {
    let shell: ShellModel
    @ObservedObject var store: ScreenStore
    let instance: UInt64
    let entry: RustEntry?

    private func pop() {
        if let entry, shell.sheet == entry {
            shell.sheet = nil
            return
        }
        guard let entry, shell.path.last == .rust(entry) else { return }
        shell.path.removeLast()
    }

    var body: some View {
        WordsShield(secure: store.shielded.contains(instance)) {
            screen
        }
        .environment(\.placeHome, { shell.popToRoot() })
        .environment(\.statusActed, { store.send(instance, .statusActed(.init())) })
    }

    @ViewBuilder
    private var screen: some View {
        let open: (Centraid_Core_V1_Route) -> Void = { shell.open($0) }
        switch store.views[instance]?.kind {
        case .wordsMake(let state)?:
            VaultWordsView(
                state: state,
                send: { store.send(instance, .wordsMake($0)) },
                onDone: pop
            )
        case .wordsEnter(let state)?:
            WordsEntryView(
                state: state,
                send: { store.send(instance, .wordsEnter($0)) },
                onDone: pop
            )
        case .wordsShow(let state)?:
            WordsShowView(
                state: state,
                send: { store.send(instance, .wordsShow($0)) },
                onDone: {
                    guard let entry, shell.path.last == .rust(entry) else { return }
                    pop()
                    shell.wordsShowFinished()
                }
            )
        case .settings(let state)?:
            SettingsView(
                state: state,
                send: { store.send(instance, .settings($0)) },
                open: open,
                onBack: pop
            )
        case .backupCheck(let state)?:
            BackupCheckView(
                state: state,
                send: { store.send(instance, .backupCheck($0)) },
                onBack: pop
            )
        case .backupHome(let state)?:
            BackupHomeView(
                state: state,
                shell: shell,
                send: { store.send(instance, .backupHome($0)) },
                open: open
            )
        case .transfer(let state)?:
            CoreTransferView(
                state: state,
                send: { store.send(instance, .transfer($0)) },
                onBack: pop
            )
        case .pairLaptop(let state)?:
            PairLaptopPageView(
                state: state,
                send: { store.send(instance, .pairLaptop($0)) },
                onDone: pop
            )
        case .counter?:
            ProofScreenView(store: store, instance: instance)
        default:
            BarePaper()
                .onAppear {
                    guard let entry, store.closedInstances.contains(instance) else { return }
                    DispatchQueue.main.async { shell.dropClosedPage(entry) }
                }
        }
    }
}
