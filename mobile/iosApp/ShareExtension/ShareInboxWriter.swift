import Foundation

struct ShareInboxWriter: Sendable {
    static let appGroup = "group.dev.centraid"
    static let inboxFolderName = "share-inbox"
    static let manifestFileName = "manifest.json"
    static let payloadFileName = "payload"
    static let supportedVersion = 1

    enum ItemKind: String, Codable, Equatable, Sendable {
        case file
        case text
        case url
    }

    struct Manifest: Codable, Equatable, Sendable {
        let v: Int
        let type: ItemKind
        let utiOrMime: String
        let name: String
        let fromApp: String
        let receivedAt: Int64

        enum CodingKeys: String, CodingKey {
            case v
            case type
            case utiOrMime = "uti_or_mime"
            case name
            case fromApp = "from_app"
            case receivedAt = "received_at"
        }

        init(
            type: ItemKind,
            utiOrMime: String,
            name: String,
            fromApp: String,
            receivedAt: Int64
        ) {
            self.v = ShareInboxWriter.supportedVersion
            self.type = type
            self.utiOrMime = utiOrMime
            self.name = name
            self.fromApp = fromApp
            self.receivedAt = receivedAt
        }
    }

    struct WrittenItem: Equatable, Sendable {
        let uuid: String
        let directory: URL
        let manifest: Manifest
    }

    enum Failure: Error, Equatable, Sendable {
        case noContainer
        case invalidUUID
        case emptyPayload
        case io(String)
    }

    let inboxDirectory: URL

    init(inboxDirectory: URL) {
        self.inboxDirectory = inboxDirectory
    }

    static func inboxDirectoryURL(fileManager: FileManager = .default) -> URL? {
        fileManager
            .containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent(inboxFolderName, isDirectory: true)
    }

    static func defaultWriter(fileManager: FileManager = .default) throws -> ShareInboxWriter {
        guard let directory = inboxDirectoryURL(fileManager: fileManager) else {
            throw Failure.noContainer
        }
        return ShareInboxWriter(inboxDirectory: directory)
    }

    static func hasPendingItems(in directory: URL, fileManager: FileManager = .default) -> Bool {
        guard let entries = try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return false
        }
        for entry in entries {
            let manifestURL = entry.appendingPathComponent(manifestFileName, isDirectory: false)
            if fileManager.fileExists(atPath: manifestURL.path) {
                return true
            }
        }
        return false
    }

    @discardableResult
    func writeText(
        _ text: String,
        name: String = "",
        fromApp: String = "",
        receivedAtMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        uuid: String = UUID().uuidString.lowercased()
    ) throws -> WrittenItem {
        guard let data = text.data(using: .utf8), !data.isEmpty else {
            throw Failure.emptyPayload
        }
        return try writeData(
            data,
            kind: .text,
            utiOrMime: "public.plain-text",
            name: name,
            fromApp: fromApp,
            receivedAtMs: receivedAtMs,
            uuid: uuid
        )
    }

    @discardableResult
    func writeURL(
        _ url: URL,
        name: String = "",
        fromApp: String = "",
        receivedAtMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        uuid: String = UUID().uuidString.lowercased()
    ) throws -> WrittenItem {
        let string = url.absoluteString
        guard let data = string.data(using: .utf8), !data.isEmpty else {
            throw Failure.emptyPayload
        }
        return try writeData(
            data,
            kind: .url,
            utiOrMime: "public.url",
            name: name.isEmpty ? (url.host ?? string) : name,
            fromApp: fromApp,
            receivedAtMs: receivedAtMs,
            uuid: uuid
        )
    }

    @discardableResult
    func writeData(
        _ data: Data,
        kind: ItemKind,
        utiOrMime: String,
        name: String = "",
        fromApp: String = "",
        receivedAtMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        uuid: String = UUID().uuidString.lowercased()
    ) throws -> WrittenItem {
        guard !data.isEmpty else { throw Failure.emptyPayload }
        let manifest = Manifest(
            type: kind,
            utiOrMime: utiOrMime,
            name: name,
            fromApp: fromApp,
            receivedAt: receivedAtMs
        )
        return try commitItem(uuid: uuid, manifest: manifest) { payloadURL in
            try data.write(
                to: payloadURL,
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
        }
    }

    @discardableResult
    func writeFile(
        at sourceURL: URL,
        utiOrMime: String,
        name: String = "",
        fromApp: String = "",
        receivedAtMs: Int64 = Int64(Date().timeIntervalSince1970 * 1000),
        uuid: String = UUID().uuidString.lowercased()
    ) throws -> WrittenItem {
        let resolvedName = name.isEmpty ? sourceURL.lastPathComponent : name
        let manifest = Manifest(
            type: .file,
            utiOrMime: utiOrMime,
            name: resolvedName,
            fromApp: fromApp,
            receivedAt: receivedAtMs
        )
        return try commitItem(uuid: uuid, manifest: manifest) { payloadURL in
            let fileManager = FileManager.default
            if fileManager.fileExists(atPath: payloadURL.path) {
                try fileManager.removeItem(at: payloadURL)
            }
            try fileManager.copyItem(at: sourceURL, to: payloadURL)
            try fileManager.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: payloadURL.path
            )
        }
    }

    private func commitItem(
        uuid: String,
        manifest: Manifest,
        writePayload: (URL) throws -> Void
    ) throws -> WrittenItem {
        let cleanUUID = uuid.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanUUID.isEmpty,
              !cleanUUID.contains("/"),
              !cleanUUID.contains(".."),
              !cleanUUID.hasPrefix(".")
        else {
            throw Failure.invalidUUID
        }

        let fileManager = FileManager.default
        do {
            try fileManager.createDirectory(at: inboxDirectory, withIntermediateDirectories: true)
            excludeFromBackup(inboxDirectory)

            let stagingDir = inboxDirectory.appendingPathComponent(".staging-\(cleanUUID)", isDirectory: true)
            let finalDir = inboxDirectory.appendingPathComponent(cleanUUID, isDirectory: true)
            if fileManager.fileExists(atPath: stagingDir.path) {
                try fileManager.removeItem(at: stagingDir)
            }
            try fileManager.createDirectory(at: stagingDir, withIntermediateDirectories: true)

            do {
                let payloadURL = stagingDir.appendingPathComponent(Self.payloadFileName, isDirectory: false)
                try writePayload(payloadURL)
                excludeFromBackup(payloadURL)

                let encoder = JSONEncoder()
                encoder.outputFormatting = [.sortedKeys]
                let manifestData = try encoder.encode(manifest)
                let manifestURL = stagingDir.appendingPathComponent(Self.manifestFileName, isDirectory: false)
                try manifestData.write(
                    to: manifestURL,
                    options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
                )
                excludeFromBackup(manifestURL)
                excludeFromBackup(stagingDir)

                if fileManager.fileExists(atPath: finalDir.path) {
                    try fileManager.removeItem(at: finalDir)
                }
                try fileManager.moveItem(at: stagingDir, to: finalDir)
                return WrittenItem(uuid: cleanUUID, directory: finalDir, manifest: manifest)
            } catch {
                try? fileManager.removeItem(at: stagingDir)
                throw error
            }
        } catch let failure as Failure {
            throw failure
        } catch {
            throw Failure.io(String(describing: error))
        }
    }

    private func excludeFromBackup(_ url: URL) {
        var mutable = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? mutable.setResourceValues(values)
    }
}
