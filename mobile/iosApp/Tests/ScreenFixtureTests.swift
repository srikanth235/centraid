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
/// ## IT RUNS NOW, AND ON A SIMULATOR
///
/// There is still no Xcode and no simulator on the machines that run
/// `cargo xtask gate`, so this is still an **owner hand-off** — but it is a
/// hand-off that has been cashed, and the command is step 4 in
/// `mobile/README.md`:
///
///     cd mobile/iosApp && xcodebuild -project Centraid.xcodeproj \
///       -scheme Centraid -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
///
/// This doc comment used to say "THIS TEST HAS NEVER RUN", and for longer than
/// it claimed: the command it named was `swift test`, which stopped being able
/// to build `Sources/` when #1020 landed unguarded UIKit imports in
/// `ShellModel` and `ContentImage`. UIKit is not a macOS framework and no
/// `#if canImport` guard conjures one, so the host build failed at dependency
/// scanning and this file was not merely unrun but **uncompiled**. Two fixes in
/// `project.yml` gave the Xcode test bundle an `Info.plist` and made its module
/// name agree with `Package.swift`'s, and all 17 laws below passed on the first
/// run that could ask them.
///
/// The photos port added eleven screens and thirty-four laws for them, written
/// here in the same pass that wrote the Kotlin half and NOT yet run: no
/// simulator step belonged to the lane that wrote them. They are a hand-off in
/// the same sense the file already was, and the command above is the one that
/// cashes it.
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
        XCTAssertEqual(fixtures.count, 63)
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

    // MARK: - Photos: the rest of the miniapp

    // Ten screens for v0's fourteen routes, and the Swift half of each law the
    // Kotlin spec asserts. Every case here is one a shell that got the
    // distinction wrong would draw wrong; a happy path would pass against every
    // such shell and is therefore not here.

    private func shelf(_ case_: String) throws -> Centraid_Screen_V1_PhotoShelfState {
        try Centraid_Screen_V1_PhotoShelfState(serializedBytes: try bytes("photos-shelf/\(case_)"))
    }

    /// ONLY trash carries a purge countdown.
    ///
    /// The field is on the one message that serves four of v0's routes, so the
    /// law is not "trash may show a countdown" but "no other shelf may".
    /// Asserting the trash case alone would pass against a shelf that filled
    /// the field for everything.
    func testOnlyTrashCarriesAPurgeCountdown() throws {
        let trash = try shelf("trash-states-its-window")
        guard case let .stateView(view) = trash.shelf.of, case let .mode(mode) = view.view else {
            return XCTFail("the trash shelf is a state view in mode form")
        }
        XCTAssertEqual(mode.kind, .trash)
        XCTAssertEqual(trash.purgeWindowDays, 30)
        for case_ in ["person", "album-selecting", "memory-empty-but-titled"] {
            XCTAssertEqual(try shelf(case_).purgeWindowDays, 0, "\(case_) may not state a window")
        }
    }

    /// The person arm brings its own name, and taking it means there is no mode
    /// to read — which is what a bag of optionals could not promise.
    func testThePersonArmBringsItsOwnName() throws {
        guard case let .stateView(view) = try shelf("person").shelf.of else {
            return XCTFail("a person shelf is a state view")
        }
        guard case let .person(person) = view.view else {
            return XCTFail("the person arm, not the mode arm")
        }
        XCTAssertEqual(person.personName, "Ada Lovelace")
    }

    /// A selection outlives the page it was made on: `ast-0204` is selected and
    /// is NOT in the loaded page, which is why the field is on the state. A
    /// selection carried on the cells is one the next page read drops.
    func testASelectionOutlivesThePageItWasMadeOn() throws {
        let album = try shelf("album-selecting")
        XCTAssertTrue(album.selecting)
        XCTAssertEqual(album.selectedAssetIds, ["ast-0201", "ast-0204"])
        let loaded = album.data.cells.map(\.assetID)
        XCTAssertFalse(loaded.contains("ast-0204"))
    }

    /// An empty shelf is DATA, and its head still has a title to draw.
    func testAnEmptyShelfIsDataAndStillHasATitle() throws {
        let memory = try shelf("memory-empty-but-titled")
        guard case let .data(data) = memory.content else {
            return XCTFail("an empty shelf decodes to the data case, never a failure")
        }
        XCTAssertTrue(data.cells.isEmpty)
        guard case let .memory(row) = memory.shelf.of else {
            return XCTFail("a memory shelf")
        }
        XCTAssertEqual(row.title, "Lisbon, April")
    }

    private func lightbox(_ case_: String) throws -> Centraid_Screen_V1_PhotoLightboxState {
        try Centraid_Screen_V1_PhotoLightboxState(
            serializedBytes: try bytes("photos-lightbox/\(case_)")
        )
    }

    /// The download arrow needs a DECISION and a HASH. `withheldByRule` is the
    /// one held state that carries it, and `seat.bytes.fetch` takes the hash.
    func testTheDownloadArrowNeedsADecisionAndAHash() throws {
        let withheld = try lightbox("withheld-by-rule")
        guard case let .detail(detail) = withheld.content else {
            return XCTFail("a loaded lightbox decodes to the detail case")
        }
        XCTAssertEqual(detail.held, .withheldByRule)
        XCTAssertEqual(detail.originalHash.count, 64)
        // Absent original, present thumbnail: the fallback, not an error.
        XCTAssertFalse(detail.hasOriginalPath)
        XCTAssertTrue(detail.hasThumbnailPath)
    }

    /// Chrome is a state, not an animation — and it is independent of the
    /// sheet. A shell that inferred one from the other would put the bars back
    /// the moment a sheet closed.
    func testChromeIsAStateAndNotTheSheet() throws {
        let hidden = try lightbox("chrome-hidden")
        XCTAssertFalse(hidden.chromeVisible)
        XCTAssertEqual(hidden.sheet, Centraid_Screen_V1_PhotoLightboxState.Sheet.none)
        XCTAssertTrue(try lightbox("withheld-by-rule").chromeVisible)
    }

    /// The facts panel names confirmed people only, and says which labels are
    /// guesses — the member's tag and a derivation's proposal are one list.
    func testTheFactsPanelSaysWhichLabelsAreGuesses() throws {
        let info = try lightbox("info-sheet-proposals")
        XCTAssertEqual(info.sheet, .info)
        XCTAssertEqual(info.detail.people.count, 1)
        XCTAssertEqual(info.detail.people[0].displayName, "Ada Lovelace")
        XCTAssertEqual(info.detail.labels.map(\.confirmed), [true, false])
    }

    /// The surface a member actually waits on can show a percentage.
    ///
    /// `fetchPercent` was absent from `PhotoDetail` for one draft, which put a
    /// number on the 120-cell grid and none here — and here is where it is
    /// felt: a member in the grid glances, a member here is waiting for THIS
    /// photograph.
    func testTheSurfaceAMemberWaitsOnCanShowAPercentage() throws {
        let fetching = try lightbox("fetching-with-percent")
        guard case let .detail(detail) = fetching.content else {
            return XCTFail("a mid-fetch lightbox still decodes to the detail case")
        }
        XCTAssertEqual(detail.held, .fetching)
        XCTAssertEqual(detail.fetchPercent, 43)
        // The bytes have not landed, so the thumbnail is still what draws.
        XCTAssertFalse(detail.hasOriginalPath)
        XCTAssertTrue(detail.hasThumbnailPath)
    }

    /// A loading lightbox still knows which photograph it is: `assetID` sits
    /// outside the oneof, so the chrome and the filmstrip have something to key
    /// by while the read is in flight.
    func testALoadingLightboxStillKnowsWhichPhotographItIs() throws {
        let loading = try lightbox("loading-keyed-by-asset")
        guard case .loading = loading.content else {
            return XCTFail("this case is still loading")
        }
        XCTAssertEqual(loading.assetID, "ast-0330")
        XCTAssertEqual(loading.neighbourAssetIds.count, 3)
    }

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
        let people = try XCTUnwrap(data.doors.first { $0.kind == .people })
        XCTAssertEqual(people.count, 214)
        XCTAssertEqual(people.needsAttention, 63)
        XCTAssertEqual(data.doors.count, 4)
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

        let peopleDoor = try XCTUnwrap(data.doors.first { $0.kind == .people })
        let duplicatesDoor = try XCTUnwrap(data.doors.first { $0.kind == .duplicates })
        XCTAssertTrue(peopleDoor.countCapped)
        XCTAssertFalse(duplicatesDoor.countCapped)
        // A badge is "there is work": a floor and a total draw the same dot,
        // which is why `needsAttention` has no capped sibling to assert.
        XCTAssertEqual(peopleDoor.needsAttention, 63)
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
        XCTAssertEqual(hits.matches.map(\.kind), [.person, .label, .title])
        // The value is the vault's word for the thing, never the query echoed
        // back: two of these three do not contain "Ada" as it was typed.
        XCTAssertEqual(hits.matches.first?.value, "Ada Lovelace")
        XCTAssertEqual(hits.matches.filter { $0.value.contains("Ada") }.count, 2)
        XCTAssertEqual(hits.cells.count, 2)
    }

    private func places(_ case_: String) throws -> Centraid_Screen_V1_PlacesState {
        try Centraid_Screen_V1_PlacesState(serializedBytes: try bytes("photos-places/\(case_)"))
    }

    /// 0,0 IS A REAL POINT IN THE GULF OF GUINEA AND NOT A NULL.
    ///
    /// These two rows carry byte-identical doubles; only the bool separates a
    /// pin at Null Island from a place the vault holds no coordinate for.
    /// Anything that tested `lat != 0 || lng != 0` is wrong about one of them.
    func testZeroZeroIsARealPointAndHasCoordinateSaysSo() throws {
        let rows = try places("no-coordinate").data.places
        let nullIsland = try XCTUnwrap(rows.first { $0.placeID == "plc-0011" })
        let unlocated = try XCTUnwrap(rows.first { $0.placeID == "plc-0012" })
        XCTAssertEqual(nullIsland.latitude, unlocated.latitude)
        XCTAssertEqual(nullIsland.longitude, unlocated.longitude)
        // SwiftProtobuf spells `has_coordinate` with a trailing `_p`, because
        // `hasCoordinate` is the presence accessor's name.
        XCTAssertTrue(nullIsland.hasCoordinate_p)
        XCTAssertFalse(unlocated.hasCoordinate_p)
    }

    /// Cards or a map is a PARAMETER, not a screen: the same rows read the same
    /// way. If the map ever needs a field the cards do not have, it has to be
    /// added here, in front of a reviewer.
    func testCardsAndTheMapAreOneScreen() throws {
        let cards = try places("no-coordinate")
        let map = try places("map-presentation")
        XCTAssertEqual(cards.presentation, .cards)
        XCTAssertEqual(map.presentation, .map)
        XCTAssertEqual(map.data.unplacedCount, cards.data.unplacedCount)
        let known = Set(cards.data.places.map(\.placeID))
        XCTAssertTrue(map.data.places.allSatisfy { known.contains($0.placeID) })
    }

    /// The unplaced count is not derived from the page. A screen that computed
    /// "everything not on this page" would say 0 here and be wrong by 1904.
    func testTheUnplacedCountIsNotDerivedFromThePage() throws {
        let data = try places("no-places-but-unplaced").data
        XCTAssertTrue(data.places.isEmpty)
        XCTAssertEqual(data.unplacedCount, 1904)
    }

    private func people(_ case_: String) throws -> Centraid_Screen_V1_PhotosPeopleState {
        try Centraid_Screen_V1_PhotosPeopleState(
            serializedBytes: try bytes("photos-people/\(case_)")
        )
    }

    /// An empty People screen is two different screens. v0 drew one sentence
    /// for all three causes (`PeopleEmptyState.tsx`); these two have the same
    /// empty list and differ in both fields that decide what a member is told
    /// and what they are offered.
    func testAnEmptyPeopleListIsTwoDifferentScreens() throws {
        let off = try people("recognition-off").data
        let noneNamed = try people("none-named").data
        XCTAssertTrue(off.people.isEmpty)
        XCTAssertTrue(noneNamed.people.isEmpty)

        XCTAssertEqual(off.emptyReason, .recognitionOff)
        // No plane running means no queue: the answer is a setting, not a door.
        XCTAssertEqual(off.proposedFaceCount, 0)

        XCTAssertEqual(noneNamed.emptyReason, .noneNamed)
        // The answer here IS the door, with its count on it.
        XCTAssertEqual(noneNamed.proposedFaceCount, 63)
        XCTAssertNotEqual(off.emptyReason, noneNamed.emptyReason)
    }

    /// A populated list says NONE explicitly — 0 is the UNSPECIFIED slot, so
    /// "not empty" is stated rather than inferred — and the door keeps its
    /// badge: named people and waiting questions are independent facts.
    func testAPopulatedPeopleListSaysNoneExplicitly() throws {
        let full = try people("named-with-proposals-waiting").data
        XCTAssertEqual(full.emptyReason, Centraid_Screen_V1_PhotosPeopleData.EmptyReason.none)
        XCTAssertEqual(full.people.count, 2)
        XCTAssertEqual(full.proposedFaceCount, 7)
        // And the per-person count is a floor when its own read filled a page.
        // Ada's 148 is where the read stopped; Grace's twelve came back whole.
        let ada = try XCTUnwrap(full.people.first { $0.displayName == "Ada Lovelace" })
        let grace = try XCTUnwrap(full.people.first { $0.displayName == "Grace Hopper" })
        XCTAssertTrue(ada.photoCountCapped)
        XCTAssertFalse(grace.photoCountCapped)
    }

    private func faces(_ case_: String) throws -> Centraid_Screen_V1_FaceReviewState {
        try Centraid_Screen_V1_FaceReviewState(serializedBytes: try bytes("photos-faces/\(case_)"))
    }

    /// A cursor past the end is a FINISH, not an empty queue — and the other
    /// screen with no question showing is not a finish either: a queue cannot
    /// fill while the plane that fills it is off.
    func testACursorPastTheEndIsAFinish() throws {
        let done = try faces("worked-through")
        XCTAssertEqual(done.data.candidates.count, 2)
        XCTAssertGreaterThanOrEqual(Int(done.cursor), done.data.candidates.count)
        XCTAssertTrue(done.recognitionEnabled)

        let off = try faces("recognition-off")
        guard case let .data(data) = off.content else {
            // A setting a member chose is not an error, so there is no retry.
            return XCTFail("recognition being off is data, not a failure")
        }
        XCTAssertTrue(data.candidates.isEmpty)
        XCTAssertEqual(off.cursor, 0)
        XCTAssertFalse(off.recognitionEnabled)
    }

    /// A face with no guess is still a question, and every box is a FRACTION of
    /// the image: there is no per-face derivative, so the box is drawn over the
    /// asset's thumbnail at whatever size the view rendered.
    func testAFaceWithNoGuessIsStillAQuestion() throws {
        let data = try faces("unnamed-guess").data
        let unnamed = try XCTUnwrap(data.candidates.first { $0.regionID == "rgn-0010" })
        XCTAssertTrue(unnamed.proposedPartyID.isEmpty)
        XCTAssertTrue(unnamed.proposedName.isEmpty)
        XCTAssertEqual(unnamed.confidence, 0)
        XCTAssertTrue(data.candidates.allSatisfy {
            $0.boxX + $0.boxWidth <= 1 && $0.boxY + $0.boxHeight <= 1
        })
        // The picker needs no second read while a member is mid-answer.
        XCTAssertEqual(data.knownPeople.count, 2)
    }

    private func duplicates(_ case_: String) throws -> Centraid_Screen_V1_DuplicatesState {
        try Centraid_Screen_V1_DuplicatesState(
            serializedBytes: try bytes("photos-duplicates/\(case_)")
        )
    }

    /// An unwalked library is not a clean one. The same empty list, one boolean
    /// apart, and only one of them may say "No duplicates". Asserted against
    /// each other because two separate assertions pass just as happily against
    /// a shell that collapsed them.
    func testAnUnwalkedLibraryIsNotACleanOne() throws {
        let incomplete = try duplicates("scan-incomplete").data
        let clean = try duplicates("scanned-and-clean").data
        XCTAssertTrue(incomplete.clusters.isEmpty)
        XCTAssertTrue(clean.clusters.isEmpty)
        XCTAssertFalse(incomplete.scanComplete)
        XCTAssertTrue(clean.scanComplete)
        XCTAssertNotEqual(incomplete, clean)
    }

    /// The shelf is ordered by what resolving each cluster gives back, and the
    /// page is whole — so the total is the sum and not a floor.
    func testDuplicateClustersAreOrderedByWhatTheyGiveBack() throws {
        let data = try duplicates("clusters-by-reclaimable").data
        let sizes = data.clusters.map(\.reclaimableBytes)
        XCTAssertEqual(sizes, sizes.sorted(by: >))
        XCTAssertFalse(data.hasNextCursor)
        XCTAssertEqual(data.totalReclaimableBytes, sizes.reduce(0, +))
    }

    /// A partial page reports a FLOOR and never a total.
    ///
    /// The pair the whole-page case needs. Same shelf, one page short: the
    /// total accounts for the clusters read and nothing behind them, and
    /// `totalCapped` is the only thing that says the sum is not the answer. A
    /// screen printing both the same way promises space it never accounted for.
    func testAPartialDuplicatesPageReportsAFloor() throws {
        let partial = try duplicates("clusters-partial-page").data
        let whole = try duplicates("clusters-by-reclaimable").data
        XCTAssertTrue(partial.hasNextCursor)
        XCTAssertTrue(partial.totalCapped)
        XCTAssertEqual(
            partial.totalReclaimableBytes,
            partial.clusters.map(\.reclaimableBytes).reduce(0, +)
        )
        XCTAssertFalse(whole.hasNextCursor)
        XCTAssertFalse(whole.totalCapped)
        // A cluster's own members are read within a page limit too.
        let capped = partial.clusters.filter(\.memberCountCapped)
        XCTAssertEqual(capped.map(\.clusterID), ["dup-0004"])
        XCTAssertTrue(whole.clusters.allSatisfy { !$0.memberCountCapped })
    }

    private func memories(_ case_: String) throws -> Centraid_Screen_V1_PhotosMemoriesState {
        try Centraid_Screen_V1_PhotosMemoriesState(
            serializedBytes: try bytes("photos-memories/\(case_)")
        )
    }

    /// "Not yet computed" is not "there are none".
    ///
    /// The same shape as `scanComplete`, and for the same reason: both screens
    /// are a pass's output with an empty list while it is pending. Asserted
    /// against each other, because two separate assertions pass just as happily
    /// against a shell that collapsed them.
    func testNotYetComputedIsNotThereAreNone() throws {
        let notYet = try memories("not-yet-computed")
        let none = try memories("computed-and-empty")
        XCTAssertTrue(notYet.data.memories.isEmpty)
        XCTAssertTrue(none.data.memories.isEmpty)
        XCTAssertFalse(notYet.data.computed)
        XCTAssertTrue(none.data.computed)
        XCTAssertNotEqual(notYet.data, none.data)
        // Data, not a failure: a retry does not make a pass run.
        guard case .data = notYet.content else {
            return XCTFail("a pending pass is data, not a failure")
        }
    }

    /// A memory the pass could not name has no title to store: the view
    /// composes one from `dayKey` and `placeName`. A title written into the
    /// vault by a view is a title no other surface agrees with, and it outlives
    /// the view that invented it.
    func testAMemoryThePassCouldNotNameHasNoTitleToStore() throws {
        let rows = try memories("title-hint-absent").data.memories
        let unnamed = try XCTUnwrap(rows.first { $0.memoryID == "mem-0020" })
        XCTAssertTrue(unnamed.titleHint.isEmpty)
        XCTAssertEqual(unnamed.dayKey, "2024-06-14")
        XCTAssertFalse(unnamed.placeName.isEmpty)
        // A span, not a day: the kinds compose differently, which is why the
        // ends are on the row rather than derived from `dayKey`.
        XCTAssertEqual(unnamed.kind, .trip)
        XCTAssertGreaterThan(unnamed.endedAt, unnamed.startedAt)
        // The branch: one row has a hint the pass wrote, and a fixture with
        // only one of them passes against a view that handles neither.
        let named = try XCTUnwrap(rows.first { $0.memoryID == "mem-0021" })
        XCTAssertEqual(named.titleHint, "On this day")
    }

    private func duplicateReview(
        _ case_: String
    ) throws -> Centraid_Screen_V1_DuplicateReviewState {
        try Centraid_Screen_V1_DuplicateReviewState(
            serializedBytes: try bytes("photos-duplicate-review/\(case_)")
        )
    }

    /// THE ONE THAT MATTERS MOST IN THIS SET.
    ///
    /// Resolving trashes every member but the one `keepAssetID` names, so a
    /// recommendation written into that field is the product choosing which of
    /// a member's photographs to delete. The suggestion stays in `data`.
    func testASuggestionTheMemberHasNotAcceptedDeletesNothing() throws {
        let state = try duplicateReview("suggestion-not-accepted")
        XCTAssertEqual(state.data.suggestedKeepAssetID, "ast-0401")
        XCTAssertFalse(state.data.suggestionReason.isEmpty)
        XCTAssertTrue(state.keepAssetID.isEmpty)
    }

    /// The member may keep the one the suggestion did not. Both fields set and
    /// disagreeing — only representable because they are two fields; one would
    /// have lost the fact that a recommendation was made and declined.
    func testTheMemberMayKeepTheOneTheSuggestionDidNot() throws {
        let state = try duplicateReview("member-overrode-the-suggestion")
        XCTAssertEqual(state.keepAssetID, "ast-0402")
        XCTAssertEqual(state.data.suggestedKeepAssetID, "ast-0401")
        // And the reason they chose it: a copy put somewhere by hand is not a
        // stray, so deleting it is a different act.
        let kept = try XCTUnwrap(state.data.members.first { $0.assetID == state.keepAssetID })
        XCTAssertTrue(kept.memberPlaced)
    }

    /// Byte-identical copies get no recommendation at all. The rule is "largest
    /// by bytes"; when it has no answer the honest state is silence, not an
    /// arbitrary pick dressed as advice.
    func testByteIdenticalCopiesGetNoRecommendation() throws {
        let data = try duplicateReview("no-suggestion-at-all").data
        XCTAssertTrue(data.suggestedKeepAssetID.isEmpty)
        XCTAssertTrue(data.suggestionReason.isEmpty)
        XCTAssertEqual(Set(data.members.map(\.byteSize)).count, 1)
    }

    private func picker(_ case_: String) throws -> Centraid_Screen_V1_PhotoPickerState {
        try Centraid_Screen_V1_PhotoPickerState(
            serializedBytes: try bytes("photos-picker/\(case_)")
        )
    }

    /// What the album already holds is not what the member just picked. The
    /// overlap with the cells is the point: without it every cell looks
    /// addable, including the ones this album already has. Two lists, disjoint
    /// — collapsing them would make new picks indistinguishable from old.
    func testWhatTheAlbumHoldsIsNotWhatTheMemberPicked() throws {
        let state = try picker("already-in-album")
        let loaded = Set(state.data.cells.map(\.assetID))
        XCTAssertEqual(state.alreadyInAlbumAssetIds, ["ast-0201", "ast-0202"])
        XCTAssertTrue(state.alreadyInAlbumAssetIds.allSatisfy { loaded.contains($0) })
        XCTAssertEqual(state.pickedAssetIds, ["ast-0203"])
        let already = Set(state.alreadyInAlbumAssetIds)
        XCTAssertTrue(state.pickedAssetIds.allSatisfy { !already.contains($0) })
    }

    /// The head is named before the read lands, and what the album holds
    /// arrived with it — from the album the member came from, not from the
    /// library read. The screen never pre-picks.
    func testThePickerHeadIsNamedBeforeTheReadLands() throws {
        let state = try picker("named-before-the-read")
        guard case let .loading(loading) = state.content else {
            return XCTFail("this case is still loading")
        }
        XCTAssertTrue(loading.firstLoad)
        XCTAssertEqual(state.collectionName, "Portugal")
        XCTAssertEqual(state.alreadyInAlbumAssetIds.count, 2)
        XCTAssertTrue(state.pickedAssetIds.isEmpty)
    }

    /// The three-state law as a sweep over the eleven new screens. An empty data
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
            "photos-shelf",
            ["album-selecting", "memory-empty-but-titled", "person", "trash-states-its-window"]
        ) { try Centraid_Screen_V1_PhotoShelfState(serializedBytes: $0).content != nil }
        try sweep(
            "photos-lightbox",
            [
                "chrome-hidden", "fetching-with-percent", "info-sheet-proposals",
                "loading-keyed-by-asset", "withheld-by-rule",
            ]
        ) { try Centraid_Screen_V1_PhotoLightboxState(serializedBytes: $0).content != nil }
        try sweep(
            "photos-collections",
            ["counts-are-floors", "new-album-sheet", "read-refused", "standing-and-owned"]
        ) { try Centraid_Screen_V1_PhotosCollectionsState(serializedBytes: $0).content != nil }
        try sweep(
            "photos-memories",
            ["computed-and-empty", "not-yet-computed", "title-hint-absent"]
        ) { try Centraid_Screen_V1_PhotosMemoriesState(serializedBytes: $0).content != nil }
        // Search has FOUR arms: resting is a third thing that is neither a load
        // nor a result, and it is still exactly one of them.
        try sweep(
            "photos-search",
            ["hits-say-why", "no-hits", "resting"]
        ) { try Centraid_Screen_V1_PhotosSearchState(serializedBytes: $0).content != nil }
        try sweep(
            "photos-places",
            ["map-presentation", "no-coordinate", "no-places-but-unplaced"]
        ) { try Centraid_Screen_V1_PlacesState(serializedBytes: $0).content != nil }
        try sweep(
            "photos-people",
            ["named-with-proposals-waiting", "none-named", "recognition-off"]
        ) { try Centraid_Screen_V1_PhotosPeopleState(serializedBytes: $0).content != nil }
        try sweep(
            "photos-faces",
            ["recognition-off", "unnamed-guess", "worked-through"]
        ) { try Centraid_Screen_V1_FaceReviewState(serializedBytes: $0).content != nil }
        try sweep(
            "photos-duplicates",
            [
                "clusters-by-reclaimable", "clusters-partial-page", "scan-incomplete",
                "scanned-and-clean",
            ]
        ) { try Centraid_Screen_V1_DuplicatesState(serializedBytes: $0).content != nil }
        try sweep(
            "photos-duplicate-review",
            ["member-overrode-the-suggestion", "no-suggestion-at-all", "suggestion-not-accepted"]
        ) { try Centraid_Screen_V1_DuplicateReviewState(serializedBytes: $0).content != nil }
        try sweep(
            "photos-picker",
            ["already-in-album", "named-before-the-read"]
        ) { try Centraid_Screen_V1_PhotoPickerState(serializedBytes: $0).content != nil }
    }
}
