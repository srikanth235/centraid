//! THE ROOT'S CHROME, AS DATA (R-CHROME-1…5) and the camera roll's two faces on
//! it. Every step leaves with its chrome: the band, the chips and the header's
//! words are derived from the state, so no arm can forget them and neither shell
//! composes them.
//!
//! * **Band:** places only (Library, Collections) then More, an ordinary tab lit
//!   while its sheet (or the tile-size choice it opened) is up. Search is not a
//!   place: the bar under the title opens it.
//! * **Chips:** the library's filter, All photos · Favorites, under the search
//!   bar. None off the library and none while selecting.
//! * **Words:** the title, the search bar, Select / Cancel, Collections' New
//!   album, and More's "Tile size", offered only on the library at All, where
//!   Years and Months draw a cover per period at an aspect the grain fixes, so a
//!   size there would act on nothing on screen.
//!
//! ## The grid reads the VAULT; the roll reads the CAMERA ROLL
//!
//! They are two planes with two permissions, and conflating them is how a denied
//! media permission blanks a library the member already owns. So a permission
//! change moves the banner and never the library. The roll itself (enumerating,
//! uploading) stays the shell's: it tells this screen the OS grant and the pass's
//! progress, and performs the remedies the banner offers.

use centraid_api_proto::core_v1 as wire;
use wire::PhotosBackupPhase as Phase;
use wire::PhotosDestination as Dest;
use wire::PhotosFilter as Filter;
use wire::PhotosGrain as Grain;
use wire::PhotosMediaPermission as Permission;
use wire::photos_home_import_banner::Remedy;

use super::layout;
use crate::strings::{Locale, fill, photos as words};

pub const BAND_LIBRARY: &str = "library";
pub const BAND_COLLECTIONS: &str = "collections";
pub const BAND_MORE: &str = "more";

pub const MORE_CAMERA_ROLL: &str = "camera_roll";
pub const MORE_TILE_SIZE: &str = "tile_size";

/// Is the library what the destination shows?
#[must_use]
pub fn is_library(destination: Dest) -> bool {
    matches!(destination, Dest::Library | Dest::Unspecified)
}

pub fn band(locale: Locale, destination: Dest, more_up: bool) -> Vec<wire::PhotosHomeBandTab> {
    vec![
        wire::PhotosHomeBandTab {
            key: BAND_LIBRARY.to_owned(),
            label: words::photos_band_library(locale),
            icon_key: "Image".to_owned(),
            current: is_library(destination) && !more_up,
        },
        wire::PhotosHomeBandTab {
            key: BAND_COLLECTIONS.to_owned(),
            label: words::photos_band_collections(locale),
            icon_key: "Layers".to_owned(),
            current: destination == Dest::Collections && !more_up,
        },
        wire::PhotosHomeBandTab {
            key: BAND_MORE.to_owned(),
            label: words::photos_band_more(locale),
            icon_key: "MoreHoriz".to_owned(),
            current: more_up,
        },
    ]
}

pub fn chips(
    locale: Locale,
    destination: Dest,
    selecting: bool,
    filter: Filter,
) -> Vec<wire::PhotosHomeFilterChip> {
    if !is_library(destination) || selecting {
        return Vec::new();
    }
    let favorites = filter == Filter::Favorites;
    vec![
        wire::PhotosHomeFilterChip {
            filter: Filter::All as i32,
            label: words::photos_filter_all(locale),
            selected: !favorites,
        },
        wire::PhotosHomeFilterChip {
            filter: Filter::Favorites as i32,
            label: words::photos_filter_favorites(locale),
            selected: favorites,
        },
    ]
}

pub fn words_of(locale: Locale) -> wire::PhotosHomeChrome {
    wire::PhotosHomeChrome {
        title: words::photos_title(locale),
        search_placeholder: words::photos_search_placeholder(locale),
        select_label: words::photos_select(locale),
        cancel_label: words::photos_grid_cancel(locale),
        new_album_label: words::photos_new_album(locale),
        show_all_label: words::photos_show_all(locale),
        collapse_all_label: words::photos_collapse_all(locale),
        close_search_label: crate::strings::shared::kit_close_search(locale),
    }
}

/// Can the roll enumerate? LIMITED counts: iOS's limited selection is a real
/// library the member chose, and a roll that treated it as a denial would back up
/// nothing while the member watched their selected photos sit there.
#[must_use]
pub fn can_enumerate(permission: Permission) -> bool {
    matches!(permission, Permission::Granted | Permission::Limited)
}

/// FOUR REASONS, FOUR SENTENCES. "Not asked" has a button, "denied" has a trip to
/// Settings, and "restricted" has neither.
fn paused_reason(locale: Locale, permission: Permission) -> String {
    match permission {
        Permission::Limited => words::photos_permission_limited(locale),
        Permission::NotAsked => words::photos_permission_not_asked(locale),
        Permission::Denied => words::photos_permission_denied(locale),
        Permission::Restricted => words::photos_permission_restricted(locale),
        Permission::Granted | Permission::Unspecified => String::new(),
    }
}

/// What the roll last told this screen.
#[derive(Clone, Debug)]
pub struct Roll {
    pub permission: Permission,
    pub phase: Phase,
    pub transferred: u32,
    pub remaining: u32,
    pub paused_reason: String,
}

impl Default for Roll {
    fn default() -> Self {
        Self {
            permission: Permission::NotAsked,
            phase: Phase::Idle,
            transferred: 0,
            remaining: 0,
            paused_reason: String::new(),
        }
    }
}

impl Roll {
    pub fn permission(&mut self, permission: Permission) {
        self.permission = permission;
        // A grant that cannot enumerate has nothing running.
        if !can_enumerate(permission) {
            self.phase = Phase::Idle;
        }
    }

    pub fn backup(&mut self, changed: &wire::PhotosBackupChanged) {
        self.phase = Phase::try_from(changed.phase).unwrap_or(Phase::Unspecified);
        self.transferred = changed.assets_transferred_this_session;
        self.remaining = changed.assets_remaining;
        self.paused_reason.clone_from(&changed.paused_reason);
    }

    #[must_use]
    pub fn running(&self) -> bool {
        matches!(self.phase, Phase::Transferring | Phase::Enumerating)
    }

    fn waiting(&self) -> bool {
        matches!(
            self.phase,
            Phase::WaitingForPower | Phase::WaitingForUnmetered | Phase::ParkedLowDisk
        )
    }

    /// What a moving or held import is doing, in a member's words: both numbers
    /// while it moves, and a wait still says what it has already carried.
    fn sentence(&self, locale: Locale) -> String {
        let done = self.transferred.to_string();
        let left = self.remaining.to_string();
        let with_counts = |sentence: String| {
            if self.transferred == 0 {
                sentence
            } else {
                format!(
                    "{sentence} {}",
                    fill(
                        &words::photos_import_wait_counts(locale),
                        &[("done", &done), ("left", &left)]
                    )
                )
            }
        };
        match self.phase {
            Phase::Transferring => fill(
                &words::photos_import_progress(locale),
                &[("done", &done), ("left", &left)],
            ),
            Phase::Enumerating => words::photos_import_looking(locale),
            Phase::WaitingForPower => with_counts(words::photos_import_wait_power(locale)),
            Phase::WaitingForUnmetered => with_counts(words::photos_import_wait_wifi(locale)),
            Phase::ParkedLowDisk => words::photos_import_paused_disk(locale),
            _ => String::new(),
        }
    }

    /// THE CAMERA-ROLL BANNER, OR NONE. It speaks only when there is something to
    /// say or do: a grant's remedy beside the grant's own sentence; an import
    /// moving; a wait or a pause; and "Import now" over an EMPTY library the grant
    /// can fill, when no pass is running. Never over photographs: a library that
    /// has them was imported, and More's camera-roll sheet is the deliberate place
    /// to run one again.
    ///
    /// `empty_library` is KNOWN, NOT GUESSED: both walks ended with no photograph,
    /// under All (Favorites emptied by its filter is not an empty library).
    #[must_use]
    pub fn banner(
        &self,
        locale: Locale,
        empty_library: bool,
    ) -> Option<wire::PhotosHomeImportBanner> {
        let remedy = match self.permission {
            Permission::NotAsked => Remedy::Ask,
            Permission::Denied => Remedy::Settings,
            Permission::Limited => Remedy::ManageSelection,
            _ => Remedy::Unspecified,
        };
        let running = self.running();
        let waiting = self.waiting();
        let import_now = empty_library && can_enumerate(self.permission) && !running;
        let sentence = if running || waiting {
            self.sentence(locale)
        } else {
            String::new()
        };
        let reason = if remedy != Remedy::Unspecified {
            paused_reason(locale, self.permission)
        } else if waiting {
            self.paused_reason.clone()
        } else if empty_library {
            // A RESTRICTED PHONE has no remedy; over an empty library the
            // sentence is why it stays empty.
            paused_reason(locale, self.permission)
        } else {
            String::new()
        };
        if sentence.is_empty() && reason.is_empty() && !import_now && remedy == Remedy::Unspecified
        {
            return None;
        }
        Some(wire::PhotosHomeImportBanner {
            sentence,
            reason,
            remedy: remedy as i32,
            allow_label: words::photos_allow_access(locale),
            settings_label: words::photos_open_settings(locale),
            manage_label: words::photos_manage_selection(locale),
            import_now,
            import_now_label: words::photos_import_now(locale),
        })
    }

    /// The camera roll's sheet: the sentence for the phase, and why it is not
    /// moving.
    #[must_use]
    pub fn detail(&self, locale: Locale) -> wire::PhotosBackupDetailSheet {
        let mut rows = vec![wire::PhotosBackupDetailRow {
            key: "Status".to_owned(),
            value: {
                let sentence = self.sentence(locale);
                if sentence.is_empty() {
                    words::photos_import_done(locale)
                } else {
                    sentence
                }
            },
        }];
        if !self.paused_reason.is_empty() {
            rows.push(wire::PhotosBackupDetailRow {
                key: "Paused".to_owned(),
                value: self.paused_reason.clone(),
            });
        }
        wire::PhotosBackupDetailSheet {
            title: words::photos_camera_roll(locale),
            status: if self.running() {
                words::photos_import_running(locale)
            } else {
                words::photos_import_auto(locale)
            },
            import_label: words::photos_import_now(locale),
            // AN IMPORT ALREADY RUNNING HAS NOTHING TO START: greyed, not hidden.
            import_enabled: !self.running(),
            rows,
        }
    }
}

/// The tile sizes choice.
#[must_use]
pub fn tile_sizes(locale: Locale, rung: u32) -> wire::PhotosTileSizeSheet {
    wire::PhotosTileSizeSheet {
        title: words::photos_tile_size(locale),
        options: layout::RUNG_LABELS
            .iter()
            .enumerate()
            .map(|(at, label)| wire::PhotosTileSizeOption {
                rung: at as u32,
                label: (*label).to_owned(),
                selected: at as u32 == rung,
            })
            .collect(),
    }
}

/// Tile size is offered in More only on the library at All.
#[must_use]
pub fn tile_size_offered(destination: Dest, grain: Grain) -> bool {
    is_library(destination) && matches!(grain, Grain::All | Grain::Unspecified)
}
