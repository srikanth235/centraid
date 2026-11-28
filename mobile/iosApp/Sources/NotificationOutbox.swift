import Foundation

struct NotificationOutboxStore: Sendable {
    static let supportedVersion = 1

    struct Envelope: Codable, Equatable, Sendable {
        let v: Int
        var items: [NotificationOutbox.Press]

        init(items: [NotificationOutbox.Press]) {
            self.v = NotificationOutboxStore.supportedVersion
            self.items = items
        }
    }

    let fileURL: URL

    init(fileURL: URL) {
        self.fileURL = fileURL
    }

    func read() -> [NotificationOutbox.Press] {
        guard let data = try? Data(contentsOf: fileURL) else { return [] }
        if let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
           envelope.v == Self.supportedVersion {
            return envelope.items
        }
        return (try? JSONDecoder().decode([NotificationOutbox.Press].self, from: data)) ?? []
    }

    func write(_ presses: [NotificationOutbox.Press]) {
        var url = fileURL
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(Envelope(items: presses)) else { return }
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }
}

enum NotificationOutbox {
    struct Press: Codable, Equatable, Sendable {
        var pressID: String
        var action: String
        var notificationID: String
        var verb: Int
        var entityID: String = ""
        var dateID: String = ""
        var fieldID: String = ""
        var atMs: Int64 = 0
        var key: String = ""

        enum CodingKeys: String, CodingKey {
            case pressID = "id"
            case action
            case notificationID = "notification_id"
            case verb
            case entityID = "entity"
            case dateID = "date_id"
            case fieldID = "field_id"
            case atMs = "at"
            case key
        }

        init(
            pressID: String,
            action: String? = nil,
            notificationID: String,
            verb: Int,
            entityID: String = "",
            dateID: String = "",
            fieldID: String = "",
            atMs: Int64 = 0,
            key: String = ""
        ) {
            self.pressID = pressID
            self.action = action ?? Self.actionName(for: verb)
            self.notificationID = notificationID
            self.verb = verb
            self.entityID = entityID
            self.dateID = dateID
            self.fieldID = fieldID
            self.atMs = atMs
            self.key = key.isEmpty ? pressID : key
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            let decodedVerb = try container.decodeIfPresent(Int.self, forKey: .verb) ?? 0
            let decodedAction = try container.decodeIfPresent(String.self, forKey: .action) ?? Self.actionName(for: decodedVerb)
            let decodedID = try container.decode(String.self, forKey: .pressID)
            self.pressID = decodedID
            self.action = decodedAction
            self.notificationID = try container.decodeIfPresent(String.self, forKey: .notificationID) ?? ""
            self.verb = decodedVerb != 0 ? decodedVerb : Self.verbRawValue(for: decodedAction)
            self.entityID = try container.decodeIfPresent(String.self, forKey: .entityID) ?? ""
            self.dateID = try container.decodeIfPresent(String.self, forKey: .dateID) ?? ""
            self.fieldID = try container.decodeIfPresent(String.self, forKey: .fieldID) ?? ""
            self.atMs = try container.decodeIfPresent(Int64.self, forKey: .atMs) ?? 0
            let decodedKey = try container.decodeIfPresent(String.self, forKey: .key) ?? ""
            self.key = decodedKey.isEmpty ? decodedID : decodedKey
        }

        func proto() -> Centraid_Core_V1_NotifyPress? {
            guard let protoVerb = Centraid_Core_V1_NotificationVerb(rawValue: verb) else { return nil }
            var press = Centraid_Core_V1_NotifyPress()
            press.id = pressID
            press.verb = protoVerb
            press.entityID = entityID
            press.dateID = dateID
            press.fieldID = fieldID
            press.atMs = atMs
            press.key = key.isEmpty ? pressID : key
            return press
        }

        static func actionName(for verb: Int) -> String {
            switch Centraid_Core_V1_NotificationVerb(rawValue: verb) {
            case .done: return "done"
            case .snoozeHour: return "snooze"
            case .open: return "open"
            case .tomorrow: return "tomorrow"
            case .undo: return "undo"
            default: return String(verb)
            }
        }

        static func verbRawValue(for action: String) -> Int {
            switch action {
            case "done": return Centraid_Core_V1_NotificationVerb.done.rawValue
            case "snooze": return Centraid_Core_V1_NotificationVerb.snoozeHour.rawValue
            case "open": return Centraid_Core_V1_NotificationVerb.open.rawValue
            case "tomorrow": return Centraid_Core_V1_NotificationVerb.tomorrow.rawValue
            case "undo": return Centraid_Core_V1_NotificationVerb.undo.rawValue
            default: return Int(action) ?? 0
            }
        }
    }

    private static let lock = NSLock()

    private static var defaultStore: NotificationOutboxStore? {
        guard let base = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        ) else { return nil }
        return NotificationOutboxStore(fileURL: base.appendingPathComponent("notification-outbox.json"))
    }

    @discardableResult
    static func add(
        notificationID: String,
        verb: Int,
        entityID: String = "",
        dateID: String = "",
        fieldID: String = "",
        atMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        store: NotificationOutboxStore? = nil
    ) -> Press {
        let id = UUID().uuidString
        let press = Press(
            pressID: id,
            notificationID: notificationID,
            verb: verb,
            entityID: entityID,
            dateID: dateID,
            fieldID: fieldID,
            atMs: atMs,
            key: id
        )
        mutate(in: store) { $0.append(press) }
        return press
    }

    static func remove(_ pressID: String, store: NotificationOutboxStore? = nil) {
        mutate(in: store) { $0.removeAll { $0.pressID == pressID } }
    }

    static func pending(store: NotificationOutboxStore? = nil) -> [Press] {
        lock.lock()
        defer { lock.unlock() }
        return (store ?? defaultStore)?.read() ?? []
    }

    private static func mutate(in store: NotificationOutboxStore?, _ change: (inout [Press]) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        guard let resolved = store ?? defaultStore else { return }
        var presses = resolved.read()
        change(&presses)
        resolved.write(presses)
    }
}
