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
    static let unwritable = "unwritable"
    static let notWatched = "not_watched"
    static let noWindow = "no_window"
    static let unsupported = "unsupported"
    static let cancelled = "cancelled"
    static let failed = "failed"
}
