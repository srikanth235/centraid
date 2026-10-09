import CryptoKit
import Foundation

#if canImport(CentraidShared)
import CentraidShared
#endif

// THE ONLY THINGS CENTRAID EVER FETCHES: THE ON-DEVICE CHAT'S MODEL, AND — ONLY
// WHEN A MEMBER FIRST ATTACHES A PHOTO — ITS VISION PROJECTOR.
//
// The shell owns these transfers and the shared chat machine only hears about
// them (`ChatEvent.DownloadProgress`, `ChatEvent.DownloadFinished`, each with a
// `vision` flag). The URLs, digests and sizes are `ChatModelAsset`'s, in
// `commonMain`, so the two shells carry one copy of them; everything else —
// where the file lands, the session, the hash, the iCloud
// exclusion — is iOS's and is here, and is one code path for both files.
//
// The projector's transfer never starts in the shipped build: the chat draws no
// attach control while `ChatMachine.ATTACHMENTS_OFFERED` is off, because the
// model cannot describe a file (R-1088-19), so no photo ever waits for it.

/// WHICH FILE A TRANSFER IS. It rides on the task (`taskDescription`), so the
/// delegate knows what landed without a table of its own.
enum ChatAsset: String {
    case model
    case vision

    var isVision: Bool { self == .vision }

    var fileName: String {
        #if canImport(CentraidShared)
        isVision ? ChatModelAsset.shared.VISION_FILE_NAME : ChatModelAsset.shared.FILE_NAME
        #else
        isVision ? "mmproj.gguf" : "model.gguf"
        #endif
    }

    var sha256: String {
        #if canImport(CentraidShared)
        isVision ? ChatModelAsset.shared.VISION_SHA256 : ChatModelAsset.shared.SHA256
        #else
        ""
        #endif
    }

    var url: URL? {
        #if canImport(CentraidShared)
        URL(string: isVision ? ChatModelAsset.shared.VISION_URL : ChatModelAsset.shared.URL)
        #else
        nil
        #endif
    }

    var staging: String { ".download-\(rawValue)" }
}

/// WHERE THE MODEL LIVES ON THIS PHONE.
enum ChatModelStore {
    /// `Application Support/models/`. Not Documents (a member never sees it in
    /// Files) and not Caches (iOS may evict a cache under pressure, and the
    /// file is half a gigabyte the member chose to fetch).
    static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("models", isDirectory: true)
    }

    static var fileName: String { ChatAsset.model.fileName }

    /// THE PATH THE CORE IS ASKED TO LOAD.
    ///
    /// A DEBUG build with `CENTRAID_DEV_MODEL` set (launched with
    /// `SIMCTL_CHILD_CENTRAID_DEV_MODEL=<path>`) loads that file instead and
    /// never downloads — the same shape as `ShellModel.devSeedHex`. A release
    /// build compiles the branch out.
    static var modelPath: String {
        #if DEBUG
        if let dev = ProcessInfo.processInfo.environment["CENTRAID_DEV_MODEL"], !dev.isEmpty {
            return dev
        }
        #endif
        return directory.appendingPathComponent(fileName).path
    }

    /// THE PATH THE CORE IS ASKED TO LOAD THE VISION PROJECTOR FROM, with the
    /// same DEBUG override as the model: `CENTRAID_DEV_MMPROJ` names a file that
    /// is loaded instead and never downloaded.
    static var projectorPath: String {
        #if DEBUG
        if let dev = ProcessInfo.processInfo.environment["CENTRAID_DEV_MMPROJ"], !dev.isEmpty {
            return dev
        }
        #endif
        return directory.appendingPathComponent(ChatAsset.vision.fileName).path
    }

    /// The model's size as the download step quotes it before a byte moves.
    static var expectedBytes: Int64 {
        #if canImport(CentraidShared)
        ChatModelAsset.shared.BYTES
        #else
        0
        #endif
    }

    /// Create the directory and keep it out of iCloud backup: half a gigabyte
    /// that can be fetched again is not what a member's backup is for, and iOS
    /// does not inherit the flag, so the file is marked in its own right too.
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
/// (`BackgroundUploads.swift`, #1080 ruling 2, held by `BackgroundPassLawSpec`),
/// and `AppDelegate` answers any other session's events at once. So a transfer
/// runs while the app does — the Chat tab says so while it is under way — and
/// one the system ends with the app is started again from the step's
/// "Download model" (`start` picks up a task this launch still holds).
///
/// What arrives is verified before it is kept: it is moved to a staging file
/// inside the models directory (the system deletes its own copy when the
/// delegate returns), hashed in 1 MB reads, and renamed into place only when
/// the digest is `ChatModelAsset.SHA256`. A mismatch is deleted and reported as
/// a failed download, so a truncated file or an error page can never reach the
/// core as a model.
final class ChatModelDownloader: NSObject, URLSessionDownloadDelegate, @unchecked Sendable {
    static let shared = ChatModelDownloader()

    /// Both fire on the main queue. The ChatModel points them at the bridge.
    var onProgress: ((ChatAsset, Int64, Int64) -> Void)?
    var onFinished: ((ChatAsset, Bool) -> Void)?

    private let lock = NSLock()
    private var lastReportedAt: [ChatAsset: Date] = [:]
    private var lastReportedPercent: [ChatAsset: Int] = [:]

    /// The asset a task is fetching. A task that says nothing is the model's:
    /// it was started by a build from before there were two.
    private func asset(of task: URLSessionTask) -> ChatAsset {
        task.taskDescription.flatMap(ChatAsset.init(rawValue:)) ?? .model
    }

    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.waitsForConnectivity = true
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    /// Make sure the session exists before the bridge asks about running work.
    func reconnect() {
        _ = session
    }

    /// SAY SO WHEN A TRANSFER IS ALREADY RUNNING.
    ///
    /// A member who leaves the Chat tab mid-download and comes back finds the
    /// model still arriving. Its progress is reported at once, bypassing the
    /// throttle, and the shared machine treats progress heard before any tap as
    /// "already downloading" — without this the tab offered "Download model"
    /// over a half-done transfer until tapped. Called after the bridge is
    /// attached and the tab has opened, so the event has a machine to land in.
    func reportRunning() {
        session.getAllTasks { [weak self] tasks in
            guard let self else { return }
            for running in tasks where running.state == .running {
                let asset = self.asset(of: running)
                let done = running.countOfBytesReceived
                let total = max(running.countOfBytesExpectedToReceive, 0)
                DispatchQueue.main.async { self.onProgress?(asset, done, total) }
            }
        }
    }

    /// Start the transfer of `asset`, or pick up the one already running.
    func start(_ asset: ChatAsset = .model) {
        ChatModelStore.prepareDirectory()
        let session = session
        session.getAllTasks { [weak self] tasks in
            guard let self else { return }
            if let running = tasks.first(where: {
                self.asset(of: $0) == asset && ($0.state == .running || $0.state == .suspended)
            }) {
                running.resume()
                return
            }
            guard let url = asset.url else { return }
            let task = session.downloadTask(with: url)
            task.taskDescription = asset.rawValue
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
        // A callback per few kilobytes would be a state per few kilobytes: one
        // per whole percent, and none sooner than a quarter second after the last.
        let asset = asset(of: downloadTask)
        let total = max(totalBytesExpectedToWrite, 0)
        let percent = total > 0 ? Int(Double(totalBytesWritten) / Double(total) * 100) : -1
        lock.lock()
        let now = Date()
        let due = percent != lastReportedPercent[asset, default: -1]
            && now.timeIntervalSince(lastReportedAt[asset, default: .distantPast]) >= 0.25
        if due {
            lastReportedAt[asset] = now
            lastReportedPercent[asset] = percent
        }
        lock.unlock()
        guard due else { return }
        DispatchQueue.main.async { [weak self] in self?.onProgress?(asset, totalBytesWritten, total) }
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        ChatModelStore.prepareDirectory()
        let asset = asset(of: downloadTask)
        let staging = ChatModelStore.directory.appendingPathComponent(asset.staging)
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
        guard error != nil else { return }
        finish(asset(of: task), false)
    }

    // MARK: Verification

    /// Move the staged file into place when its SHA-256 is the expected one;
    /// delete it otherwise.
    private static func keep(_ staging: URL, as asset: ChatAsset) -> Bool {
        guard let digest = sha256(of: staging), digest == asset.sha256 else {
            try? FileManager.default.removeItem(at: staging)
            return false
        }
        let final = ChatModelStore.directory.appendingPathComponent(asset.fileName)
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
        lastReportedPercent[asset] = -1
        lastReportedAt[asset] = .distantPast
        lock.unlock()
        DispatchQueue.main.async { [weak self] in self?.onFinished?(asset, ok) }
    }
}
