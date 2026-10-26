import SwiftUI
import UniformTypeIdentifiers

/// FOLLOWING A FOLDER, THE IOS HALF (#1127, R-1127-7; #1135).
///
/// Three things only the shell can do: raise the system's FOLDER picker (only the member's own
/// "Follow a folder" tap does; a following pass never asks the OS for anything), keep the access
/// the member granted (a security-scoped bookmark per folder, [FolderAccess]), and read a folder
/// (`FoldersRead`, `StageFolderFile`, [FolderReader]). What is followed, what a changed file is
/// and what a vanished folder means are Rust's (`imports.files`, `crates/screens/src/imports`).
///
/// The persisted access is the SHELL's and lives in `UserDefaults`, one bookmark per origin
/// (`folder:<uuid>`, minted here); the vault holds only the origin and its links (R-1127-1:
/// nothing is written to the folder).
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

/// THE FOLLOWER'S FOLDER READER (#1127): `FoldersRead` answered with a LISTING of every folder
/// Rust names, over access the member already granted, and `StageFolderFile` streamed through the
/// stage door. No bytes are read by a listing.
///
/// - A folder with no usable bookmark is LEFT OUT of the listing, which is how Rust learns it is
///   gone.
/// - **A listing that failed part-way, or met an iCloud placeholder (`.name.icloud`: a file whose
///   bytes are not on this phone, listed under another name), is not complete**, so it trashes
///   nothing: a file that is merely not here yet must not look removed (R-1127-3).
/// - Hidden files and folders, packages (`.app`, `.pages`…) and non-regular files are skipped, and
///   a file whose bytes are not on this phone is not listed.
enum FolderReader {
    private static let keys: [URLResourceKey] = [
        .isRegularFileKey, .isDirectoryKey, .isPackageKey, .fileSizeKey,
        .contentModificationDateKey, .typeIdentifierKey, .ubiquitousItemDownloadingStatusKey,
    ]

    static func list(_ read: Centraid_Core_V1_FoldersRead) -> Centraid_Core_V1_FoldersListing {
        var listing = Centraid_Core_V1_FoldersListing()
        listing.deviceID = PhoneCalendar.deviceID
        listing.complete = true
        for origin in read.origins {
            guard let root = FolderAccess.resolve(origin: origin) else { continue }
            var folder = Centraid_Core_V1_FolderListed()
            folder.origin = origin
            folder.label = root.lastPathComponent
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
                listing.complete = false
                continue
            }
            let rootParts = root.pathComponents
            for case let url as URL in walk {
                let name = url.lastPathComponent
                guard let values = try? url.resourceValues(forKeys: Set(keys)) else {
                    listing.complete = false
                    continue
                }
                if name.hasPrefix(".") {
                    if name.hasSuffix(".icloud") { listing.complete = false }
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
                    listing.complete = false
                    continue
                }
                let local = values.ubiquitousItemDownloadingStatus.map { $0 == .current || $0 == .downloaded } ?? true
                guard local else {
                    listing.complete = false
                    continue
                }
                var file = Centraid_Core_V1_FolderFile()
                file.path = parts.dropFirst(rootParts.count).joined(separator: "/")
                file.size = UInt64(max(values.fileSize ?? 0, 0))
                file.modifiedMs = Int64((values.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000)
                file.mediaType = values.typeIdentifier.flatMap { UTType($0)?.preferredMIMEType } ?? ""
                folder.files.append(file)
            }
            if failed { listing.complete = false }
            listing.folders.append(folder)
        }
        return listing
    }

    /// One followed file, streamed through the stage door. Not `ok` when it would not open or
    /// read, or the core refused.
    static func stage(_ asked: Centraid_Core_V1_StageFolderFile, core: any ScreenCore) async -> Centraid_Core_V1_FolderFileStaged {
        var staged = Centraid_Core_V1_FolderFileStaged()
        guard let root = FolderAccess.resolve(origin: asked.origin), !asked.path.contains("..") else { return staged }
        let url = root.appendingPathComponent(asked.path)
        if case let .staged(handle) = await StageDoor.stage(core, file: url.path, mediaType: asked.mediaType) {
            staged.ok = true
            staged.contentHash = handle.contentHash
            staged.byteSize = handle.byteSize
        }
        return staged
    }
}

/// THE FOLDER PICKER (#1127; the `FollowFolder` and `StopFollowing` effects, #1135). Rust asks;
/// this raises the system's folder picker, keeps the access the member grants under an origin it
/// mints (`folder:<uuid>`), and answers `FolderFollowed` with the origin and the name the phone
/// gives the folder, `EffectDone` for a closed picker, `EffectFailed` for a refusal (Rust words
/// it). The Docs drive tells the follower; nothing is told from here.
@MainActor
final class DocsFollow: ObservableObject {
    static let shared = DocsFollow()

    /// The folder picker is up.
    @Published var picking = false

    private var answer: ((Centraid_Core_V1_EffectResult.OneOf_Outcome) -> Void)?

    /// "Follow a folder": raise the picker.
    func request(answer: @escaping (Centraid_Core_V1_EffectResult.OneOf_Outcome) -> Void) {
        self.answer = answer
        picking = true
    }

    func picked(_ result: Result<[URL], Swift.Error>) {
        switch result {
        case let .failure(error):
            if (error as NSError).code == NSUserCancelledError { done() } else { fail() }
        case let .success(urls):
            guard let url = urls.first else { return done() }
            // PICKED TWICE IS NOT A SECOND ORIGIN: the folder's own origin is answered again.
            let origin = FolderAccess.following(url) ?? "folder:\(UUID().uuidString.lowercased())"
            guard FolderAccess.remember(origin: origin, url: url) else { return fail() }
            var followed = Centraid_Core_V1_FolderFollowed()
            followed.origin = origin
            followed.name = url.lastPathComponent
            answer?(.folderFollowed(followed))
            answer = nil
        }
    }

    /// "Stop following": the vault forgets the links (Rust) and every document stays; the access goes.
    func stop(_ origin: String, answer: (Centraid_Core_V1_EffectResult.OneOf_Outcome) -> Void) {
        FolderAccess.forget(origin: origin)
        answer(.done(Centraid_Core_V1_EffectDone()))
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
