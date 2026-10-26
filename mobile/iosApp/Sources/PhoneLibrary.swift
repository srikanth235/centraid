#if os(iOS)
import Foundation
import ImageIO
import Photos
import UIKit
import UniformTypeIdentifiers

/// THE CAMERA ROLL'S PHOTOKIT HALF (#1025 S6; #1080, the walker; #1135).
///
/// `imports.camera_roll` decides everything (the grant's words, the cursor kept per vault, what
/// may cross which link, an edit beside its original, what to render); this file only performs
/// what it asks, as effects, and answers them:
///
/// - `LibraryPermission` reads or asks the grant ([permission], [requestPermission]);
/// - `RollPage` lists the assets after a cursor this file minted ([page]);
/// - `LibraryStage` streams one resource straight out of Photos into the stage door, with no
///   second copy ([stage]);
/// - `LibraryDerivatives` renders the tiers the core lacks from the CURRENT edit and stages them
///   against the original ([derivatives]).
///
/// A library change while the app is on screen is told to the roll as `LibraryChanged`
/// ([LibraryWatcher]).
enum PhoneLibrary {
    // MARK: The grant

    /// The grant as it stands; never prompts.
    static func permission() -> Centraid_Core_V1_PhotosMediaPermission {
        permission(of: PHPhotoLibrary.authorizationStatus(for: .readWrite))
    }

    /// ASK, AND WAIT FOR THE ANSWER. `.readWrite` and nothing narrower: `.addOnly`
    /// cannot enumerate at all, so an app granted it would find an empty roll.
    static func requestPermission() async -> Centraid_Core_V1_PhotosMediaPermission {
        let status = await withCheckedContinuation { continuation in
            PHPhotoLibrary.requestAuthorization(for: .readWrite) { continuation.resume(returning: $0) }
        }
        LibraryWatcher.shared.registerIfAllowed()
        return permission(of: status)
    }

    private static func permission(of status: PHAuthorizationStatus) -> Centraid_Core_V1_PhotosMediaPermission {
        switch status {
        case .authorized: return .granted
        // A FIRST-CLASS STATE, not a denial with fewer photos.
        case .limited: return .limited
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .notAsked
        @unknown default: return .unspecified
        }
    }

    // MARK: One page

    /// ONE PAGE OF THE CAMERA ROLL. Two walks, one cursor: **the first walk is a keyset on
    /// `creationDate`**, from the oldest photograph up, carrying the change token taken when it
    /// STARTED (`k|<token>|<millis>|<localIdentifier>`); **every walk after it is that token's**,
    /// the assets ADDED or UPDATED since (`t|<token>|<offered>`). A keyset alone misses an asset
    /// that arrives with an old capture date (an AirDropped photograph from last year), and the
    /// token is what Photos keeps for exactly that question; an update is offered only when the
    /// member edited the asset. A token Photos no longer answers for starts the first walk again,
    /// which the core's `already_held` makes cheap. A cursor a v0 build wrote
    /// (`<millis>|<localIdentifier>`) finishes its keyset and then takes the token of that moment.
    static func page(cursor: String, limit: Int) async -> Centraid_Core_V1_RollPaged {
        let fields = cursor.components(separatedBy: field)
        if fields.first == tokenWalk, fields.count == 3 {
            let offered = Int(fields[2]) ?? 0
            if let page = await changedPage(token: fields[1], offered: offered, limit: limit) { return page }
            return await keysetPage(from: nil, token: ChangeTokens.current(), limit: limit)
        }
        if fields.first == keysetWalk, fields.count >= 4 {
            let rest = fields.dropFirst(2).joined(separator: field)
            return await keysetPage(from: KeysetCursor.parse(rest), token: fields[1].isEmpty ? nil : fields[1], limit: limit)
        }
        let legacy = KeysetCursor.parse(cursor)
        return await keysetPage(from: legacy, token: legacy == nil ? ChangeTokens.current() : nil, limit: limit)
    }

    /// The first walk: `creationDate` keyset. **The predicate is `>=`, and the overlap is skipped
    /// here**, because `localIdentifier` is no key `NSPredicate` over `PHAsset` accepts; an asset
    /// with NO `creationDate` reads as the floor, where Photos' ascending sort puts it too.
    private static func keysetPage(from: KeysetCursor?, token: String?, limit: Int) async -> Centraid_Core_V1_RollPaged {
        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
        if let from {
            options.predicate = NSPredicate(
                format: "creationDate >= %@",
                Date(timeIntervalSince1970: Double(from.epochMillis) / 1000) as NSDate
            )
        }
        // A LAZY, SNAPSHOT-BACKED FETCH: reading `limit` of them costs `limit` reads.
        let fetched = PHAsset.fetchAssets(with: options)
        var assets: [Centraid_Core_V1_RollAsset] = []
        var index = 0
        var passed = from == nil
        while index < fetched.count, assets.count < limit {
            let asset = fetched.object(at: index)
            index += 1
            let cursor = KeysetCursor(epochMillis: epochMillis(of: asset), localID: asset.localIdentifier)
            if !passed {
                // Everything up to AND INCLUDING the cursor's own identifier was offered.
                if cursor.localID == from?.localID { passed = true }
                continue
            }
            let after = token.map { "\(keysetWalk)\(field)\($0)\(field)\(cursor.encoded)" } ?? cursor.encoded
            assets.append(await describe(asset, cursor: cursor, after: after))
        }
        var paged = Centraid_Core_V1_RollPaged()
        paged.assets = assets
        paged.exhausted = index >= fetched.count
        // THE END OF THE FIRST WALK HANDS OVER TO ITS TOKEN, taken when it started, so nothing
        // added during the walk is missed.
        if paged.exhausted, let next = token ?? ChangeTokens.current() {
            paged.nextCursor = "\(tokenWalk)\(field)\(next)\(field)0"
        } else {
            paged.nextCursor = assets.last?.after ?? ""
        }
        return paged
    }

    /// Every walk after the first: the assets added or edited since `token`, `offered` of them
    /// already offered. Nil when Photos will not answer for the token.
    private static func changedPage(token: String, offered: Int, limit: Int) async -> Centraid_Core_V1_RollPaged? {
        guard let changes = ChangeTokens.changed(since: token) else { return nil }
        let window = Array(changes.identifiers.dropFirst(offered).prefix(limit))
        let found = PHAsset.fetchAssets(withLocalIdentifiers: window, options: nil)
        var byID: [String: PHAsset] = [:]
        found.enumerateObjects { asset, _, _ in byID[asset.localIdentifier] = asset }
        var assets: [Centraid_Core_V1_RollAsset] = []
        for (at, id) in window.enumerated() {
            // ADDED OR EDITED, THEN DELETED inside the window: nothing to offer. A deletion is
            // never mirrored (R-1127-4): the vault is the backup.
            guard let asset = byID[id] else { continue }
            // A METADATA-ONLY UPDATE IS NOT AN EDIT. The cursor still moves past it.
            guard changes.inserted.contains(id) || asset.hasAdjustments else { continue }
            let after = "\(tokenWalk)\(field)\(token)\(field)\(offered + at + 1)"
            assets.append(await describe(asset, cursor: KeysetCursor(epochMillis: epochMillis(of: asset), localID: id), after: after))
        }
        var paged = Centraid_Core_V1_RollPaged()
        paged.assets = assets
        paged.exhausted = offered + window.count >= changes.identifiers.count
        // CAUGHT UP: the next walk is from the newest change seen.
        paged.nextCursor = paged.exhausted
            ? "\(tokenWalk)\(field)\(changes.newest ?? token)\(field)0"
            : "\(tokenWalk)\(field)\(token)\(field)\(offered + window.count)"
        return paged
    }

    /// One `PHAsset` and its resources. A Live Photo is one capture of a still and its paired
    /// movie; an edit is a render beside what the camera wrote (A20), its ref naming the
    /// `modificationDate` it is read at. Burst members and RAW pairs get no group: grouping on
    /// `burstIdentifier` would invent a relationship the owner never made.
    private static func describe(_ asset: PHAsset, cursor: KeysetCursor, after: String) async -> Centraid_Core_V1_RollAsset {
        let live = asset.mediaSubtypes.contains(.photoLive)
        let identifier = asset.localIdentifier
        let resources = PHAssetResource.assetResources(for: asset)
        // `hasAdjustments` alone does not make the camera's bytes a second file: an adjustment
        // Photos never rendered leaves the camera's file as the only one, and it is then both.
        let edited = asset.hasAdjustments
        let camera = edited && resources.contains(where: isRender) && cameraOf(resources) != nil
        var rolled = Centraid_Core_V1_RollAsset()
        rolled.after = after
        rolled.kind = asset.mediaType == .video ? .video : .photo
        rolled.capturedAt = iso(epochMillis: cursor.epochMillis)
        rolled.capturedUtcOffsetMinutes = Int32(await captureOffset(of: asset))
        rolled.captureGroup = live || edited ? identifier : ""
        if camera {
            rolled.resources.append(resource(LibraryRefs.camera(identifier), .cameraOriginal))
        }
        rolled.resources.append(resource(
            edited ? LibraryRefs.rendition(identifier, modifiedMillis: modifiedMillis(of: asset)) : identifier,
            .original
        ))
        if live {
            rolled.resources.append(resource(LibraryRefs.pairedVideo(identifier), .pairedVideo))
        }
        return rolled
    }

    private static func resource(_ ref: String, _ role: Centraid_Core_V1_RollResource.Role) -> Centraid_Core_V1_RollResource {
        var resource = Centraid_Core_V1_RollResource()
        resource.ref = ref
        resource.role = role
        return resource
    }

    // MARK: One resource, into the stage door

    /// OPEN ONE RESOURCE AND STREAM IT THROUGH THE STAGE DOOR (#1080 ruling 6): `source =
    /// OS_LIBRARY` with the ref as `os_ref`, and nothing copied. An original only in iCloud is
    /// downloaded only when Rust allowed it (`allow_network`).
    static func stage(_ asked: Centraid_Core_V1_LibraryStage, core: any ScreenCore) async -> Centraid_Core_V1_LibraryStaged {
        var staged = Centraid_Core_V1_LibraryStaged()
        guard let resource = resource(for: asked.ref) else {
            staged.outcome = .gone
            return staged
        }
        let mediaType = asked.mediaType.isEmpty ? mime(of: resource.uniformTypeIdentifier) : asked.mediaType
        let stream = LibraryStream()
        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = asked.allowNetwork
        let manager = PHAssetResourceManager.default()
        let request = manager.requestData(for: resource,
            options: options,
            dataReceivedHandler: { stream.deliver($0) },
            completionHandler: { stream.finish($0) }
        )
        stream.cancel = { manager.cancelDataRequest(request) }
        defer { stream.close() }
        switch await stream.first() {
        case .inCloud:
            staged.outcome = .inCloud
            return staged
        case .nothing:
            staged.outcome = .gone
            return staged
        case .data:
            break
        }
        var begin = StageDoor.Begin(mediaType: mediaType, byteSize: asked.byteSize)
        // NOT MARKED EDITED (R-1127-5): an edit's ref names the `modificationDate` it was read
        // at, which is the delete guard's witness, and the camera's file is a resource of its own.
        begin.osRef = asked.ref
        switch await StageDoor.stage(core, begin, read: { try await stream.read(max: $0) }) {
        case let .staged(handle):
            staged.outcome = .ready
            staged.mediaType = mediaType
            staged.contentHash = handle.contentHash
            staged.byteSize = handle.byteSize
            staged.alreadyHeld = handle.alreadyHeld
            staged.derivativesHeld = handle.derivativesHeld
        case .refused:
            // The sentence is Rust's to word.
            staged.outcome = .failed
        }
        return staged
    }

    /// RENDER the tiers the core lacks, drawn by Photos from the current edit, and stage each as
    /// a derivative of the original. A tier that fails costs nothing but itself.
    static func derivatives(_ asked: Centraid_Core_V1_LibraryDerivatives, core: any ScreenCore) async {
        guard let asset = asset(for: asked.ref) else { return }
        for tier in asked.tiers {
            guard let edge = tierEdges[tier], let bytes = await render(asset, edge: edge) else { continue }
            var begin = StageDoor.Begin(mediaType: "image/jpeg")
            begin.forHash = asked.forHash
            begin.tier = tier
            _ = await StageDoor.stage(core, bytes: bytes, begin)
        }
    }

    /// The long edge of each tier, as the core's own renditions draw them.
    private static let tierEdges: [String: CGFloat] = ["thumb": 360, "preview": 2048]

    /// `crates/media/src/renditions.rs`' JPEG quality.
    private static let jpegQuality: CGFloat = 0.8

    /// Aspect-fit inside a square of `edge`, upright. **No download**: an original only in
    /// iCloud still has a local thumbnail to draw from. `jpegData` encodes pixels and no GPS.
    private static func render(_ asset: PHAsset, edge: CGFloat) async -> Data? {
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .exact
        options.isNetworkAccessAllowed = false
        let image: UIImage? = await withCheckedContinuation { continuation in
            PHImageManager.default().requestImage(for: asset,
                targetSize: CGSize(width: edge, height: edge),
                contentMode: .aspectFit,
                options: options
            ) { drawn, _ in continuation.resume(returning: drawn) }
        }
        return image?.jpegData(compressionQuality: jpegQuality)
    }

    // MARK: Refs and resources

    private static func asset(for ref: String) -> PHAsset? {
        PHAsset.fetchAssets(withLocalIdentifiers: [LibraryRefs.identifier(of: ref)], options: nil).firstObject
    }

    /// THE REF'S VERSION IS EVIDENCE, NOT A REQUEST: a rendition ref reads the rendition as it is
    /// now, and the core's hash check keeps a later edit's bytes out of the old name.
    private static func resource(for ref: String) -> PHAssetResource? {
        guard let asset = asset(for: ref) else { return nil }
        let resources = PHAssetResource.assetResources(for: asset)
        if LibraryRefs.isPairedVideo(ref) { return pairedVideoOf(resources) }
        if LibraryRefs.isCamera(ref) { return cameraOf(resources) }
        return originalOf(resources)
    }

    private static func isRender(_ resource: PHAssetResource) -> Bool {
        resource.type == .fullSizePhoto || resource.type == .fullSizeVideo
    }

    /// What the camera wrote, which Photos keeps beside an edit's render.
    private static func cameraOf(_ resources: [PHAssetResource]) -> PHAssetResource? {
        resources.first { $0.type == .photo || $0.type == .video }
    }

    /// The current rendition: an edit's render when there is one, else what the camera wrote.
    private static func originalOf(_ resources: [PHAssetResource]) -> PHAssetResource? {
        resources.first(where: isRender) ?? cameraOf(resources)
    }

    private static func pairedVideoOf(_ resources: [PHAssetResource]) -> PHAssetResource? {
        resources.first { $0.type == .fullSizePairedVideo } ?? resources.first { $0.type == .pairedVideo }
    }

    /// A resource's uniform type as a MIME type.
    static func mime(of identifier: String) -> String {
        if let mime = UTType(identifier)?.preferredMIMEType { return mime }
        switch identifier {
        case "public.heic", "public.heif": return "image/heic"
        case "public.jpeg": return "image/jpeg"
        case "public.png": return "image/png"
        case "com.compuserve.gif": return "image/gif"
        case "com.apple.quicktime-movie": return "video/quicktime"
        case "public.mpeg-4": return "video/mp4"
        default: return "application/octet-stream"
        }
    }

    // MARK: Times

    /// `creationDate` as epoch milliseconds; nil reads as the floor. Negative is real (a scanned
    /// photograph from 1965) and still orders correctly.
    private static func epochMillis(of asset: PHAsset) -> Int64 {
        guard let date = asset.creationDate else { return 0 }
        return Int64((date.timeIntervalSince1970 * 1000).rounded(.down))
    }

    private static func modifiedMillis(of asset: PHAsset) -> Int64 {
        guard let date = asset.modificationDate else { return 0 }
        return Int64((date.timeIntervalSince1970 * 1000).rounded(.down))
    }

    /// RFC 3339 in UTC, in the POSIX locale: a phone set to a Buddhist calendar formats `yyyy`
    /// as 2568.
    private static func iso(epochMillis: Int64) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss'Z'"
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter.string(from: Date(timeIntervalSince1970: Double(epochMillis) / 1000))
    }

    /// THE CAPTURE'S ZONE OFFSET, minutes east of UTC, from the file's own EXIF
    /// `OffsetTimeOriginal` (D-1025-S7-77): `PHAsset` states none. Zero for everything that
    /// cannot be read without a download (a video, an original only in iCloud, a file with no
    /// tag) and never the reader's zone. `OffsetTime` is the zone of the last change and is not
    /// read.
    private static func captureOffset(of asset: PHAsset) async -> Int {
        guard asset.mediaType == .image else { return 0 }
        let options = PHContentEditingInputRequestOptions()
        options.isNetworkAccessAllowed = false
        return await withCheckedContinuation { continuation in
            // THE TAG IS READ INSIDE THE HANDLER: the input's URL is only good while it lives.
            // ImageIO reads the header and not the pixels.
            asset.requestContentEditingInput(with: options) { input, _ in
                guard let url = input?.fullSizeImageURL,
                      let source = CGImageSourceCreateWithURL(url as CFURL, nil),
                      let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                      let exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any],
                      let tag = exif[kCGImagePropertyExifOffsetTimeOriginal] as? String
                else {
                    continuation.resume(returning: 0)
                    return
                }
                continuation.resume(returning: offsetMinutes(tag) ?? 0)
            }
        }
    }

    /// `+05:30`, `-0800`, `+09` or `Z` as minutes; nil for anything else, or past the vault's
    /// bound of eighteen hours.
    static func offsetMinutes(_ text: String) -> Int? {
        let tag = text.trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: "\u{0}")))
        if tag == "Z" || tag == "z" { return 0 }
        guard let first = tag.first, first == "+" || first == "-" else { return nil }
        let digits = Array(tag.dropFirst())
        let hours: String
        let minutes: String
        switch digits.count {
        case 5 where digits[2] == ":":
            hours = String(digits[0 ..< 2])
            minutes = String(digits[3 ..< 5])
        case 4:
            hours = String(digits[0 ..< 2])
            minutes = String(digits[2 ..< 4])
        case 2:
            hours = String(digits)
            minutes = "00"
        default:
            return nil
        }
        let ascii = { (part: String) in part.allSatisfy { ("0" ... "9").contains($0) } }
        guard ascii(hours), ascii(minutes), let h = Int(hours), let m = Int(minutes), m <= 59 else { return nil }
        let total = (first == "-" ? -1 : 1) * (h * 60 + m)
        return abs(total) <= 1080 ? total : nil
    }

    // MARK: Cursors

    private static let field = "|"
    private static let keysetWalk = "k"
    private static let tokenWalk = "t"

    /// `<epoch millis>|<localIdentifier>`.
    private struct KeysetCursor: Equatable {
        let epochMillis: Int64
        let localID: String

        var encoded: String { "\(epochMillis)|\(localID)" }

        /// A cursor this file did not write starts the walk again rather than being guessed at:
        /// starting again re-offers what the core holds, which is cheap; a guessed date skips.
        static func parse(_ text: String) -> KeysetCursor? {
            guard let at = text.firstIndex(of: "|"), let millis = Int64(text[..<at]) else { return nil }
            return KeysetCursor(epochMillis: millis, localID: String(text[text.index(after: at)...]))
        }
    }
}

/// THE REFS OF A PHOTO LIBRARY ASSET (#1127, A20): what the core keeps as a stage's `os_ref` and
/// a deleter later gets back. The core reads only the part before the first `#`, so every ref of
/// one asset is one library item, offered for deletion whole or not at all. `#` cannot occur in a
/// `PHAsset` identifier (`<UUID>/L0/001`).
///
/// ```
///   <identifier>                a plain asset's original
///   <identifier>#pairedVideo    a Live Photo's movie
///   <identifier>#camera         what the camera wrote under an edit
///   <identifier>#r<millis>      an edited asset's render, read at that `modificationDate`
/// ```
enum LibraryRefs {
    static let pairedVideoSuffix = "#pairedVideo"
    static let cameraSuffix = "#camera"
    static let renditionMark = "#r"

    static func rendition(_ identifier: String, modifiedMillis: Int64) -> String {
        "\(identifier)\(renditionMark)\(modifiedMillis)"
    }

    static func camera(_ identifier: String) -> String { identifier + cameraSuffix }

    static func pairedVideo(_ identifier: String) -> String { identifier + pairedVideoSuffix }

    /// The asset a ref names: everything before the first `#`.
    static func identifier(of ref: String) -> String {
        ref.firstIndex(of: "#").map { String(ref[..<$0]) } ?? ref
    }

    /// The version a rendition's ref was read at, or nil for any other ref.
    static func witness(of ref: String) -> Int64? {
        guard let range = ref.range(of: renditionMark) else { return nil }
        return Int64(ref[range.upperBound...])
    }

    static func isRendition(_ ref: String) -> Bool { witness(of: ref) != nil }

    static func isCamera(_ ref: String) -> Bool { ref.hasSuffix(cameraSuffix) }

    static func isPairedVideo(_ ref: String) -> Bool { ref.hasSuffix(pairedVideoSuffix) }
}

/// THE PERSISTENT CHANGE TOKEN, KEPT AS TEXT: archived and base64'd, since
/// `PHPersistentChangeToken` is opaque and `NSSecureCoding`.
private enum ChangeTokens {
    struct Changes {
        /// Every asset the changes named, in the order Photos recorded them (additions first
        /// within one change), each where it was FIRST named, so a longer walk only appends.
        let identifiers: [String]
        let inserted: Set<String>
        let newest: String?
    }

    static func current() -> String? {
        encode(PHPhotoLibrary.shared().currentChangeToken)
    }

    static func encode(_ token: PHPersistentChangeToken) -> String? {
        (try? NSKeyedArchiver.archivedData(withRootObject: token, requiringSecureCoding: true))?.base64EncodedString()
    }

    static func decode(_ text: String) -> PHPersistentChangeToken? {
        guard let data = Data(base64Encoded: text) else { return nil }
        return try? NSKeyedUnarchiver.unarchivedObject(ofClass: PHPersistentChangeToken.self, from: data)
    }

    /// Nil when Photos will not answer: an expired token, which restarts the walk.
    static func changed(since text: String) -> Changes? {
        guard let token = decode(text),
              let changes = try? PHPhotoLibrary.shared().fetchPersistentChanges(since: token)
        else { return nil }
        var seen: [String] = []
        var known: Set<String> = []
        var inserted: Set<String> = []
        var newest: PHPersistentChangeToken?
        for change in changes {
            if let details = try? change.changeDetails(for: .asset) {
                // ONE CHANGE'S SET HAS NO ORDER; sorted, so a resumed page is the same page.
                for id in details.insertedLocalIdentifiers.sorted() {
                    inserted.insert(id)
                    if known.insert(id).inserted { seen.append(id) }
                }
                for id in details.updatedLocalIdentifiers.sorted() where known.insert(id).inserted {
                    seen.append(id)
                }
            }
            newest = change.changeToken
        }
        return Changes(identifiers: seen, inserted: inserted, newest: newest.flatMap(encode))
    }
}

/// ONE RESOURCE, STREAMED FROM PHOTOS. `requestData` is a PUSH api: Photos calls the data handler
/// on its own queue with each chunk, and the handler WAITS while four chunks are unread, which is
/// the backpressure: a 4K video is never in memory whole, and Photos reads no faster than the
/// stage door hashes and seals. [close] cancels the request, so a stage refused half way leaves no
/// Photos queue waiting on nobody.
private final class LibraryStream: @unchecked Sendable {
    enum First {
        case data
        case inCloud
        case nothing
    }

    /// `PHPhotosError.networkAccessRequired`: the original is only in iCloud and the request said
    /// not to download it.
    private static let networkAccessRequired = 3164
    private static let buffered = 4

    var cancel: () -> Void = {}

    private let condition = NSCondition()
    private var chunks: [Data] = []
    private var first: First?
    private var ended = false
    private var broken = false
    private var closed = false
    private var pending = Data()

    /// Photos' data handler, on Photos' own queue. The data is COPIED: Photos may reuse it.
    func deliver(_ data: Data) {
        guard !data.isEmpty else { return }
        condition.lock()
        defer { condition.unlock() }
        if first == nil { first = .data }
        while chunks.count >= Self.buffered, !closed { condition.wait() }
        guard !closed else { return }
        chunks.append(Data(data))
        condition.broadcast()
    }

    /// Photos' completion handler: the end, or why there is no more. A read that BROKE fails the
    /// stage: a truncated original staged whole would be committed under the truncation's hash.
    func finish(_ error: Error?) {
        condition.lock()
        defer { condition.unlock() }
        if first == nil {
            let code = (error as NSError?)?.code
            // NOTHING AT ALL is an empty resource, which is not a photograph.
            first = code == Self.networkAccessRequired ? .inCloud : .nothing
        }
        if error != nil { broken = true }
        ended = true
        condition.broadcast()
    }

    /// The first thing that happened: a chunk, the end, or an original only in iCloud.
    func first() async -> First {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                self.condition.lock()
                while self.first == nil { self.condition.wait() }
                let first = self.first ?? .nothing
                self.condition.unlock()
                continuation.resume(returning: first)
            }
        }
    }

    /// At most `max` bytes, empty at the end; throws when Photos broke off the read.
    func read(max: Int) async throws -> Data {
        if pending.isEmpty {
            pending = try await next()
            if pending.isEmpty { return Data() }
        }
        let slice = pending.prefix(max)
        pending = pending.dropFirst(slice.count)
        return Data(slice)
    }

    private func next() async throws -> Data {
        let result: Result<Data, Error> = await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .utility).async {
                self.condition.lock()
                while self.chunks.isEmpty, !self.ended { self.condition.wait() }
                let outcome: Result<Data, Error>
                if !self.chunks.isEmpty {
                    outcome = .success(self.chunks.removeFirst())
                    self.condition.broadcast()
                } else if self.broken {
                    outcome = .failure(CocoaError(.fileReadUnknown))
                } else {
                    outcome = .success(Data())
                }
                self.condition.unlock()
                continuation.resume(returning: outcome)
            }
        }
        return try result.get()
    }

    /// Cannot fail: it runs on every path out of a stage.
    func close() {
        condition.lock()
        let wasClosed = closed
        closed = true
        condition.broadcast()
        condition.unlock()
        if !wasClosed, !ended { cancel() }
    }
}

/// THE LIBRARY CHANGED WHILE THE APP IS ON SCREEN: a nudge to walk, told to the camera roll
/// (`ImportsCameraRollEvent.LibraryChanged`). It reports THAT the library changed and never what:
/// the cursor is the durable answer.
///
/// **REGISTERING IS AN ACCESS, NOT A SUBSCRIPTION.** With the grant still `notDetermined`,
/// `register` presents the system's photo prompt itself, which is how a phone with no vault once
/// asked for the camera roll at first launch. So the observer waits for an answer that lets the
/// app read: it is registered when one is held, and again after the member grants one.
final class LibraryWatcher: NSObject, PHPhotoLibraryChangeObserver, @unchecked Sendable {
    static let shared = LibraryWatcher()

    /// What a change is told to; set by the session.
    var onChange: (() -> Void)?
    private var registered = false

    func registerIfAllowed() {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard !registered, status == .authorized || status == .limited else { return }
        registered = true
        PHPhotoLibrary.shared().register(self)
    }

    func photoLibraryDidChange(_ changeInstance: PHChange) {
        DispatchQueue.main.async { self.onChange?() }
    }
}
#endif
