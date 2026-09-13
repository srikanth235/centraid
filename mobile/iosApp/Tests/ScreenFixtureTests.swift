import Foundation
import XCTest

/// THE OTHER HALF OF "ONE FIXTURE, TWO LANGUAGES" (#1020, D-1020-E3).
///
/// `mobile/shared/src/jvmTest/.../ScreenFixtureSpec.kt` decodes
/// `contracts/screens/**.bin` with Wire and asserts the screen laws. **This
/// file decodes the same bytes with SwiftProtobuf and asserts the same laws**,
/// which is the pattern v0 already uses for its tunnel wire format
/// (`apps/mobile/modules/centraid-tunnel/.../TunnelWireConformanceTest.kt` and
/// `ios/Tests/TunnelWireConformanceTests.swift` over one golden file) and the
/// reason is the same: a fixture each is two fixtures.
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
        XCTAssertEqual(fixtures.count, 19)
        for fixture in fixtures {
            let binary = try XCTUnwrap(fixture["binary"] as? String)
            let name = String(binary.dropFirst("contracts/screens/".count).dropLast(".bin".count))
            XCTAssertNoThrow(try bytes(name), "\(name) is listed and missing")
        }
    }

    /// The law, from the Swift side: an empty ledger and a refused read must
    /// not decode to the same screen.
    func testEmptyLedgerAndRefusedReadAreDifferentScreens() throws {
        let empty = try Centraid_screen_v1_TallyListState(
            serializedBytes: try bytes("tally/empty-ledger")
        )
        let refused = try Centraid_screen_v1_TallyListState(
            serializedBytes: try bytes("tally/refused-denied")
        )

        // `data` present with no rows IS an answer.
        XCTAssertEqual(empty.content, .data(Centraid_screen_v1_TallyListData()))
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
        let state = try Centraid_screen_v1_TallyListState(
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
        let state = try Centraid_screen_v1_PhotosGridState(
            serializedBytes: try bytes("photos/permission-denied")
        )
        XCTAssertEqual(state.permission, .denied)
        XCTAssertEqual(state.data.cells.count, 1)
        XCTAssertEqual(state.backup.phase, .idle)
        XCTAssertTrue(state.backup.pausedReason.contains("Settings"))
    }

    /// iOS's limited selection is a first-class state.
    func testLimitedSelectionIsNeitherEmptyNorDenied() throws {
        let state = try Centraid_screen_v1_PhotosGridState(
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
        let state = try Centraid_screen_v1_PhotosGridState(
            serializedBytes: try bytes("photos/more-sheet-open")
        )
        XCTAssertEqual(state.sheet, .more)
        XCTAssertEqual(state.destination, .library)
    }

    /// A refused SAVE keeps the words; a refused READ does not.
    func testARefusedSaveKeepsTheEditor() throws {
        let saveRefused = try Centraid_screen_v1_NotesEditorState(
            serializedBytes: try bytes("notes/save-refused")
        )
        XCTAssertEqual(saveRefused.draft.body, "Book the cabin.")
        XCTAssertEqual(saveRefused.save, .refused)
        XCTAssertEqual(saveRefused.draft.saveFailure.kind, .unavailable)

        let readRefused = try Centraid_screen_v1_NotesEditorState(
            serializedBytes: try bytes("notes/read-refused")
        )
        guard case .failure = readRefused.content else {
            return XCTFail("a refused read replaces the editor")
        }
    }

    /// "The platform would not say" is not "offline".
    func testPlatformRefusedIsNotOffline() throws {
        let refusedToSay = try Centraid_screen_v1_SeatState(
            serializedBytes: try bytes("seat/platform-refused-to-say")
        )
        let waiting = try Centraid_screen_v1_SeatState(
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
            let state = try Centraid_screen_v1_TallyListState(
                serializedBytes: try bytes("tally/\(fixture)")
            )
            XCTAssertNotNil(state.content, "\(fixture) sets exactly one content case")
        }
    }
}
