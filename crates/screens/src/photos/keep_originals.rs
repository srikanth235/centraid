//! "KEEP ORIGINALS ON THIS PHONE" AND "FREE UP SPACE" (#1029, #1080 A19, A20),
//! as plain Rust that a screen maps into its own view message. Two surfaces over
//! the core's originals doors: an album shelf's switch, which puts that album on
//! this phone's keep list, and the More sheet's row, which says what freeing
//! space would reclaim and does it.
//!
//! The doors themselves are the core's (the census, `releasable`, `released`,
//! called by `photos::free_up`) and the platform's (the system's delete
//! confirmation, the `LibraryDelete` effect); what they came to is a
//! [`wire::FreeUpFacts`]. What a member reads about them is derived once, here.
//!
//! "Free up space" is a verb only where a gateway holds an original whole (the
//! core's `releasable` door) and the phone can delete behind the system's own
//! confirmation. A phone that cannot draws no row at all: an action it cannot
//! take is not offered.

use centraid_api_proto::core_v1 as wire;
use wire::free_up_facts::Outcome;

use crate::strings::{Locale, fill, photos as photos_words, photos_home as words};

/// The switch's title and its spoken label.
#[must_use]
pub fn switch_title(locale: Locale) -> String {
    photos_words::photos_keep_originals_title(locale)
}

#[must_use]
pub fn switch_label(locale: Locale) -> String {
    photos_words::photos_keep_originals_label(locale)
}

/// What a photograph deleted for good costs the backup device (#1080 F5),
/// drawn under the row whatever the count.
#[must_use]
pub fn retention_body(locale: Locale) -> String {
    photos_words::photos_free_up_retention_body(locale)
}

/// The line under the switch, derived from the switch (v0's
/// `keepOriginalsMeta`).
#[must_use]
pub fn meta(locale: Locale, keep: bool) -> String {
    if keep {
        words::keep_meta_kept(locale)
    } else {
        words::keep_meta_included(locale)
    }
}

/// An album shelf's switch. Offered on an album and on nothing else: a switch on
/// the favourites would be a keep list of a predicate, which is not a thing the
/// list can hold.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SwitchRow {
    pub offered: bool,
    /// False until the keep list has answered for THIS album: the switch is
    /// disabled and `meta` says it is checking.
    pub ready: bool,
    pub keep: bool,
    /// A change is on its way to the core. The switch shows the member's answer
    /// and holds still until the list confirms it.
    pub saving: bool,
    pub meta: String,
}

impl SwitchRow {
    /// The row a freshly opened shelf starts with.
    #[must_use]
    pub fn opened(locale: Locale, is_album: bool) -> Self {
        if is_album {
            Self {
                offered: true,
                meta: words::keep_checking(locale),
                ..Self::default()
            }
        } else {
            Self::default()
        }
    }

    /// The row is waiting for the list to say (so the shell should ask).
    #[must_use]
    pub fn checking(&self) -> bool {
        self.offered && !self.ready && !self.saving
    }

    /// The member flipped the switch. `None` is "ignore": before the list has
    /// answered, while a change is already on its way, or a flip to the value it
    /// already holds.
    #[must_use]
    pub fn toggled(&self, locale: Locale, keep: bool) -> Option<Self> {
        (self.offered && self.ready && !self.saving && self.keep != keep).then(|| Self {
            keep,
            saving: true,
            meta: meta(locale, keep),
            ..self.clone()
        })
    }

    /// What the list said about `album_id`. `None` is "not this album's answer":
    /// one that landed after the member moved to another album, or on a shelf
    /// that offers no row. A non-empty `refusal` leaves the switch disabled with
    /// that sentence.
    #[must_use]
    pub fn settled(
        &self,
        locale: Locale,
        shown_album: Option<&str>,
        album_id: &str,
        keep: bool,
        refusal: &str,
    ) -> Option<Self> {
        if !self.offered || shown_album != Some(album_id) {
            return None;
        }
        Some(if refusal.is_empty() {
            Self {
                ready: true,
                saving: false,
                keep,
                meta: meta(locale, keep),
                ..self.clone()
            }
        } else {
            Self {
                ready: false,
                saving: false,
                keep: false,
                meta: refusal.to_owned(),
                ..self.clone()
            }
        })
    }

    /// The sentence for a keep list the core would not read or write.
    #[must_use]
    pub fn unreadable(locale: Locale) -> String {
        words::keep_unreadable(locale)
    }
}

/// The More sheet's "Free up space" row.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FreeUpRow {
    pub offered: bool,
    pub counted: bool,
    pub meta: String,
    pub reason: String,
    pub action_label: String,
    pub enabled: bool,
    pub releasable_count: u32,
    pub releasable_bytes: u64,
    /// The system's confirmation is up, or the deletion is running.
    pub freeing: bool,
    pub notice: String,
}

/// Decimal bytes the way a backup's own screens say them: `999 bytes`, `12 KB`,
/// `340 MB`, `2 GB` (whole units, truncated).
#[must_use]
pub fn drain_bytes(count: u64) -> String {
    match count {
        0..=999 => format!("{count} bytes"),
        1_000..=999_999 => format!("{} KB", count / 1_000),
        1_000_000..=999_999_999 => format!("{} MB", count / 1_000_000),
        _ => format!("{} GB", count / 1_000_000_000),
    }
}

impl FreeUpRow {
    /// The row while the census runs.
    #[must_use]
    pub fn counting(locale: Locale) -> Self {
        Self {
            offered: true,
            meta: words::free_up_counting(locale),
            ..Self::default()
        }
    }

    /// The row from what the shell counted. A census that did not answer is "Not
    /// counted yet", never zero; a core that could not say what is safe offers
    /// nothing. The action frees exactly what the core listed, so its size is
    /// theirs.
    #[must_use]
    pub fn from_facts(locale: Locale, facts: &wire::FreeUpFacts) -> Self {
        // NO ROW AT ALL where nothing can delete (A20).
        if !facts.offered {
            return Self::default();
        }
        let notice = notice(locale, facts);
        if !facts.counted {
            return Self {
                offered: true,
                meta: words::free_up_not_counted(locale),
                notice,
                ..Self::default()
            };
        }
        if facts.on_phone_count == 0 {
            return Self {
                offered: true,
                counted: true,
                meta: words::free_up_no_originals(locale),
                notice,
                ..Self::default()
            };
        }
        let noun = if facts.on_phone_count == 1 {
            words::free_up_original_one(locale)
        } else {
            words::free_up_original_many(locale)
        };
        let kept = match facts.kept_count {
            0 => String::new(),
            1 => words::free_up_kept_one(locale),
            n => fill(
                &words::free_up_kept_many(locale),
                &[("count", &n.to_string())],
            ),
        };
        let mut row = Self {
            offered: true,
            counted: true,
            meta: fill(
                &words::free_up_meta(locale),
                &[
                    ("count", &facts.on_phone_count.to_string()),
                    ("noun", &noun),
                    ("size", &drain_bytes(facts.on_phone_bytes)),
                ],
            ),
            notice,
            ..Self::default()
        };
        if !facts.checked {
            row.reason = format!("{}{kept}", words::free_up_not_checked(locale));
        } else if facts.releasable_count == 0 {
            row.reason = format!("{}{kept}", words::free_up_nothing_safe(locale));
        } else {
            let backed_up = if facts.releasable_count == 1 {
                words::free_up_backed_up_one(locale)
            } else {
                fill(
                    &words::free_up_backed_up_many(locale),
                    &[("count", &facts.releasable_count.to_string())],
                )
            };
            row.reason = format!("{backed_up}{kept}");
            row.action_label = fill(
                &words::free_up_action(locale),
                &[("size", &drain_bytes(facts.releasable_bytes))],
            );
            row.enabled = true;
            row.releasable_count = facts.releasable_count;
            row.releasable_bytes = facts.releasable_bytes;
        }
        row
    }

    /// The member tapped the action. `None` is "ignore": before the count, with
    /// nothing to free, or while a free-up is already in the system's hands.
    #[must_use]
    pub fn tapped(&self) -> Option<Self> {
        (self.counted && self.enabled && !self.freeing).then(|| Self {
            freeing: true,
            notice: String::new(),
            ..self.clone()
        })
    }
}

/// What the last free-up came to, in one clause; empty before the first.
fn notice(locale: Locale, facts: &wire::FreeUpFacts) -> String {
    match Outcome::try_from(facts.outcome).unwrap_or(Outcome::Unspecified) {
        Outcome::Unspecified => String::new(),
        Outcome::Freed => fill(
            &words::free_up_freed(locale),
            &[("size", &drain_bytes(facts.freed_bytes))],
        ),
        Outcome::NothingRemoved => words::free_up_nothing_removed(locale),
        Outcome::NotRecorded => words::free_up_not_recorded(locale),
        Outcome::NotChecked => words::free_up_not_checked(locale),
        Outcome::PlatformError => facts.platform_error.clone(),
    }
}
