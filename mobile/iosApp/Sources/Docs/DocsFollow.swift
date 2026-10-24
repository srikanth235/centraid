import SwiftUI
import UniformTypeIdentifiers

import CentraidShared

/// FOLLOWING A FOLDER, THE IOS HALF (#1127, R-1127-7; `DocsFollowBridge`'s header).
///
/// Three things only the shell can do: raise the system's FOLDER picker (only the member's own
/// "Follow a folder" tap does; a following pass never asks the OS for anything), keep the access
/// the member granted (a security-scoped bookmark per folder, [FolderAccess]), and list a folder
/// ([FolderFollowReader]). What is followed, what a changed file is, and what a vanished folder
/// asks are the shared code's.
///
/// The persisted access is the SHELL's and lives in `UserDefaults`, one bookmark per origin id;
/// the vault holds only the origin and its links (R-1127-1: nothing is written to the folder).
enum FolderAccess {
    private static let prefix = "docs.folder.bookmark."
    private static let lock = NSLock()
    /// Scopes started and kept for the process: a pass lists a folder and then reads its files later.
    private static var started: [String: URL] = [:]

    /// Keep the access to [url] under [origin]. False when iOS would not make a bookmark of it.
    static func remember(origin: String, url: URL) -> Bool {
        let scoped = url.startAccessingSecurityScopedResource()
        guard let data = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) else {
            if scoped { url.stopAccessingSecurityScopedResource() }
            return false
        }
        UserDefaults.standard.set(data, forKey: prefix + origin)
        lock.withLock { started[origin] = url }
        return true
    }

    /// The folder [origin] names, with access started, or nil when it is GONE: no bookmark, a
    /// bookmark that no longer resolves (the folder was deleted), one that resolves into the
    /// trash, or one whose folder cannot be reached. A STALE bookmark (the folder moved or was
    /// renamed) resolves, and is refreshed.
    static func resolve(origin: String) -> URL? {
        if let held = lock.withLock({ started[origin] }), reachable(held) { return held }
        lock.withLock {
            started[origin]?.stopAccessingSecurityScopedResource()
            started[origin] = nil
        }
        guard let data = UserDefaults.standard.data(forKey: prefix + origin) else { return nil }
        var stale = false
        guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale) else {
            return nil
        }
        let scoped = url.startAccessingSecurityScopedResource()
        guard reachable(url) else {
            if scoped { url.stopAccessingSecurityScopedResource() }
            return nil
        }
        if stale, let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
            UserDefaults.standard.set(fresh, forKey: prefix + origin)
        }
        lock.withLock { started[origin] = url }
        return url
    }

    /// The origin already following [url], if any: picking a folder twice is not a second origin.
    static func following(_ url: URL) -> String? {
        for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix(prefix) {
            let origin = String(key.dropFirst(prefix.count))
            if let known = resolve(origin: origin), known.standardizedFileURL.path == url.standardizedFileURL.path {
                return origin
            }
        }
        return nil
    }

    /// The member stopped following [origin], or a pick was refused: the bookmark and its scope go.
    static func forget(origin: String) {
        lock.withLock {
            started[origin]?.stopAccessingSecurityScopedResource()
            started[origin] = nil
        }
        UserDefaults.standard.removeObject(forKey: prefix + origin)
    }

    private static func reachable(_ url: URL) -> Bool {
        guard (try? url.checkResourceIsReachable()) == true,
              (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
        else { return false }
        // A folder deleted in Files moves to Recently Deleted, and a bookmark follows it there.
        return !url.pathComponents.contains { $0 == ".Trash" || $0 == ".Trashes" }
    }
}

/// THE FOLLOWER'S FOLDER READER (#1127): a LISTING of every followed folder, off the main thread,
/// over access the member already granted. No bytes are read here; a file's [PhoneFile.open] is
/// called by the pass only for a file that is new or whose size or modification time moved.
///
/// - A folder with no usable bookmark is LEFT OUT of `origins`, which is how the shared engine
///   learns it is gone and asks (R-1127-9).
/// - **A listing that failed part-way, or met an iCloud placeholder (`.name.icloud`: a file whose
///   bytes are not on this phone, listed under another name), is not complete**, so it trashes
///   nothing: a file that is merely not here yet must not look removed (R-1127-3).
/// - Hidden files and folders, packages (`.app`, `.pages`…) and non-regular files are skipped.
final class FolderFollowReader: NSObject, FilesReader {
    func read(followed: [String], deliver: @escaping (FilesRead?) -> Void) {
        Task.detached(priority: .utility) { deliver(Self.list(followed)) }
    }

    private static let keys: [URLResourceKey] = [
        .isRegularFileKey, .isDirectoryKey, .isPackageKey, .fileSizeKey,
        .contentModificationDateKey, .typeIdentifierKey, .ubiquitousItemDownloadingStatusKey,
    ]

    static func list(_ followed: [String]) -> FilesRead {
        var files: [PhoneFile] = []
        var origins: [PhoneOriginRef] = []
        var complete = true
        for origin in followed {
            guard let root = FolderAccess.resolve(origin: origin) else { continue }
            origins.append(FilesImport.shared.folder(origin: origin, name: root.lastPathComponent))
            var failed = false
            guard let walk = FileManager.default.enumerator(
                at: root,
                includingPropertiesForKeys: keys,
                options: [.skipsPackageDescendants],
                errorHandler: { _, _ in
                    failed = true
                    return true
                }
            ) else {
                complete = false
                continue
            }
            let rootParts = root.pathComponents
            for case let url as URL in walk {
                let name = url.lastPathComponent
                guard let values = try? url.resourceValues(forKeys: Set(keys)) else {
                    complete = false
                    continue
                }
                if name.hasPrefix(".") {
                    if name.hasSuffix(".icloud") { complete = false }
                    if values.isDirectory == true { walk.skipDescendants() }
                    continue
                }
                if values.isPackage == true {
                    walk.skipDescendants()
                    continue
                }
                guard values.isRegularFile == true else { continue }
                let parts = url.pathComponents
                guard parts.count > rootParts.count, Array(parts.prefix(rootParts.count)) == rootParts else {
                    complete = false
                    continue
                }
                let relative = parts.dropFirst(rootParts.count).joined(separator: "/")
                let local = values.ubiquitousItemDownloadingStatus.map { $0 == .current || $0 == .downloaded } ?? true
                let path = url.path
                files.append(PhoneFile(
                    origin: origin,
                    path: relative,
                    size: Int64(values.fileSize ?? 0),
                    modifiedMs: Int64((values.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000),
                    mediaType: values.typeIdentifier.flatMap { UTType($0)?.preferredMIMEType } ?? "",
                    open: { local ? PhoneFileSources.shared.atPath(path: path) : nil }
                ))
            }
            if failed { complete = false }
        }
        return FilesRead(files: files, origins: origins, complete: complete)
    }
}

/// THE FOLDER PICKER (#1127; the `FollowFolder` and `StopFollowing` effects, #1135).
/// Rust asks; this raises the system's folder picker, keeps the access the member grants,
/// tells the vault (`DocsFollowBridge`) and answers: `FolderFollowed` with the origin and the
/// name the phone gives the folder, `EffectDone` for a closed picker, `EffectFailed` for a
/// refusal (Rust says the sentence). What is followed is the shared follower engine's.
@MainActor
final class DocsFollow: ObservableObject {
    static let shared = DocsFollow()

    /// The folder picker is up.
    @Published var picking = false

    weak var shell: ShellModel?
    let bridge = DocsScreens.followBridge

    private var answer: ((Centraid_Core_V1_EffectResult.OneOf_Outcome) -> Void)?

    /// "Follow a folder": raise the picker.
    func request(answer: @escaping (Centraid_Core_V1_EffectResult.OneOf_Outcome) -> Void) {
        self.answer = answer
        picking = true
    }

    /// The folders the vault follows now, for the drive's More sheet.
    func followed(_ deliver: @escaping ([FollowedFolder]) -> Void) {
        bridge.followed { folders in
            DispatchQueue.main.async { deliver(folders) }
        }
    }

    func picked(_ result: Result<[URL], Swift.Error>) {
        switch result {
        case let .failure(error):
            if (error as NSError).code == NSUserCancelledError { done() } else { fail() }
        case let .success(urls):
            guard let url = urls.first else { return done() }
            if FolderAccess.following(url) != nil {
                // Already followed: a pass over it is the most the tap can mean.
                shell?.followFolders()
                return done()
            }
            let origin = bridge.mintOrigin()
            guard FolderAccess.remember(origin: origin, url: url) else { return fail() }
            let name = url.lastPathComponent
            bridge.follow(origin: origin, name: name) { [weak self] ok in
                DispatchQueue.main.async {
                    guard let self else { return }
                    if ok.boolValue {
                        self.shell?.followFolders()
                        var followed = Centraid_Core_V1_FolderFollowed()
                        followed.origin = origin
                        followed.name = name
                        self.answer?(.folderFollowed(followed))
                        self.answer = nil
                    } else {
                        FolderAccess.forget(origin: origin)
                        self.fail()
                    }
                }
            }
        }
    }

    /// "Stop following": the vault forgets the links and keeps every document; then the access goes.
    func stop(_ origin: String, answer: @escaping (Centraid_Core_V1_EffectResult.OneOf_Outcome) -> Void) {
        bridge.stop(origin: origin) { ok in
            DispatchQueue.main.async {
                if ok.boolValue { FolderAccess.forget(origin: origin) }
                answer(.done(Centraid_Core_V1_EffectDone()))
            }
        }
    }

    private func done() {
        answer?(.done(Centraid_Core_V1_EffectDone()))
        answer = nil
    }

    private func fail() {
        var failed = Centraid_Core_V1_EffectFailed()
        failed.reason = "the folder could not be followed"
        answer?(.failed(failed))
        answer = nil
    }
}

/// THE FOLDER PICKER, hosted beside the file picker's (a view carries one importer).
struct DocsFollowRoot: View {
    @ObservedObject var model = DocsFollow.shared

    var body: some View {
        Color.clear
            .fileImporter(isPresented: $model.picking, allowedContentTypes: [.folder], allowsMultipleSelection: false) { result in
                model.picked(result)
            }
    }
}
