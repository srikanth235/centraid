import Foundation
#if canImport(Photos)
import Photos
#endif

import CentraidShared

// FREE UP SPACE'S HAND ON THE PHOTO LIBRARY (#1080 A19, A20).
//
// The core never deletes from the library; this file is the one place on iOS
// that does, and only behind Photos' own confirmation:
// `PHAssetChangeRequest.deleteAssets` inside `performChanges` raises the
// system's alert, which counts what goes and deletes on a yes. What the
// member reads and agrees to is the platform's sentence, not this app's.
//
// Three rules this file keeps, each with its reason:
//
// 1. **AN ASSET GOES WHOLE, OR NOT AT ALL.** A Live Photo is two rows in the
//    vault: the still under the asset's `localIdentifier`, and its movie under
//    the same identifier plus `#pairedVideo` (`LibraryRefs.PAIRED_VIDEO`, which
//    this file must spell the same way). Deleting the asset deletes both, so a
//    Live Photo goes only when the core offered both rows, and an asset never
//    goes on its movie's row alone.
// 2. **AN EDITED ASSET GOES ONLY WHEN THE GATEWAY HAS THE VERSION THE LIBRARY
//    HOLDS NOW** (A20(3)). The rendition's ref names the `modificationDate` it
//    was read at (`<identifier>#r<millis>`); an asset with `hasAdjustments` is
//    released only when one of the offered refs names the version now. An edit
//    made since the backup, or any change that moved the date and was not
//    walked in yet, leaves the asset where it is: the gateway then holds the
//    render before it, and deleting would lose the edit. An asset that is not
//    edited now goes on the camera's own row: its bare identifier, or its
//    `#camera` row when the member reverted an edit. This replaces the blanket
//    `hasAdjustments` keep; the camera original the edit sits on is a row of
//    its own in the vault, so what an edit replaced is not lost either.
// 3. **WHAT IS REPORTED IS WHAT THIS REQUEST REMOVED.** On a yes every asset
//    in the request is gone, and the hashes reported are exactly its rows. The
//    member's no is `declined`; any other failure is `error`, with nothing
//    reported deleted. An offered asset the library no longer shows — deleted
//    in Photos meanwhile, or outside a limited selection — is not reported:
//    its absence is not proof that this request removed it.
//
// Nothing here mirrors a deletion INTO the vault (R-1127-4): the vault is the
// photograph's backup, and this is only the member's own Free up space.

/// The pure half, so a test can show each rule refuse without the library.
/// Its ref spellings are `LibraryRefs` (commonMain), restated.
enum LibraryDeletion {
    /// `LibraryRefs.PAIRED_VIDEO`: the suffix a Live Photo's movie row carries.
    static let pairedVideoSuffix = "#pairedVideo"
    /// `LibraryRefs.CAMERA`: the camera's own file under an edit.
    static let cameraSuffix = "#camera"
    /// `LibraryRefs`' rendition marker: `<identifier>#r<millis>`.
    static let renditionMarker = "#r"

    /// The asset an `os_ref` names: everything before the first `#`.
    static func assetIdentifier(of ref: String) -> String {
        ref.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ref
    }

    /// The version a rendition's ref was read at, or nil for any other ref.
    static func witness(of ref: String) -> Int64? {
        guard let marker = ref.range(of: renditionMarker) else { return nil }
        return Int64(ref[marker.upperBound...])
    }

    /// `modificationDate` as `IosMediaLibrary` writes it into a ref: epoch
    /// milliseconds, truncated; a missing date reads as zero.
    static func modifiedMillis(_ date: Date?) -> Int64 {
        guard let date else { return 0 }
        return Int64(date.timeIntervalSince1970 * 1_000.0)
    }

    /// RULES 1 AND 2: whether the asset [identifier] may be deleted, given the
    /// rows the core offered, whether it is edited now, the version it is at
    /// now ([modified], see [modifiedMillis]), and whether it is live.
    static func mayDelete(identifier: String, offered: Set<String>, edited: Bool, modified: Int64, live: Bool) -> Bool {
        let mine = offered.filter { assetIdentifier(of: $0) == identifier }
        let stills = mine.filter { !$0.hasSuffix(pairedVideoSuffix) }
        guard !stills.isEmpty else { return false }
        if edited {
            guard stills.contains(where: { witness(of: $0) == modified }) else { return false }
        } else {
            guard stills.contains(identifier) || stills.contains(identifier + cameraSuffix) else { return false }
        }
        return !live || mine.contains(identifier + pairedVideoSuffix)
    }

/// What a finished request came to.
    enum Answer: Equatable {
        case deleted
        case declined
        /// The platform's own words, or nil when it gave none.
        case failed(String?)
    }

    /// RULE 3. The member's no is PhotoKit's `userCancelled`, or Cocoa's
    /// `NSUserCancelledError` on an older path; both are code 3072.
    static func answer(success: Bool, error: Swift.Error?) -> Answer {
        if success { return .deleted }
        guard let error else { return .failed(nil) }
        let failure = error as NSError
        #if canImport(Photos)
        if failure.domain == PHPhotosError.errorDomain, failure.code == PHPhotosError.Code.userCancelled.rawValue {
            return .declined
        }
        #endif
        if failure.domain == NSCocoaErrorDomain, failure.code == NSUserCancelledError {
            return .declined
        }
        return .failed(failure.localizedDescription)
    }
}

#if canImport(Photos)
/// THE KOTLIN-VISIBLE HALF (seam contract A20): `LibraryDeleter` is
/// `commonMain`'s interface and this is its iOS implementation, installed once
/// through `HomeBridge.installLibraryDeleter` (`ShellModel.init`).
final class PhotoLibraryDeleter: NSObject, LibraryDeleter {
    /// Photos confirms every deletion itself; a library this app may not
    /// change offers nothing to free.
    func capability() -> DeleteCapability {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .authorized, .limited:
            return DeleteCapability.systemConfirmation
        default:
            return DeleteCapability.none
        }
    }

    func delete(items: [ReleasableItem], done: @escaping (DeleteOutcome) -> Void) {
        let offered = Set(items.map(\.osRef))
        let identifiers = Array(Set(offered.map { LibraryDeletion.assetIdentifier(of: $0) }))
        var doomed: [PHAsset] = []
        var going: Set<String> = []
        PHAsset.fetchAssets(withLocalIdentifiers: identifiers, options: nil).enumerateObjects { asset, _, _ in
            let allowed = LibraryDeletion.mayDelete(
                identifier: asset.localIdentifier,
                offered: offered,
                edited: asset.hasAdjustments,
                modified: LibraryDeletion.modifiedMillis(asset.modificationDate),
                live: asset.mediaSubtypes.contains(.photoLive)
            )
            guard allowed else { return }
            doomed.append(asset)
            going.insert(asset.localIdentifier)
        }
        // NOTHING TO ASK ABOUT asks nothing: no alert for zero items.
        guard !doomed.isEmpty else {
            done(DeleteOutcome(deleted: [], declined: false, error: nil))
            return
        }
        let assets = doomed as NSArray
        let removing = going
        PHPhotoLibrary.shared().performChanges({
            PHAssetChangeRequest.deleteAssets(assets)
        }, completionHandler: { success, error in
            switch LibraryDeletion.answer(success: success, error: error) {
            case .deleted:
                let gone = items.filter { removing.contains(LibraryDeletion.assetIdentifier(of: $0.osRef)) }
                done(DeleteOutcome(deleted: gone.map(\.contentHash), declined: false, error: nil))
            case .declined:
                done(DeleteOutcome(deleted: [], declined: true, error: nil))
            case let .failed(words):
                done(DeleteOutcome(deleted: [], declined: false, error: words))
            }
        })
    }
}
#endif
