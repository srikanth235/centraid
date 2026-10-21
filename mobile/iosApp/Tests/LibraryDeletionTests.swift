import Foundation
import Photos
import XCTest

@testable import CentraidApp

/// FREE UP SPACE'S PURE HALF (#1080 A19, A20; #1127).
///
/// Which assets the iOS deleter may hand to Photos, and what a finished
/// request meant — without the library. Each rule has its NEGATIVE case: an
/// asset edited after its backup, a Live Photo without its movie and a movie
/// row alone are all kept, because a gate shown only green is a gate nobody saw
/// refuse. The system's alert and the deletion itself are device hand-offs
/// (`docs/release/v1-handoffs.md`, section 8).
final class LibraryDeletionTests: XCTestCase {
    private let still = "6C1E9C2B-1F0A-4E7B-9B21-3D1A2F0C8E11/L0/001"

    private func mayDelete(
        _ offered: Set<String>,
        edited: Bool = false,
        modified: Int64 = 0,
        live: Bool = false
    ) -> Bool {
        LibraryDeletion.mayDelete(identifier: still, offered: offered, edited: edited, modified: modified, live: live)
    }

    func testAPhotoTheCoreOfferedMayGo() {
        XCTAssertTrue(mayDelete([still]))
    }

    func testAnEditedAssetGoesOnlyWhenTheGatewayHasTheVersionTheLibraryHoldsNow() {
        let backedUp = still + "#r1760000000123"
        let camera = still + LibraryDeletion.cameraSuffix
        XCTAssertTrue(mayDelete([camera, backedUp], edited: true, modified: 1_760_000_000_123))
        // EDITED AGAIN SINCE: the library is at a version no ref names.
        XCTAssertFalse(mayDelete([camera, backedUp], edited: true, modified: 1_760_000_999_000))
        // EDITED AFTER A BACKUP THAT SAW IT UNEDITED: only the bare ref exists.
        XCTAssertFalse(mayDelete([still], edited: true, modified: 1_760_000_000_123))
        XCTAssertFalse(mayDelete([camera], edited: true, modified: 1_760_000_000_123))
    }

    func testTheLatestOfSeveralRenditionsIsTheOneThatCounts() {
        let first = still + "#r100"
        let second = still + "#r200"
        XCTAssertTrue(mayDelete([first, second], edited: true, modified: 200))
        XCTAssertFalse(mayDelete([first, second], edited: true, modified: 300))
    }

    func testAnEditRevertedGoesOnTheCamerasOwnRowOnly() {
        let camera = still + LibraryDeletion.cameraSuffix
        let rendition = still + "#r100"
        XCTAssertTrue(mayDelete([camera, rendition], edited: false))
        // THE CAMERA'S FILE WAS NEVER BACKED UP: what the library holds now is not on the gateway.
        XCTAssertFalse(mayDelete([rendition], edited: false))
    }

    func testALivePhotoGoesOnlyWithItsMovie() {
        let movie = still + LibraryDeletion.pairedVideoSuffix
        XCTAssertTrue(mayDelete([still, movie], live: true))
        XCTAssertFalse(mayDelete([still], live: true))
        let rendition = still + "#r100"
        XCTAssertTrue(mayDelete([rendition, movie], edited: true, modified: 100, live: true))
        XCTAssertFalse(mayDelete([rendition], edited: true, modified: 100, live: true))
    }

    func testAMovieRowAloneNeverDeletesItsAsset() {
        let movie = still + LibraryDeletion.pairedVideoSuffix
        XCTAssertFalse(mayDelete([movie], live: true))
        XCTAssertFalse(mayDelete([], live: false))
    }

    func testARefNamesItsAssetItsPartAndItsVersion() {
        XCTAssertEqual(LibraryDeletion.assetIdentifier(of: still), still)
        XCTAssertEqual(LibraryDeletion.assetIdentifier(of: still + LibraryDeletion.pairedVideoSuffix), still)
        XCTAssertEqual(LibraryDeletion.assetIdentifier(of: still + LibraryDeletion.cameraSuffix), still)
        XCTAssertEqual(LibraryDeletion.assetIdentifier(of: still + "#r1760000000123"), still)
        XCTAssertEqual(LibraryDeletion.witness(of: still + "#r1760000000123"), 1_760_000_000_123)
        XCTAssertNil(LibraryDeletion.witness(of: still))
        XCTAssertNil(LibraryDeletion.witness(of: still + LibraryDeletion.cameraSuffix))
        XCTAssertNil(LibraryDeletion.witness(of: still + LibraryDeletion.pairedVideoSuffix))
    }

    func testTheVersionIsSpelledTheWayTheWalkerSpellsIt() {
        // `IosMediaLibrary.modifiedMillisOf`: seconds * 1000, truncated.
        XCTAssertEqual(LibraryDeletion.modifiedMillis(Date(timeIntervalSince1970: 1_760_000_000.5)), 1_760_000_000_500)
        XCTAssertEqual(LibraryDeletion.modifiedMillis(nil), 0)
    }

    func testAYesIsDeletedANoIsDeclinedAndAnythingElseFails() {
        XCTAssertEqual(LibraryDeletion.answer(success: true, error: nil), .deleted)
        let cancelled = NSError(domain: PHPhotosError.errorDomain, code: PHPhotosError.Code.userCancelled.rawValue)
        XCTAssertEqual(LibraryDeletion.answer(success: false, error: cancelled), .declined)
        let cocoa = NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError)
        XCTAssertEqual(LibraryDeletion.answer(success: false, error: cocoa), .declined)
        let denied = NSError(domain: PHPhotosError.errorDomain, code: PHPhotosError.Code.accessUserDenied.rawValue)
        XCTAssertEqual(LibraryDeletion.answer(success: false, error: denied), .failed(denied.localizedDescription))
        XCTAssertEqual(LibraryDeletion.answer(success: false, error: nil), .failed(nil))
    }
}
