import Foundation
import Photos
import XCTest

@testable import CentraidApp

/// FREE UP SPACE'S PURE HALF (#1080 A19, A20).
///
/// Which assets the iOS deleter may hand to Photos, and what a finished
/// request meant — without the library. Each rule has its NEGATIVE case: an
/// edited asset, a Live Photo without its movie and a movie row alone are all
/// kept, because a gate shown only green is a gate nobody saw refuse. The
/// system's alert and the deletion itself are device hand-offs
/// (`docs/release/v1-handoffs.md`, section 8).
final class LibraryDeletionTests: XCTestCase {
    private let still = "6C1E9C2B-1F0A-4E7B-9B21-3D1A2F0C8E11/L0/001"

    func testAPhotoTheCoreOfferedMayGo() {
        XCTAssertTrue(LibraryDeletion.mayDelete(identifier: still, offered: [still], edited: false, live: false))
    }

    func testAnAssetEditedSinceItWasBackedUpIsKept() {
        XCTAssertFalse(LibraryDeletion.mayDelete(identifier: still, offered: [still], edited: true, live: false))
    }

    func testALivePhotoGoesOnlyWithItsMovie() {
        let movie = still + LibraryDeletion.pairedVideoSuffix
        XCTAssertTrue(LibraryDeletion.mayDelete(identifier: still, offered: [still, movie], edited: false, live: true))
        XCTAssertFalse(LibraryDeletion.mayDelete(identifier: still, offered: [still], edited: false, live: true))
    }

    func testAMovieRowAloneNeverDeletesItsAsset() {
        let movie = still + LibraryDeletion.pairedVideoSuffix
        XCTAssertFalse(LibraryDeletion.mayDelete(identifier: still, offered: [movie], edited: false, live: true))
        XCTAssertFalse(LibraryDeletion.mayDelete(identifier: still, offered: [], edited: false, live: false))
    }

    func testARefNamesItsAsset() {
        XCTAssertEqual(LibraryDeletion.assetIdentifier(of: still), still)
        XCTAssertEqual(LibraryDeletion.assetIdentifier(of: still + LibraryDeletion.pairedVideoSuffix), still)
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
