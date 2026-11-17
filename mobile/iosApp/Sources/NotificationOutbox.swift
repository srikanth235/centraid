import Foundation

/// THE PRESSES NOT YET KNOWN TO BE APPLIED (#1188, A6): a small queue for the phone's own writer.
/// A press is returned only after its identity is durably written and excluded from device backup.
enum NotificationOutbox {
    struct Press: Codable, Equatable {
        var pressID: String
        var notificationID: String
        var verb: Int
    }

    enum Failure: Error, Equatable {
        case unavailable
        case unreadable
        case corrupt
        case notExcluded
        case notProtected
        case writeFailed
    }

    private static let lock = NSLock()

    /// File-backed store; tests supply a disposable URL and exercise real Foundation I/O.
    struct Store {
        let url: URL
        private let failReplacementForTesting: Bool

        init(url: URL, failReplacementForTesting: Bool = false) {
            self.url = url
            self.failReplacementForTesting = failReplacementForTesting
        }

        func add(notificationID: String, verb: Int) throws -> Press {
            try Self.locked {
                var presses = try read()
                let press = Press(pressID: UUID().uuidString, notificationID: notificationID, verb: verb)
                presses.append(press)
                try write(presses)
                return press
            }
        }

        func remove(_ pressID: String) throws {
            try Self.locked {
                var presses = try read()
                presses.removeAll { $0.pressID == pressID }
                try write(presses)
            }
        }

        func pending() throws -> [Press] {
            try Self.locked { try read() }
        }

        private func read() throws -> [Press] {
            let data: Data
            do { data = try Data(contentsOf: url) }
            catch {
                if let cocoa = error as? CocoaError, cocoa.code == .fileReadNoSuchFile { return [] }
                if let posix = error as? POSIXError, posix.code == .ENOENT { return [] }
                throw Failure.unreadable
            }
            let values: URLResourceValues
            do { values = try url.resourceValues(forKeys: [.isExcludedFromBackupKey]) }
            catch { throw Failure.notExcluded }
            guard values.isExcludedFromBackup == true else { throw Failure.notExcluded }
            let protection: URLResourceValues
            do { protection = try url.resourceValues(forKeys: [.fileProtectionKey]) }
            catch { throw Failure.notProtected }
            guard protection.fileProtection == .completeUntilFirstUserAuthentication else {
                throw Failure.notProtected
            }
            do { return try JSONDecoder().decode([Press].self, from: data) }
            catch { throw Failure.corrupt }
        }

        private func write(_ presses: [Press]) throws {
            let data: Data
            do { data = try JSONEncoder().encode(presses) }
            catch { throw Failure.writeFailed }
            var temporary = url.deletingLastPathComponent()
                .appendingPathComponent(".notification-outbox-\(UUID().uuidString).tmp")
            do {
                try data.write(to: temporary, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try temporary.setResourceValues(values)
                let stored = try temporary.resourceValues(forKeys: [.isExcludedFromBackupKey])
                guard stored.isExcludedFromBackup == true else { throw Failure.notExcluded }
                if FileManager.default.fileExists(atPath: url.path) {
                    if failReplacementForTesting { throw Failure.writeFailed }
                    _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary)
                } else {
                    if failReplacementForTesting { throw Failure.writeFailed }
                    try FileManager.default.moveItem(at: temporary, to: url)
                }
                let final = try url.resourceValues(forKeys: [.isExcludedFromBackupKey])
                guard final.isExcludedFromBackup == true else { throw Failure.notExcluded }
                let finalProtection = try url.resourceValues(forKeys: [.fileProtectionKey])
                guard finalProtection.fileProtection == .completeUntilFirstUserAuthentication else {
                    throw Failure.notProtected
                }
            } catch {
                // The live queue is untouched until a protected, excluded replacement is ready.
                try? FileManager.default.removeItem(at: temporary)
                throw Failure.writeFailed
            }
        }

        private static func locked<T>(_ body: () throws -> T) rethrows -> T {
            lock.lock()
            defer { lock.unlock() }
            return try body()
        }
    }

    private static var sharedStore: Store? {
        guard let base = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        ) else { return nil }
        return Store(url: base.appendingPathComponent("notification-outbox.json"))
    }

    static func add(notificationID: String, verb: Int) throws -> Press {
        guard let sharedStore else { throw Failure.unavailable }
        return try sharedStore.add(notificationID: notificationID, verb: verb)
    }

    static func remove(_ pressID: String) throws {
        guard let sharedStore else { throw Failure.unavailable }
        try sharedStore.remove(pressID)
    }

    static func pending() throws -> [Press] {
        guard let sharedStore else { throw Failure.unavailable }
        return try sharedStore.pending()
    }
}
