import CryptoKit
import Foundation

// THE ONLY THINGS CENTRAID EVER FETCHES: THE ON-DEVICE CHAT'S MODEL, AND — ONLY
// WHEN A MEMBER FIRST ATTACHES A PHOTO — ITS VISION PROJECTOR.
//
// Rust names the file to fetch (`ModelDownload`: url, file name, SHA-256, size and the
// directory) and hears about the transfer as `ChatEvent.DownloadProgress` and
// `DownloadFinished` (each with a `vision` flag). Everything else is iOS's and is here, one code
// path for both files: where the file lands, the session, the hash, the iCloud exclusion.

/// WHICH FILE A TRANSFER IS, as the effect named it. It rides on the task
/// (`taskDescription`, encoded), so the delegate knows what landed without a table of its own.
struct ChatAsset: Codable, Hashable {
    let vision: Bool
    let url: String
    let fileName: String
    let sha256: String
    let directory: String

    init(_ download: Centraid_Core_V1_ModelDownload) {
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
/// reported as a failed download, so a truncated file or an error page can never reach the core
/// as a model.
final class ChatModelDownloader: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    static let shared = ChatModelDownloader()

    /// Both fire on the main queue. The ChatModel points them at the chat.
    var onProgress: ((_ vision: Bool, Int64, Int64) -> Void)?
    var onFinished: ((_ vision: Bool, Bool) -> Void)?

    private let lock = NSLock()
    private var lastReportedAt: [Bool: Date] = [:]
    private var lastReportedPercent: [Bool: Int] = [:]

    /// The asset a task is fetching.
    private func asset(of task: URLSessionTask) -> ChatAsset? {
        ChatAsset.decode(task.taskDescription)
    }

    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    /// Make sure the session exists before the chat asks about running work.
    func reconnect() {
        _ = session
    }

    /// SAY SO WHEN A TRANSFER IS ALREADY RUNNING.
    ///
    /// A member who leaves the Chat tab mid-download and comes back finds the model still
    /// arriving. Its progress is reported at once, bypassing the throttle, and the chat treats
    /// progress heard before any tap as "already downloading".
    func reportRunning() {
        session.getAllTasks { [weak self] tasks in
            guard let self else { return }
            for running in tasks where running.state == .running {
                guard let asset = self.asset(of: running) else { continue }
                let done = running.countOfBytesReceived
                let total = max(running.countOfBytesExpectedToReceive, 0)
                DispatchQueue.main.async { self.onProgress?(asset.vision, done, total) }
            }
        }
    }

    /// Start the transfer of `asset`, or pick up the one already running.
    func start(_ asset: ChatAsset) {
        ChatModelStore.prepareDirectory()
        let session = session
        session.getAllTasks { [weak self] tasks in
            guard let self else { return }
            if let running = tasks.first(where: {
                self.asset(of: $0)?.vision == asset.vision && ($0.state == .running || $0.state == .suspended)
            }) {
                running.resume()
                return
            }
            guard let url = URL(string: asset.url) else {
                self.finish(asset, false)
                return
            }
            let task = session.downloadTask(with: url)
            task.taskDescription = asset.encoded
            task.resume()
        }
    }

    // MARK: URLSessionDownloadDelegate

    func urlSession(
        _ session: URLSession,
        downloadTask: URLSessionDownloadTask,
        didWriteData bytesWritten: Int64,
        totalBytesWritten: Int64,
        totalBytesExpectedToWrite: Int64
    ) {
        guard let asset = asset(of: downloadTask) else { return }
        // A callback per few kilobytes would be a state per few kilobytes: one per whole percent,
        // and none sooner than a quarter second after the last.
        let total = max(totalBytesExpectedToWrite, 0)
        let percent = total > 0 ? Int(Double(totalBytesWritten) / Double(total) * 100) : -1
        lock.lock()
        let now = Date()
        let due = percent != lastReportedPercent[asset.vision, default: -1]
            && now.timeIntervalSince(lastReportedAt[asset.vision, default: .distantPast]) >= 0.25
        if due {
            lastReportedAt[asset.vision] = now
            lastReportedPercent[asset.vision] = percent
        }
        lock.unlock()
        guard due else { return }
        DispatchQueue.main.async { [weak self] in self?.onProgress?(asset.vision, totalBytesWritten, total) }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let asset = asset(of: downloadTask) else { return }
        ChatModelStore.prepareDirectory()
        let staging = asset.directoryURL.appendingPathComponent(asset.staging)
        try? FileManager.default.removeItem(at: staging)
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        do {
            try FileManager.default.moveItem(at: location, to: staging)
        } catch {
            return finish(asset, false)
        }
        guard status == 200 else {
            try? FileManager.default.removeItem(at: staging)
            return finish(asset, false)
        }
        // THE HASH IS OFF THE DELEGATE QUEUE: half a gigabyte is seconds of work.
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let ok = Self.keep(staging, as: asset)
            self?.finish(asset, ok)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Swift.Error?) {
        // A transfer that finished cleanly was settled in `didFinishDownloadingTo`.
        guard error != nil, let asset = asset(of: task) else { return }
        finish(asset, false)
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

    private func finish(_ asset: ChatAsset, _ ok: Bool) {
        lock.lock()
        lastReportedPercent[asset.vision] = -1
        lastReportedAt[asset.vision] = .distantPast
        lock.unlock()
        DispatchQueue.main.async { [weak self] in self?.onFinished?(asset.vision, ok) }
    }
}
