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
        XCTAssertEqual(fixtures.count, 18)
        for fixture in fixtures {
            let binary = try XCTUnwrap(fixture["binary"] as? String)
            let name = String(binary.dropFirst("contracts/screens/".count).dropLast(".bin".count))
            XCTAssertNoThrow(try bytes(name), "\(name) is listed and missing")
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
