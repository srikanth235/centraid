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
struct ChatAsset: Codable, Hashable, Sendable {
    let vision: Bool
    let url: String
    let fileName: String
    let sha256: String
    let bytes: UInt64
    let directory: String
    /// The member allowed mobile data for this transfer (absent in a task an earlier build made).
    let allowCellular: Bool?

    init(_ download: Centraid_Core_V1_ModelDownload) {
        allowCellular = download.allowCellular
        vision = download.vision
        url = download.url
        fileName = download.fileName
        sha256 = download.sha256
        bytes = download.bytes
        directory = download.modelsDir
    }

    init(vision: Bool, url: String, fileName: String, sha256: String, bytes: UInt64, directory: String, allowCellular: Bool? = nil) {
        self.vision = vision
        self.url = url
        self.fileName = fileName
        self.sha256 = sha256
        self.bytes = bytes
        self.directory = directory
        self.allowCellular = allowCellular
    }

    var isVision: Bool { vision }
    var staging: String { ".download-\(sha256).part" }

    var directoryURL: URL { URL(fileURLWithPath: directory, isDirectory: true) }
    var key: String { "\(directory)|\(fileName)|\(sha256)" }
    var isValid: Bool {
        guard let url = URL(string: url), url.scheme?.lowercased() == "https", url.host != nil,
              url.user == nil, url.password == nil,
              fileName == URL(fileURLWithPath: fileName).lastPathComponent,
              !fileName.isEmpty, fileName != ".", fileName != "..",
              !fileName.contains("\\"), bytes > 0,
              sha256.count == 64, sha256.allSatisfy({ $0.isHexDigit }),
              directoryURL.standardizedFileURL == ChatModelStore.directory.standardizedFileURL
        else { return false }
        return true
    }

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
    @MainActor private struct Waiter {
        let id: UUID
        let continuation: CheckedContinuation<Bool, Never>
    }
    @MainActor private var completionWaiters: [String: [Waiter]] = [:]
    private let redirectLock = NSLock()
    private var redirectCounts: [Int: Int] = [:]

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
        guard asset.isValid, asset.encoded != nil else { finish(asset, kept: false); return }
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
                self.asset(of: $0)?.key == asset.key && ($0.state == .running || $0.state == .suspended)
            }) {
                running.resume()
                DispatchQueue.main.async { self.enforce() }
                return
            }
            guard let url = URL(string: asset.url), asset.isValid else {
                Task { @MainActor [weak self] in self?.finish(asset, kept: false) }
                return
            }
            let task = session.downloadTask(with: url)
            task.taskDescription = asset.encoded
            task.resume()
            DispatchQueue.main.async { self.enforce() }
        }
    }

    @MainActor func startAndWait(_ asset: ChatAsset) async -> Bool {
        guard asset.isValid, asset.encoded != nil, !Task.isCancelled else { return false }
        let final = asset.directoryURL.appendingPathComponent(asset.fileName)
        if Self.verified(final, asset: asset) { return true }
        let id = UUID()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                if Task.isCancelled { continuation.resume(returning: false); return }
                completionWaiters[asset.key, default: []].append(Waiter(id: id, continuation: continuation))
                start(asset)
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.cancelWaiter(id, key: asset.key) }
        }
    }

    @MainActor private func finish(_ asset: ChatAsset, kept: Bool) {
        let waiters = completionWaiters.removeValue(forKey: asset.key) ?? []
        waiters.forEach { $0.continuation.resume(returning: kept) }
    }

    @MainActor private func cancelWaiter(_ id: UUID, key: String) {
        guard var waiters = completionWaiters[key], let index = waiters.firstIndex(where: { $0.id == id }) else { return }
        let waiter = waiters.remove(at: index)
        completionWaiters[key] = waiters.isEmpty ? nil : waiters
        waiter.continuation.resume(returning: false)
    }

    private func takeRedirect(_ taskID: Int) -> Int {
        redirectLock.lock()
        defer { redirectLock.unlock() }
        let count = redirectCounts[taskID, default: 0] + 1
        redirectCounts[taskID] = count
        return count
    }

    private func clearRedirects(_ taskID: Int) {
        redirectLock.lock()
        redirectCounts.removeValue(forKey: taskID)
        redirectLock.unlock()
    }

    // MARK: URLSessionDownloadDelegate

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        guard let asset = asset(of: downloadTask) else { return }
        guard asset.isValid,
              let finalURL = downloadTask.response?.url,
              finalURL.scheme?.lowercased() == "https",
              finalURL.user == nil, finalURL.password == nil
        else {
            clearRedirects(downloadTask.taskIdentifier)
            Task { @MainActor [weak self] in self?.finish(asset, kept: false) }
            return
        }
        clearRedirects(downloadTask.taskIdentifier)
        ChatModelStore.prepareDirectory()
        let staging = asset.directoryURL.appendingPathComponent(asset.staging)
        try? FileManager.default.removeItem(at: staging)
        let status = (downloadTask.response as? HTTPURLResponse)?.statusCode ?? 0
        do {
            try FileManager.default.moveItem(at: location, to: staging)
        } catch {
            Task { @MainActor [weak self] in self?.finish(asset, kept: false) }
            return
        }
        guard status == 200 else {
            try? FileManager.default.removeItem(at: staging)
            Task { @MainActor [weak self] in self?.finish(asset, kept: false) }
            return
        }
        guard let response = downloadTask.response,
              response.expectedContentLength < 0 || UInt64(response.expectedContentLength) == asset.bytes
        else {
            try? FileManager.default.removeItem(at: staging)
            Task { @MainActor [weak self] in self?.finish(asset, kept: false) }
            return
        }
        // THE HASH IS OFF THE DELEGATE QUEUE: half a gigabyte is seconds of work.
        DispatchQueue.global(qos: .utility).async {
            let kept = Self.keep(staging, as: asset)
            Task { @MainActor [weak self] in self?.finish(asset, kept: kept) }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        clearRedirects(task.taskIdentifier)
        guard let asset = asset(of: task) else { return }
        guard error != nil else { return }
        Task { @MainActor [weak self] in self?.finish(asset, kept: false) }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        guard let asset = asset(of: task), asset.isValid,
              let source = URL(string: asset.url), let destination = request.url,
              Self.redirectAllowed(source: source, destination: destination, redirectCount: takeRedirect(task.taskIdentifier))
        else {
            completionHandler(nil)
            if let asset = asset(of: task) { Task { @MainActor [weak self] in self?.finish(asset, kept: false) } }
            return
        }
        completionHandler(request)
    }

    static func redirectAllowed(source: URL, destination: URL, redirectCount: Int) -> Bool {
        source.scheme?.lowercased() == "https" && source.host != nil &&
            destination.scheme?.lowercased() == "https" && destination.host != nil &&
            destination.user == nil && destination.password == nil && redirectCount <= 5
    }

    // MARK: Verification

    /// Move the staged file into place when its SHA-256 is the expected one; delete it otherwise.
    static func keep(_ staging: URL, as asset: ChatAsset) -> Bool {
        guard verified(staging, asset: asset) else {
            try? FileManager.default.removeItem(at: staging)
            return false
        }
        let final = asset.directoryURL.appendingPathComponent(asset.fileName)
        do {
            if FileManager.default.fileExists(atPath: final.path) {
                _ = try FileManager.default.replaceItemAt(final, withItemAt: staging)
            } else {
                try FileManager.default.moveItem(at: staging, to: final)
            }
        } catch {
            try? FileManager.default.removeItem(at: staging)
            return false
        }
        ChatModelStore.excludeFromBackup(final)
        return true
    }

    static func verified(_ url: URL, asset: ChatAsset) -> Bool {
        guard asset.isValid,
              let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize,
              UInt64(size) == asset.bytes,
              let digest = sha256(of: url)
        else { return false }
        return digest.caseInsensitiveCompare(asset.sha256) == .orderedSame
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
