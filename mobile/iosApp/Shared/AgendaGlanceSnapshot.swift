import Foundation

/// THE WIDGETS' SNAPSHOT, AS THE SHELL AND THE WIDGET EXTENSION BOTH READ IT
/// (#1173, wave 3). Compiled into the app AND into `CentraidWidgets`.
///
/// Rust writes the document (`crates/screens/src/agenda/glance`) and decides every
/// word and every row in it; the app keeps it in the App Group container
/// (`ScreenStore`, `Effect.agenda_glance`) and the widgets and Siri read it from
/// there. This file only decodes it. Nothing here reads the vault, opens the core,
/// or links SwiftProtobuf: the document is JSON, and the extension must stay that
/// small (`project.yml`).
///
/// A document this file cannot decode, or whose `version` is not the one it knows,
/// loads as NOTHING, and every reader treats nothing as "unavailable": never as an
/// empty day, which would claim the member has nothing due.
struct AgendaGlanceSnapshot: Codable, Equatable, Sendable {
    /// The one schema version this reader understands.
    static let supportedVersion = 1
    /// The file's name in the shared container: one name for the writer and the readers.
    static let fileName = "agenda-glance.json"
    /// The App Group both processes belong to (`project.yml` entitlements).
    static let appGroup = "group.dev.centraid"

    var version: Int
    /// `"ready"` or `"unavailable"`.
    var state: String
    var today: String
    /// Local wall clock in `zone`, `YYYY-MM-DDTHH:MM`.
    var nowLocal: String
    var zone: String
    /// After this local wall clock the document is stale.
    var refreshAfter: String
    /// THE OPEN KEYS (additive; absent in a document an older core wrote): opaque
    /// strings the core named for a tap on the widget's body. A widget hands one
    /// back through `AgendaOpenURL` and names no screen itself.
    var openUpNext: String?
    var openReminders: String?
    var openAdd: String?
    var words: Words
    var upNext: [UpNext]
    var reminders: Reminders
    var siri: Siri

    struct Words: Codable, Equatable, Sendable {
        var upNextTitle: String
        var todayTitle: String
        var remindersTitle: String
        var nothingNext: String
        var noReminders: String
        var unavailable: String
        var stale: String
        var overdueLabel: String
        var todayLabel: String
        var flaggedLabel: String
        var addLabel: String
    }

    struct UpNext: Codable, Equatable, Sendable, Identifiable {
        var id: String
        /// `"event"` or `"task"`.
        var kind: String
        var title: String
        var timeLabel: String
        var dayLabel: String
        var startsLocal: String
        var endsLocal: String
        var allDay: Bool
        /// A colour key (`"agenda"`, `"red"`), never a colour.
        var tint: String
        /// The key the core names for a tap on the row (opaque).
        var open: String?
    }

    struct Reminders: Codable, Equatable, Sendable {
        var todayCount: Int
        var overdueCount: Int
        var flaggedCount: Int
        var rows: [Row]

        struct Row: Codable, Equatable, Sendable, Identifiable {
            var id: String
            var title: String
            var dueLabel: String
            var overdue: Bool
            var flagged: Bool
            /// The key the core names for a tap on the row (opaque).
            var open: String?
        }
    }

    struct Siri: Codable, Equatable, Sendable {
        var nextSentence: String
    }

    // MARK: Opening

    /// The URL a widget's tap opens the app with: `centraid://agenda?open=<key>`.
    /// The URL names no screen: the key is the core's, handed back untouched (the
    /// app reports it as `AgendaIntentOpen` and the core answers with a page).
    /// Nil for a missing or empty key, so a widget with no key sets no link.
    static func openURL(_ key: String?) -> URL? {
        guard let key, !key.isEmpty else { return nil }
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        guard let encoded = key.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return URL(string: "\(openScheme)://\(openHost)?\(openQueryName)=\(encoded)")
    }

    /// The key out of a URL `openURL` made; nil for a URL of any other shape (another
    /// scheme or host, a path, more or other query items, an empty or oversize key).
    static func openKey(from url: URL) -> String? {
        guard url.scheme == openScheme, url.host == openHost,
            url.path.isEmpty || url.path == "/",
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let items = components.queryItems, items.count == 1,
            items[0].name == openQueryName,
            let key = items[0].value, !key.isEmpty, key.count <= maxOpenKeyLength
        else { return nil }
        return key
    }

    /// The URL scheme the app registers (`project.yml`'s `CFBundleURLTypes`).
    static let openScheme = "centraid"
    /// Names the app (the one that owns the key), never a screen.
    static let openHost = "agenda"
    static let openQueryName = "open"
    /// A key longer than this is not one the core wrote.
    static let maxOpenKeyLength = 256

    // MARK: Reading

    /// Decode a document. Unknown keys are ignored (a newer Rust may add some);
    /// a missing key, malformed JSON or a version other than 1 is `nil`.
    static func decode(_ data: Data) -> AgendaGlanceSnapshot? {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard let snapshot = try? decoder.decode(AgendaGlanceSnapshot.self, from: data),
            snapshot.version == supportedVersion
        else { return nil }
        return snapshot
    }

    /// The shared container's directory, or nil where the App Group is not
    /// provisioned (a build with no provisioning profile carrying the group).
    static func containerURL() -> URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    }

    /// The snapshot the app last kept, or nil when there is no file, it cannot be
    /// read, or it is not a version-1 document.
    static func load() -> AgendaGlanceSnapshot? {
        guard let url = containerURL()?.appendingPathComponent(fileName),
            let data = try? Data(contentsOf: url)
        else { return nil }
        return decode(data)
    }

    // MARK: Staleness

    /// Whether `refresh_after` has passed on the device's clock, compared in the
    /// document's own zone (the core spelled both as civil strings in `zone`; the
    /// widget is the platform's timeline, so it may read the clock where Rust may
    /// not). A "ready" document whose stamp does not parse is stale, never healthy.
    /// An "unavailable" document is not stale: it already says so.
    func isStale(now: Date) -> Bool {
        guard state == "ready" else { return false }
        guard let deadline = refreshDate else { return true }
        return now >= deadline
    }

    /// `refresh_after` as an instant, or nil when it or the zone does not parse.
    var refreshDate: Date? {
        guard let zone = TimeZone(identifier: zone) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm"
        return formatter.date(from: refreshAfter)
    }

    /// The one sentence a widget shows INSTEAD of its rows, or nil when the rows
    /// are the truth: the unavailable sentence for an unavailable document, the
    /// stale sentence once `refresh_after` has passed.
    func notice(now: Date) -> String? {
        if state != "ready" { return words.unavailable }
        return isStale(now: now) ? words.stale : nil
    }
}
