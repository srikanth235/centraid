import Foundation
import Security

// THE SHELL'S TWO SECRET STORES (#1135, lane H2): the performer of the generic
// `SecretBatch` and `SyncedSecretsProbe` effects. The shell keeps bytes; Rust
// decides what to keep and where (`crates/screens/src/custody/secrets.rs`).
//
// **THE ACCOUNT NAMES ARE TODAY'S**, so a member's seed and vault indices that an
// earlier build wrote are found after the update. Rust never spells a prefix:
//
// * DEVICE: `kSecClassGenericPassword`, service `centraid.v1.`, account
//   `centraid.v1.<key>`, `AfterFirstUnlockThisDeviceOnly` (what `IosSecureStore`
//   wrote). Never in iCloud Keychain and never in an encrypted backup.
// * SYNCED: service `centraid.v1.synced.`, account `<key>`, `kSecAttrSynchronizable`
//   true, `AfterFirstUnlock` WITHOUT `ThisDeviceOnly` (the two go together; a
//   synchronizable item with a device-only accessibility is refused). What
//   `IosSyncedSecrets` wrote: the seed and the seeds of vaults on their own words.
//
// A write is DELETE THEN ADD (`SecItemAdd` answers duplicate rather than
// replacing), an empty value deletes (an empty secret that reads back as
// present is a credential the app believes it has), and a SYNCHRONISED write
// reads back and answers `ok: false` when the value is not there: iCloud
// Keychain off still accepts an add on some systems.

enum SecretStores {
    private static let devicePrefix = "centraid.v1."
    private static let syncedService = "centraid.v1.synced."
    private static let probeKey = "availability-probe"

    /// Run `batch` in order, one answer per op.
    static func run(_ batch: Centraid_Core_V1_SecretBatch) -> Centraid_Core_V1_SecretBatched {
        var done = Centraid_Core_V1_SecretBatched()
        done.answers = batch.ops.map(perform)
        return done
    }

    /// Whether a synchronizable item round-trips right now (iCloud Keychain on).
    /// The Keychain will not answer "is iCloud Keychain on" directly; whether an
    /// item round-trips is the same question asked the only way iOS answers it.
    static func probe() -> Centraid_Core_V1_SyncedSecretsStatus {
        let value = Data("probe".utf8)
        let stored = write(.synced, key: probeKey, value: value)
        let readBack = stored ? read(.synced, key: probeKey) : nil
        _ = delete(.synced, key: probeKey)
        var status = Centraid_Core_V1_SyncedSecretsStatus()
        status.synchronizing = readBack == value
        // True on iOS: an iCloud Keychain item comes back whenever the member
        // signs in, not only during a setup wizard.
        status.restoresAfterSetup = true
        return status
    }

    private enum Store { case device, synced }

    private static func perform(_ op: Centraid_Core_V1_SecretOp) -> Centraid_Core_V1_SecretAnswer {
        let store: Store = op.store == .synced ? .synced : .device
        var answer = Centraid_Core_V1_SecretAnswer()
        switch op.op {
        case .get:
            answer.ok = true
            if let value = read(store, key: op.key) {
                answer.found = true
                answer.value = value
            }
        case .set:
            if op.value.isEmpty {
                answer.ok = delete(store, key: op.key)
            } else {
                answer.ok = write(store, key: op.key, value: op.value)
                // A SYNCHRONISED SET MUST READ BACK: ok only when the value is there.
                if answer.ok, store == .synced { answer.ok = read(store, key: op.key) == op.value }
            }
        case .delete:
            answer.ok = delete(store, key: op.key)
        case .list:
            answer.ok = true
            answer.entries = list(store, prefix: op.key)
        default:
            break
        }
        return answer
    }

    private static func service(_ store: Store) -> String {
        store == .synced ? syncedService : devicePrefix
    }

    private static func account(_ store: Store, key: String) -> String {
        store == .synced ? key : devicePrefix + key
    }

    private static func query(_ store: Store, key: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service(store),
        ]
        if let key { query[kSecAttrAccount as String] = account(store, key: key) }
        // THE ONE ATTRIBUTE THE SYNCED STORE EXISTS FOR.
        if store == .synced { query[kSecAttrSynchronizable as String] = kCFBooleanTrue }
        return query
    }

    private static func read(_ store: Store, key: String) -> Data? {
        var request = query(store, key: key)
        request[kSecReturnData as String] = kCFBooleanTrue
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var found: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &found) == errSecSuccess else { return nil }
        return found as? Data
    }

    private static func write(_ store: Store, key: String, value: Data) -> Bool {
        // REPLACE, NEVER TWO: a second value under one key is a phone that
        // answers whichever the Keychain happened to return.
        _ = delete(store, key: key)
        var add = query(store, key: key)
        add[kSecValueData as String] = value
        // ONLY ON THE ADD: `kSecAttrAccessible` is a matching attribute as well
        // as a stored one, so putting it in the read and delete queries would
        // miss any item an earlier build wrote with a different accessibility.
        add[kSecAttrAccessible as String] = store == .synced
            ? kSecAttrAccessibleAfterFirstUnlock
            : kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        if status != errSecSuccess {
            NSLog("centraid: the secure store refused a write (OSStatus %d)", status)
        }
        return status == errSecSuccess
    }

    private static func delete(_ store: Store, key: String) -> Bool {
        let status = SecItemDelete(query(store, key: key) as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    private static func list(_ store: Store, prefix: String) -> [Centraid_Core_V1_SecretEntry] {
        var request = query(store, key: nil)
        request[kSecReturnAttributes as String] = kCFBooleanTrue
        request[kSecReturnData as String] = kCFBooleanTrue
        request[kSecMatchLimit as String] = kSecMatchLimitAll
        var found: CFTypeRef?
        guard SecItemCopyMatching(request as CFDictionary, &found) == errSecSuccess,
              let items = found as? [[String: Any]] else { return [] }
        let strip = store == .device ? devicePrefix : ""
        return items.compactMap { item in
            guard let account = item[kSecAttrAccount as String] as? String,
                  let value = item[kSecValueData as String] as? Data,
                  account.hasPrefix(strip) else { return nil }
            let key = String(account.dropFirst(strip.count))
            guard key.hasPrefix(prefix) else { return nil }
            var entry = Centraid_Core_V1_SecretEntry()
            entry.key = key
            entry.value = value
            return entry
        }
    }
}
