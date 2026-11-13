import Foundation

/// THE PRESSES NOT YET KNOWN TO BE APPLIED (#1188, A6): a small queue for the phone's own writer, not
/// a replica log; nothing in it waits for a gateway.
///
/// A button on a notification must not be lost because the core could not start in the seconds iOS
/// gives a background action. The press is written here BEFORE the shell asks for the store, and
/// leaves only when the core has taken it; whatever remains is sent again at the next start
/// (`Notifications.drain`). Each press has an id of its own that travels to Rust
/// (`NotificationAnswered.pressID`), which runs the write under a key made from it, so a press sent
/// twice is applied once. The file is excluded from the device backup, like the vault.
enum NotificationOutbox {
    struct Press: Codable, Equatable {
        var pressID: String
        var notificationID: String
        var verb: Int
    }

    private static let lock = NSLock()

    private static var url: URL? {
        guard let base = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        ) else { return nil }
        return base.appendingPathComponent("notification-outbox.json")
    }

    /// Write a press down, and give it its id.
    @discardableResult
    static func add(notificationID: String, verb: Int) -> Press {
        let press = Press(pressID: UUID().uuidString, notificationID: notificationID, verb: verb)
        mutate { $0.append(press) }
        return press
    }

    /// The core has it: the press leaves.
    static func remove(_ pressID: String) {
        mutate { $0.removeAll { $0.pressID == pressID } }
    }

    static func pending() -> [Press] {
        lock.lock()
        defer { lock.unlock() }
        return read()
    }

    private static func mutate(_ change: (inout [Press]) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        var presses = read()
        change(&presses)
        write(presses)
    }

    private static func read() -> [Press] {
        guard let url, let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([Press].self, from: data)) ?? []
    }

    private static func write(_ presses: [Press]) {
        guard var url else { return }
        guard let data = try? JSONEncoder().encode(presses) else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }
}
