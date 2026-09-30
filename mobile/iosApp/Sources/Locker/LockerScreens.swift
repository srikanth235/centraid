import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

/// LOCKER, REGISTERED (#1047, D-5). Its one line is in `AppRegistry.apps`.
///
/// Five routes over five bridges, every one riding `LockerGate.shared`, plus
/// the lock wall's bridge (`locker.lock`) — the platform seam this file and
/// `LockerLockSeam` implement exactly as `LockerGate.kt` states it: the
/// capability read, one OS prompt per token, the answer mapped to its
/// outcome, `backgrounded()` on `.background` only, `foregrounded()` on the
/// way back. **Everything else is the machine's**: the phases, every word on
/// the wall, what a screen may read.
///
/// **INTENTS ARE THE SHELL'S**: `AddItem`, `ItemPicked`, a More row, `EditTapped`
/// and `UseTapped` change nothing in their machines; each view forwards the
/// event and then pushes the route built here.
enum LockerScreens: AppScreens {
    static let appID = "locker"

    /// `LockerHomeMachine.SCREEN_ID`.
    static let home = "locker.home"
    /// `LockerItemMachine.SCREEN_ID`.
    static let item = "locker.item"
    /// `LockerEditorMachine.SCREEN_ID`.
    static let editor = "locker.editor"
    /// `LockerGeneratorMachine.SCREEN_ID` — drawn in the home's band slot.
    static let generator = "locker.generator"
    /// The kit's trash with Locker as its parameter.
    static let trash = "locker.trash"
    /// `LockerExportMachine.SCREEN_ID` (#1047 T2).
    static let export = "locker.export"
    /// `LockerImportMachine.SCREEN_ID` (#1047 T2).
    static let importScreen = "locker.import"
    /// The lock wall's state.
    static let lock = "locker.lock"

    #if canImport(CentraidShared)
    /// THE WALL'S BRIDGE, for the app's life (`LockerLockBridge`'s header).
    static let lockBridge = LockerLockBridge(gate: LockerGate.Companion.shared.shared)
    static let editorBridge = LockerEditorBridge()
    static let generatorBridge = LockerGeneratorBridge()
    static let itemBridge = LockerItemBridge()
    /// The export's bridge, whose save seam `LockerTransferRoot` installs.
    static let exportBridge = LockerExportBridge()
    static let importBridge = LockerImportBridge()
    #endif

    // MARK: Routes

    static let homeRoute = ShellModel.Route.screen(
        home,
        Centraid_Screen_V1_LockerHomeEvent.with { $0.opened = .with { $0.destination = .items } }.encoded
    )

    /// `parent` is the PUSHING page's own title, which the item's back says.
    static func itemRoute(_ itemID: String, parent: String) -> ShellModel.Route {
        .screen(item, Centraid_Screen_V1_LockerItemEvent.Opened.with {
            $0.itemID = itemID
            $0.parent = parent
        }.encoded)
    }

    /// A new item. The id is minted by the bridge on open, never by a route.
    static let addRoute = ShellModel.Route.screen(editor, Data("add".utf8))
    /// A new login carrying the generator's output — handed over bridge to
    /// bridge (`openAddFrom`), never through a route.
    static let addFromGeneratorRoute = ShellModel.Route.screen(editor, Data("generator".utf8))

    static func editRoute(_ itemID: String) -> ShellModel.Route {
        .screen(editor, Data("edit:\(itemID)".utf8))
    }

    static let trashRoute = ShellModel.Route.screen(trash, Data())
    static let exportRoute = ShellModel.Route.screen(export, Data())
    static let importRoute = ShellModel.Route.screen(importScreen, Data())

    // MARK: Registration

    @MainActor
    static func register(into shell: ShellModel) {
        #if canImport(CentraidShared)
        shell.register(ScreenPort(
            id: lock,
            send: { [weak shell] event in
                lockBridge.send(event: event.kotlin)
                // `WordsTapped` IS AN INTENT (the gate ignores it): the shell
                // opens words.enter to give this phone's vaults their key.
                if case .words = (try? Centraid_Screen_V1_LockerLockEvent(serializedBytes: event))?.kind {
                    shell?.openRekey()
                }
            },
            attach: { lockBridge.attach(session: $0) },
            observe: { onState in lockBridge.observe { onState($0.data) } }
        ))
        shell.register(.locker(home, LockerHomeBridge()))
        shell.register(.locker(item, itemBridge))
        shell.register(.locker(editor, editorBridge))
        shell.register(.locker(generator, generatorBridge))
        shell.register(.of(trash, LockerTrashBridge(gate: LockerGate.Companion.shared.shared)))
        shell.register(.locker(export, exportBridge))
        shell.register(.locker(importScreen, importBridge))
        #endif

        func push(_ shell: ShellModel?) -> (ShellModel.Route) -> Void {
            { [weak shell] route in shell?.path.append(route) }
        }
        func pop(_ shell: ShellModel?) -> () -> Void {
            { [weak shell] in
                guard let shell, !shell.path.isEmpty else { return }
                shell.path.removeLast()
            }
        }
        func sender(_ shell: ShellModel?, _ id: String) -> (Data) -> Void {
            { [weak shell] in shell?.send(screen: id, event: $0) }
        }

        // THE HOME RE-OPENS ON THE TAB IT WAS LEFT ON.
        shell.route(
            home,
            open: { [weak shell] parameter in
                guard let shell else { return }
                LockerLockSeam.attached(shell)
                let held = (try? Centraid_Screen_V1_LockerHomeState(serializedBytes: shell.state(home))) ?? .init()
                var event = (try? Centraid_Screen_V1_LockerHomeEvent(serializedBytes: parameter)) ?? .init()
                if held.destination != .unspecified { event.opened.destination = held.destination }
                shell.send(screen: home, event: event.encoded)
            },
            view: { shell, _ in
                AnyView(LockerHomeView(
                    data: shell.state(home),
                    lock: shell.state(lock),
                    generator: shell.state(generator),
                    send: sender(shell, home),
                    sendLock: sender(shell, lock),
                    sendGenerator: sender(shell, generator),
                    push: push(shell),
                    onHome: { [weak shell] in shell?.path.removeAll() }
                ))
            }
        )
        shell.route(
            item,
            open: { [weak shell] parameter in
                guard let shell else { return }
                LockerLockSeam.attached(shell)
                #if canImport(CentraidShared)
                let opened = (try? Centraid_Screen_V1_LockerItemEvent.Opened(serializedBytes: parameter)) ?? .init()
                itemBridge.open(itemId: opened.itemID, parent: opened.parent)
                #endif
            },
            view: { shell, _ in
                AnyView(LockerItemView(
                    data: shell.state(item),
                    lock: shell.state(lock),
                    send: sender(shell, item),
                    sendLock: sender(shell, lock),
                    push: push(shell),
                    onBack: pop(shell),
                    onDeparted: { [weak shell] in shell?.departed(item) }
                ))
            }
        )
        shell.route(
            editor,
            open: { [weak shell] parameter in
                guard let shell else { return }
                LockerLockSeam.attached(shell)
                #if canImport(CentraidShared)
                let spoken = String(decoding: parameter, as: UTF8.self)
                if spoken == "generator" {
                    editorBridge.openAddFrom(generator: generatorBridge)
                } else if spoken.hasPrefix("edit:") {
                    editorBridge.openEdit(itemId: String(spoken.dropFirst("edit:".count)))
                } else {
                    editorBridge.openAdd()
                }
                #endif
            },
            view: { shell, _ in
                AnyView(LockerEditorView(
                    data: shell.state(editor),
                    lock: shell.state(lock),
                    send: sender(shell, editor),
                    sendLock: sender(shell, lock),
                    onClose: pop(shell),
                    onDeparted: { [weak shell] in shell?.departed(editor) }
                ))
            }
        )
        shell.route(
            export,
            open: { [weak shell] _ in
                guard let shell else { return }
                LockerLockSeam.attached(shell)
                #if canImport(CentraidShared)
                exportBridge.open(parent: LockerWords.appName)
                #endif
            },
            view: { shell, _ in
                AnyView(LockerExportView(
                    data: shell.state(export),
                    lock: shell.state(lock),
                    send: sender(shell, export),
                    sendLock: sender(shell, lock),
                    onBack: pop(shell),
                    onDeparted: { [weak shell] in shell?.departed(export) }
                ))
            }
        )
        shell.route(
            importScreen,
            open: { [weak shell] _ in
                guard let shell else { return }
                LockerLockSeam.attached(shell)
                #if canImport(CentraidShared)
                importBridge.open(parent: LockerWords.appName)
                #endif
            },
            view: { shell, _ in
                AnyView(LockerImportView(
                    data: shell.state(importScreen),
                    lock: shell.state(lock),
                    send: sender(shell, importScreen),
                    sendLock: sender(shell, lock),
                    onPicked: { name, bytes in
                        #if canImport(CentraidShared)
                        importBridge.picked(name: name, bytes: bytes.kotlin)
                        #endif
                    },
                    onBack: pop(shell),
                    onDeparted: { [weak shell] in shell?.departed(importScreen) }
                ))
            }
        )
        shell.route(
            trash,
            open: { [weak shell] _ in
                guard let shell else { return }
                LockerLockSeam.attached(shell)
                shell.send(screen: trash, event: TrashListView.event { $0.opened = .init() })
            },
            view: { shell, _ in
                AnyView(LockerCovered(lock: shell.state(lock), sendLock: sender(shell, lock), onBack: pop(shell)) {
                    // THE KIT SHIELDS ITS LIST AND ITS CONFIRM while the gate
                    // says `secure`, and keeps its toolbar outside the canvas.
                    TrashListView(
                        data: shell.state(trash),
                        send: sender(shell, trash),
                        onBack: pop(shell),
                        secure: Centraid_Screen_V1_LockerLockState.of(shell.state(lock)).secure
                    )
                })
            }
        )
    }

    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? { homeRoute }

    /// THE SEAMS, AT THE ROOT: the OS prompt, the scene's phases, and the
    /// export's save sheet (#1047 T2).
    @MainActor
    static func global(_ shell: ShellModel) -> AnyView? {
        AnyView(ZStack {
            LockerLockSeam(shell: shell)
            LockerTransferRoot()
        })
    }
}

#if canImport(CentraidShared)
extension ScreenPort {
    /// A Locker bridge: `LockerScreenBridge` holds Locker's own held state (the
    /// gate, a reveal) rather than subclassing the kit's `ScreenBridge`, and
    /// speaks the same verbs.
    static func locker<S: AnyObject, E: AnyObject>(_ id: String, _ bridge: LockerScreenBridge<S, E>) -> ScreenPort {
        ScreenPort(
            id: id,
            send: { bridge.send(event: $0.kotlin) },
            attach: { bridge.attach(session: $0) },
            observe: { onState in bridge.observe { onState($0.data) } },
            departed: { bridge.departed() }
        )
    }
}
#endif
