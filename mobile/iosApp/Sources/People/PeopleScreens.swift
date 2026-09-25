import SwiftUI
import UIKit

#if canImport(CentraidShared)
import CentraidShared
#endif

/// PEOPLE, REGISTERED (#1029 app port; K5). Its one line is in `AppRegistry.apps`.
///
/// **EVERY ROUTE'S PARAMETER IS ITS SCREEN'S OWN `Opened` EVENT, ENCODED.** The
/// route carries exactly the bytes the machine is told on every appearance, so
/// there is no second spelling of "which person" between the push and the
/// open.
///
/// **THE INTENTS ARE THE SHELL'S.** `PersonPicked`, `AddPersonRequested`,
/// `TrashRequested`, `LogTouchRequested`, `EditRequested` and `ChannelTapped`
/// change nothing in the machines; each is forwarded (so a spec that watches
/// the event log still sees it) and then routed here — a push, or the OS for a
/// channel (tel:, mailto:, Maps, the pasteboard).
enum PeopleScreens: AppScreens {
    static let appID = "people"
    static let home = "people.home"
    static let person = "people.person"
    static let editor = "people.editor"
    static let trash = "people.trash"

    static var homeRoute: ShellModel.Route {
        .screen(home, Centraid_Screen_V1_PeopleHomeEvent.with {
            $0.opened = .with { $0.destination = .people }
        }.encoded)
    }

    static func personRoute(_ partyID: String, name: String, logTouch: Bool = false) -> ShellModel.Route {
        .screen(person, Centraid_Screen_V1_PeoplePersonEvent.with {
            $0.opened = .with {
                $0.partyID = partyID
                $0.name = name
                $0.logTouch = logTouch
            }
        }.encoded)
    }

    static func editorRoute(_ partyID: String) -> ShellModel.Route {
        .screen(editor, Centraid_Screen_V1_PeopleEditorEvent.with {
            $0.opened = .with { $0.partyID = partyID }
        }.encoded)
    }

    /// A NEW PERSON, under an id minted here — `PeopleEditorBridge.openNew`'s
    /// event, spelled as bytes so the route and the open are one thing.
    static var newPersonRoute: ShellModel.Route {
        .screen(editor, Centraid_Screen_V1_PeopleEditorEvent.with {
            $0.opened = .with { $0.mintedPartyID = UUID().uuidString.lowercased() }
        }.encoded)
    }

    @MainActor
    static func register(into shell: ShellModel) {
        #if canImport(CentraidShared)
        shell.register(.of(home, PeopleHomeBridge()))
        shell.register(.of(person, PeoplePersonBridge()))
        shell.register(.of(editor, PeopleEditorBridge()))
        shell.register(.of(trash, PeopleTrashBridge()))
        #endif

        shell.route(
            home,
            open: { [weak shell] parameter in shell?.send(screen: home, event: parameter) },
            view: { shell, _ in
                AnyView(PeopleHomeView(
                    data: shell.state(home),
                    send: { [weak shell] bytes in
                        guard let shell else { return }
                        shell.send(screen: home, event: bytes)
                        routeHome(bytes, shell)
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

    static func tileRoute(_ tile: Centraid_Screen_V1_HomeTile) -> ShellModel.Route? { homeRoute }

    // MARK: - Intents

    @MainActor
    private static func routeHome(_ bytes: Data, _ shell: ShellModel) {
        guard let event = try? Centraid_Screen_V1_PeopleHomeEvent(serializedBytes: bytes) else { return }
        switch event.kind {
        case let .person(picked):
            shell.path.append(personRoute(picked.partyID, name: picked.name))
        case let .logTouch(picked):
            shell.path.append(personRoute(picked.partyID, name: picked.name, logTouch: true))
        case .addPerson:
            shell.path.append(newPersonRoute)
        case .trash:
            shell.path.append(.screen(trash, Data()))
        default:
            break
        }
    }

    @MainActor
    private static func routePerson(_ bytes: Data, _ shell: ShellModel) {
        guard let event = try? Centraid_Screen_V1_PeoplePersonEvent(serializedBytes: bytes) else { return }
        let state = (try? Centraid_Screen_V1_PeoplePersonState(serializedBytes: shell.state(person))) ?? .init()
        switch event.kind {
        case .edit:
            guard !state.partyID.isEmpty else { return }
            shell.path.append(editorRoute(state.partyID))
        case let .channel(tapped):
            guard case let .data(data) = state.content,
                  let row = data.channels.first(where: { $0.channelID == tapped.channelID })
            else { return }
            openChannel(row)
        default:
            break
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
