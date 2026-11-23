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
            text: "synthetic Locker value",
            expiresAt: expiry,
            directory: directory
        )

        XCTAssertEqual(
            LockerClipboardLeaseStore.load(directory: directory),
            LockerClipboardLease(
                vaultID: "vault-a",
                token: "opaque-marker-a",
                digest: LockerClipboardLeaseStore.digest("synthetic Locker value"),
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
            readContentDigest: { LockerClipboardLeaseStore.digest("synthetic Locker value") },
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
            text: "synthetic Locker value",
            expiresAt: Date(timeIntervalSince1970: 1_800_000_000),
            directory: directory
        )
        var didReadMarker = false
        var didReadContent = false
        var didClearPasteboard = false

        let cleared = LockerClipboardLeaseStore.clearOwned(
            vaultID: "vault-a",
            markerPresent: { false },
            readMarkerToken: {
                didReadMarker = true
                return "unrelated text"
            },
            readContentDigest: {
                didReadContent = true
                return "unrelated digest"
            },
            clearPasteboard: { didClearPasteboard = true },
            directory: directory
        )

        XCTAssertFalse(cleared)
        XCTAssertFalse(didReadMarker, "type metadata gates every marker-content read")
        XCTAssertFalse(didReadContent)
        XCTAssertFalse(didClearPasteboard)
        XCTAssertNil(LockerClipboardLeaseStore.load(directory: directory))
    }

    func testTokenMismatchPreservesANewerClipboardItemEvenIfGenerationWasReused() throws {
        let directory = directory()
        defer { remove(directory) }
        try LockerClipboardLeaseStore.record(
            vaultID: "vault-a",
            token: "old-process-marker",
            text: "original Locker value",
            expiresAt: Date(timeIntervalSince1970: 1_800_000_000),
            directory: directory
        )
        // A reboot can reuse a numeric pasteboard generation. Ownership depends on the item
        // marker and content digest, never on that counter.
        var didReadContent = false
        var didClearPasteboard = false

        let cleared = LockerClipboardLeaseStore.clearOwned(
            vaultID: "vault-a",
            markerPresent: { true },
            readMarkerToken: { "newer-unrelated-marker" },
            readContentDigest: {
                didReadContent = true
                return "must-not-read"
            },
            clearPasteboard: { didClearPasteboard = true },
            directory: directory
        )

        XCTAssertFalse(cleared)
        XCTAssertFalse(didReadContent)
        XCTAssertFalse(didClearPasteboard)
        XCTAssertNil(LockerClipboardLeaseStore.load(directory: directory))
    }

    func testMatchingMarkerWithChangedContentDoesNotClearTheReplacement() throws {
        let directory = directory()
        defer { remove(directory) }
        try LockerClipboardLeaseStore.record(
            vaultID: "vault-a",
            token: "opaque-marker-a",
            text: "original Locker value",
            expiresAt: Date(timeIntervalSince1970: 1_800_000_000),
            directory: directory
        )
        var didClearPasteboard = false

        let cleared = LockerClipboardLeaseStore.clearOwned(
            vaultID: "vault-a",
            markerPresent: { true },
            readMarkerToken: { "opaque-marker-a" },
            readContentDigest: { LockerClipboardLeaseStore.digest("changed clipboard value") },
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
            text: "original Locker value",
            expiresAt: Date(timeIntervalSince1970: 1_800_000_000),
            directory: directory
        )
        var digestReads = 0
        var didClearPasteboard = false

        let cleared = LockerClipboardLeaseStore.clearOwned(
            vaultID: "vault-a",
            markerPresent: { true },
            readMarkerToken: { "opaque-marker-a" },
            readContentDigest: {
                digestReads += 1
                return digestReads == 1
                    ? LockerClipboardLeaseStore.digest("original Locker value")
                    : LockerClipboardLeaseStore.digest("newer clipboard value")
            },
            clearPasteboard: { didClearPasteboard = true },
            directory: directory
        )

        XCTAssertFalse(cleared)
        XCTAssertEqual(digestReads, 2, "ownership is checked again immediately before clearing")
        XCTAssertFalse(didClearPasteboard)
        XCTAssertNil(LockerClipboardLeaseStore.load(directory: directory))
    }

    func testUnavailableContentDigestPreservesLeaseForALaterExplicitLockRetry() throws {
        let directory = directory()
        defer { remove(directory) }
        try LockerClipboardLeaseStore.record(
            vaultID: "vault-a",
            token: "opaque-marker-a",
            text: "original Locker value",
            expiresAt: Date(timeIntervalSince1970: 1_800_000_000),
            directory: directory
        )
        let originalLease = LockerClipboardLeaseStore.load(directory: directory)
        var didClearPasteboard = false

        let firstAttempt = LockerClipboardLeaseStore.clearOwned(
            vaultID: "vault-a",
            markerPresent: { true },
            readMarkerToken: { "opaque-marker-a" },
            readContentDigest: { nil },
            clearPasteboard: { didClearPasteboard = true },
            directory: directory
        )

        XCTAssertFalse(firstAttempt)
        XCTAssertFalse(didClearPasteboard)
        XCTAssertEqual(LockerClipboardLeaseStore.load(directory: directory), originalLease)

        let retry = LockerClipboardLeaseStore.clearOwned(
            vaultID: "vault-a",
            markerPresent: { true },
            readMarkerToken: { "opaque-marker-a" },
            readContentDigest: { LockerClipboardLeaseStore.digest("original Locker value") },
            clearPasteboard: { didClearPasteboard = true },
            directory: directory
        )

        XCTAssertTrue(retry)
        XCTAssertTrue(didClearPasteboard)
        XCTAssertNil(LockerClipboardLeaseStore.load(directory: directory))
    }

    func testAnotherVaultDoesNotReadOrConsumeTheCurrentLease() throws {
        let directory = directory()
        defer { remove(directory) }
        try LockerClipboardLeaseStore.record(
            vaultID: "vault-b",
            token: "opaque-marker-b",
            text: "synthetic Locker value",
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
            readContentDigest: { "unused" },
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
            text: "synthetic Locker value",
            expiresAt: Date(timeIntervalSince1970: 1_800_000_000),
            directory: directory
        )

        try LockerClipboardLeaseStore.record(
            vaultID: "",
            token: "",
            text: "",
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
