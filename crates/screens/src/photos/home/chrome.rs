//! THE ROOT'S CHROME, AS DATA (R-CHROME-1…5) and the camera roll's one face on
//! it, the banner. Every step leaves with its chrome: the band, the filter menu and the
//! header's words are derived from the state, so no arm can forget them and
//! neither shell composes them.
//!
//! * **Band:** places only (Library, Collections) then More, an ordinary tab lit
//!   while its sheet (or the tile-size choice it opened) is up. Search is not a
//!   place: the band's trailing key opens it.
//! * **Filter menu:** the header's filter button, All photos · Favorites
//!   (`filter_menu`). None off the library and none while selecting.
//! * **Grain:** Years · Months · All (`grain_segments`), a view of the same
//!   photographs, drawn in the band like the system Photos'. None off the library,
//!   none while selecting, and none while there is nothing to zoom.
//! * **Words:** the title, the search key, Select / Cancel, Collections' New
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
use crate::kit::menu;
use crate::strings::{Locale, fill, photos as words};

pub const BAND_LIBRARY: &str = "library";
pub const BAND_COLLECTIONS: &str = "collections";
pub const BAND_MORE: &str = "more";

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

/// The filter section's key and its two options' keys (`photos-filter-show-all`
/// on a screen).
pub const FILTER: &str = "show";
pub const FILTER_ALL: &str = "all";
pub const FILTER_FAVORITES: &str = "favorites";

/// THE HEADER'S FILTER BUTTON: All photos · Favorites, one single-choice section,
/// lit while Favorites narrows the library. None off the library and none while
/// selecting, when the header's other item is Cancel.
pub fn filter_menu(
    locale: Locale,
    destination: Dest,
    selecting: bool,
    filter: Filter,
) -> Option<wire::FilterMenu> {
    if !is_library(destination) || selecting {
        return None;
    }
    let favorites = filter == Filter::Favorites;
    Some(menu::menu(
        locale,
        vec![menu::single(
            FILTER,
            words::photos_filter_title(locale),
            vec![
                menu::option(FILTER_ALL, words::photos_filter_all(locale), !favorites),
                menu::option(
                    FILTER_FAVORITES,
                    words::photos_filter_favorites(locale),
                    favorites,
                ),
            ],
        )],
        favorites,
    ))
}

/// The filter a pick of the filter section means, or None for any other pick.
#[must_use]
pub fn filter_of(pick: menu::Pick<'_>) -> Option<Filter> {
    match (pick.section, pick.option) {
        (FILTER, FILTER_ALL) => Some(Filter::All),
        (FILTER, FILTER_FAVORITES) => Some(Filter::Favorites),
        _ => None,
    }
}

/// THE ZOOM, AS THE BAND'S SEGMENTS: Years · Months · All, widest first, the
/// current one selected (an unset grain is All, as the library draws it). It is
/// away wherever the library is not what is drawn, while selecting (the
/// selection bar stands in the band's place) and while there are no photographs
/// to zoom (`has_photos`: a loading, failed or empty library, or a filter that
/// matched nothing).
pub fn grain_segments(
    locale: Locale,
    destination: Dest,
    selecting: bool,
    has_photos: bool,
    grain: Grain,
) -> Vec<wire::PhotosHomeGrainSegment> {
    if !is_library(destination) || selecting || !has_photos {
        return Vec::new();
    }
    let current = if grain == Grain::Unspecified {
        Grain::All
    } else {
        grain
    };
    [
        (Grain::Years, words::photos_grain_years(locale)),
        (Grain::Months, words::photos_grain_months(locale)),
        (Grain::All, words::photos_grain_all(locale)),
    ]
    .into_iter()
    .map(|(segment, label)| wire::PhotosHomeGrainSegment {
        grain: segment as i32,
        label,
        selected: segment == current,
    })
    .collect()
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
        selecting_title: words::photos_grid_select(locale),
        send_copy_label: words::photos_send_copy(locale),
        search_label: crate::strings::shared::kit_search(locale),
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
    /// has them was imported, and the roll walks again on its own (a grant, a
    /// change in the library) without a menu to ask it.
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
