import Foundation

struct TodayGlanceSnapshot: Codable, Equatable, Sendable {
    static let supportedVersion = 1
    static let deviceKey = "widget.today"
    static let fileName = "widget.today.json"
    static let appGroup = "group.dev.centraid"

    var v: Int
    var title: String
    var day: String
    var summary: String
    var lines: [Line]

    struct Line: Codable, Equatable, Sendable, Identifiable {
        var text: String
        var url: String
        var kind: String

        var id: String { "\(kind):\(url):\(text)" }
    }

    static func decode(_ data: Data) -> TodayGlanceSnapshot? {
        guard let snapshot = try? JSONDecoder().decode(TodayGlanceSnapshot.self, from: data),
              snapshot.v == supportedVersion
        else { return nil }
        return snapshot
    }

    static func containerURL() -> URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)
    }

    static func load() -> TodayGlanceSnapshot? {
        guard let url = containerURL()?.appendingPathComponent(fileName),
              let data = try? Data(contentsOf: url)
        else { return nil }
        return decode(data)
    }

    static func parseOpenURL(_ url: URL) -> (kind: String, id: String)? {
        guard url.scheme == "centraid", url.host == "open" else { return nil }
        let parts = url.pathComponents.filter { $0 != "/" && !$0.isEmpty }
        guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty else { return nil }
        return (parts[0], parts[1])
    }
}
