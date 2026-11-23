import Foundation
import XCTest

@testable import CentraidApp

final class LockerClipboardLeaseTests: XCTestCase {
    private func directory() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("centraid-clipboard-lease-tests-\(UUID().uuidString)", isDirectory: true)
    }

    private func remove(_ directory: URL) {
        try? FileManager.default.removeItem(at: directory)
    }

    func testLeasePersistsVaultMarkerAndExpiryAndClearsTheMatchingItem() throws {
        let directory = directory()
        defer { remove(directory) }
        let expiry = Date(timeIntervalSince1970: 1_800_000_000)
        try LockerClipboardLeaseStore.record(
            vaultID: "vault-a",
            token: "opaque-marker-a",
            expiresAt: expiry,
            directory: directory
        )

        XCTAssertEqual(
            LockerClipboardLeaseStore.load(directory: directory),
            LockerClipboardLease(
                vaultID: "vault-a",
                token: "opaque-marker-a",
                expiresAt: expiry
            )
        )
        let metadataURL = directory.appendingPathComponent("locker-clipboard-lease-v1.plist")
        XCTAssertEqual(
            try metadataURL.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup,
            true
        )
        var didReadMarker = false
        var didClearPasteboard = false
        let cleared = LockerClipboardLeaseStore.clearOwned(
            vaultID: "vault-a",
            markerPresent: { true },
            readMarkerToken: {
                didReadMarker = true
                return "opaque-marker-a"
            },
            clearPasteboard: { didClearPasteboard = true },
            directory: directory
        )

        XCTAssertTrue(cleared)
        XCTAssertTrue(didReadMarker)
        XCTAssertTrue(didClearPasteboard)
        XCTAssertNil(LockerClipboardLeaseStore.load(directory: directory))
    }

    func testUnrelatedClipboardWithoutMarkerIsPreservedWithoutReadingItsContents() throws {
        let directory = directory()
        defer { remove(directory) }
        try LockerClipboardLeaseStore.record(
            vaultID: "vault-a",
            token: "opaque-marker-a",
            expiresAt: Date(timeIntervalSince1970: 1_800_000_000),
            directory: directory
        )
        var didReadMarker = false
        var didClearPasteboard = false

        let cleared = LockerClipboardLeaseStore.clearOwned(
            vaultID: "vault-a",
            markerPresent: { false },
            readMarkerToken: {
                didReadMarker = true
                return "unrelated text"
            },
            clearPasteboard: { didClearPasteboard = true },
            directory: directory
        )

        XCTAssertFalse(cleared)
        XCTAssertFalse(didReadMarker, "type metadata gates every marker-content read")
        XCTAssertFalse(didClearPasteboard)
        XCTAssertNil(LockerClipboardLeaseStore.load(directory: directory))
    }

    func testTokenMismatchPreservesANewerClipboardItemEvenIfGenerationWasReused() throws {
        let directory = directory()
        defer { remove(directory) }
        try LockerClipboardLeaseStore.record(
            vaultID: "vault-a",
            token: "old-process-marker",
            expiresAt: Date(timeIntervalSince1970: 1_800_000_000),
            directory: directory
        )
        // A reboot can reuse a numeric pasteboard generation. Ownership depends on the item
        // marker token, never on that counter.
        var didClearPasteboard = false

        let cleared = LockerClipboardLeaseStore.clearOwned(
            vaultID: "vault-a",
            markerPresent: { true },
            readMarkerToken: { "newer-unrelated-marker" },
            clearPasteboard: { didClearPasteboard = true },
            directory: directory
        )

        XCTAssertFalse(cleared)
        XCTAssertFalse(didClearPasteboard)
        XCTAssertNil(LockerClipboardLeaseStore.load(directory: directory))
    }

    func testReplacementBetweenOwnershipCheckAndClearIsRevalidated() throws {
        let directory = directory()
        defer { remove(directory) }
        try LockerClipboardLeaseStore.record(
            vaultID: "vault-a",
            token: "opaque-marker-a",
            expiresAt: Date(timeIntervalSince1970: 1_800_000_000),
            directory: directory
        )
        var tokenReads = 0
        var didClearPasteboard = false

        let cleared = LockerClipboardLeaseStore.clearOwned(
            vaultID: "vault-a",
            markerPresent: { true },
            readMarkerToken: {
                tokenReads += 1
                return tokenReads == 1 ? "opaque-marker-a" : "newer-marker"
            },
            clearPasteboard: { didClearPasteboard = true },
            directory: directory
        )

        XCTAssertFalse(cleared)
        XCTAssertEqual(tokenReads, 2, "ownership is checked again immediately before clearing")
        XCTAssertFalse(didClearPasteboard)
        XCTAssertNil(LockerClipboardLeaseStore.load(directory: directory))
    }

    func testNoDigestIsPersistedAndAnOldOneIsRewrittenAway() throws {
        let directory = directory()
        defer { remove(directory) }
        try LockerClipboardLeaseStore.record(
            vaultID: "vault-a",
            token: "opaque-marker-a",
            expiresAt: Date(timeIntervalSince1970: 1_800_000_000),
            directory: directory
        )
        let url = directory.appendingPathComponent("locker-clipboard-lease-v1.plist")
        func keys() throws -> Set<String> {
            let raw = try PropertyListSerialization.propertyList(
                from: Data(contentsOf: url), options: [], format: nil
            ) as? [String: Any]
            return Set(raw?.keys.map { $0 } ?? [])
        }
        XCTAssertEqual(try keys(), ["vaultID", "token", "expiresAt"])

        let legacy: [String: Any] = [
            "vaultID": "vault-a",
            "token": "opaque-marker-a",
            "digest": "0123abcd",
            "expiresAt": Date(timeIntervalSince1970: 1_800_000_000),
        ]
        try PropertyListSerialization.data(fromPropertyList: legacy, format: .binary, options: 0)
            .write(to: url)

        XCTAssertEqual(LockerClipboardLeaseStore.load(directory: directory)?.token, "opaque-marker-a")
        XCTAssertEqual(try keys(), ["vaultID", "token", "expiresAt"])
    }

    func testAnotherVaultDoesNotReadOrConsumeTheCurrentLease() throws {
        let directory = directory()
        defer { remove(directory) }
        try LockerClipboardLeaseStore.record(
            vaultID: "vault-b",
            token: "opaque-marker-b",
            expiresAt: Date(timeIntervalSince1970: 1_800_000_000),
            directory: directory
        )
        var didInspectPasteboard = false

        let cleared = LockerClipboardLeaseStore.clearOwned(
            vaultID: "vault-a",
            markerPresent: {
                didInspectPasteboard = true
                return true
            },
            readMarkerToken: { "opaque-marker-b" },
            clearPasteboard: {},
            directory: directory
        )

        XCTAssertFalse(cleared)
        XCTAssertFalse(didInspectPasteboard)
        XCTAssertEqual(LockerClipboardLeaseStore.load(directory: directory)?.vaultID, "vault-b")
    }

    func testEmptyVaultIdCannotCreateAnOwnedLease() throws {
        let directory = directory()
        defer { remove(directory) }
        try LockerClipboardLeaseStore.record(
            vaultID: "vault-a",
            token: "opaque-marker-a",
            expiresAt: Date(timeIntervalSince1970: 1_800_000_000),
            directory: directory
        )

        try LockerClipboardLeaseStore.record(
            vaultID: "",
            token: "",
            expiresAt: Date(timeIntervalSince1970: 1_800_000_030),
            directory: directory
        )

        XCTAssertNil(LockerClipboardLeaseStore.load(directory: directory))
    }

    func testLegacyTextClearRetiresOnlyAnOwnedLeaseWhoseMarkerIsGone() {
        XCTAssertEqual(
            LockerClipboardLeaseStore.legacyClearAction(
                leasePresent: true,
                markerPresent: true
            ),
            .keepOwnedLease
        )
        XCTAssertEqual(
            LockerClipboardLeaseStore.legacyClearAction(
                leasePresent: true,
                markerPresent: false
            ),
            .retireStaleLease
        )
        XCTAssertEqual(
            LockerClipboardLeaseStore.legacyClearAction(
                leasePresent: false,
                markerPresent: true
            ),
            .inspectUnownedText
        )
    }
}
