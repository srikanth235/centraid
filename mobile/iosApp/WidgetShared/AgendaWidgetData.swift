import Foundation

/// The host publishes display-only Agenda data; the extension never opens the vault.
struct AgendaWidgetData: Codable, Equatable {
    static let group = "group.dev.centraid.agenda"
    static let key = "agenda-widget"

    var title: String
    var eventTitle: String
    var eventWhen: String
    var reminders: String
    var reminderTitle: String
    var openLabel: String
    var newLabel: String
    var emptyLabel: String
    var updatedLabel: String
    var updatedAt: Date

    static func read() -> Self? {
        guard let bytes = UserDefaults(suiteName: group)?.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: bytes)
    }
}
