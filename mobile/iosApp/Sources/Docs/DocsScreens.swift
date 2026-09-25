import SwiftUI

#if canImport(CentraidShared)
import CentraidShared
#endif

/// DOCS, REGISTERED (K5; #1046). Its one line is in `AppRegistry.apps`.
///
/// Five routes over four machines: the drive at its band (`docs.drive`), a
/// folder page pushed over it (a second `DocsDriveBridge` under
/// `docs.folder`, so the drive under it keeps its own tab, filters and
/// scroll), a document, the text editor and the trash. A route's parameter is
/// the screen's own `Opened` event, encoded; `open` sends it on every
/// appearance, so a pop back re-reads.
///
/// **INTENTS ARE THE SHELL'S** (`DocsBridges.kt`): `FolderPicked`,
/// `DocumentPicked`, `EditRequested`, `TrashOpened` push here; `AddRequested`
/// is the OS's (see `DocsDriveView.addRequested`).
enum DocsScreens: AppScreens {
    static let appID = "docs"

    /// `DocsDriveMachine.SCREEN_ID`.
    static let drive = "docs.drive"
    /// The folder page: the drive's machine on its own bridge.
    static let folder = "docs.folder"
    /// `DocsDocumentMachine.SCREEN_ID`.
    static let document = "docs.document"
    /// `DocsEditorMachine.SCREEN_ID`.
    static let editor = "docs.editor"
    static let trash = "docs.trash"

    static let driveRoute = ShellModel.Route.screen(
        drive,
        Centraid_Screen_V1_DocsDriveEvent.with { $0.opened = .with { $0.destination = .all } }.encoded
    )

    static func folderRoute(_ folderID: String, _ name: String) -> ShellModel.Route {
        .screen(folder, Centraid_Screen_V1_DocsDriveEvent.with {
            $0.opened = .with { $0.destination = .folders; $0.folderID = folderID; $0.folderName = name }
        }.encoded)
    }

    static func documentRoute(_ documentID: String, _ title: String) -> ShellModel.Route {
        .screen(document, Centraid_Screen_V1_DocsDocumentEvent.with {
            $0.opened = .with { $0.documentID = documentID; $0.title = title }
        }.encoded)
    }

    static func editorRoute(_ documentID: String, _ title: String) -> ShellModel.Route {
        .screen(editor, Centraid_Screen_V1_DocsEditorEvent.with {
            $0.opened = .with { $0.documentID = documentID; $0.title = title }
        }.encoded)
    }

    /// The trash names its own title and back words (`TrashListState`).
    static let trashRoute = ShellModel.Route.screen(trash, Data())

    @MainActor
    static func register(into shell: ShellModel) {
        #if canImport(CentraidShared)
        shell.register(.of(drive, DocsDriveBridge()))
        shell.register(.of(folder, DocsDriveBridge()))
        shell.register(.of(document, DocsDocumentBridge()))
        shell.register(.of(editor, DocsEditorBridge()))
        shell.register(.of(trash, DocsTrashBridge()))
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

        // THE DRIVE RE-OPENS WHERE IT WAS LEFT: a pop back from a document
        // lands on Starred if Starred was where the member was.
        shell.route(
            drive,
            open: { [weak shell] parameter in
                guard let shell else { return }
                let held = (try? Centraid_Screen_V1_DocsDriveState(serializedBytes: shell.state(drive))) ?? .init()
                var event = (try? Centraid_Screen_V1_DocsDriveEvent(serializedBytes: parameter)) ?? .init()
                if held.destination != .unspecified { event.opened.destination = held.destination }
                shell.send(screen: drive, event: event.encoded)
            },
            view: { shell, _ in
                AnyView(DocsDriveView(
                    data: shell.state(drive),
                    screen: drive,
                    parentTitle: nil,
                    send: sender(shell, drive),
                    push: push(shell),
                    onBack: pop(shell),
                    onHome: { [weak shell] in shell?.path.removeAll() }
                ))
            }
        )
        shell.route(
            folder,
            open: { [weak shell] parameter in shell?.send(screen: folder, event: parameter) },
            view: { shell, _ in
                AnyView(DocsDriveView(
                    data: shell.state(folder),
                    screen: folder,
                    parentTitle: folderParent(shell),
                    send: sender(shell, folder),
                    push: push(shell),
                    onBack: pop(shell),
                    onHome: { [weak shell] in shell?.path.removeAll() }
                ))
            }
        )
        shell.route(
            document,
            open: { [weak shell] parameter in shell?.send(screen: document, event: parameter) },
            view: { shell, _ in
                AnyView(DocsDocumentView(
                    data: shell.state(document),
                    send: sender(shell, document),
                    push: push(shell),
                    onBack: pop(shell),
                    onDeparted: { [weak shell] in shell?.departed(document) }
                ))
            }
        )
        shell.route(
            editor,
            open: { [weak shell] parameter in shell?.send(screen: editor, event: parameter) },
            view: { shell, parameter in
                AnyView(DocsEditorView(
                    data: shell.state(editor),
                    opened: parameter,
                    send: sender(shell, editor),
                    onClose: pop(shell),
                    onDeparted: { [weak shell] in shell?.departed(editor) }
                ))
            }
        )
        shell.route(
            trash,
            open: { [weak shell] _ in
                shell?.send(screen: trash, event: TrashListView.event { $0.opened = .init() })
            },
            view: { shell, _ in
                AnyView(TrashListView(
                    data: shell.state(trash),
                    send: sender(shell, trash),
                    onBack: pop(shell)
                ))
            }
        )
    }

    /// A folder page backs to its parent folder when the folder page's crumbs
    /// name one, and to the drive otherwise.
    @MainActor
    static func folderParent(_ shell: ShellModel) -> String {
        let page = (try? Centraid_Screen_V1_DocsDriveState(serializedBytes: shell.state(folder))) ?? .init()
        if case let .data(data)? = page.content, data.crumbs.count > 1 {
            return data.crumbs[data.crumbs.count - 2].name
        }
        let home = (try? Centraid_Screen_V1_DocsDriveState(serializedBytes: shell.state(drive))) ?? .init()
        return home.chrome.title.isEmpty ? page.chrome.title : home.chrome.title
    }

    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? { driveRoute }
}
