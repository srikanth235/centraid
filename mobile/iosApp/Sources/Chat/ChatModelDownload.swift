import CryptoKit
import Foundation

// THE ONLY THINGS CENTRAID EVER FETCHES: THE ON-DEVICE CHAT'S MODEL, AND — ONLY
// WHEN A MEMBER FIRST ATTACHES A PHOTO — ITS VISION PROJECTOR.
//
// Rust names the file to fetch (`ModelDownload`: url, file name, SHA-256, size and the
// directory). Everything else is iOS's and is here, one code path for both files: where the file
// lands, the session, the hash, the iCloud exclusion.

/// WHICH FILE A TRANSFER IS, as the effect named it. It rides on the task
/// (`taskDescription`, encoded), so the delegate knows what landed without a table of its own.
struct ChatAsset: Codable, Hashable {
    let vision: Bool
    let url: String
    let fileName: String
    let sha256: String
    let directory: String
    /// The member allowed mobile data for this transfer (absent in a task an earlier build made).
    let allowCellular: Bool?

    init(_ download: Centraid_Core_V1_ModelDownload) {
        allowCellular = download.allowCellular
        vision = download.vision
        url = download.url
        fileName = download.fileName
        sha256 = download.sha256
        directory = download.modelsDir
    }

    var isVision: Bool { vision }
    var staging: String { vision ? ".download-vision" : ".download-model" }

    var directoryURL: URL { URL(fileURLWithPath: directory, isDirectory: true) }

    var encoded: String? {
        (try? JSONEncoder().encode(self)).flatMap { String(data: $0, encoding: .utf8) }
    }

    static func decode(_ text: String?) -> ChatAsset? {
        text.flatMap { $0.data(using: .utf8) }.flatMap { try? JSONDecoder().decode(ChatAsset.self, from: $0) }
    }
}

/// WHERE THE MODEL LIVES ON THIS PHONE.
enum ChatModelStore {
    /// `Application Support/models/`. Not Documents (a member never sees it in Files) and not
    /// Caches (iOS may evict a cache under pressure, and the file is half a gigabyte the member
    /// chose to fetch). Rust is told this directory when the tab opens and names the files in it.
    static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("models", isDirectory: true)
    }

    /// Create the directory and keep it out of iCloud backup: half a gigabyte that can be fetched
    /// again is not what a member's backup is for, and iOS does not inherit the flag, so the file
    /// is marked in its own right too.
    static func prepareDirectory() {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        excludeFromBackup(directory)
    }

    static func excludeFromBackup(_ url: URL) {
        var target = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? target.setResourceValues(values)
    }
}

/// THE MODEL AND PROJECTOR DOWNLOADS, ON AN ORDINARY SESSION.
///
/// Not a background `URLSession`: the app has exactly ONE, the upload mover's
/// (`BackgroundUploads.swift`, #1080 ruling 2), and `AppDelegate`
/// answers any other session's events at once. So a transfer runs while the app does and one the
/// system ends with the app is started again from the step's "Download model" (`start` picks up a
/// task this launch still holds).
///
/// What arrives is verified before it is kept: it is moved to a staging file inside the models
/// directory (the system deletes its own copy when the delegate returns), hashed in 1 MB reads,
/// and renamed into place only when the digest is the one Rust named. A mismatch is deleted and
/// dropped, so a truncated file or an error page can never reach the core
/// as a model.
final class ChatModelDownloader: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    static let shared = ChatModelDownloader()

    /// The asset a task is fetching.
    private func asset(of task: URLSessionTask) -> ChatAsset? {
        ChatAsset.decode(task.taskDescription)
    }

    @MainActor private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    /// WHICH TRANSFERS MAY USE MOBILE DATA (by `vision`): the member's word, for the transfer that is
    /// going. Without it a transfer is held (suspended) while the phone is on mobile data and goes on
    /// by itself when Wi-Fi comes back (#1188 download rules).
    @MainActor private var cellularAllowed: Set<Bool> = []
    @MainActor private var watching = false

    /// Hold or let go each transfer by the network now and the member's word.
    @MainActor func enforce() {
        let onMobileData = ChatDeviceWatcher.shared.network == .cellular
        session.getAllTasks { [weak self] tasks in
            guard let self else { return }
            DispatchQueue.main.async {
                for task in tasks {
                    guard let asset = self.asset(of: task) else { continue }
                    let allowed = !onMobileData || self.cellularAllowed.contains(asset.vision)
                    if allowed, task.state == .suspended { task.resume() }
                    if !allowed, task.state == .running { task.suspend() }
                }
            }
        }
    }

    /// Start the transfer of `asset`, or pick up the one already running.
    @MainActor func start(_ asset: ChatAsset) {
        ChatModelStore.prepareDirectory()
        if asset.allowCellular == true { cellularAllowed.insert(asset.vision) } else { cellularAllowed.remove(asset.vision) }
        if !watching {
            watching = true
            NotificationCenter.default.addObserver(forName: .chatNetworkChanged, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.enforce() }
            }
        }
        let session = session
        session.getAllTasks { [weak self] tasks in
            guard let self else { return }
            if let running = tasks.first(where: {
                self.asset(of: $0)?.vision == asset.vision && ($0.state == .running || $0.state == .suspended)
            }) {
                running.resume()
                DispatchQueue.main.async { self.enforce() }
                return
            }
            guard let url = URL(string: asset.url) else { return }
            let task = session.downloadTask(with: url)
            task.taskDescription = asset.encoded
            task.resume()
            DispatchQueue.main.async { self.enforce() }
        }
    }

    // MARK: URLSessionDownloadDelegate

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let asset = asset(of: downloadTask) else { return }
        ChatModelStore.prepareDirectory()
        let staging = asset.directoryURL.appendingPathComponent(asset.staging)
        try? FileManager.default.removeItem(at: staging)
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        do {
            try FileManager.default.moveItem(at: location, to: staging)
        } catch {
            return
        }
        guard status == 200 else {
            try? FileManager.default.removeItem(at: staging)
            return
        }
        // THE HASH IS OFF THE DELEGATE QUEUE: half a gigabyte is seconds of work.
        DispatchQueue.global(qos: .utility).async {
            _ = Self.keep(staging, as: asset)
        }
    }

    // MARK: Verification

    /// Move the staged file into place when its SHA-256 is the expected one; delete it otherwise.
    private static func keep(_ staging: URL, as asset: ChatAsset) -> Bool {
        guard let digest = sha256(of: staging), digest == asset.sha256 else {
            try? FileManager.default.removeItem(at: staging)
            return false
        }
        let final = asset.directoryURL.appendingPathComponent(asset.fileName)
        try? FileManager.default.removeItem(at: final)
        do {
            try FileManager.default.moveItem(at: staging, to: final)
        } catch {
            try? FileManager.default.removeItem(at: staging)
            return false
        }
        ChatModelStore.excludeFromBackup(final)
        return true
    }

    static func sha256(of url: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let read: Result<Data?, Swift.Error> = autoreleasepool {
                Result { try handle.read(upToCount: 1 << 20) }
            }
            guard case let .success(chunk) = read else { return nil }
            guard let chunk, !chunk.isEmpty else { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
