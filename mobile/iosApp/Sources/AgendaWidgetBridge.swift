import Foundation
import WidgetKit

@MainActor
enum AgendaWidgetBridge {
    static func publish(_ home: Centraid_Core_V1_HomeState) {
        let defaults = UserDefaults(suiteName: AgendaWidgetData.group)
        guard case let .data(data)? = home.content, data.hasAgendaWidget else {
            if defaults?.object(forKey: AgendaWidgetData.key) != nil {
                defaults?.removeObject(forKey: AgendaWidgetData.key)
                WidgetCenter.shared.reloadTimelines(ofKind: "dev.centraid.agenda")
            }
            return
        }
        let source = data.agendaWidget
        var snapshot = AgendaWidgetData(
            title: source.title, eventTitle: source.eventTitle, eventWhen: source.eventWhen,
            reminders: source.reminders, reminderTitle: source.reminderTitle,
            openLabel: source.openLabel, newLabel: source.newLabel, emptyLabel: source.emptyLabel,
            updatedLabel: source.updatedLabel, updatedAt: Date()
        )
        if let previous = AgendaWidgetData.read() {
            snapshot.updatedAt = previous.updatedAt
            if previous == snapshot && Date().timeIntervalSince(previous.updatedAt) < 900 { return }
            snapshot.updatedAt = Date()
        }
        guard let bytes = try? JSONEncoder().encode(snapshot) else { return }
        defaults?.set(bytes, forKey: AgendaWidgetData.key)
        WidgetCenter.shared.reloadTimelines(ofKind: "dev.centraid.agenda")
    }
}

/// URLs and App Intents only ask Rust for a destination. They never choose a
/// route, write a task or open a second core. A title is a prefilled draft.
@MainActor
enum AgendaEntrypoint {
    private static var pending: Centraid_Core_V1_HomeEvent.EntryAsked?

    static func open(_ url: URL) {
        guard url.scheme == "centraid", url.host == "agenda" else { return }
        let entry: Centraid_Core_V1_HomeEvent.EntryAsked.Entry
        switch url.path {
        case "/calendar": entry = .agendaCalendar
        case "/reminders": entry = .agendaReminders
        case "/new": entry = .agendaNewReminder
        default: return
        }
        let title = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
            .first(where: { $0.name == "title" })?.value ?? ""
        request(entry, title: title)
    }

    static func request(_ entry: Centraid_Core_V1_HomeEvent.EntryAsked.Entry, title: String = "") {
        pending = .with { $0.entry = entry; $0.title = String(title.prefix(1024)) }
        if let store = ShellModel.shared.screens { consume(store) }
    }

    static func consume(_ store: ScreenStore) {
        guard let pending, let home = store.homeView, case .data? = home.content else { return }
        self.pending = nil
        store.sendHome(.entryAsked(pending))
    }
}
