#if canImport(UIKit)
import Foundation

/// **KEEP EVERY VAULT-DERIVED FILE OUT OF iCLOUD BACKUP, AND ENCRYPTED AT REST**
/// (#1029 line 84, F5; W13 finding 6).
///
/// The audit found nothing in this repository setting `isExcludedFromBackup` or
/// any `NSFileProtection` value — `grep -rn 'isExcludedFromBackup\|NSFileProtection' mobile crates`
/// was empty. So the vault file, its `-wal` and `-shm`, its `.bytes` store, the
/// backup spool, the scratch directory and the head all rode into iCloud
/// backup. Not in plaintext to iCloud's eye — a vault file is a SQLite database
/// of a member's rows, and it is the *file* that is secret — but a member's
/// entire vault ended up in a copy they did not ask for, on a service the whole
/// product exists to not depend on. Android has refused this since v0, three
/// ways at once, and iOS refused it nowhere:
///
/// ```
/// $ grep -rn 'allowBackup\|dataExtractionRules\|fullBackupContent' mobile
/// mobile/androidApp/src/main/AndroidManifest.xml:28:        android:allowBackup="false"
/// mobile/androidApp/src/main/AndroidManifest.xml:29:        android:dataExtractionRules="@xml/data_extraction_rules"
/// mobile/androidApp/src/main/AndroidManifest.xml:30:        android:fullBackupContent="@xml/full_backup_content"
/// ```
///
/// ## WHY THIS IS A SWEEP AND NOT AN ATTRIBUTE SET AT CREATION
///
/// **iOS does not inherit `isExcludedFromBackup`.** It is a per-item resource
/// value; a file created inside an excluded directory is not itself excluded,
/// which is the trap this whole class of bug lives in. So the directory gets it
/// *and* every item under it does.
///
/// And the items are not made here. The vault file's name is minted in
/// `Shelf` (Kotlin, `commonMain`); `-wal` and `-shm` are SQLite's; `.bytes` is
/// derived in `crates/core-ffi`; `objects/`, `spool/`, `scratch/` and
/// `head.json` are `BackupHome::open`'s. None of those layers can call
/// `URL.setResourceValues`, and the one layer that both owns this directory and
/// can is the shell — `ShellModel.vaultDirectory` is where the path is made.
/// So the shell sweeps: once before the core opens, once after, and again
/// whenever the app goes to the background, which is the moment before iOS
/// would take a backup.
///
/// ## DATA PROTECTION, AND WHY NOT `.complete`
///
/// #1029 line 84 says `completeUntilFirstUserAuthentication`, not `complete`,
/// and the reason is in the product: capture, backup upload and the byte
/// store's work continue while the phone is locked. Under `.complete` the file
/// becomes unreadable the moment the screen locks and every background task
/// that touches it fails; under `.completeUntilFirstUserAuthentication` the
/// file is encrypted at rest until the member unlocks the phone once after a
/// reboot, and readable after that. It is the strongest class that does not
/// make a background write a crash.
enum VaultFileProtection {
    /// The protection class every vault-derived path is written under
    /// (#1029 line 84).
    static let dataProtection = FileProtectionType.completeUntilFirstUserAuthentication

    /// Exclude `directory` and everything under it from OS backup, and set the
    /// data-protection class on each.
    ///
    /// Idempotent and cheap: setting a resource value that is already set is a
    /// no-op, and the directory holds a vault file and its sidecars rather than
    /// a member's photo library.
    ///
    /// It never throws. A phone whose filesystem refused one of these is a
    /// phone whose vault still has to open; the refusal is logged and the next
    /// sweep tries again.
    static func secure(directory: String) {
        let root = URL(fileURLWithPath: directory, isDirectory: true)
        exclude(root)
        guard
            let items = FileManager.default.enumerator(
                at: root,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: []
            )
        else { return }
        for case let item as URL in items {
            exclude(item)
        }
    }

    /// One item: excluded from backup, and written under the protection class.
    private static func exclude(_ url: URL) {
        var item = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        do {
            try item.setResourceValues(values)
        } catch {
            NSLog("centraid: could not exclude %@ from backup: %@", url.path, "\(error)")
        }
        do {
            try FileManager.default.setAttributes(
                [.protectionKey: dataProtection],
                ofItemAtPath: url.path
            )
        } catch {
            NSLog("centraid: could not set data protection on %@: %@", url.path, "\(error)")
        }
    }
}
#endif
