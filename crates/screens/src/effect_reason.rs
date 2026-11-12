//! The reasons a shell gives when it cannot perform an effect (`EffectFailed.reason`).
//!
//! A reason is a FACT, never words: the shell sends one of these codes and the core decides
//! whether the member sees anything. Where a screen shows a sentence for a case, it picks that
//! sentence in Rust from the code (`UNAVAILABLE`, or `EffectFailed.denied` for a refused grant).
//! Every other code is log-only. The `native-effect-reasons` rule (`cargo xtask rules`) holds the
//! shells to this set: a literal passed as a reason that is not a `pub const` here is a finding.

/// The member's grant (or the system's permission) is not there. Sent with `denied = true`.
pub const DENIED: &str = "denied";
/// This phone has nothing that does it (no picker, no Reminders store, no app to open a link).
pub const UNAVAILABLE: &str = "unavailable";
/// The store or file was there but could not be read.
pub const UNREADABLE: &str = "unreadable";
/// The store or file was there but could not be written.
pub const UNWRITABLE: &str = "unwritable";
/// The phone store was asked for but this shell does not watch it.
pub const NOT_WATCHED: &str = "not_watched";
/// No window or screen was up to perform the effect over.
pub const NO_WINDOW: &str = "no_window";
/// The shell does not perform this effect, operation or version.
pub const UNSUPPORTED: &str = "unsupported";
/// The member dismissed the prompt. Sent with `cancelled = true`.
pub const CANCELLED: &str = "cancelled";
/// The effect did not complete and there is nothing more to say.
pub const FAILED: &str = "failed";
