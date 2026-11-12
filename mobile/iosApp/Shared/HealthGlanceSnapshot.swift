import Foundation

/// HEALTH'S WIDGET SNAPSHOT, AS THE SHELL AND THE WIDGET EXTENSION BOTH READ IT
/// (#1185). Compiled into the app AND into `CentraidWidgets`.
///
/// Rust writes the document (`crates/screens/src/health/glance`) and decides every
/// word and every figure in it, finished in the member's language and units; the
/// app keeps it in the App Group container (`HealthGlanceWriter`,
/// `Effect.health_glance`) and the widget reads it from there. This file only
/// decodes. Nothing here reads the vault, opens the core or links SwiftProtobuf.
///
/// A document this file cannot decode, or whose `version` is not the one it knows,
/// loads as NOTHING, and the widget draws only its own name: never an empty,
/// healthy-looking day.
struct HealthGlanceSnapshot: Codable, Equatable, Sendable {
    /// The one schema version this reader understands.
    static let supportedVersion = 1
    /// The file's name in the shared container. Rust names it (`Effect.health_glance`'s
    /// `file`); this is the reader's copy of that one name.
    static let fileName = "health-glance.json"
    /// The widget's kind: the writer reloads exactly this widget's timelines.
    static let widgetKind = "dev.centraid.widget.health"

    var version: Int
    /// `"ready"`, `"empty"` or `"unavailable"`.
    var state: String
    var today: String
    var zone: String
    /// Local wall clock in `zone`, `YYYY-MM-DDTHH:MM`; after it the document is stale.
    var refreshAfter: String
    /// The opaque key a tap hands back (`openURL`); the core names the page.
    var open: String
    var words: Words
    var figures: [Figure]
    var sleepLine: String

    struct Words: Codable, Equatable, Sendable {
        var title: String
        var empty: String
        var nothing: String
        var stale: String
        var staleHint: String
        var unavailable: String
        var stepsCaption: String
    }

    struct Figure: Codable, Equatable, Sendable, Identifiable {
        /// `"steps"`, `"sleep"`, `"energy"`, `"exercise"` or `"weight"`.
        var metric: String
        var label: String
        var value: String
        var unit: String
        var text: String
        var id: String { metric }
    }

    // MARK: Opening

    /// The URL the widget's tap opens the app with: `centraid://health?open=<key>`.
    /// Nil for an empty key, so a widget with no key sets no link.
    static func openURL(_ key: String?) -> URL? {
        guard let key, !key.isEmpty else { return nil }
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        guard let encoded = key.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return URL(string: "\(openScheme)://\(openHost)?\(openQueryName)=\(encoded)")
    }

    /// The key out of a URL `openURL` made; nil for a URL of any other shape.
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

    static let openScheme = "centraid"
    /// Names the app (the one that owns the key), never a screen.
    static let openHost = "health"
    static let openQueryName = "open"
    static let maxOpenKeyLength = 256

    // MARK: Reading

    /// Decode a document. Unknown keys are ignored; a missing key, malformed JSON or
    /// a version other than 1 is `nil`.
    static func decode(_ data: Data) -> HealthGlanceSnapshot? {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        guard let snapshot = try? decoder.decode(HealthGlanceSnapshot.self, from: data),
            snapshot.version == supportedVersion
        else { return nil }
        return snapshot
    }

    /// The snapshot the app last kept, or nil when there is none that this reader trusts.
    static func load() -> HealthGlanceSnapshot? {
        guard let url = AgendaGlanceSnapshot.containerURL()?.appendingPathComponent(fileName),
            let data = try? Data(contentsOf: url)
        else { return nil }
        return decode(data)
    }

    // MARK: Staleness

    /// Whether `refresh_after` has passed on the device's clock, compared in the
    /// document's own zone. A "ready" document whose stamp does not parse is stale.
    /// An "empty" or "unavailable" document is not: it already says what it says.
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
}
