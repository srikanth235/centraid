import Foundation
#if canImport(Photos)
import Photos
#endif

#if canImport(CentraidShared)
import CentraidShared
#endif

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
//    the same identifier plus `#pairedVideo` (`IosMediaLibrary`'s
//    `PAIRED_VIDEO`, which this file must spell the same way). Deleting the
//    asset deletes both, so a Live Photo goes only when the core offered both
//    rows, and an asset never goes on its movie's row alone.
// 2. **AN ASSET EDITED SINCE IT WAS BACKED UP IS KEPT.** The core never offers
//    an asset it staged as edited (A20), but the member may have edited one
//    since: the gateway then holds the rendition before the edit, and deleting
//    would lose the edit. `hasAdjustments` is read here, at deletion time.
// 3. **WHAT IS REPORTED IS WHAT THIS REQUEST REMOVED.** On a yes every asset
//    in the request is gone, and the hashes reported are exactly its rows. The
//    member's no is `declined`; any other failure is `error`, with nothing
//    reported deleted. An offered asset the library no longer shows — deleted
//    in Photos meanwhile, or outside a limited selection — is not reported:
//    its absence is not proof that this request removed it.

/// The pure half, so a test can show each rule refuse without the library.
enum LibraryDeletion {
    /// `IosMediaLibrary`'s `PAIRED_VIDEO`: the suffix a Live Photo's movie row carries.
    static let pairedVideoSuffix = "#pairedVideo"

    /// The asset an `os_ref` names: the identifier, with a movie's suffix removed.
    static func assetIdentifier(of ref: String) -> String {
        ref.hasSuffix(pairedVideoSuffix) ? String(ref.dropLast(pairedVideoSuffix.count)) : ref
    }

    /// RULES 1 AND 2: whether the asset [identifier] may be deleted, given the
    /// rows the core offered, whether it is edited now, and whether it is live.
    static func mayDelete(identifier: String, offered: Set<String>, edited: Bool, live: Bool) -> Bool {
        guard !edited, offered.contains(identifier) else { return false }
        return !live || offered.contains(identifier + pairedVideoSuffix)
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
    static func answer(success: Bool, error: Error?) -> Answer {
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

#if canImport(CentraidShared) && canImport(Photos)
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
