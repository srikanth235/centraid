import Foundation
import XCTest

// The generated `Centraid_Screen_V1_*` types are compiled into the app
// target, so the test has to import it to see them (#1020).
@testable import CentraidApp

/// THE OTHER HALF OF "ONE FIXTURE, TWO LANGUAGES" (#1020, D-1020-E3).
///
/// `mobile/shared/src/jvmTest/.../ScreenFixtureSpec.kt` decodes
/// `contracts/screens/**.bin` with Wire and asserts the screen laws. **This
/// file decodes the same bytes with SwiftProtobuf and asserts the same laws**,
/// because a fixture each is two fixtures.
///
/// ## THIS TEST HAS NEVER RUN
///
/// There is no Xcode and no simulator on the machines that run
/// `cargo xtask gate`. It is an **owner hand-off**, and the exact command is in
/// `mobile/README.md`:
///
///     cd mobile/iosApp && swift test
///
/// It is written as a complete test rather than a sketch so the hand-off is an
/// invocation and not a porting job. What it needs first is
/// `protoc-gen-swift` over `crates/api-proto/proto` (see `Sources/StateViews.swift`).
///
/// Reporting this as a passing test would be the single most misleading thing
/// this lane could do, so the receipt names it in the owner hand-offs and
/// nowhere else.
final class ScreenFixtureTests: XCTestCase {
    /// `contracts/screens`, found from this file rather than from a working
    /// directory: `swift test` and Xcode disagree about the latter.
    private var screens: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // iosApp
            .deletingLastPathComponent()   // mobile
            .deletingLastPathComponent()   // the repo root
            .appendingPathComponent("contracts/screens")
    }

    private func bytes(_ fixture: String) throws -> Data {
        try Data(contentsOf: screens.appendingPathComponent("\(fixture).bin"))
    }

    /// THE MANIFEST IS THE LIST. A fixture added without regenerating it is a
    /// fixture this test never sees, which is exactly what the Kotlin side
    /// asserts from its end.
    func testManifestAndDirectoryAgree() throws {
        let manifest = try Data(contentsOf: screens.appendingPathComponent("manifest.json"))
        let decoded = try JSONSerialization.jsonObject(with: manifest) as? [String: Any]
        let fixtures = decoded?["fixtures"] as? [[String: Any]] ?? []
        XCTAssertEqual(fixtures.count, 26)
        for fixture in fixtures {
            let binary = try XCTUnwrap(fixture["binary"] as? String)
            let name = String(binary.dropFirst("contracts/screens/".count).dropLast(".bin".count))
            XCTAssertNoThrow(try bytes(name), "\(name) is listed and missing")
        }
    }

    /// The law, from the Swift side: an empty ledger and a refused read must
    /// not decode to the same screen.
    func testEmptyLedgerAndRefusedReadAreDifferentScreens() throws {
        let empty = try Centraid_Screen_V1_TallyListState(
            serializedBytes: try bytes("tally/empty-ledger")
        )
        let refused = try Centraid_Screen_V1_TallyListState(
            serializedBytes: try bytes("tally/refused-denied")
        )

        // `data` present with no rows IS an answer.
        XCTAssertEqual(empty.content, .data(Centraid_Screen_V1_TallyListData()))
        XCTAssertTrue(empty.data.rows.isEmpty)

        // A refusal has no data at all, and carries the access plane's
        // sentence rather than its predicate.
        guard case let .failure(failure) = refused.content else {
            return XCTFail("a refused read decodes to the failure case")
        }
        XCTAssertEqual(failure.kind, .refused)
        XCTAssertEqual(failure.sentence, "This is not shared with you.")
        XCTAssertNotEqual(empty, refused)
    }

    /// Money carries its own exponent and locale. JPY at exponent 0 is the row
    /// that breaks a renderer that divides minor units by 100 unconditionally,
    /// which is v0's bug (`packages/design/src/format.ts:38`).
    func testMoneyCarriesItsOwnExponentAndLocale() throws {
        let state = try Centraid_Screen_V1_TallyListState(
            serializedBytes: try bytes("tally/data-page")
        )
        let yen = try XCTUnwrap(state.data.rows.first { $0.amount.currency == "JPY" })
        XCTAssertEqual(yen.amount.exponent, 0)
        XCTAssertEqual(yen.amount.locale, "ja-JP")
        let dollars = try XCTUnwrap(state.data.rows.first { $0.amount.currency == "USD" })
        XCTAssertEqual(dollars.amount.exponent, 2)
        // A keyset cursor: the sort key and the primary key, never an offset.
        XCTAssertTrue(state.data.nextCursor.contains("|"))
    }

    /// A denied photo grant must not blank a library the member already owns.
    func testDeniedPhotoPermissionKeepsTheGridFull() throws {
        let state = try Centraid_Screen_V1_PhotosGridState(
            serializedBytes: try bytes("photos/permission-denied")
        )
        XCTAssertEqual(state.permission, .denied)
        XCTAssertEqual(state.data.cells.count, 1)
        XCTAssertEqual(state.backup.phase, .idle)
        XCTAssertTrue(state.backup.pausedReason.contains("Settings"))
    }

    /// iOS's limited selection is a first-class state.
    func testLimitedSelectionIsNeitherEmptyNorDenied() throws {
        let state = try Centraid_Screen_V1_PhotosGridState(
            serializedBytes: try bytes("photos/limited-selection")
        )
        XCTAssertEqual(state.permission, .limited)
        XCTAssertEqual(state.backup.phase, .transferring)
        XCTAssertEqual(state.backup.transport, .irohBlobs)
        // A Live Photo's still and its paired movie share one capture group.
        XCTAssertFalse(state.data.cells[0].captureGroupID.isEmpty)
    }

    /// `more` is a sheet, never a destination.
    func testMoreIsASheet() throws {
        let state = try Centraid_Screen_V1_PhotosGridState(
            serializedBytes: try bytes("photos/more-sheet-open")
        )
        XCTAssertEqual(state.sheet, .more)
        XCTAssertEqual(state.destination, .library)
    }

    /// A refused SAVE keeps the words; a refused READ does not.
    func testARefusedSaveKeepsTheEditor() throws {
        let saveRefused = try Centraid_Screen_V1_NotesEditorState(
            serializedBytes: try bytes("notes/save-refused")
        )
        XCTAssertEqual(saveRefused.draft.body, "Book the cabin.")
        XCTAssertEqual(saveRefused.save, .refused)
        XCTAssertEqual(saveRefused.draft.saveFailure.kind, .unavailable)

        let readRefused = try Centraid_Screen_V1_NotesEditorState(
            serializedBytes: try bytes("notes/read-refused")
        )
        guard case .failure = readRefused.content else {
            return XCTFail("a refused read replaces the editor")
        }
    }

    /// "The platform would not say" is not "offline".
    func testPlatformRefusedIsNotOffline() throws {
        let refusedToSay = try Centraid_Screen_V1_SeatState(
            serializedBytes: try bytes("seat/platform-refused-to-say")
        )
        let waiting = try Centraid_Screen_V1_SeatState(
            serializedBytes: try bytes("seat/waiting-for-mount")
        )
        XCTAssertEqual(refusedToSay.connectivity, .unknownPlatformRefused)
        XCTAssertEqual(waiting.connectivity, .offline)
        XCTAssertNotEqual(refusedToSay.connectivity, waiting.connectivity)
        XCTAssertEqual(refusedToSay.pending.queuedUploads, 41)
    }

    /// The sweep: no fixture may carry both a failure and data.
    func testEveryFixtureSetsAtMostOneContentState() throws {
        for fixture in ["loading-first", "data-page", "empty-ledger", "refused-denied",
                        "low-disk-parked", "offline-withheld"] {
            let state = try Centraid_Screen_V1_TallyListState(
                serializedBytes: try bytes("tally/\(fixture)")
            )
            XCTAssertNotNil(state.content, "\(fixture) sets exactly one content case")
        }
    }

    // MARK: - Home, the graded springboard

    private func home(_ case_: String) throws -> Centraid_Screen_V1_HomeState {
        try Centraid_Screen_V1_HomeState(serializedBytes: try bytes("home/\(case_)"))
    }

    /// THE FOURTH READ STATE, and the reason Home has one.
    ///
    /// Both of these show eight tiles with no content. Only one of them may say
    /// the vault is empty, and it is the one whose reads LANDED.
    func testUnreadableSpringboardIsNotAFirstRun() throws {
        let unreadable = try home("every-tile-unreadable")
        let firstRun = try home("first-run")

        XCTAssertTrue(unreadable.data.everyTileUnreadable)
        XCTAssertEqual(unreadable.data.springboard, .content)
        XCTAssertTrue(unreadable.data.tiles.allSatisfy { $0.status == .unknown })

        XCTAssertEqual(firstRun.data.springboard, .firstRun)
        XCTAssertFalse(firstRun.data.everyTileUnreadable)

        XCTAssertNotEqual(unreadable.data.springboard, firstRun.data.springboard)
    }

    /// A withheld count is ABSENT, never zero — and the vault total omits it.
    func testWithheldCountIsAbsentAndNotZero() throws {
        let content = try home("content")
        let locker = try XCTUnwrap(content.data.tiles.first { $0.appID == "locker" })
        XCTAssertEqual(locker.status, .content)
        // `hasCount` is the whole point: a `0` here would be a lie about how
        // many secrets a member holds.
        XCTAssertFalse(locker.hasCount)
        // 1284 + 42 + 7, with Locker contributing nothing at all.
        XCTAssertEqual(content.data.things.total, 1333)
    }

    func testCappedCountIsOnlyAFloor() throws {
        let things = try home("status-urgent").data.things
        XCTAssertTrue(things.capped)
        XCTAssertEqual(things.total, 500)
    }

    /// An asset whose bytes are not addressable yet is STILL A CELL: dropping
    /// the row would reflow ten photos as one blank under a "10".
    func testUnaddressablePhotoIsStillACell() throws {
        let photos = try XCTUnwrap(
            try home("content").data.tiles.first { $0.appID == "photos" }
        )
        let cells = photos.body.photos.cells
        XCTAssertEqual(cells.count, 3)
        XCTAssertFalse(try XCTUnwrap(cells.last).hasThumbnailPath)
    }

    /// Locker's body is a STATE and not a query result, so it always has
    /// something true to say and is never an invitation to fill it.
    func testLockerEarnsTheGridWhileEmpty() throws {
        let locker = try XCTUnwrap(
            try home("first-run").data.tiles.first { $0.appID == "locker" }
        )
        XCTAssertEqual(locker.status, .empty)
        XCTAssertTrue(locker.earnsGrid)
    }

    func testLoadingSpringboardReportsItsTotalUnsettled() throws {
        let loading = try home("loading-first").data
        XCTAssertEqual(loading.springboard, .loading)
        XCTAssertFalse(loading.things.settled)
        // A read in flight holds its slot at full geometry.
        XCTAssertTrue(loading.tiles.allSatisfy { $0.earnsGrid })
    }

    /// Distinct from every tile being unreadable: that Home loaded and could not
    /// read its apps; this one could not load, so it invents no apps.
    func testARefusedHomeHasNoGridAtAll() throws {
        let refused = try home("read-refused")
        // The oneof itself, not a `has` flag: this proves the state carries a
        // failure AND carries no grid, which two separate assertions would not.
        guard case let .failure(failure) = refused.content else {
            return XCTFail("a refused Home decodes to the failure case")
        }
        XCTAssertEqual(failure.kind, .noCopyYet)
    }

    func testAllAppsSheetLeavesTheHomeUnderneathIntact() throws {
        let sheet = try home("all-apps-open")
        XCTAssertTrue(sheet.allAppsSheetOpen)
        XCTAssertEqual(sheet.data.tiles.count, 8)
    }
}
