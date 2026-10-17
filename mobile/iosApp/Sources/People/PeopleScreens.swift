import SwiftUI
import UIKit

import CentraidShared

/// PEOPLE, REGISTERED (#1029 app port; K5). Its one line is in `AppRegistry.apps`.
///
/// **EVERY ROUTE'S PARAMETER IS ITS SCREEN'S OWN `Opened` EVENT, ENCODED.** The
/// route carries exactly the bytes the machine is told on every appearance, so
/// there is no second spelling of "which person" between the push and the
/// open.
///
/// **THE INTENTS ARE THE SHELL'S, AND WHERE THEY GO IS SHARED.** `PersonPicked`,
/// `AddPersonRequested`, `MoreRowPicked`, `LogTouchRequested`, `EditRequested`
/// and `ChannelTapped` change nothing in the machines; each is forwarded (so a
/// spec that watches the event log still sees it) and then handed to
/// `PeopleRouting` — a push it names, or, for a channel, the row it names,
/// whose value goes to the OS here (tel:, mailto:, Maps, the pasteboard).
enum PeopleScreens: AppScreens {
    static let appID = AppIds.shared.PEOPLE
    /// The machines' `SCREEN_ID`s.
    static let home = PeopleHomeMachine.shared.SCREEN_ID
    static let person = PeoplePersonMachine.shared.SCREEN_ID
    static let editor = PeopleEditorMachine.shared.SCREEN_ID
    static let trash = PeopleTrashKt.PeopleTrashMachine.screenId

    @MainActor
    static func register(into shell: ShellModel) {
        shell.register(.of(home, PeopleHomeBridge()))
        shell.register(.of(person, PeoplePersonBridge()))
        shell.register(.of(editor, PeopleEditorBridge()))
        shell.register(.of(trash, PeopleTrashBridge()))

        shell.route(
            home,
            open: { [weak shell] parameter in shell?.send(screen: home, event: parameter) },
            view: { shell, _ in
                AnyView(PeopleHomeView(
                    data: shell.state(home),
                    send: { [weak shell] bytes in
                        guard let shell else { return }
                        shell.send(screen: home, event: bytes)
                        shell.apply(PeopleRouting.shared.route(screenId: home, event: bytes.kotlin, state: shell.state(home).kotlin))
                    },
                    onHome: { [weak shell] in shell?.path.removeAll() }
                ))
            }
        )

        shell.route(
            person,
            open: { [weak shell] parameter in shell?.send(screen: person, event: parameter) },
            view: { shell, parameter in
                AnyView(PeoplePersonView(
                    data: shell.state(person),
                    opened: parameter,
                    send: { [weak shell] bytes in
                        guard let shell else { return }
                        shell.send(screen: person, event: bytes)
                        routePerson(bytes, shell)
                    },
                    onBack: { [weak shell] in pop(shell) }
                ))
            }
        )

        shell.route(
            editor,
            open: { [weak shell] parameter in shell?.send(screen: editor, event: parameter) },
            view: { shell, parameter in
                AnyView(PeopleEditorView(
                    data: shell.state(editor),
                    opened: parameter,
                    send: { [weak shell] in shell?.send(screen: editor, event: $0) },
                    onClose: { [weak shell] in pop(shell) },
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
                    send: { [weak shell] in shell?.send(screen: trash, event: $0) },
                    onBack: { [weak shell] in pop(shell) }
                ))
            }
        )
    }

    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? { .home(of: appID) }

    // MARK: - Intents

    /// A person's intents: the editor push is `PeopleRouting`'s, and so is
    /// which channel row a tap meant.
    @MainActor
    private static func routePerson(_ bytes: Data, _ shell: ShellModel) {
        let state = shell.state(person).kotlin
        shell.apply(PeopleRouting.shared.route(screenId: person, event: bytes.kotlin, state: state))
        if let row = PeopleRouting.shared.channelRow(event: bytes.kotlin, state: state),
           let channel = try? Centraid_Screen_V1_PeopleChannelRow(serializedBytes: row.data) {
            openChannel(channel)
        }
    }

    /// A CHANNEL, HANDED TO THE OS by the intent the machine folded onto the
    /// row. The row's value is the member's own words; the URL is only its
    /// envelope.
    @MainActor
    private static func openChannel(_ row: Centraid_Screen_V1_PeopleChannelRow) {
        let value = row.value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        let url: URL?
        switch row.intent {
        case .call:
            let dialable = value.filter { $0.isNumber || $0 == "+" || $0 == "*" || $0 == "#" }
            url = URL(string: "tel:\(dialable)")
        case .mail:
            url = value.addingPercentEncoding(withAllowedCharacters: .urlUserAllowed).flatMap { URL(string: "mailto:\($0)") }
        case .map:
            var components = URLComponents(string: "https://maps.apple.com/")
            components?.queryItems = [URLQueryItem(name: "q", value: value)]
            url = components?.url
        case .copy, .unspecified, .UNRECOGNIZED:
            UIPasteboard.general.string = value
            url = nil
        }
        if let url { UIApplication.shared.open(url) }
    }

    @MainActor
    private static func pop(_ shell: ShellModel?) {
        guard let shell, !shell.path.isEmpty else { return }
        shell.path.removeLast()
    }
}
