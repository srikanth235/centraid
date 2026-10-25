//! THE MEMBER'S TRANSFER RULE, and the one other setting that decides what a
//! pass may seal (#1025 S4, #1080).
//!
//! **One setting for both directions**: the pass carries it on
//! `DrainRequest.rule` for what this phone BACKS UP, and the fetch window uses
//! it for what it DOWNLOADS. Bytes are never pushed, they are PLANNED, and the
//! plan is the member's: the gateway cannot know which SIM is in the phone or
//! whether the member is abroad.
//!
//! ## One per DEVICE, not per vault
//!
//! What this governs is a data plan, and a phone has one however many vaults it
//! holds. It lives in the device secret store because that is the only durable
//! key-value the shell has; not because it is a secret.
//!
//! ## The arithmetic is the core's
//!
//! This carries a member's choice onto the wire and nothing else. What a pass
//! may seal and move under which rule on which link is the core's
//! `phone::drain::Conditions`, in one place; a copy here would be a second rule
//! deciding a member's bill. No sizes and no ceilings appear in this file.
//!
//! ## Thumbnails and previews are not in here
//!
//! A thumbnail crosses on any link and ahead of everything, because it is
//! kilobytes and it is the grid. Only the originals are worth a decision. A
//! video's original never crosses a metered link: no setting turns it off.

use centraid_api_proto::core_v1 as wire;

use crate::custody::secrets::VaultSecrets;
use crate::strings::{self, Locale};

/// The device-store key of the rule.
pub const KEY: &str = "transfer-rule";
/// The device-store key of "Include videos". Its own key because it answers a
/// different question: what, not over which link.
pub const INCLUDE_VIDEOS_KEY: &str = "transfer-rule.include-videos";
/// Stored while the member spends less than the default. **Absent is
/// INCLUDED**: the complete backup is the default, which is also why the wire
/// spells it `exclude_videos` (proto3's zero value is the whole library).
const EXCLUDED: &str = "excluded";

/// The member's rule for originals.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum TransferRule {
    /// THE DEFAULT.
    #[default]
    WifiOnly,
    /// A photograph's original on cellular; a video's still waits for Wi-Fi.
    WifiAndCellularPhotos,
    /// Nothing arrives on its own; what this phone sends waits for Wi-Fi.
    Manual,
}

impl TransferRule {
    /// The three choices, in the order the sheet draws them.
    pub const ALL: [Self; 3] = [Self::WifiOnly, Self::WifiAndCellularPhotos, Self::Manual];

    /// What the store holds: a word, so a dump is readable.
    #[must_use]
    pub fn stored(self) -> &'static str {
        match self {
            Self::WifiOnly => "wifi-only",
            Self::WifiAndCellularPhotos => "wifi-and-cellular-photos",
            Self::Manual => "manual",
        }
    }

    /// **An unreadable value is the default, not a failure**: a member whose
    /// preferences were written by a newer build must still sync, and the
    /// default is the conservative one, so an unknown word is a phone that
    /// spends less, never one that spends more.
    #[must_use]
    pub fn of(stored: Option<&str>) -> Self {
        Self::ALL
            .into_iter()
            .find(|rule| Some(rule.stored()) == stored)
            .unwrap_or_default()
    }

    /// The value a pass carries: one conversion, so the enum and the proto are
    /// not two vocabularies.
    #[must_use]
    pub fn wire(self) -> wire::TransferRule {
        match self {
            Self::WifiOnly => wire::TransferRule::WifiOnly,
            Self::WifiAndCellularPhotos => wire::TransferRule::WifiAndCellularPhotos,
            Self::Manual => wire::TransferRule::Manual,
        }
    }

    /// The sentence a member reads for this choice.
    #[must_use]
    pub fn sentence(self, locale: Locale) -> String {
        match self {
            Self::WifiOnly => strings::passes::rule_wifi_only(locale),
            Self::WifiAndCellularPhotos => strings::passes::rule_wifi_and_cellular_photos(locale),
            Self::Manual => strings::passes::rule_manual(locale),
        }
    }
}

/// The heading the transfer sheet draws.
#[must_use]
pub fn title(locale: Locale) -> String {
    strings::passes::transfer_title(locale)
}

/// What the sheet says under the heading, once, rather than repeating "on this
/// phone" in all three sentences.
#[must_use]
pub fn subtitle(locale: Locale) -> String {
    strings::passes::transfer_subtitle(locale)
}

/// The line the header draws when a rule is holding originals back; empty when
/// none is.
#[must_use]
pub fn waiting_sentence(locale: Locale, count: u64) -> String {
    if count == 0 {
        String::new()
    } else {
        strings::passes::originals_waiting(locale, count)
    }
}

/// The two settings a pass reads at its start, never cached across passes: a
/// phone that leaves Wi-Fi between two passes must carry the new answer into
/// the second, and a member who changed the rule must see it in the next one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rules {
    pub rule: TransferRule,
    pub include_videos: bool,
}

impl Default for Rules {
    fn default() -> Self {
        Self {
            rule: TransferRule::default(),
            include_videos: true,
        }
    }
}

impl Rules {
    /// What the device store holds, as the shell last said (see
    /// [`VaultSecrets::absorb`]); the defaults before it was read.
    #[must_use]
    pub fn read(secrets: &VaultSecrets) -> Self {
        Self {
            rule: TransferRule::of(secrets.device_value(KEY).as_deref()),
            include_videos: secrets.device_value(INCLUDE_VIDEOS_KEY).as_deref() != Some(EXCLUDED),
        }
    }

    /// The op that writes the rule. Send it as a `SecretBatch` and absorb the
    /// answer; the new rule is then what [`Self::read`] answers.
    #[must_use]
    pub fn write_rule(rule: TransferRule) -> wire::SecretOp {
        VaultSecrets::device_set(KEY, rule.stored())
    }

    /// The op that writes "Include videos". **Included is stored as absence**,
    /// so the store holds a key only while the member is spending less than
    /// the default.
    #[must_use]
    pub fn write_include_videos(include: bool) -> wire::SecretOp {
        VaultSecrets::device_set(INCLUDE_VIDEOS_KEY, if include { "" } else { EXCLUDED })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unknown_word_is_the_cheapest_rule() {
        assert_eq!(TransferRule::of(None), TransferRule::WifiOnly);
        assert_eq!(
            TransferRule::of(Some("from-a-newer-build")),
            TransferRule::WifiOnly
        );
        for rule in TransferRule::ALL {
            assert_eq!(TransferRule::of(Some(rule.stored())), rule);
        }
    }

    #[test]
    fn the_enum_and_the_wire_are_one_vocabulary() {
        assert_eq!(TransferRule::WifiOnly.wire(), wire::TransferRule::WifiOnly);
        assert_eq!(
            TransferRule::WifiAndCellularPhotos.wire(),
            wire::TransferRule::WifiAndCellularPhotos
        );
        assert_eq!(TransferRule::Manual.wire(), wire::TransferRule::Manual);
    }

    #[test]
    fn each_rule_has_its_own_plain_sentence() {
        let en = Locale::En;
        assert_eq!(
            TransferRule::WifiOnly.sentence(en),
            "Full-size photos and videos back up and download on Wi-Fi only."
        );
        assert_eq!(
            TransferRule::WifiAndCellularPhotos.sentence(en),
            "Full-size photos back up and download on Wi-Fi or cellular; videos wait for Wi-Fi."
        );
        assert_eq!(
            TransferRule::Manual.sentence(en),
            "Full-size photos download when you tap one; backups wait for Wi-Fi."
        );
        assert_eq!(title(en), "Downloads");
        assert!(subtitle(en).contains("thumbnails download on any network"));
    }

    #[test]
    fn the_waiting_line_is_empty_for_none_and_counts_the_rest() {
        let en = Locale::En;
        assert_eq!(waiting_sentence(en, 0), "");
        assert_eq!(waiting_sentence(en, 1), "1 original waiting for Wi-Fi");
        assert_eq!(waiting_sentence(en, 12), "12 originals waiting for Wi-Fi");
    }

    #[test]
    fn videos_are_included_until_the_member_says_otherwise_and_the_default_stores_nothing() {
        use crate::testing::FakeShell;
        let secrets = VaultSecrets::new();
        let mut shell = FakeShell::default();
        let apply = |secrets: &VaultSecrets, shell: &mut FakeShell, op: wire::SecretOp| {
            let ops = vec![op];
            let answers = shell.batch(&wire::SecretBatch { ops: ops.clone() }).answers;
            secrets.absorb(&ops, &answers);
        };
        assert!(Rules::read(&secrets).include_videos);
        apply(&secrets, &mut shell, Rules::write_include_videos(false));
        assert!(!Rules::read(&secrets).include_videos);
        assert_eq!(
            shell.device.get(INCLUDE_VIDEOS_KEY).map(String::as_str),
            Some("excluded")
        );
        apply(&secrets, &mut shell, Rules::write_include_videos(true));
        assert!(Rules::read(&secrets).include_videos);
        // INCLUDED IS STORED AS ABSENCE: the store holds a key only while the
        // member is spending less than the default.
        assert!(shell.device.is_empty());
        apply(
            &secrets,
            &mut shell,
            Rules::write_rule(TransferRule::Manual),
        );
        assert_eq!(Rules::read(&secrets).rule, TransferRule::Manual);
        assert_eq!(shell.device.get(KEY).map(String::as_str), Some("manual"));
    }
}
