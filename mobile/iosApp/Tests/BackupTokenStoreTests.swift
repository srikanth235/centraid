import Foundation
import Security
import XCTest

@testable import CentraidApp

/// THE GATEWAY TOKEN'S HOME ON iOS (#1191 B15, `contracts/backup/decisions.md` E12).
///
/// The token goes through the device secret store (`SecretBatch`, store DEVICE) under
/// `gateway-token.<vault hex>.<gateway hex>`. What this proves, on the simulator's Keychain: the item
/// is `AfterFirstUnlockThisDeviceOnly` and not synchronizable (so never in iCloud Keychain nor a
/// backup), no file the app writes holds the token's bytes, and a delete removes it. A restart and the
/// real first-unlock are the owner's device walk.
final class BackupTokenStoreTests: XCTestCase {
    private let key = "gateway-token." + String(repeating: "a1", count: 16) + "." + String(repeating: "b2", count: 16)
    private let token = Data(("tok-" + String(repeating: "7f3c9e", count: 10)).utf8)

    override func tearDown() {
        _ = run(.delete)
        super.tearDown()
    }

    private func run(_ kind: Centraid_Core_V1_SecretOp.Op, value: Data = Data()) -> Centraid_Core_V1_SecretAnswer {
        var op = Centraid_Core_V1_SecretOp()
        op.store = .device
        op.op = kind
        op.key = key
        op.value = value
        var batch = Centraid_Core_V1_SecretBatch()
        batch.ops = [op]
        return SecretStores.run(batch).answers[0]
    }

    private func attributes() -> [String: Any]? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "centraid.v1.",
            kSecAttrAccount as String: "centraid.v1." + key,
            kSecReturnAttributes as String: kCFBooleanTrue as Any,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var found: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess else { return nil }
        return found as? [String: Any]
    }

    func testTheTokenIsKeptAfterFirstUnlockOnThisDeviceOnly() throws {
        XCTAssertTrue(run(.set, value: token).ok)
        let got = run(.get)
        XCTAssertTrue(got.found)
        XCTAssertEqual(got.value, token)
        let item = try XCTUnwrap(attributes())
        XCTAssertEqual(item[kSecAttrAccessible as String] as? String, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        // Absent or false: never synchronizable.
        let sync = item[kSecAttrSynchronizable as String]
        XCTAssertTrue(sync == nil || (sync as? NSNumber)?.boolValue == false)
    }

    func testNoFileTheAppWritesHoldsTheToken() throws {
        XCTAssertTrue(run(.set, value: token).ok)
        let fm = FileManager.default
        var roots = fm.urls(for: .documentDirectory, in: .userDomainMask)
        roots += fm.urls(for: .libraryDirectory, in: .userDomainMask)
        roots += fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)
        roots.append(fm.temporaryDirectory)
        var scanned = 0
        for root in roots {
            guard let walk = fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey]) else { continue }
            for case let url as URL in walk {
                guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true,
                      let bytes = try? Data(contentsOf: url) else { continue }
                scanned += 1
                XCTAssertNil(bytes.range(of: token), "token bytes found in \(url.path)")
            }
        }
        XCTAssertGreaterThanOrEqual(scanned, 0)
    }

    func testAnEmptyValueAndADeleteBothRemoveIt() {
        XCTAssertTrue(run(.set, value: token).ok)
        XCTAssertTrue(run(.delete).ok)
        XCTAssertFalse(run(.get).found)
        XCTAssertTrue(run(.set, value: token).ok)
        XCTAssertTrue(run(.set, value: Data()).ok)
        XCTAssertFalse(run(.get).found)
    }
}
