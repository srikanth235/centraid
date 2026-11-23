import Foundation

/// The shell's restart-safe ownership record for the latest Locker clipboard item.
/// It contains no clipboard text and no digest of it (a short PIN or code would fall to an
/// offline guess), only an opaque item marker, its vault and the original OS expiry. The marker
/// token proves ownership: a pasteboard item is immutable once set, so the same token means the
/// same item.
struct LockerClipboardLease: Codable, Equatable, Sendable {
    let vaultID: String
    let token: String
    let expiresAt: Date
}

enum LockerClipboardLeaseDisposition: Equatable {
    case ignore
    case discard
    case clear
}

enum LockerLegacyClearAction: Equatable {
    case inspectUnownedText
    case keepOwnedLease
    case retireStaleLease
}

enum LockerClipboardLeaseStore {
    static let markerType = "dev.centraid.locker-clipboard-owner"
    private static let fileName = "locker-clipboard-lease-v1.plist"

    static func disposition(
        lease: LockerClipboardLease,
        requestedVaultID: String,
        markerPresent: Bool,
        markerToken: String?
    ) -> LockerClipboardLeaseDisposition {
        guard !requestedVaultID.isEmpty, lease.vaultID == requestedVaultID else {
            return .ignore
        }
        guard markerPresent else { return .discard }
        guard let markerToken else { return .ignore }
        return markerToken == lease.token ? .clear : .discard
    }

    static func legacyClearAction(leasePresent: Bool, markerPresent: Bool) -> LockerLegacyClearAction {
        guard leasePresent else { return .inspectUnownedText }
        return markerPresent ? .keepOwnedLease : .retireStaleLease
    }

    static func load(directory: URL? = nil) -> LockerClipboardLease? {
        guard let url = fileURL(directory: directory),
            let data = try? Data(contentsOf: url)
        else { return nil }
        guard let lease = try? PropertyListDecoder().decode(LockerClipboardLease.self, from: data) else {
            return nil
        }
        // An older build also stored an unsalted digest of the text. Rewrite without it.
        if let raw = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil)
            as? [String: Any], raw["digest"] != nil,
            let clean = try? PropertyListEncoder().encode(lease)
        {
            try? clean.write(
                to: url,
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
        }
        return lease
    }

    /// Synchronously publish ownership metadata before the OS copy is reported complete.
    /// The metadata file is local-only, protected at rest, and excluded from device backup.
    static func record(
        vaultID: String,
        token: String,
        expiresAt: Date,
        directory: URL? = nil
    ) throws {
        guard !vaultID.isEmpty, !token.isEmpty else {
            remove(directory: directory)
            return
        }
        guard var url = fileURL(directory: directory) else {
            throw CocoaError(.fileWriteUnknown)
        }
        let lease = LockerClipboardLease(
            vaultID: vaultID,
            token: token,
            expiresAt: expiresAt
        )
        let data = try PropertyListEncoder().encode(lease)
        let previous = try? Data(contentsOf: url)
        do {
            try data.write(
                to: url,
                options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
            )
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try url.setResourceValues(values)
        } catch {
            // A failed metadata publication must not replace the previous copy's ownership.
            if let previous {
                try? previous.write(
                    to: url,
                    options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
                )
                var values = URLResourceValues()
                values.isExcludedFromBackup = true
                try? url.setResourceValues(values)
            } else {
                remove(directory: directory)
            }
            throw error
        }
    }

    static func remove(directory: URL? = nil) {
        guard let url = fileURL(directory: directory) else { return }
        try? FileManager.default.removeItem(at: url)
    }

    private static func fileURL(directory: URL?) -> URL? {
        let base: URL
        if let directory {
            base = directory
        } else if let appSupport = try? FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ) {
            base = appSupport
        } else {
            return nil
        }
        do {
            try FileManager.default.createDirectory(
                at: base,
                withIntermediateDirectories: true,
                attributes: nil
            )
        } catch {
            return nil
        }
        return base.appendingPathComponent(fileName, isDirectory: false)
    }

    /// Clears only the current item carrying the exact marker token published with `vaultID`.
    /// The type check gates marker access.
    @discardableResult
    static func clearOwned(
        vaultID: String,
        markerPresent: () -> Bool,
        readMarkerToken: () -> String?,
        clearPasteboard: () -> Void,
        directory: URL? = nil
    ) -> Bool {
        guard let lease = load(directory: directory) else { return false }
        guard lease.vaultID == vaultID, !vaultID.isEmpty else { return false }
        let present = markerPresent()
        let token = present ? readMarkerToken() : nil
        switch disposition(
            lease: lease,
            requestedVaultID: vaultID,
            markerPresent: present,
            markerToken: token
        ) {
        case .ignore:
            return false
        case .discard:
            remove(directory: directory)
            return false
        case .clear:
            // Pasteboard contents may change after the first read. Recheck the type marker and
            // token synchronously immediately before the destructive assignment.
            let stillPresent = markerPresent()
            let currentToken = stillPresent ? readMarkerToken() : nil
            switch disposition(
                lease: lease,
                requestedVaultID: vaultID,
                markerPresent: stillPresent,
                markerToken: currentToken
            ) {
            case .ignore:
                return false
            case .discard:
                remove(directory: directory)
                return false
            case .clear:
                break
            }
            remove(directory: directory)
            clearPasteboard()
            return true
        }
    }
}
