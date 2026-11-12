package dev.centraid.android.kit

/**
 * The reasons this shell gives when it cannot perform an effect (`EffectFailed.reason`).
 *
 * A reason is a fact, never words: the core decides what a member reads for each case. These
 * values are the `pub const`s of `crates/screens/src/effect_reason.rs`; the `native-effect-reasons`
 * rule (`cargo xtask rules`) fails when this object and that file differ, or when a shell passes
 * any other literal as a reason.
 */
object EffectReason {
    const val DENIED = "denied"
    const val UNAVAILABLE = "unavailable"
    const val UNREADABLE = "unreadable"
    const val UNWRITABLE = "unwritable"
    const val NOT_WATCHED = "not_watched"
    const val NO_WINDOW = "no_window"
    const val UNSUPPORTED = "unsupported"
    const val CANCELLED = "cancelled"
    const val FAILED = "failed"
}
