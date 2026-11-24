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
/// ## WHY TOP-LEVEL DIRECTORY PROTECTION INSTEAD OF A FULL RECURSIVE WALK
///
/// `ShellModel` calls `VaultFileProtection.secure(directory:)` synchronously
/// during launch and when entering the background. Walking every file under
/// `vault.bytes/` (`90,000+` blob files) performs `180,000+` syscalls on the
/// main thread and risks an iOS watchdog (`0x8badf00d`) kill.
///
/// On iOS / APFS:
///
/// 1. **Apple QA1719 directory backup exclusion:** setting
///    `URLResourceValues.isExcludedFromBackup = true` on a directory excludes
///    that directory and **all** of its descendants from iCloud/Finder backup.
/// 2. **APFS `FileProtectionType` inheritance:** setting
///    `FileProtectionType.completeUntilFirstUserAuthentication` on a directory
///    causes newly created files and subdirectories inside it to inherit that
///    protection class automatically.
///
/// Therefore `secure(directory:)` marks `root`, pre-creates and marks
/// `vault.bytes/` and `vault.staging/` before the core writes into them, marks
/// immediate top-level children of `root`, and marks only the immediate shard
/// directories inside `vault.bytes/` (at most 256 two-hex-char fan-out
/// directories), never descending into individual blob files.
///
/// Each vault's directory holds, by R-1029-8's list as #1212 left it:
///
/// | Path | Made by | What it is |
/// |---|---|---|
/// | `vault.db`, `-wal`, `-shm` | the Rust shelf names it (`crates/screens/src/vault`); SQLite | the vault |
/// | `vault.bytes/` | pre-created here / the core's content store (`crates/blobs`) | originals with no OS-library home, and every derivative (256 shard directories) |
/// | `vault.state.db`, `-wal`, `-shm` | the core's backup state (`crates/vault/src/backup/state.rs`) | destinations, confirmations, blob chunks — device-local and derived |
/// | `vault.staging/` | pre-created here / the core's staging area (`crates/vault/src/backup/staging.rs`) | sealed parts and OS-library streams waiting for a gateway, which the OS reads while the app is suspended |
/// | `vault.scratch/` | the core during "Check my backup" | temporary restore check directory |
///
/// and the directory itself holds `.centraid-upload-pins.plist`, the gateway
/// certificates the background mover pins against (`UploadPins`). Locker's
/// `K` is not among them: it is derived from the seed in the core's memory
/// and never written (#1047, Q-1047-11). None of those layers can call
/// `URL.setResourceValues`, and the one layer that both owns this directory and
/// can is the shell — `ShellModel.vaultDirectory` is where the path is made.
/// So the shell secures the top-level structure once before the core opens,
/// once after, and again whenever the app goes to the background, which is the
/// moment before iOS would take a backup.
///
/// ## DATA PROTECTION, AND WHY NOT `.complete`
///
/// #1029 line 84 says `completeUntilFirstUserAuthentication`, not `complete`,
/// and the reason is in the product: capture, backup upload and the byte
/// store's work continue while the phone is locked. Under `.complete` the file
/// becomes unreadable the moment the screen locks and every background task
/// that touches it fails — including the OS's own background uploads, which
/// read `vault.staging/` parts with this app suspended (#1080 ruling 2). Under
/// `.completeUntilFirstUserAuthentication` the file is encrypted at rest until
/// the member unlocks the phone once after a reboot, and readable after that.
/// It is the strongest class that does not make a background write a crash.
enum VaultFileProtection {
    /// The protection class every vault-derived path is written under
    /// (#1029 line 84).
    static let dataProtection = FileProtectionType.completeUntilFirstUserAuthentication

    /// Exclude `directory` and its top-level entries from OS backup, and set
    /// the data-protection class so APFS inheritance and QA1719 cover every
    /// descendant without walking `vault.bytes/`.
    ///
    /// Bounded work (`O(top-level entries + <=256 shard directories)`): never
    /// walks individual blob files inside `vault.bytes/`.
    ///
    /// It never throws. A phone whose filesystem refused one of these is a
    /// phone whose vault still has to open; the refusal is logged and the next
    /// sweep tries again.
    static func secure(directory: String) {
        let fm = FileManager.default
        let root = URL(fileURLWithPath: directory, isDirectory: true)
        exclude(root)

        if fm.fileExists(atPath: root.path) {
            for name in ["vault.bytes", "vault.staging"] {
                let sub = root.appendingPathComponent(name, isDirectory: true)
                try? fm.createDirectory(
                    at: sub,
                    withIntermediateDirectories: true,
                    attributes: [.protectionKey: dataProtection]
                )
                exclude(sub)
            }
        }

        if let items = try? fm.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: []
        ) {
            for item in items {
                exclude(item)
            }
        }

        let bytesRoot = root.appendingPathComponent("vault.bytes", isDirectory: true)
        if let shards = try? fm.contentsOfDirectory(
            at: bytesRoot,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: []
        ) {
            for shard in shards {
                if (try? shard.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
                    exclude(shard)
                }
            }
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
