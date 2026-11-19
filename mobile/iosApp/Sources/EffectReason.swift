import Foundation

/// The reasons this shell gives when it cannot perform an effect (`EffectFailed.reason`).
///
/// A reason is a fact, never words: the core decides what a member reads for each case. These
/// values are the `pub const`s of `crates/screens/src/effect_reason.rs`; the
/// `native-effect-reasons` rule (`cargo xtask rules`) fails when this enum and that file differ,
/// or when a shell passes any other literal as a reason.
enum EffectReason {
    static let denied = "denied"
    static let unavailable = "unavailable"
    static let unreadable = "unreadable"
    static let tooLarge = "too_large"
    static let unwritable = "unwritable"
    static let storageFull = "storage_full"
    static let notWatched = "not_watched"
    static let noWindow = "no_window"
    static let unsupported = "unsupported"
    static let cancelled = "cancelled"
    static let failed = "failed"
}

extension EffectReason {
    /// WHY A WRITE FAILED, as a fact for the core to word: a full phone (`NSFileWriteOutOfSpaceError`,
    /// `ENOSPC`, here or under the error) is `storageFull`; anything else is `otherwise`.
    static func ofWrite(_ error: Swift.Error, otherwise: String) -> String {
        let ns = error as NSError
        let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError
        let full = [ns, underlying].compactMap { $0 }.contains {
            ($0.domain == NSCocoaErrorDomain && $0.code == NSFileWriteOutOfSpaceError)
                || ($0.domain == NSPOSIXErrorDomain && $0.code == Int(ENOSPC))
        }
        return full ? storageFull : otherwise
    }
}
