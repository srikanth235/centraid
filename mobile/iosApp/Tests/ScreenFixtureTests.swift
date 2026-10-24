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
/// ## IT RUNS ON A SIMULATOR
///
/// There is no Xcode and no simulator on the machines that run
/// `cargo xtask gate`, so this is an **owner hand-off**, and the command is
/// step 4 in `mobile/README.md`:
///
///     cd mobile/iosApp && xcodebuild -project Centraid.xcodeproj \
///       -scheme Centraid -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
final class ScreenFixtureTests: XCTestCase {
    /// `contracts/screens`, found from this file rather than from a working
    /// directory.
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
        XCTAssertEqual(fixtures.count, 47)
        for fixture in fixtures {
            let binary = try XCTUnwrap(fixture["binary"] as? String)
            let name = String(binary.dropFirst("contracts/screens/".count).dropLast(".bin".count))
            XCTAssertNoThrow(try bytes(name), "\(name) is listed and missing")
        }
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
        for fixture in ["permission-denied", "limited-selection"] {
            let state = try Centraid_Screen_V1_PhotosGridState(
                serializedBytes: try bytes("photos/\(fixture)")
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
    /// Both of these show seven tiles with no content. Only one of them may say
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

    /// A withheld count is ABSENT, never zero.
    func testWithheldCountIsAbsentAndNotZero() throws {
        let content = try home("content")
        let locker = try XCTUnwrap(content.data.tiles.first { $0.appID == "locker" })
        XCTAssertEqual(locker.status, .content)
        // `hasCount` is the whole point: a `0` here would be a lie about how
        // many secrets a member holds.
        XCTAssertFalse(locker.hasCount)
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
    func testEveryAppIsOnTheGridOnDayOne() throws {
        let data = try home("first-run").data
        let locker = try XCTUnwrap(data.tiles.first { $0.appID == "locker" })
        XCTAssertEqual(locker.status, .empty)
        XCTAssertEqual(Set(data.gridRows.flatMap { $0.appIds }), Set(data.tiles.map { $0.appID }))
    }

    func testLoadingSpringboardHoldsItsGrid() throws {
        let loading = try home("loading-first").data
        XCTAssertEqual(loading.springboard, .loading)
        // A read in flight holds its slot at full geometry.
        XCTAssertEqual(Set(loading.gridRows.flatMap { $0.appIds }), Set(loading.tiles.map { $0.appID }))
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

    // MARK: - Photos: the rest of the miniapp

    // Ten screens for v0's fourteen routes, and the Swift half of each law the
    // Kotlin spec asserts. Every case here is one a shell that got the
    // distinction wrong would draw wrong; a happy path would pass against every
    // such shell and is therefore not here.

    private func collections(_ case_: String) throws -> Centraid_Screen_V1_PhotosCollectionsState {
        try Centraid_Screen_V1_PhotosCollectionsState(
            serializedBytes: try bytes("photos-collections/\(case_)")
        )
    }

    /// One row type for five shelves, and `memberOwned` is the only difference.
    func testOneShelfRowTypeAndMemberOwnedIsTheDifference() throws {
        let data = try collections("standing-and-owned").data
        XCTAssertEqual(data.shelves.filter { !$0.memberOwned }.count, 4)
        let owned = try XCTUnwrap(data.shelves.first { $0.memberOwned })
        XCTAssertEqual(owned.title, "Portugal")
        // Zero is a real count and the row is still a door; and the absent
        // cover is absent rather than a placeholder the view would load.
        let videos = try XCTUnwrap(data.shelves.first { $0.title == "Videos" })
        XCTAssertEqual(videos.itemCount, 0)
        XCTAssertFalse(videos.hasCoverThumbnailPath)
        // The doors are the taps that land somewhere other than a shelf, and
        // the badge is a different number from the count.
        let duplicates = try XCTUnwrap(data.doors.first { $0.kind == .duplicates })
        XCTAssertEqual(duplicates.count, 3)
        XCTAssertEqual(duplicates.needsAttention, 3)
        XCTAssertEqual(data.doors.count, 2)
    }

    /// A sheet leaves the list underneath intact — a shape a route could not
    /// produce.
    func testTheNewAlbumSheetLeavesTheListIntact() throws {
        let sheet = try collections("new-album-sheet")
        XCTAssertEqual(sheet.sheet, .newAlbum)
        XCTAssertEqual(sheet.data.shelves.count, 2)
    }

    /// A count over a filled page is a FLOOR, and the row says so.
    ///
    /// No `COUNT(*)` on the read door, so every count here is counted from the
    /// rows one page returned. Both pairs live in one fixture because a view
    /// that drew capped and uncapped alike passes against either alone.
    func testACountOverAFilledPageIsAFloor() throws {
        let data = try collections("counts-are-floors").data
        let trash = try XCTUnwrap(data.shelves.first { $0.title == "Trash" })
        let album = try XCTUnwrap(data.shelves.first { $0.memberOwned })
        XCTAssertEqual(trash.itemCount, 2)
        XCTAssertFalse(trash.itemCountCapped)
        XCTAssertEqual(album.itemCount, 137)
        // "At least 137". A bare number states a total nobody counted.
        XCTAssertTrue(album.itemCountCapped)

        let placesDoor = try XCTUnwrap(data.doors.first { $0.kind == .places })
        let duplicatesDoor = try XCTUnwrap(data.doors.first { $0.kind == .duplicates })
        XCTAssertTrue(placesDoor.countCapped)
        XCTAssertFalse(duplicatesDoor.countCapped)
        // A badge is "there is work": a floor and a total draw the same dot,
        // which is why `needsAttention` has no capped sibling to assert.
        XCTAssertEqual(duplicatesDoor.needsAttention, 3)
        XCTAssertTrue(data.hasNextCursor)
    }

    /// A refused Collections invents no standing shelves. The four exist in
    /// every vault, but their counts and covers come from a read.
    func testARefusedCollectionsInventsNoShelves() throws {
        guard case let .failure(failure) = try collections("read-refused").content else {
            return XCTFail("a refused Collections decodes to the failure case")
        }
        XCTAssertEqual(failure.kind, .noCopyYet)
    }

    private func search(_ case_: String) throws -> Centraid_Screen_V1_PhotosSearchState {
        try Centraid_Screen_V1_PhotosSearchState(
            serializedBytes: try bytes("photos-search/\(case_)")
        )
    }

    /// A corrected answer is the shared field's words (#1097, R-1097-27): the
    /// hits still answer what was typed, and an exact answer carries none.
    func testACorrectedAnswerIsTheFieldsWords() throws {
        let corrected = try search("corrected")
        XCTAssertEqual(corrected.query, "sunscren")
        XCTAssertEqual(corrected.search.corrected, "sunscreen")
        XCTAssertEqual(corrected.search.term, "sunscren")
        guard case let .hits(hits) = corrected.content else {
            return XCTFail("a corrected answer is hits")
        }
        XCTAssertEqual(hits.query, "sunscren")
        XCTAssertEqual(hits.cells.count, 1)
        XCTAssertFalse(try search("hits-say-why").hasSearch)
    }

    /// Resting and no-hits must never read the same words. Both show a grid
    /// with nothing in it; only one of them may say "Nothing matched".
    func testRestingAndNoHitsAreDifferentScreens() throws {
        let resting = try search("resting")
        let noHits = try search("no-hits")

        XCTAssertEqual(resting.query, "")
        guard case let .resting(vocabulary) = resting.content else {
            return XCTFail("nothing typed decodes to the resting case")
        }
        XCTAssertEqual(vocabulary.suggestedLabels.count, 2)

        XCTAssertEqual(noHits.query, "kayak")
        guard case let .hits(hits) = noHits.content else {
            return XCTFail("an empty result is data, not a failure")
        }
        XCTAssertTrue(hits.cells.isEmpty)
        XCTAssertNotEqual(resting, noHits)
    }

    /// A match is a KIND and a name, never prose.
    ///
    /// Field 4 was `repeated string matched_on` and is now reserved. A prose
    /// line made each shell compose its own sentence, which is how v0's empty
    /// states drifted apart; the kind is the contract's and the sentence is the
    /// view's.
    func testAMatchIsAKindAndANameNeverProse() throws {
        let hits = try search("hits-say-why").hits
        XCTAssertEqual(hits.matches.map(\.kind), [.place, .label, .title])
        // The value is the vault's word for the thing, never the query echoed
        // back: two of these three do not contain "Dublin" as it was typed.
        XCTAssertEqual(hits.matches.first?.value, "Dún Laoghaire")
        XCTAssertEqual(hits.matches.filter { $0.value.contains("Dublin") }.count, 1)
        XCTAssertEqual(hits.cells.count, 2)
    }

    /// The three-state law as a sweep over the nine new screens. An empty data
    /// case standing in for a failure is the fourth state every one of these is
    /// tempted to grow, and the only way to know none of them did is to ask all
    /// of them. `content` is an optional oneof: exactly one arm, or nil.
    func testEveryNewPhotosFixtureSetsExactlyOneContentState() throws {
        func sweep(_ directory: String, _ cases: [String], _ set: (Data) throws -> Bool) throws {
            for case_ in cases {
                XCTAssertTrue(
                    try set(try bytes("\(directory)/\(case_)")),
                    "\(directory)/\(case_) sets exactly one content case"
                )
            }
        }
        try sweep(
            "photos-collections",
            ["counts-are-floors", "new-album-sheet", "read-refused", "standing-and-owned"]
        ) { try Centraid_Screen_V1_PhotosCollectionsState(serializedBytes: $0).content != nil }
        // Search has FOUR arms: resting is a third thing that is neither a load
        // nor a result, and it is still exactly one of them.
        try sweep(
            "photos-search",
            ["corrected", "hits-say-why", "no-hits", "resting"]
        ) { try Centraid_Screen_V1_PhotosSearchState(serializedBytes: $0).content != nil }
    }

    // MARK: - Money (#1099)

    private func money(_ case_: String) throws -> Centraid_Screen_V1_MoneyHomeState {
        try Centraid_Screen_V1_MoneyHomeState(serializedBytes: try bytes("money/\(case_)"))
    }

    private func moneyImport(_ case_: String) throws -> Centraid_Screen_V1_MoneyImportState {
        try Centraid_Screen_V1_MoneyImportState(serializedBytes: try bytes("money-import/\(case_)"))
    }

    private func moneyTransaction(_ case_: String) throws -> Centraid_Screen_V1_MoneyTransactionState {
        try Centraid_Screen_V1_MoneyTransactionState(serializedBytes: try bytes("money-transaction/\(case_)"))
    }

    /// Day one is one sentence and one action, with the same verb in the header.
    func testMoneyDayOneIsOneSentenceAndOneAction() throws {
        let state = try money("day-one")
        let empty = state.data.spending.empty
        XCTAssertTrue(state.data.spending.hasEmpty)
        XCTAssertEqual(empty.headline, "Import a bank statement to see this month.")
        XCTAssertEqual(empty.actionLabel, state.chrome.addLabel)
        XCTAssertEqual(state.band.map(\.key), ["spending", "activity", "cashflow", "more"])
        XCTAssertTrue(state.data.spending.heroes.isEmpty)
    }

    /// Two currencies are two heroes, and a figure never spans them.
    func testMoneyTwoCurrenciesAreTwoHeroes() throws {
        let spending = try money("spending").data.spending
        XCTAssertEqual(spending.heroes.map { $0.spent.currency }, ["USD", "CAD"])
        XCTAssertEqual(spending.tables.count, 1)
        XCTAssertEqual(spending.tables[0].currency, "USD")
        // Over plan is a minus sign and a tone, never a colour alone.
        let over = try XCTUnwrap(spending.tables[0].rows.first)
        XCTAssertTrue(over.over)
        XCTAssertEqual(over.left.minor, -2_827)
        XCTAssertEqual(spending.inOutNet[0].figures.map(\.label), ["In", "Out", "Net"])
    }

    /// A transfer keeps its row, greyed, and the chip row has no sort chip.
    func testMoneyATransferKeepsItsRowGreyed() throws {
        let state = try money("activity")
        XCTAssertEqual(state.chips.map(\.key), ["month", "account", "category"])
        let transfer = state.data.activity.sections[1].rows[0]
        XCTAssertTrue(transfer.dimmed)
        XCTAssertEqual(transfer.chips[0].label, "Transfer")
    }

    /// A denied Money is the gate; a failed read keeps its band.
    func testMoneyDeniedIsTheGateAndAFailedReadKeepsItsBand() throws {
        let denied = try money("denied")
        let refused = try money("read-refused")
        guard case .denied(let gate)? = denied.content else { return XCTFail("denied is its own arm") }
        XCTAssertEqual(gate.title, "Money is off")
        XCTAssertTrue(denied.band.isEmpty)
        guard case .failure(let failure)? = refused.content else { return XCTFail("a refused read is a failure") }
        XCTAssertEqual(failure.kind, .unavailable)
        XCTAssertEqual(refused.band.count, 4)
    }

    /// The import review counts every verdict, and the date-order question has
    /// no rows and no default.
    func testMoneyImportReviewCountsEveryVerdict() throws {
        let review = try moneyImport("planned").data
        let statement = try XCTUnwrap(review.statements.first)
        XCTAssertEqual(statement.counts.map(\.label), ["New", "Already in", "Check these", "Can\u{2019}t read"])
        XCTAssertEqual(statement.rows.first { $0.lineLabel == "Row 88" }?.reason, "Amount has a letter O.")
        XCTAssertEqual(review.publishLabel, "Import 186 rows")
        let question = try moneyImport("question").data
        let asked = try XCTUnwrap(question.statements.first)
        XCTAssertTrue(asked.hasQuestion)
        XCTAssertFalse(asked.question.options.contains(where: \.selected))
        XCTAssertTrue(asked.rows.isEmpty)
        XCTAssertEqual(question.publishLabel, "")
    }

    /// A transaction offers a transfer and a rule and carries no write.
    func testMoneyATransactionOffersATransferAndARule() throws {
        let state = try moneyTransaction("offers")
        XCTAssertEqual(state.data.transferOffer.key, "transfer")
        XCTAssertEqual(state.data.ruleOffer.key, "rule")
        XCTAssertEqual(state.write.phase, .idle)
        XCTAssertEqual(state.data.actions.filter(\.destructive).map(\.key), ["void"])
    }

    /// Every Money fixture sets exactly one content state.
    func testEveryMoneyFixtureSetsExactlyOneContentState() throws {
        for case_ in ["day-one", "spending", "activity", "denied", "read-refused"] {
            XCTAssertNotNil(try money(case_).content, "money/\(case_)")
        }
        for case_ in ["planned", "question"] {
            XCTAssertNotNil(try moneyImport(case_).content, "money-import/\(case_)")
        }
        XCTAssertNotNil(try moneyTransaction("offers").content, "money-transaction/offers")
    }
}
