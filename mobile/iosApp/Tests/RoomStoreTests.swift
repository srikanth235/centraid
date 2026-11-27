import SwiftUI
import Contacts
import LocalAuthentication
import XCTest
@testable import CentraidApp

@MainActor
final class RoomStoreTests: XCTestCase {
    func testRoomTextSyncSeqRevRule() {
        var sync = RoomTextSync()
        XCTAssertTrue(sync.shouldAdopt(remoteValue: "hello", remoteRev: 0, localText: ""))

        let s1 = sync.nextSeq()
        XCTAssertEqual(s1, 1)
        let s2 = sync.nextSeq()
        XCTAssertEqual(s2, 2)

        XCTAssertFalse(sync.shouldAdopt(remoteValue: "h", remoteRev: 1, localText: "he"))
        XCTAssertFalse(sync.shouldAdopt(remoteValue: "he", remoteRev: 2, localText: "he"))
        XCTAssertTrue(sync.shouldAdopt(remoteValue: "hello", remoteRev: 2, localText: "he"))
    }

    func testParseAppearance() {
        XCTAssertEqual(RoomStore.parseAppearance(#"{"v":1,"value":"light"}"#), .light)
        XCTAssertEqual(RoomStore.parseAppearance(#"{"v":1,"value":"dark"}"#), .dark)
        XCTAssertNil(RoomStore.parseAppearance(#"{"v":1,"value":"system"}"#))
        XCTAssertNil(RoomStore.parseAppearance("not json"))
    }

    func testAppearanceChangeEventReloadsMissingValueBackToSystem() async {
        let core = RoomEffectTestCore(appearance: #"{"v":1,"value":"dark"}"#)
        let store = RoomStore(core: core)
        let systemReset = expectation(description: "appearance key deletion resets to system")
        var schemes: [ColorScheme?] = []
        store.onAppearanceChanged = { scheme in
            schemes.append(scheme)
            if schemes.count == 2 { systemReset.fulfill() }
        }
        await store.start()
        XCTAssertEqual(schemes.count, 1)
        XCTAssertEqual(schemes[0], .dark)
        await core.setAppearance(nil)
        await core.emitChange(table: "appearance")
        await fulfillment(of: [systemReset], timeout: 2)
        XCTAssertNil(schemes[1])
        store.stop()
    }

    func testGenericCoreBridgeFailureUsesMemberCopyAndPreservesCoreSentences() {
        XCTAssertEqual(
            RoomStore.coreFailureSentence(NSError(domain: "bridge", code: 1)),
            KitWords.CORE_REQUEST_FAILED
        )
        let refused = Centraid_Core_V1_Error.with { $0.sentence = "The vault is locked." }
        XCTAssertEqual(RoomStore.coreFailureSentence(Core.Failure.refused(refused)), "The vault is locked.")
        XCTAssertEqual(
            RoomStore.coreFailureSentence(Core.Failure.poisoned(diagnosticID: "d1", sentence: "Vault damaged.")),
            "Vault damaged."
        )
    }

    func testShareInBridgeFailureSurfacesMemberSentence() async throws {
        let inbox = FileManager.default.temporaryDirectory
            .appendingPathComponent("centraid-room-share-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: inbox, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: inbox) }
        try ShareInboxWriter(inboxDirectory: inbox).writeText(
            "Keep this note",
            uuid: "01930000-0000-7000-8000-000000000011"
        )
        let store = RoomStore(core: RoomEffectTestCore(failShareIn: true))

        let items = await store.drainShareInbox(inboxURL: inbox)
        XCTAssertTrue(items.isEmpty)
        XCTAssertEqual(store.errorSentence, KitWords.CORE_REQUEST_FAILED)
    }

    func testCoreStoreStoreReadFollowAnswerPreservesAskAndGrant() throws {
        let effect = Centraid_Core_V1_ShellEffect.with {
            $0.effectID = 81
            $0.kind = .storeRead(.with { $0.system = "calendar" })
        }
        let request = try XCTUnwrap(RoomStore.followAnswer(effect, grant: .granted, inputJSON: #"{"origin":{"ref":"contacts","label":"Contacts"},"records":[],"complete":true}"#))
        guard case .follow(let pass)? = request.kind else {
            return XCTFail("Store read did not become a follow answer")
        }
        XCTAssertEqual(pass.verb, .pass)
        XCTAssertEqual(pass.system, "calendar")
        XCTAssertEqual(pass.askID, 81)
        XCTAssertEqual(pass.grant, .granted)
        XCTAssertEqual(pass.inputJSON, #"{"origin":{"ref":"contacts","label":"Contacts"},"records":[],"complete":true}"#)
    }

    func testCameraRollPageUsesCursorAndStagedHashAndDoesNotInferDeletions() throws {
        let record: [String: Any] = [
            "external_id": "asset-local-id",
            "size": 4096,
            "fields": [
                "blob": String(repeating: "a", count: 64),
                "media_type": "image/heic",
                "taken_at": "2026-11-27T10:20:30Z",
                "width": 1600,
                "height": 1200,
            ],
        ]
        let json = try XCTUnwrap(RoomStore.cameraRollInputJSON(
            cursor: "k|opaque-next|asset-local-id",
            records: [record],
            complete: false
        ))
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let origin = try XCTUnwrap(payload["origin"] as? [String: Any])
        XCTAssertEqual(origin["ref"] as? String, "camera-roll")
        XCTAssertEqual(origin["cursor"] as? String, "k|opaque-next|asset-local-id")
        XCTAssertEqual(payload["complete"] as? Bool, false)
        XCTAssertNil(payload["gone"])
        let rows = try XCTUnwrap(payload["records"] as? [[String: Any]])
        XCTAssertEqual(rows.first?["external_id"] as? String, "asset-local-id")
        XCTAssertEqual((rows.first?["size"] as? NSNumber)?.intValue, 4096)
        let fields = try XCTUnwrap(rows.first?["fields"] as? [String: Any])
        XCTAssertEqual(fields["blob"] as? String, String(repeating: "a", count: 64))
        XCTAssertEqual(fields["media_type"] as? String, "image/heic")
    }

    func testCameraRollPageRejectsUnstagedOrMalformedRecords() {
        XCTAssertNil(RoomStore.cameraRollInputJSON(
            cursor: "",
            records: [["external_id": "asset", "size": 1, "fields": ["media_type": "image/jpeg"]]],
            complete: true
        ))
    }

    func testStoreReadEffectFromCoreAnswersOneUnavailableFollowRequest() async throws {
        let core = RoomEffectTestCore()
        let store = RoomStore(core: core)
        var effect = Centraid_Core_V1_ShellEffect()
        effect.effectID = 101
        effect.kind = .storeRead(.with { $0.system = "calendar" })
        var requests = core.requests.makeAsyncIterator()
        await store.answerCoreEffect(effect)
        let next = await requests.next()
        let request = try XCTUnwrap(next)
        guard case .follow(let pass)? = request.kind else { return XCTFail("Expected FollowRequest") }
        XCTAssertEqual(pass.verb, .pass)
        XCTAssertEqual(pass.system, "calendar")
        XCTAssertEqual(pass.askID, 101)
        XCTAssertEqual(pass.grant, .unavailable)
    }

    func testNativeReaderAdapterFeedsSnapshotIntoExactlyOneCorePass() async throws {
        let core = RoomEffectTestCore()
        var readerCalls: [(String, Bool)] = []
        let payload = #"{"snapshots":[{"origin":{"ref":"calendar:work","label":"Work"},"records":[],"complete":true}]}"#
        let store = RoomStore(core: core, nativeFollowReader: { read in
            readerCalls.append((read.system, read.askPermission))
            return (.granted, payload)
        })
        var effect = Centraid_Core_V1_ShellEffect()
        effect.effectID = 234
        effect.kind = .storeRead(.with { $0.system = "calendar"; $0.askPermission = true })
        var requests = core.requests.makeAsyncIterator()
        await store.answerCoreEffect(effect)
        let next = await requests.next()
        let request = try XCTUnwrap(next)
        XCTAssertEqual(readerCalls.count, 1)
        XCTAssertEqual(readerCalls.first?.0, "calendar")
        XCTAssertEqual(readerCalls.first?.1, true)
        guard case .follow(let pass)? = request.kind else { return XCTFail("Expected FollowRequest") }
        XCTAssertEqual(pass.verb, .pass)
        XCTAssertEqual(pass.askID, 234)
        XCTAssertEqual(pass.grant, .granted)
        XCTAssertEqual(pass.inputJSON, payload)
    }

    func testFollowMergeRefusalShowsCoreSentence() async throws {
        let core = RoomEffectTestCore(followSentence: "The phone's contacts could not be added.")
        let store = RoomStore(core: core)
        var effect = Centraid_Core_V1_ShellEffect()
        effect.effectID = 102
        effect.kind = .storeRead(.with { $0.system = "contacts" })
        await store.answerCoreEffect(effect)
        XCTAssertEqual(store.followSentence, "The phone's contacts could not be added.")
    }

    func testContactSnapshotMapsEveryFollowedFieldAndChildRow() throws {
        let contact = CNMutableContact()
        contact.givenName = "Ada"
        contact.familyName = "Lovelace"
        contact.organizationName = "Analytical Engines"
        contact.jobTitle = "Mathematician"
        contact.nickname = "Augusta"
        contact.phoneNumbers = [
            CNLabeledValue(label: CNLabelPhoneNumberMain, value: CNPhoneNumber(stringValue: "+1 (555) 010-1000")),
        ]
        contact.emailAddresses = [
            CNLabeledValue(label: CNLabelHome, value: "ada@example.test" as NSString),
        ]
        contact.birthday = DateComponents(month: 12, day: 10)

        let record = try XCTUnwrap(RoomStore.contactRecord(contact))
        let fields = try XCTUnwrap(record["fields"] as? [String: Any])
        XCTAssertEqual(record["external_id"] as? String, contact.identifier)
        XCTAssertEqual(fields["title"] as? String, "Ada Lovelace")
        XCTAssertEqual(fields["org"] as? String, "Analytical Engines")
        XCTAssertEqual(fields["role"] as? String, "Mathematician")
        XCTAssertEqual(fields["nickname"] as? String, "Augusta")
        let points = try XCTUnwrap(fields["points"] as? [[String: Any]])
        XCTAssertEqual(points.count, 2)
        XCTAssertEqual(points[0]["kind"] as? String, "phone")
        XCTAssertEqual(points[1]["kind"] as? String, "email")
        let dates = try XCTUnwrap(fields["dates"] as? [[String: Any]])
        XCTAssertEqual(dates.count, 1)
        XCTAssertEqual(dates[0]["kind"] as? String, "birthday")
        XCTAssertEqual(dates[0]["date"] as? String, "--12-10")
    }

    func testContactOrganizationTypeMapsOrganizationForm() {
        XCTAssertEqual(RoomStore.contactForm(.organization), "org")
        XCTAssertEqual(RoomStore.contactForm(.person), "person")
    }

    func testContactSnapshotSendsNullForClearedOptionalScalars() throws {
        let contact = CNMutableContact()
        contact.givenName = "Ada"
        contact.nickname = "Augusta"
        contact.organizationName = "Analytical Engines"
        contact.jobTitle = "Mathematician"
        let populated = try XCTUnwrap(RoomStore.contactRecord(contact)["fields"] as? [String: Any])
        XCTAssertEqual(populated["nickname"] as? String, "Augusta")
        XCTAssertEqual(populated["org"] as? String, "Analytical Engines")
        XCTAssertEqual(populated["role"] as? String, "Mathematician")
        contact.nickname = ""
        contact.organizationName = ""
        contact.jobTitle = ""
        let record = try XCTUnwrap(RoomStore.contactRecord(contact))
        let fields = try XCTUnwrap(record["fields"] as? [String: Any])
        XCTAssertEqual(fields["form"] as? String, "person")
        for key in ["sort_name", "family", "phonetic", "nickname", "org", "role"] {
            XCTAssertTrue(fields[key] is NSNull, "cleared contact field \(key) must be explicit null")
        }
    }

    func testCalendarOccurrenceIdentityUsesOriginalOccurrenceDate() throws {
        let formatter = ISO8601DateFormatter()
        let monday = try XCTUnwrap(formatter.date(from: "2026-11-02T09:00:00Z"))
        let thursday = try XCTUnwrap(formatter.date(from: "2026-11-05T09:00:00Z"))
        let mondayID = RoomStore.calendarOccurrenceID(itemID: "series-1", occurrenceDate: monday)
        let thursdayID = RoomStore.calendarOccurrenceID(itemID: "series-1", occurrenceDate: thursday)
        XCTAssertEqual(mondayID, "series-1#\(Int64(monday.timeIntervalSince1970 * 1000))")
        XCTAssertNotEqual(mondayID, thursdayID)
        // A detached event can change its actual start while its original occurrence key stays put.
        XCTAssertEqual(
            RoomStore.calendarOccurrenceID(itemID: "series-1", occurrenceDate: monday),
            mondayID
        )
    }

    func testCalendarExpandedOccurrencesAreOneOffsInAnIncompleteWindow() throws {
        let formatter = ISO8601DateFormatter()
        let dates = try [
            XCTUnwrap(formatter.date(from: "2026-11-02T09:00:00Z")),
            XCTUnwrap(formatter.date(from: "2026-11-05T09:00:00Z")),
        ]
        let records: [[String: Any]] = dates.map { date in
            [
                "external_id": RoomStore.calendarOccurrenceID(itemID: "series-1", occurrenceDate: date),
                "fields": ["title": "Standup", "rule": NSNull(), "overrides": NSNull()] as [String: Any],
            ]
        }
        let encoded = RoomStore.encodeSnapshots([[
            "origin": ["ref": "calendar:work", "label": "Work"],
            "records": records,
            "complete": false,
        ]])
        XCTAssertEqual(encoded.grant, .granted)
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(encoded.inputJSON.utf8)) as? [String: Any])
        let snapshots = try XCTUnwrap(payload["snapshots"] as? [[String: Any]])
        XCTAssertEqual(snapshots[0]["complete"] as? Bool, false)
        let rows = try XCTUnwrap(snapshots[0]["records"] as? [[String: Any]])
        XCTAssertEqual(rows.count, 2)
        XCTAssertNotEqual(rows[0]["external_id"] as? String, rows[1]["external_id"] as? String)
        for row in rows {
            let fields = try XCTUnwrap(row["fields"] as? [String: Any])
            XCTAssertTrue(fields["rule"] is NSNull)
        }
    }

    func testReminderRecurrencePreservesWeekdaysAndUntil() throws {
        let endDate = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-12-31T23:59:59Z"))
        let weekdays = [
            EKRecurrenceDayOfWeek(.tuesday),
            EKRecurrenceDayOfWeek(.thursday),
        ]
        let recurrence = EKRecurrenceRule(
            recurrenceWith: .weekly,
            interval: 1,
            daysOfTheWeek: weekdays,
            daysOfTheMonth: nil,
            monthsOfTheYear: nil,
            weeksOfTheYear: nil,
            daysOfTheYear: nil,
            setPositions: nil,
            end: EKRecurrenceEnd(end: endDate)
        )
        XCTAssertEqual(
            RoomStore.recurrenceRule(recurrence),
            "FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261231T235959Z"
        )
    }

    func testCalendarAndRemindersSnapshotsUseCoreBatchAndSingleContracts() throws {
        let event = ["external_id": "event-1", "fields": [
            "title": "Planning", "starts": "2026-11-27T10:00:00Z", "timing": "zoned",
            "busy": 1, "overrides": [], "reminders": [10], "attendees": [["name": "Ada", "email": "ada@example.test", "state": "accepted"]],
        ] as [String: Any]] as [String: Any]
        let calendar = RoomStore.encodeSnapshots([[
            "origin": ["ref": "calendar:work", "label": "Work", "color": "0.1,0.2,0.3,1"],
            "records": [event], "complete": true,
        ]])
        XCTAssertEqual(calendar.grant, .granted)
        let calendarJSON = try XCTUnwrap(calendar.inputJSON.data(using: .utf8))
        let batch = try XCTUnwrap(JSONSerialization.jsonObject(with: calendarJSON) as? [String: Any])
        let snapshots = try XCTUnwrap(batch["snapshots"] as? [[String: Any]])
        XCTAssertEqual(snapshots.count, 1)
        XCTAssertEqual((snapshots[0]["origin"] as? [String: Any])?["ref"] as? String, "calendar:work")
        XCTAssertEqual(((snapshots[0]["records"] as? [[String: Any]])?.first?["external_id"] as? String), "event-1")

        let reminder = RoomStore.encodeSnapshot(
            origin: ["ref": "list:home", "label": "Reminders"],
            records: [["external_id": "task-1", "fields": ["title": "Call", "status": "open", "due": NSNull(), "reminders": [10]]]],
            complete: true
        )
        XCTAssertEqual(reminder.grant, .granted)
        let reminderJSON = try XCTUnwrap(reminder.inputJSON.data(using: .utf8))
        let snapshot = try XCTUnwrap(JSONSerialization.jsonObject(with: reminderJSON) as? [String: Any])
        XCTAssertNil(snapshot["snapshots"])
        XCTAssertEqual((snapshot["origin"] as? [String: Any])?["ref"] as? String, "list:home")
        XCTAssertEqual((snapshot["records"] as? [[String: Any]])?.count, 1)
    }

    func testReminderListGrowthKeepsTheFirstOriginAndIdentifiersStable() throws {
        let first = [
            "origin": ["ref": "list:home-list", "label": "Home"],
            "records": [["external_id": "task-1", "fields": ["title": "Call", "status": "open"]]],
            "complete": true,
        ] as [String: Any]
        let second = [
            "origin": ["ref": "list:work-list", "label": "Work"],
            "records": [["external_id": "task-2", "fields": ["title": "Plan", "status": "open"]]],
            "complete": true,
        ] as [String: Any]
        let before = RoomStore.encodeSnapshots([first])
        let after = RoomStore.encodeSnapshots([first, second])
        let beforePayload = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(before.inputJSON.utf8)) as? [String: Any])
        let afterPayload = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(after.inputJSON.utf8)) as? [String: Any])
        let beforeSnapshots = try XCTUnwrap(beforePayload["snapshots"] as? [[String: Any]])
        let afterSnapshots = try XCTUnwrap(afterPayload["snapshots"] as? [[String: Any]])
        XCTAssertEqual(afterSnapshots.count, 2)
        XCTAssertEqual(
            (beforeSnapshots[0]["origin"] as? [String: Any])?["ref"] as? String,
            (afterSnapshots[0]["origin"] as? [String: Any])?["ref"] as? String
        )
        XCTAssertEqual(
            ((beforeSnapshots[0]["records"] as? [[String: Any]])?.first?["external_id"] as? String),
            ((afterSnapshots[0]["records"] as? [[String: Any]])?.first?["external_id"] as? String)
        )
    }

    func testHealthCursorInputPreservesDeltaDeletesAndIncompleteGrants() throws {
        let json = try XCTUnwrap(RoomStore.healthInputJSON(
            workouts: [
                "origin": ["ref": "healthkit", "label": "Health", "cursor": "opaque-anchor"],
                "records": [["external_id": "workout-1", "fields": ["kind": "walking", "starts": "2026-11-27T10:00:00Z"]]],
                "complete": false,
                "gone": ["deleted-workout"],
            ],
            readings: [
                "origin": ["ref": "healthkit-readings", "label": "Health"],
                "records": [["external_id": "weight-sample-1", "fields": ["metric": "weight_kg", "at": "2026-11-27T10:00:00Z", "value": 70.5]]],
                "complete": false,
            ],
            totals: [
                "origin": ["system": "health", "ref": "healthkit"],
                "days": [["day": "2026-11-27", "metric": "steps", "value": 20]],
            ]
        ))
        let payload = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        let workouts = try XCTUnwrap(payload["workouts"] as? [String: Any])
        XCTAssertEqual(workouts["complete"] as? Bool, false)
        XCTAssertEqual(workouts["gone"] as? [String], ["deleted-workout"])
        XCTAssertEqual((workouts["origin"] as? [String: Any])?["cursor"] as? String, "opaque-anchor")
        let readings = try XCTUnwrap(payload["readings"] as? [String: Any])
        XCTAssertEqual(readings["complete"] as? Bool, false)
        XCTAssertEqual((readings["records"] as? [[String: Any]])?.count, 1)
        XCTAssertEqual(((readings["records"] as? [[String: Any]])?.first?["fields"] as? [String: Any])?["metric"] as? String, "weight_kg")
        let totals = try XCTUnwrap(payload["totals"] as? [String: Any])
        XCTAssertEqual((totals["days"] as? [[String: Any]])?.first?["metric"] as? String, "steps")
    }

    func testModelTransferRejectsWrongHashAndTruncationWithoutReplacingVerifiedFile() throws {
        ChatModelStore.prepareDirectory()
        let final = ChatModelStore.directory.appendingPathComponent("fixture-\(UUID().uuidString).bin")
        let staging = ChatModelStore.directory.appendingPathComponent("fixture-\(UUID().uuidString).part")
        defer { try? FileManager.default.removeItem(at: final); try? FileManager.default.removeItem(at: staging) }
        let old = Data("previous verified model".utf8)
        try old.write(to: final)
        let truncated = Data("short".utf8)
        try truncated.write(to: staging)
        let wrongHash = ChatAsset(
            vision: false, url: "https://models.example/model.bin", fileName: final.lastPathComponent,
            sha256: String(repeating: "0", count: 64), bytes: 100, directory: ChatModelStore.directory.path
        )
        XCTAssertFalse(ChatModelDownloader.verified(staging, asset: wrongHash))
        XCTAssertFalse(ChatModelDownloader.keep(staging, as: wrongHash))
        XCTAssertEqual(try Data(contentsOf: final), old)

        let correctDigest = try XCTUnwrap(ChatModelDownloader.sha256(of: final))
        let wrongLength = ChatAsset(
            vision: false, url: "https://models.example/model.bin", fileName: final.lastPathComponent,
            sha256: correctDigest, bytes: UInt64(old.count + 1), directory: ChatModelStore.directory.path
        )
        try truncated.write(to: staging)
        XCTAssertFalse(ChatModelDownloader.verified(staging, asset: wrongLength))
        XCTAssertFalse(ChatModelDownloader.keep(staging, as: wrongLength))
        XCTAssertEqual(try Data(contentsOf: final), old)
    }

    func testModelWaitRejectsCancellationBeforeStartingTransfer() async {
        let asset = ChatAsset(
            vision: false, url: "https://models.example/model.bin", fileName: "cancel-fixture.bin",
            sha256: String(repeating: "0", count: 64), bytes: 12, directory: ChatModelStore.directory.path
        )
        let task = Task { @MainActor in
            await Task.yield()
            return await ChatModelDownloader.shared.startAndWait(asset)
        }
        task.cancel()
        let result = await task.value
        XCTAssertFalse(result)
    }

    func testModelRedirectAllowsBoundedHTTPSCDNAndRejectsDowngradeOrCredentials() throws {
        let source = try XCTUnwrap(URL(string: "https://models.example/model.bin"))
        let cdn = try XCTUnwrap(URL(string: "https://cdn.example/model.bin?signature=abc"))
        let insecure = try XCTUnwrap(URL(string: "http://cdn.example/model.bin"))
        let credentialed = try XCTUnwrap(URL(string: "https://member@cdn.example/model.bin"))
        XCTAssertTrue(ChatModelDownloader.redirectAllowed(source: source, destination: cdn, redirectCount: 1))
        XCTAssertTrue(ChatModelDownloader.redirectAllowed(source: source, destination: cdn, redirectCount: 5))
        XCTAssertFalse(ChatModelDownloader.redirectAllowed(source: source, destination: cdn, redirectCount: 6))
        XCTAssertFalse(ChatModelDownloader.redirectAllowed(source: source, destination: insecure, redirectCount: 1))
        XCTAssertFalse(ChatModelDownloader.redirectAllowed(source: source, destination: credentialed, redirectCount: 1))
    }

    func testModelTransferRejectsUnsafeURLAndPathBeforeWaiting() async {
        let unsafeURL = ChatAsset(
            vision: false, url: "http://models.example/model.bin", fileName: "model.bin",
            sha256: String(repeating: "0", count: 64), bytes: 12, directory: ChatModelStore.directory.path
        )
        let unsafePath = ChatAsset(
            vision: false, url: "https://models.example/model.bin", fileName: "../model.bin",
            sha256: String(repeating: "0", count: 64), bytes: 12, directory: ChatModelStore.directory.path
        )
        let badURL = await ChatModelDownloader.shared.startAndWait(unsafeURL)
        let badPath = await ChatModelDownloader.shared.startAndWait(unsafePath)
        XCTAssertFalse(badURL)
        XCTAssertFalse(badPath)
    }

    func testShareInNoticeKeepsEveryKeptDetail() {
        let filed = Centraid_Core_V1_ShareInItem.with { $0.fate = .filed; $0.detail = "note" }
        let kept = Centraid_Core_V1_ShareInItem.with { $0.fate = .kept; $0.detail = "unsupported type" }
        let emptyKept = Centraid_Core_V1_ShareInItem.with { $0.fate = .kept }
        XCTAssertEqual(RoomStore.shareInNotice([filed, kept, emptyKept]), "unsupported type")
        XCTAssertNil(RoomStore.shareInNotice([filed, emptyKept]))
        XCTAssertNil(RoomStore.shareInNotice([filed]))
    }

    func testRoomEffectDispatcherSendsOneTypedAnswerPerEffectID() async throws {
        let core = RoomEffectTestCore()
        var performed: [UInt64] = []
        let store = RoomStore(core: core) { effect in
            performed.append(effect.effectID)
            switch effect.kind {
            case .storeRead?:
                return .grant(.with { $0.grant = .granted })
            case .ownerCheck?:
                return .owner(.with { $0.passed = true })
            case .pickFile?:
                return .picked(.with { $0.items = [.with { $0.path = "/picked/file"; $0.name = "file" }] })
            case .pickPhoto?:
                return .picked(.with { $0.items = [.with { $0.path = "/picked/photo"; $0.name = "photo" }] })
            case .scanDocument?:
                return .picked(.with { $0.items = [.with { $0.path = "/picked/scan"; $0.name = "scan.pdf" }] })
            case .permissionStatus?:
                return .grant(.with { $0.grant = .granted })
            default:
                return .done(.init())
            }
        }
        let effects = roomEffects()
        var answers = core.answers.makeAsyncIterator()
        for (index, effect) in effects.enumerated() {
            store.answerEffects([effect, effect], instance: 77)
            let next = await answers.next()
            let answer = try XCTUnwrap(next)
            XCTAssertEqual(answer.effectID, UInt64(index + 1))
            switch index {
            case 0, 13:
                guard case .grant(let grant)? = answer.outcome else { return XCTFail("Expected a grant") }
                XCTAssertEqual(grant.grant, .granted)
            case 4:
                guard case .owner(let owner)? = answer.outcome else { return XCTFail("Expected owner check") }
                XCTAssertTrue(owner.passed)
            case 8, 9, 10:
                guard case .picked(let picked)? = answer.outcome else { return XCTFail("Expected picked files") }
                XCTAssertEqual(picked.items.count, 1)
            default:
                guard case .done? = answer.outcome else { return XCTFail("Expected completion") }
            }
        }
        XCTAssertEqual(performed, Array(1...14).map { UInt64($0) })
    }

    func testRoomEffectCancellationIsForwardedAsCancelledFailure() async throws {
        let core = RoomEffectTestCore()
        let store = RoomStore(core: core) { _ in
            var failed = Centraid_Core_V1_ShellFailed()
            failed.grant = .cancelled
            failed.reason = EffectReason.cancelled
            return .failed(failed)
        }
        var effect = Centraid_Core_V1_ShellEffect()
        effect.effectID = 99
        effect.kind = .pickFile(.init())
        var answers = core.answers.makeAsyncIterator()
        store.answerEffects([effect, effect], instance: 4)
        let next = await answers.next()
        let answer = try XCTUnwrap(next)
        XCTAssertEqual(answer.effectID, 99)
        guard case .failed(let failure)? = answer.outcome else { return XCTFail("Expected cancellation") }
        XCTAssertTrue(failure.cancelled)
        XCTAssertEqual(failure.grant, .cancelled)
        XCTAssertEqual(failure.reason, EffectReason.cancelled)
    }

    func testNativePickerCallbackMapsEmptySelectionToCancelled() {
        switch FilePerformer.pickerResult([]) {
        case .success: XCTFail("An empty picker selection is cancellation")
        case .failure(let reason): XCTAssertEqual(reason, EffectReason.cancelled)
        }
    }

    func testNestedFilePresenterChangesCoalesceToOneFilesTrigger() async throws {
        let core = RoomEffectTestCore()
        let store = RoomStore(core: core)
        XCTAssertTrue(store.scheduleFilesTrigger())
        XCTAssertFalse(store.scheduleFilesTrigger())
        var requests = core.requests.makeAsyncIterator()
        let next = await requests.next()
        let request = try XCTUnwrap(next)
        guard case .follow(let follow)? = request.kind else { return XCTFail("Expected a follow trigger") }
        XCTAssertEqual(follow.verb, .trigger)
        XCTAssertEqual(follow.system, "files")
        let triggerCount = await core.followTriggerCount()
        XCTAssertEqual(triggerCount, 1)
    }

    func testPickedFileIsStagedBeforeNativeShellPickedContainsHandle() async throws {
        let core = RoomEffectTestCore()
        let store = RoomStore(core: core)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("room-picked-\(UUID().uuidString).txt")
        let bytes = Data("staged picker bytes".utf8)
        try bytes.write(to: url)
        defer { try? FileManager.default.removeItem(at: url) }
        let item = Centraid_Core_V1_ShellPickedItem.with {
            $0.path = url.path
            $0.name = url.lastPathComponent
            $0.mediaType = "text/plain"
            $0.size = UInt64(bytes.count)
        }
        let stagedResult = await store.stagePickedItems([item])
        let staged = try XCTUnwrap(stagedResult)
        XCTAssertEqual(staged.count, 1)
        XCTAssertTrue(staged[0].hasStageHandle)
        XCTAssertEqual(staged[0].stageHandle.byteSize, UInt64(bytes.count))
        XCTAssertEqual(staged[0].stageHandle.contentHash.count, 32)
        let count = await core.stageRequestCount()
        XCTAssertGreaterThanOrEqual(count, 4)
    }

    func testOwnerCheckCapabilityErrorsDoNotCountAsDenials() {
        let unavailable = RoomStore.ownerCheckOutcome(available: false, errorCode: LAError.biometryNotAvailable.rawValue, passed: false)
        guard case .failed(let noCapability)? = unavailable else { return XCTFail("Expected unavailable") }
        XCTAssertEqual(noCapability.reason, EffectReason.unavailable)

        let noPasscode = RoomStore.ownerCheckOutcome(available: false, errorCode: LAError.passcodeNotSet.rawValue, passed: false)
        guard case .owner(let ownerNoPasscode)? = noPasscode else { return XCTFail("Expected no-passcode owner result") }
        XCTAssertTrue(ownerNoPasscode.noPasscode)

        let denial = RoomStore.ownerCheckOutcome(available: true, errorCode: LAError.authenticationFailed.rawValue, passed: false)
        guard case .owner(let ownerDenied)? = denial else { return XCTFail("Expected an owner denial") }
        XCTAssertFalse(ownerDenied.passed)
        XCTAssertFalse(ownerDenied.cancelled)

        let cancel = RoomStore.ownerCheckOutcome(available: true, errorCode: LAError.userCancel.rawValue, passed: false)
        guard case .owner(let ownerCancelled)? = cancel else { return XCTFail("Expected cancellation") }
        XCTAssertTrue(ownerCancelled.cancelled)
    }

    func testBackgroundMasksLockerDataAndRetainsNonSecureRoom() {
        let core = RoomEffectTestCore()
        let store = RoomStore(core: core)
        var notes = Centraid_Core_V1_RoomShown()
        notes.tab = RustScreens.homeTab
        notes.instance = 1
        notes.depth = 1
        notes.transition = .push
        notes.room.key = "notes"
        notes.room.state = .ready(.init())
        store.apply(notes)

        var locker = Centraid_Core_V1_RoomShown()
        locker.tab = RustScreens.homeTab
        locker.instance = 2
        locker.depth = 2
        locker.transition = .push
        locker.room.key = "locker/item/example"
        locker.room.secure = true
        locker.room.state = .ready(.init())
        store.apply(locker)

        store.lifecycle(foreground: false)

        XCTAssertEqual(store.currentStack.count, 2)
        XCTAssertEqual(store.currentStack[0].room.key, "notes")
        XCTAssertTrue(store.currentStack[1].room.secure)
        guard case .loading? = store.currentStack[1].room.state else { return XCTFail("Expected a masked room") }
        XCTAssertTrue(store.currentStack[1].room.key.isEmpty)

        var wall = locker
        wall.transition = .reload
        wall.room.key = "locker"
        wall.secureEpoch = 1
        wall.room.state = .ready(.init())
        store.apply(wall)
        XCTAssertEqual(store.currentStack.last?.room.key, "locker")
        XCTAssertTrue(store.currentStack.last?.room.secure == true)
    }

    func testLatePreBackgroundSecureRoomCannotResurrectAfterForeground() {
        let store = RoomStore(core: RoomEffectTestCore())
        let home = shown(instance: 1, depth: 1, key: "home", secure: false, transition: .push)
        let locker = shown(instance: 2, depth: 2, key: "locker", secure: true, transition: .push)
        store.apply(home)
        store.apply(locker)

        store.lifecycle(foreground: false)
        store.lifecycle(foreground: true)

        var wall = shown(instance: 2, depth: 2, key: "locker", secure: true, transition: .reload)
        wall.secureEpoch = 1
        store.apply(wall)
        var lateDetail = shown(instance: 3, depth: 3, key: "locker/item/revealed", secure: true, transition: .push)
        lateDetail.secureEpoch = 0
        store.apply(lateDetail)

        XCTAssertEqual(store.currentStack.map(\.room.key), ["home", "locker"])
        XCTAssertTrue(store.currentStack[1].room.secure)
        guard case .ready? = store.currentStack[1].room.state else {
            return XCTFail("Expected the authoritative foreground wall")
        }
    }

    func testStaleRoomResponseSuppressesOwnerPromptAndClipboardButKeepsUnrelatedEffects() {
        let ownerCheck = Centraid_Core_V1_ShellEffect.with {
            $0.kind = .ownerCheck(.init())
        }
        let clipboard = Centraid_Core_V1_ShellEffect.with {
            $0.kind = .clipboardCopy(.init())
        }
        let settings = Centraid_Core_V1_ShellEffect.with {
            $0.kind = .openSettings(.init())
        }

        XCTAssertFalse(RoomStore.allows(effect: ownerCheck, responseEpoch: 0, secureEpochFloor: 1))
        XCTAssertFalse(RoomStore.allows(effect: clipboard, responseEpoch: 0, secureEpochFloor: 1))
        XCTAssertTrue(RoomStore.allows(effect: settings, responseEpoch: 0, secureEpochFloor: 1))
        XCTAssertTrue(RoomStore.allows(effect: ownerCheck, responseEpoch: 1, secureEpochFloor: 1))
    }

    func testQueuedOwnerEffectIsRecheckedAgainstEpochImmediatelyBeforePerformer() async {
        let core = RoomEffectTestCore()
        var performed: [UInt64] = []
        let store = RoomStore(core: core) { effect in
            performed.append(effect.effectID)
            return .done(.init())
        }
        store.lifecycle(foreground: false)

        let old = Centraid_Core_V1_ShellEffect.with {
            $0.effectID = 41
            $0.kind = .ownerCheck(.init())
        }
        await store.performResponseEffects([old], instance: 9, responseEpoch: 0)
        XCTAssertTrue(performed.isEmpty, "a queued pre-background prompt must not run")

        let current = Centraid_Core_V1_ShellEffect.with {
            $0.effectID = 42
            $0.kind = .ownerCheck(.init())
        }
        await store.performResponseEffects([current], instance: 9, responseEpoch: 1)
        XCTAssertEqual(performed, [42], "an effect from the authoritative epoch remains usable")
    }

    func testLockerReloadUsesCoreDepthAndRetainsNonLockerSuffix() {
        let store = RoomStore(core: RoomEffectTestCore())
        let home = shown(instance: 1, depth: 1, key: "home", secure: false, transition: .push)
        let locker = shown(instance: 2, depth: 2, key: "locker", secure: true, transition: .push)
        let detail = shown(instance: 3, depth: 3, key: "locker/detail", secure: true, transition: .push)
        let people = shown(instance: 4, depth: 4, key: "people/person", secure: false, transition: .push)
        [home, locker, detail, people].forEach(store.apply)

        let wall = shown(instance: 2, depth: 2, key: "locker", secure: true, transition: .reload)
        store.apply(wall)
        XCTAssertEqual(store.currentStack.map(\.room.key), ["home", "locker"])

        let returnedPeople = shown(instance: 4, depth: 3, key: "people/person", secure: false, transition: .reload)
        store.apply(returnedPeople)
        XCTAssertEqual(store.currentStack.map(\.room.key), ["home", "locker", "people/person"])
        XCTAssertTrue(store.currentStack[1].room.secure)
    }

    private func shown(
        instance: UInt64,
        depth: UInt32,
        key: String,
        secure: Bool,
        transition: Centraid_Core_V1_RoomTransition
    ) -> Centraid_Core_V1_RoomShown {
        var shown = Centraid_Core_V1_RoomShown()
        shown.tab = RustScreens.homeTab
        shown.instance = instance
        shown.depth = depth
        shown.transition = transition
        shown.room.key = key
        shown.room.secure = secure
        shown.room.state = .ready(.init())
        return shown
    }

    private func roomEffects() -> [Centraid_Core_V1_ShellEffect] {
        [
            .with { $0.kind = .storeRead(.init()) },
            .with { $0.kind = .phoneWatch(.init()) },
            .with { $0.kind = .openSettings(.init()) },
            .with { $0.kind = .releaseGrant(.init()) },
            .with { $0.kind = .ownerCheck(.init()) },
            .with { $0.kind = .share(.init()) },
            .with { $0.kind = .saveFile(.init()) },
            .with { $0.kind = .pickFile(.init()) },
            .with { $0.kind = .pickPhoto(.init()) },
            .with { $0.kind = .scanDocument(.init()) },
            .with { $0.kind = .clipboardCopy(.init()) },
            .with { $0.kind = .photoDelete(.init()) },
            .with { $0.kind = .modelDownload(.init()) },
            .with { $0.kind = .permissionStatus(.init()) },
        ].enumerated().map { index, effect in
            var identified = effect
            identified.effectID = UInt64(index + 1)
            return identified
        }
    }

    func testGlanceSnapshotURLIsForwardedRawToCore() async throws {
        let json = """
        {"v":1,"title":"Today","day":"2026-11-26","summary":"1 event","lines":[{"text":"Dentist","url":"centraid://open/event/ev1","kind":"event"}]}
        """
        let snapshot = try XCTUnwrap(TodayGlanceSnapshot.decode(Data(json.utf8)))
        XCTAssertEqual(snapshot.title, "Today")
        XCTAssertEqual(snapshot.lines.count, 1)
        XCTAssertEqual(snapshot.lines[0].text, "Dentist")

        let url = try XCTUnwrap(URL(string: snapshot.lines[0].url))
        let core = RoomEffectTestCore()
        let store = RoomStore(core: core)
        var requests = core.requests.makeAsyncIterator()
        await store.open(deepLink: url)
        let next = await requests.next()
        let request = try XCTUnwrap(next)
        guard case .room(let room)? = request.kind,
              case .open(let open)? = room.kind
        else { return XCTFail("Deep link did not open a room") }
        XCTAssertEqual(open.deepLink, url.absoluteString)

        XCTAssertNil(TodayGlanceSnapshot.decode(Data(#"{"v":2,"title":"Today","day":"2026-11-26","summary":"","lines":[]}"#.utf8)))
    }
}

private actor RoomEffectTestCore: ScreenCore {
    nonisolated let updates: AsyncStream<Centraid_Core_V1_ScreenUpdate>
    nonisolated let answers: AsyncStream<Centraid_Core_V1_ShellEffectResult>
    nonisolated let requests: AsyncStream<Centraid_Core_V1_Request>
    nonisolated let changes: AsyncStream<Centraid_Core_V1_ChangeEvent>
    private nonisolated let answerSink: AsyncStream<Centraid_Core_V1_ShellEffectResult>.Continuation
    private nonisolated let requestSink: AsyncStream<Centraid_Core_V1_Request>.Continuation
    private nonisolated let changeSink: AsyncStream<Centraid_Core_V1_ChangeEvent>.Continuation
    private let followSentence: String?
    private let failShareIn: Bool
    private var appearance: String?
    private var stageCount = 0
    private var followTriggers = 0

    init(followSentence: String? = nil, appearance: String? = nil, failShareIn: Bool = false) {
        self.followSentence = followSentence
        self.appearance = appearance
        self.failShareIn = failShareIn
        updates = AsyncStream { $0.finish() }
        let stream = AsyncStream<Centraid_Core_V1_ShellEffectResult>.makeStream()
        answers = stream.stream
        answerSink = stream.continuation
        let requests = AsyncStream<Centraid_Core_V1_Request>.makeStream()
        self.requests = requests.stream
        requestSink = requests.continuation
        let changes = AsyncStream<Centraid_Core_V1_ChangeEvent>.makeStream()
        self.changes = changes.stream
        changeSink = changes.continuation
    }

    func call(_ request: Centraid_Core_V1_Request) async throws -> Centraid_Core_V1_Response {
        requestSink.yield(request)
        if case .shareIn? = request.kind, failShareIn {
            throw RoomTestBridgeFailure.failed
        }
        if case .stage(let stage)? = request.kind {
            stageCount += 1
            var answer = Centraid_Core_V1_StageResponse()
            switch stage.kind {
            case .begin?:
                answer.kind = .begun(.with { $0.stagingID = "stage-fixture"; $0.chunkBytes = 1024 })
            case .chunk?:
                answer.kind = .chunked(.with { $0.received = 1 })
            case .end?:
                answer.kind = .handle(.with { $0.contentHash = Data(repeating: 0x11, count: 32); $0.byteSize = 19 })
            default:
                break
            }
            var response = Centraid_Core_V1_Response()
            response.kind = .stage(answer)
            return response
        }
        if case .follow(let follow)? = request.kind, follow.verb == .trigger {
            followTriggers += 1
        }
        if case .device(let device)? = request.kind, case .get(let get)? = device.kind, get.key == "settings.appearance" {
            var answer = Centraid_Core_V1_DeviceResponse()
            answer.found = appearance != nil
            answer.value = appearance ?? ""
            var response = Centraid_Core_V1_Response()
            response.kind = .device(answer)
            return response
        }
        if case .room(let room)? = request.kind,
           case .send(let send)? = room.kind,
           case .effectResult(let answer)? = send.event.kind
        {
            answerSink.yield(answer)
        }
        if case .follow? = request.kind, let followSentence {
            var follow = Centraid_Core_V1_FollowResponse()
            follow.declined = true
            follow.sentence = followSentence
            var response = Centraid_Core_V1_Response()
            response.kind = .follow(follow)
            return response
        }
        return .with { $0.kind = .room(.init()) }
    }

    func setAppearance(_ value: String?) { appearance = value }

    func stageRequestCount() -> Int { stageCount }

    func followTriggerCount() -> Int { followTriggers }

    func emitChange(table: String) {
        var change = Centraid_Core_V1_ChangeEvent()
        change.table = table
        changeSink.yield(change)
    }

    func call(_ request: Centraid_Core_V1_Request, lane: Core.Lane) async throws -> Centraid_Core_V1_Response {
        try await call(request)
    }
}

private enum RoomTestBridgeFailure: Error {
    case failed
}
