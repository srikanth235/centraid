import Foundation
import XCTest
@testable import CentraidApp

final class ShareInboxWriterTests: XCTestCase {
    private func makeTempDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("centraid-share-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir
    }

    func testWriteTextAndURLFollowD2ManifestContract() throws {
        let inbox = try makeTempDir()
        let writer = ShareInboxWriter(inboxDirectory: inbox)
        XCTAssertFalse(ShareInboxWriter.hasPendingItems(in: inbox))

        let textItem = try writer.writeText(
            "Remember the groceries",
            name: "Quick note",
            fromApp: "Notes",
            receivedAtMs: 1_732_680_000_000,
            uuid: "01930000-0000-7000-8000-000000000001"
        )
        XCTAssertTrue(ShareInboxWriter.hasPendingItems(in: inbox))

        let payloadData = try Data(contentsOf: textItem.directory.appendingPathComponent("payload"))
        XCTAssertEqual(String(data: payloadData, encoding: .utf8), "Remember the groceries")

        let manifestData = try Data(contentsOf: textItem.directory.appendingPathComponent("manifest.json"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: manifestData) as? [String: Any])
        XCTAssertEqual(json["v"] as? Int, 1)
        XCTAssertEqual(json["type"] as? String, "text")
        XCTAssertEqual(json["uti_or_mime"] as? String, "public.plain-text")
        XCTAssertEqual(json["name"] as? String, "Quick note")
        XCTAssertEqual(json["from_app"] as? String, "Notes")
        XCTAssertEqual(json["received_at"] as? Int64, 1_732_680_000_000)

        let url = try XCTUnwrap(URL(string: "https://example.org/recipe"))
        let urlItem = try writer.writeURL(
            url,
            fromApp: "Safari",
            receivedAtMs: 1_732_680_001_000,
            uuid: "01930000-0000-7000-8000-000000000002"
        )
        let urlPayload = try Data(contentsOf: urlItem.directory.appendingPathComponent("payload"))
        XCTAssertEqual(String(data: urlPayload, encoding: .utf8), "https://example.org/recipe")
        XCTAssertEqual(urlItem.manifest.type, .url)
        XCTAssertEqual(urlItem.manifest.utiOrMime, "public.url")
    }

    func testWriteFileCopiesPayloadAtomicallyAndRejectsBadInputs() throws {
        let dir = try makeTempDir()
        let inbox = dir.appendingPathComponent("share-inbox", isDirectory: true)
        let source = dir.appendingPathComponent("receipt.pdf")
        let bytes = Data([0x25, 0x50, 0x44, 0x46, 0x2D])
        try bytes.write(to: source)

        let writer = ShareInboxWriter(inboxDirectory: inbox)
        let item = try writer.writeFile(
            at: source,
            utiOrMime: "application/pdf",
            fromApp: "Files",
            receivedAtMs: 1_732_680_002_000,
            uuid: "01930000-0000-7000-8000-000000000003"
        )
        XCTAssertEqual(item.manifest.type, .file)
        XCTAssertEqual(item.manifest.name, "receipt.pdf")
        XCTAssertEqual(try Data(contentsOf: item.directory.appendingPathComponent("payload")), bytes)

        XCTAssertThrowsError(try writer.writeText("", uuid: "01930000-0000-7000-8000-000000000004"))
        XCTAssertThrowsError(try writer.writeText("hi", uuid: "../escape"))
        XCTAssertThrowsError(try writer.writeText("hi", uuid: ".hidden"))
    }

    func testNotificationOutboxWritesVersionedD7Envelope() throws {
        let dir = try makeTempDir()
        let store = NotificationOutboxStore(fileURL: dir.appendingPathComponent("outbox.json"))

        let press = NotificationOutbox.add(
            notificationID: "alert|rem1|2026-11-27T09:00",
            verb: Centraid_Core_V1_NotificationVerb.done.rawValue,
            entityID: "task-123",
            atMs: 1_732_680_003_000,
            store: store
        )

        let raw = try Data(contentsOf: store.fileURL)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: raw) as? [String: Any])
        XCTAssertEqual(json["v"] as? Int, 1)
        let items = try XCTUnwrap(json["items"] as? [[String: Any]])
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items[0]["id"] as? String, press.pressID)
        XCTAssertEqual(items[0]["action"] as? String, "done")
        XCTAssertEqual(items[0]["entity"] as? String, "task-123")
        XCTAssertEqual(items[0]["key"] as? String, press.pressID)

        let pending = NotificationOutbox.pending(store: store)
        XCTAssertEqual(pending.count, 1)
        XCTAssertEqual(pending[0].proto()?.verb, .done)
        XCTAssertEqual(pending[0].proto()?.entityID, "task-123")

        NotificationOutbox.remove(press.pressID, store: store)
        XCTAssertTrue(NotificationOutbox.pending(store: store).isEmpty)
    }

    #if os(iOS)
    func testNotificationCategoriesEnforceDoneOnlyForTasks() {
        var doneAction = Centraid_Core_V1_NotificationAction()
        doneAction.verb = .done
        doneAction.label = "Done"

        var snoozeAction = Centraid_Core_V1_NotificationAction()
        snoozeAction.verb = .snoozeHour
        snoozeAction.label = "Snooze"

        var eventCat = Centraid_Core_V1_NotificationCategory()
        eventCat.categoryID = Notifications.eventCategoryID
        eventCat.actions = [doneAction, snoozeAction]

        let categories = Notifications.notificationCategories(from: [eventCat])
        let byID = Dictionary(uniqueKeysWithValues: categories.map { ($0.identifier, $0) })

        XCTAssertEqual(
            byID[Notifications.taskCategoryID]?.actions.map(\.identifier),
            [Notifications.doneActionID, Notifications.snoozeActionID]
        )
        XCTAssertEqual(
            byID[Notifications.eventCategoryID]?.actions.map(\.identifier),
            [Notifications.snoozeActionID]
        )
        XCTAssertEqual(
            byID[Notifications.personCategoryID]?.actions.map(\.identifier),
            [Notifications.snoozeActionID]
        )
        XCTAssertEqual(
            byID[Notifications.lockerItemCategoryID]?.actions.map(\.identifier),
            [Notifications.snoozeActionID]
        )

        XCTAssertEqual(Notifications.verb(forActionIdentifier: "done"), .done)
        XCTAssertEqual(Notifications.verb(forActionIdentifier: "snooze"), .snoozeHour)
        XCTAssertEqual(
            Notifications.verb(forActionIdentifier: String(Centraid_Core_V1_NotificationVerb.done.rawValue)),
            .done
        )
    }
    #endif
}
