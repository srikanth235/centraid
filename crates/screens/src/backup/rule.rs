//! THE MEMBER'S TRANSFER RULE AND THE VIDEOS BIT (#1025 S4, #1080), as this phone
//! keeps them.
//!
//! **One setting for both directions**: the pass carries the rule on
//! `DrainRequest.rule` for what this phone BACKS UP, and the fetch window on
//! `originals` for what it DOWNLOADS. The Home header's sheet and the Backup
//! screen draw the same three choices from one store.
//!
//! **One per DEVICE, not per vault**: what it governs is a data plan, and a phone
//! has one however many vaults it holds. It lives in the shell's device-only
//! store (a small per-device value that has to survive a relaunch), under the
//! keys below, and is read and written as `SecretOp`s.
//!
//! **This module does none of the arithmetic.** What a pass may seal and move
//! under which rule on which link is the core's `phone::drain::Conditions`; a
//! second copy here would be a second rule deciding a member's bill. **No sizes
//! and no ceilings appear in this file.** A video's original never crosses a
//! metered link whatever the rule: that is the core's fixed rule, not a fourth
//! choice.
//!
//! An unreadable value is the DEFAULT, not an error: a member whose preferences
//! were written by a newer build must still back up, and the default is the
//! conservative one, so the failure mode of an unknown word is a phone that
//! spends less, never one that spends more.

use centraid_api_proto::core_v1 as wire;

use crate::strings::{Locale, backup_home as words};

/// The device-store key of the rule.
pub const RULE_KEY: &str = "transfer-rule";

/// The device-store key of the second control: whether video originals are
/// backed up at all. Its own key because it answers a different question (what,
/// not over which link).
pub const INCLUDE_VIDEOS_KEY: &str = "transfer-rule.include-videos";

/// What the videos key holds while videos are left out. **Included is stored as
/// absence**, so the store holds a key only while the member is spending less
/// than the default, and the complete backup is the default.
const EXCLUDED: &str = "excluded";

/// The member's rule.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TransferRule {
    /// THE DEFAULT. Its failure mode is a late photograph, not a bill.
    #[default]
    WifiOnly,
    /// A photograph's original on cellular; a video's still waits for Wi-Fi.
    WifiAndCellularPhotos,
    /// Nothing ARRIVES on its own; the member taps what they want. Backing up
    /// has no tap, so what this phone sends under it waits for Wi-Fi.
    Manual,
}

impl TransferRule {
    /// In the order a sheet lists them.
    pub const ALL: [Self; 3] = [Self::WifiOnly, Self::WifiAndCellularPhotos, Self::Manual];

    /// The word the store holds, so a dump is readable.
    #[must_use]
    pub const fn stored(self) -> &'static str {
        match self {
            Self::WifiOnly => "wifi-only",
            Self::WifiAndCellularPhotos => "wifi-and-cellular-photos",
            Self::Manual => "manual",
        }
    }

    /// The rule a stored word names; anything else is the default.
    #[must_use]
    pub fn of(stored: Option<&str>) -> Self {
        Self::ALL
            .into_iter()
            .find(|rule| Some(rule.stored()) == stored)
            .unwrap_or_default()
    }

    /// The sentence a member reads: plain, and never a label plus a footnote.
    #[must_use]
    pub fn sentence(self, locale: Locale) -> String {
        match self {
            Self::WifiOnly => words::rule_wifi_only(locale),
            Self::WifiAndCellularPhotos => words::rule_wifi_and_cellular_photos(locale),
            Self::Manual => words::rule_manual(locale),
        }
    }

    /// The value a pass carries. One conversion, here, so the enum and the proto
    /// cannot become two vocabularies.
    #[must_use]
    pub const fn to_wire(self) -> wire::TransferRule {
        match self {
            Self::WifiOnly => wire::TransferRule::WifiOnly,
            Self::WifiAndCellularPhotos => wire::TransferRule::WifiAndCellularPhotos,
            Self::Manual => wire::TransferRule::Manual,
        }
    }
}

fn device(op: wire::secret_op::Op, key: &str, value: &str) -> wire::SecretOp {
    wire::SecretOp {
        op: op as i32,
        store: wire::SecretStore::Device as i32,
        key: key.to_owned(),
        value: value.as_bytes().to_vec(),
    }
}

/// The two reads, in this order: the rule, then whether videos are included.
#[must_use]
pub fn read_ops() -> Vec<wire::SecretOp> {
    vec![
        device(wire::secret_op::Op::Get, RULE_KEY, ""),
        device(wire::secret_op::Op::Get, INCLUDE_VIDEOS_KEY, ""),
    ]
}

/// The rule and the videos bit from the answers to [`read_ops`]. An answer that
/// did not come is the default for that control.
#[must_use]
pub fn from_answers(answers: &[wire::SecretAnswer]) -> (TransferRule, bool) {
    let text = |at: usize| {
        answers
            .get(at)
            .filter(|answer| answer.ok && answer.found)
            .map(|answer| String::from_utf8_lossy(&answer.value).into_owned())
    };
    (
        TransferRule::of(text(0).as_deref()),
        text(1).as_deref() != Some(EXCLUDED),
    )
}

/// Keep `rule`.
#[must_use]
pub fn write_rule(rule: TransferRule) -> wire::SecretOp {
    device(wire::secret_op::Op::Set, RULE_KEY, rule.stored())
}

/// Keep whether videos are included; included is stored as absence.
#[must_use]
pub fn write_include_videos(include: bool) -> wire::SecretOp {
    device(
        wire::secret_op::Op::Set,
        INCLUDE_VIDEOS_KEY,
        if include { "" } else { EXCLUDED },
    )
}
