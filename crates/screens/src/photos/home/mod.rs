//! `photos.home` (#1135): the library grid, Collections, Search and the More
//! sheet, one screen with three places and a sheet.
//!
//! * **Library** (the root): the live photographs, newest first and then the
//!   undated tail, a page at a time; a zoom (Years · Months · All), a filter (All ·
//!   Favorites), a tile size, select mode with its batch writes, and the camera
//!   roll's banner. The shell reports the width the grid is drawn at; Rust packs
//!   the justified rows and the cards ([`layout`]).
//! * **Collections**: the albums, the standing shelves, the doors, the albums in
//!   the trash ([`collections`]).
//! * **Search**: the bar under the title ([`search`]).
//! * **More** is a sheet and never a destination.
//!
//! ## What reads and what re-folds
//!
//! The library reads a page when the end of what is loaded comes into view and
//! reads in place on any change. Every other control (grain, filter, tile size,
//! viewport, folding a section) re-folds what is held. Loads and writes are
//! synchronous, so a gesture that writes reads again before the view is drawn.
//!
//! ## Rows open pages by their own route
//!
//! A shelf, an album, a door and a search hit carry the [`wire::Route`] to push.
//! The library's tiles share one: `open` is the lightbox route with every loaded
//! id as its neighbours and an empty photo id, which the shell fills in for the
//! tapped tile.

pub mod chrome;
mod collections;
pub mod layout;
mod library;
mod search;

use centraid_api_proto::core_v1 as wire;
use wire::PhotosDestination as Dest;
use wire::PhotosFilter as Filter;
use wire::PhotosGrain as Grain;
use wire::photos_home_event::Kind as H;
use wire::photos_home_state::Sheet;
use wire::screen_event::Kind as E;

use self::chrome::Roll;
use self::collections::Collections;
use self::library::Library;
use self::search::Search;
use super::album_choice::{AlbumChoice, Outcome as ChoiceOutcome};
use super::cells::{self, Link};
use super::keep_originals::FreeUpRow;
use super::selection::{Drain, Offer, Outcome, Selection, Verb, Wording};
use super::{fetch, routes};
use crate::kit::civil;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, fill, photos as words, photos_home as sentences};

/// A registry factory.
#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let args = match &route.args {
        Some(wire::route::Args::PhotosHome(args)) => args.clone(),
        _ => wire::PhotosHomeRoute::default(),
    };
    Some(Box::new(Home::new(&args)))
}

struct Home {
    destination: Dest,
    sheet: Sheet,
    library: Library,
    filter: Filter,
    grain: Grain,
    rung: u32,
    place_day: String,
    viewport: (f64, f64),
    collections: Collections,
    search: Search,
    selection: Selection,
    choice: AlbumChoice,
    link: Link,
    /// Content ids whose original is being fetched: their cells say so.
    fetching: Vec<String>,
    roll: Roll,
    free_up: FreeUpRow,
    status: Option<wire::StatusLine>,
}

impl Home {
    fn new(args: &wire::PhotosHomeRoute) -> Self {
        let named = Dest::try_from(args.destination).unwrap_or(Dest::Unspecified);
        let query = args.query.clone().unwrap_or_default();
        let destination = if !query.trim().is_empty() {
            Dest::Search
        } else if named == Dest::Unspecified {
            Dest::Library
        } else {
            named
        };
        let mut search = Search::default();
        search.set_term(&query);
        Self {
            destination,
            sheet: Sheet::None,
            library: Library::default(),
            filter: Filter::All,
            grain: Grain::All,
            rung: layout::DEFAULT_RUNG,
            place_day: String::new(),
            viewport: (0.0, 0.0),
            collections: Collections::default(),
            search,
            selection: Selection::new(Offer::Library, Drain::Ends, Wording::Selected),
            choice: AlbumChoice::new(),
            link: Link::default(),
            fetching: Vec::new(),
            roll: Roll::default(),
            free_up: FreeUpRow::default(),
            status: None,
        }
    }

    // ---------------------------------------------------------------- reads --

    /// Read what the place on screen shows. The library is held across places: a
    /// return to it is a read in place, not a reload.
    fn read(&mut self, ctx: &Ctx) {
        match self.destination {
            Dest::Collections => self.collections.read(ctx),
            Dest::Search => self.search.read(ctx),
            _ => self.read_library(ctx),
        }
        self.choice.reload(ctx);
    }

    fn read_library(&mut self, ctx: &Ctx) {
        if self.library.loaded() {
            self.library.refresh(ctx, self.filter);
            let shown: Vec<String> = self
                .library
                .cells
                .iter()
                .map(|c| c.photo_id.clone())
                .collect();
            self.selection.retain_in(&shown);
        } else {
            self.library.first(ctx, self.filter);
        }
    }

    fn move_to(&mut self, destination: Dest, ctx: &Ctx) {
        if destination == Dest::Unspecified {
            return;
        }
        self.sheet = Sheet::None;
        if !chrome::is_library(destination) {
            // LEAVING THE LIBRARY RESETS WHAT ONLY THE LIBRARY HAS: a selection
            // must not outlive the grid it was made on, and the zoom comes back to
            // All. The photographs themselves stay read.
            self.leave_selection();
            self.grain = Grain::All;
            self.place_day.clear();
        }
        if destination != Dest::Search {
            self.search.close();
        }
        self.destination = if destination == Dest::Unspecified {
            Dest::Library
        } else {
            destination
        };
        self.status = None;
        self.read(ctx);
    }

    fn leave_selection(&mut self) {
        self.selection.leave();
        self.choice.close();
        if self.sheet == Sheet::CopyPlace {
            self.sheet = Sheet::None;
        }
    }

    fn days(&self) -> Vec<String> {
        self.library
            .cells
            .iter()
            .map(|cell| {
                cell.taken_at
                    .as_deref()
                    .map(|at| cells::capture_day(at, cell.offset_min.unwrap_or(0)))
                    .unwrap_or_default()
            })
            .fold(Vec::new(), |mut days, day| {
                if days.last() != Some(&day) {
                    days.push(day);
                }
                days
            })
    }

    fn ordered(&self) -> Vec<String> {
        cells::dedupe_live(&self.library.cells)
            .into_iter()
            .map(|cell| cell.photo_id.clone())
            .collect()
    }

    fn rung_effects(&self) -> Vec<wire::Effect> {
        vec![wire::Effect {
            kind: Some(wire::effect::Kind::Keychain(wire::KeychainOp {
                op: wire::keychain_op::Op::Set as i32,
                key: layout::RUNG_KEY.to_owned(),
                value: self.rung.to_string().into_bytes(),
            })),
        }]
    }

    fn set_rung(&mut self, rung: u32) -> Vec<wire::Effect> {
        let rung = layout::clamp_rung(rung);
        if rung == self.rung {
            return Vec::new();
        }
        self.rung = rung;
        self.rung_effects()
    }

    // --------------------------------------------------------------- events --

    fn on_event(&mut self, event: H, ctx: &Ctx) -> Vec<wire::Effect> {
        let locale = ctx.locale();
        match event {
            H::Band(key) => match key.as_str() {
                chrome::BAND_LIBRARY => self.move_to(Dest::Library, ctx),
                chrome::BAND_COLLECTIONS => self.move_to(Dest::Collections, ctx),
                chrome::BAND_MORE => return self.open_sheet(Sheet::More),
                _ => {}
            },
            H::Destination(destination) => {
                self.move_to(
                    Dest::try_from(destination).unwrap_or(Dest::Unspecified),
                    ctx,
                );
            }
            H::Selection(event) => {
                let ordered = self.ordered();
                let outcome = self.selection.update(&event, &ordered, ctx);
                self.after_selection(outcome, ctx);
            }
            H::AlbumChoice(event) => {
                let picked = self.selection.picked().to_vec();
                match self.choice.update(&event, &picked, ctx) {
                    ChoiceOutcome::Moved => {}
                    ChoiceOutcome::Added { written, .. } => {
                        self.selection.settle(&written, Verb::AddToAlbum);
                        self.read_library(ctx);
                    }
                    ChoiceOutcome::Created { refusal } => self.selection.refuse(refusal),
                }
            }
            H::Viewport(viewport) => self.viewport = (viewport.width, viewport.height),
            H::Refreshed(_) => {
                self.status = None;
                if self.library.loaded()
                    || !matches!(self.destination, Dest::Library | Dest::Unspecified)
                {
                    self.read(ctx);
                } else {
                    self.library.first(ctx, self.filter);
                }
            }
            H::NextPage(_) => {
                if chrome::is_library(self.destination) {
                    self.library.more(ctx, self.filter);
                }
            }
            H::Filter(filter) => {
                let filter = Filter::try_from(filter).unwrap_or(Filter::Unspecified);
                if filter != Filter::Unspecified && filter != self.filter {
                    // THE FILTER NARROWS THE READ, NOT THE DRAWING: filtering the
                    // pages already loaded would show "No favorites yet" over a
                    // library whose favourites simply had not been paged in.
                    self.filter = filter;
                    self.place_day.clear();
                    self.library.first(ctx, filter);
                }
            }
            H::Grain(changed) => {
                let grain = Grain::try_from(changed.grain).unwrap_or(Grain::Unspecified);
                if grain != Grain::Unspecified {
                    self.land_on(grain, &changed.at_day);
                }
            }
            H::PeriodOpened(day) => {
                // A CARD IS A DOOR ONE GRAIN IN, at that period's first day.
                self.grain = layout::narrower(self.grain);
                self.place_day = day;
            }
            H::Rung(rung) => {
                // A SIZE PICKED FROM MORE'S CHOICE CLOSES IT.
                if self.sheet == Sheet::TileSize {
                    self.sheet = Sheet::None;
                }
                return self.set_rung(rung);
            }
            H::Pinched(pinch) => {
                let landed = layout::pinch(self.grain, self.rung, pinch.scale);
                let mut effects = self.set_rung(landed.rung);
                if landed.grain != self.grain {
                    self.land_on(landed.grain, &pinch.at_day);
                }
                effects.extend(Vec::new());
                return effects;
            }
            H::OriginalRequested(photo_id) => return self.request_original(&photo_id),
            H::SearchOpened(_) => self.move_to(Dest::Search, ctx),
            H::SearchTerm(term) => {
                self.sheet = Sheet::None;
                self.destination = Dest::Search;
                self.search.set_term(&term);
                self.search.read(ctx);
            }
            H::SearchClosed(_) => self.move_to(Dest::Library, ctx),
            H::Sheet(opened) => {
                let sheet = Sheet::try_from(opened.sheet).unwrap_or(Sheet::Unspecified);
                match sheet {
                    Sheet::Unspecified => {}
                    Sheet::None => self.sheet = Sheet::None,
                    other => return self.open_sheet(other),
                }
            }
            H::SectionToggled(section) => self.collections.toggle(&section),
            H::FoldAll(_) => self.collections.fold_all(),
            H::NewAlbumName(name) => self.collections.new_album_name = name,
            H::NewAlbumSubmitted(_) => match self.collections.create(ctx) {
                // THE SHEET STAYS OPEN UNTIL THE WRITE COMMITS: closing it would be
                // the screen claiming an album exists because a button was pressed,
                // and a refusal would then have nowhere to be read.
                Ok(true) => {
                    self.sheet = Sheet::None;
                    self.status = None;
                    self.collections.read(ctx);
                }
                Ok(false) => {}
                Err(sentence) => self.status = Some(refused(sentence)),
            },
            H::AlbumDeleteAsked(id) => self.collections.deleting = Some(id),
            H::AlbumDeleteDismissed(_) => self.collections.deleting = None,
            H::AlbumDeleteConfirmed(_) => {
                if let Some(id) = self.collections.deleting.take() {
                    self.status = Collections::delete(ctx, &id).err().map(refused);
                    self.collections.read(ctx);
                }
            }
            H::AlbumRestored(id) => {
                self.status = Collections::restore(ctx, &id).err().map(refused);
                self.collections.read(ctx);
            }
            H::Permission(changed) => {
                self.roll.permission(
                    wire::PhotosMediaPermission::try_from(changed.permission).unwrap_or_default(),
                );
            }
            H::Backup(changed) => self.roll.backup(&changed),
            H::Link(changed) => {
                self.link = Link {
                    rule: wire::TransferRule::try_from(changed.rule).unwrap_or_default(),
                    metered: changed.metered,
                };
            }
            H::Remedy(picked) => {
                use wire::camera_roll::Action;
                use wire::photos_home_import_banner::Remedy;
                let action = match Remedy::try_from(picked.remedy).unwrap_or(Remedy::Unspecified) {
                    Remedy::Ask => Action::AskPermission,
                    Remedy::Settings => Action::OpenSettings,
                    Remedy::ManageSelection => Action::ManageSelection,
                    Remedy::Unspecified => return Vec::new(),
                };
                return vec![camera_roll(action)];
            }
            H::ImportNow(_) => {
                if !self.roll.running() {
                    return vec![camera_roll(wire::camera_roll::Action::ImportNow)];
                }
            }
            H::FreeUpTapped(_) => {
                if let Some(row) = self.free_up.tapped() {
                    self.free_up = row;
                    return vec![free_up(wire::free_up_space::Action::Free)];
                }
            }
            H::CopyAsked(_) => {
                if !self.selection.picked().is_empty() {
                    self.sheet = Sheet::CopyPlace;
                }
            }
            H::CopyPlaceChosen(chosen) => {
                if self.sheet == Sheet::CopyPlace && !self.selection.picked().is_empty() {
                    self.sheet = Sheet::None;
                    self.status = None;
                    return vec![wire::Effect {
                        kind: Some(wire::effect::Kind::ExportOriginals(wire::ExportOriginals {
                            photo_ids: self.selection.picked().to_vec(),
                            mode: wire::export_originals::Mode::Send as i32,
                            keep_location: chosen.keep_location,
                        })),
                    }];
                }
            }
        }
        let _ = locale;
        Vec::new()
    }

    /// A zoom lands where the member was (v0's `changeGrain` → `anchorForGrain`).
    fn land_on(&mut self, grain: Grain, at_day: &str) {
        let days = self.days();
        let refs: Vec<&str> = days.iter().map(String::as_str).collect();
        self.place_day = layout::anchor(grain, at_day, &refs);
        self.grain = grain;
    }

    fn open_sheet(&mut self, sheet: Sheet) -> Vec<wire::Effect> {
        self.sheet = sheet;
        // THE ROW IS COUNTED WHEN THE SHEET OPENS: a count is only as fresh as
        // the last import, and a census lists the whole content store.
        if sheet == Sheet::More {
            return vec![free_up(wire::free_up_space::Action::Count)];
        }
        Vec::new()
    }

    fn after_selection(&mut self, outcome: Outcome, ctx: &Ctx) {
        match outcome {
            Outcome::Moved => {}
            Outcome::OpenAlbumChoice => {
                let picked = self.selection.picked().to_vec();
                let opened = wire::PhotosAlbumChoiceEvent {
                    kind: Some(wire::photos_album_choice_event::Kind::Opened(
                        wire::photos_album_choice_event::Opened {},
                    )),
                };
                self.choice.update(&opened, &picked, ctx);
            }
            Outcome::Wrote(_) => self.read_library(ctx),
        }
    }

    fn request_original(&mut self, photo_id: &str) -> Vec<wire::Effect> {
        let Some(hash) = self
            .library
            .cells
            .iter()
            .chain(self.search.cells())
            .find(|cell| cell.photo_id == photo_id)
            .map(|cell| cell.content_id.clone())
            .filter(|hash| !hash.is_empty())
        else {
            return Vec::new();
        };
        if self.fetching.contains(&hash) {
            return Vec::new();
        }
        // The cell goes to FETCHING HERE and not when the answer comes back: the
        // round trip is the whole duration a member is waiting through.
        self.fetching.push(hash.clone());
        self.status = None;
        vec![fetch::effect(&hash)]
    }

    fn on_effect(&mut self, result: &wire::EffectResult, ctx: &Ctx) {
        use wire::effect_result::Outcome as O;
        let locale = ctx.locale();
        match &result.outcome {
            Some(O::OriginalFetched(fetched)) => {
                self.fetching.retain(|hash| *hash != fetched.content_hash);
                match fetch::settle(locale, result) {
                    // THE BYTES ARE ON THIS PHONE NOW: a read draws the original.
                    Ok(()) => self.read(ctx),
                    Err(sentence) => self.status = Some(refused(sentence)),
                }
            }
            Some(O::Failed(_)) => {
                if !self.fetching.is_empty() {
                    self.fetching.clear();
                    self.status = Some(refused(fetch::no_answer(locale)));
                }
            }
            Some(O::OriginalsExported(exported)) => self.exported(locale, exported),
            Some(O::FreeUpFacts(facts)) => self.free_up = FreeUpRow::from_facts(locale, facts),
            Some(O::Keychain(value)) if value.found => {
                if let Ok(rung) = String::from_utf8_lossy(&value.value).trim().parse::<u32>() {
                    self.rung = layout::clamp_rung(rung);
                }
            }
            _ => {}
        }
    }

    fn exported(&mut self, locale: Locale, exported: &wire::OriginalsExported) {
        use wire::originals_exported::Status;
        let missing = match exported.missing {
            0 => String::new(),
            1 => sentences::copy_missing_one(locale),
            n => fill(
                &sentences::copy_missing_many(locale),
                &[("count", &n.to_string())],
            ),
        };
        let sentence = match Status::try_from(exported.status).unwrap_or(Status::Unspecified) {
            // THE SHEET SAYS WHAT IT DID; this says only what did not go.
            Status::Done | Status::Unspecified => missing,
            Status::NoneHere => sentences::copy_none_here(locale),
            Status::LocationNotRemovable => sentences::copy_location_not_removable(locale),
            Status::Failed => sentences::copy_export_failed(locale),
        };
        self.status = (!sentence.is_empty()).then(|| wire::StatusLine {
            sentence,
            action_label: String::new(),
            refused: false,
        });
    }

    // ----------------------------------------------------------------- view --

    fn link(&self) -> Link {
        self.link
    }

    fn library_view(&self, locale: Locale) -> wire::PhotosLibrary {
        let rung = self.rung;
        let target = f64::from(layout::RUNG_HEIGHTS[layout::clamp_rung(rung) as usize]);
        let content = match self.library.phase {
            library::Phase::Failed => {
                wire::photos_library::Content::Failure(crate::kit::read::failure(locale))
            }
            library::Phase::Loading => {
                wire::photos_library::Content::Loading(wire::PhotosLibraryLoading {
                    skeleton: if self.viewport.0 > 0.0 {
                        layout::skeleton(self.viewport.0, target, self.viewport.1)
                            .into_iter()
                            .map(|row| wire::PhotosPackedRow {
                                packed: row.into_iter().map(|t| packed(&t)).collect(),
                            })
                            .collect()
                    } else {
                        Vec::new()
                    },
                })
            }
            library::Phase::Ready => {
                wire::photos_library::Content::Data(Box::new(self.library_data(locale, target)))
            }
        };
        wire::PhotosLibrary {
            content: Some(content),
            grain: self.grain as i32,
            filter: self.filter as i32,
            rung,
            place_day: self.place_day.clone(),
        }
    }

    fn library_data(&self, locale: Locale, target: f64) -> wire::PhotosLibraryData {
        let _ = target;
        let mut tiles = cells::tiles(&self.library.cells, self.link(), locale);
        for tile in &mut tiles {
            if self.fetching.contains(&tile.content_id) {
                tile.held = wire::photo_tile::Held::Fetching as i32;
            }
        }
        let ids: Vec<String> = tiles.iter().map(|tile| tile.photo_id.clone()).collect();
        let cells_for_layout: Vec<layout::Cell<'_>> = tiles
            .iter()
            .map(|tile| layout::Cell {
                id: &tile.photo_id,
                day: &tile.day,
                video: tile.kind == wire::photo_tile::Kind::Video as i32,
                boxed: layout::Boxed {
                    width: tile.width,
                    height: tile.height,
                },
            })
            .collect();
        let picked = self.selection.picked();
        let (rows, grain_items) = match self.grain {
            Grain::Years | Grain::Months => {
                let years = self.grain == Grain::Years;
                let periods = layout::periods(
                    locale,
                    &cells_for_layout,
                    |at| tiles[at].thumbnail_path.is_some(),
                    years,
                );
                let items = layout::grain_items(periods, years)
                    .into_iter()
                    .map(|item| wire::PhotosGrainItem {
                        key: item.key,
                        header: item.header,
                        periods: item
                            .periods
                            .into_iter()
                            .map(|period| {
                                let cover = tiles.get(period.cover).cloned();
                                wire::PhotosPeriod {
                                    accessibility_label: format!(
                                        "{}, {}",
                                        period.title, period.count
                                    ),
                                    key: period.key,
                                    title: period.title,
                                    count_label: period.count,
                                    cover,
                                    anchor_day: period.anchor_day,
                                }
                            })
                            .collect(),
                    })
                    .collect();
                (Vec::new(), items)
            }
            _ => {
                let rows = if self.viewport.0 > 0.0 {
                    layout::rows(
                        locale,
                        &cells_for_layout,
                        self.viewport.0,
                        self.rung,
                        layout::current_year(),
                    )
                    .into_iter()
                    .map(|row| {
                        let all_selected = !row.ids.is_empty()
                            && row.ids.iter().all(|id| picked.iter().any(|p| p == id));
                        wire::PhotosTimelineRow {
                            kind: row.kind as i32,
                            select_label: if row.ids.is_empty() {
                                String::new()
                            } else {
                                fill(
                                    &if all_selected {
                                        words::photos_deselect_day(locale)
                                    } else {
                                        words::photos_select_day(locale)
                                    },
                                    &[("title", &row.title)],
                                )
                            },
                            id: row.id,
                            day: row.day,
                            title: row.title,
                            ids: row.ids,
                            all_selected,
                            packed: row.tiles.iter().map(packed).collect(),
                        }
                    })
                    .collect()
                } else {
                    Vec::new()
                };
                (rows, Vec::new())
            }
        };
        let complete = self.library.complete();
        let empty = (self.library.cells.is_empty() && complete).then(|| {
            if self.filter == Filter::Favorites {
                wire::EmptyState {
                    headline: words::photos_grid_no_favorites(locale),
                    body: words::photos_grid_no_favorites_caption(locale),
                    ..wire::EmptyState::default()
                }
            } else {
                wire::EmptyState {
                    headline: words::photos_grid_empty(locale),
                    body: words::photos_grid_empty_caption(locale),
                    ..wire::EmptyState::default()
                }
            }
        });
        wire::PhotosLibraryData {
            count_label: cells::count_phrase(
                locale,
                self.library
                    .total
                    .unwrap_or(u32::try_from(tiles.len()).unwrap_or(u32::MAX)),
                self.library.total.is_none() && !complete,
            ),
            open: Some(routes::lightbox("", &ids, "")),
            rows,
            grain_items,
            complete,
            empty,
            undated_note: if matches!(self.grain, Grain::Years | Grain::Months) {
                words::photos_library_undated_note(locale)
            } else {
                String::new()
            },
            loading_more: false,
            loading_more_label: words::photos_library_loading_more(locale),
            scrub_label: words::photos_scrub(locale),
            tiles,
        }
    }

    fn empty_library(&self) -> bool {
        self.library.complete() && self.library.cells.is_empty() && self.filter != Filter::Favorites
    }

    fn more_sheet(&self, locale: Locale) -> wire::PhotosMoreSheet {
        let mut rows = vec![wire::PhotosMoreRow {
            key: chrome::MORE_CAMERA_ROLL.to_owned(),
            label: words::photos_camera_roll(locale),
            meta: String::new(),
            icon_key: "Archive".to_owned(),
            route: None,
        }];
        if chrome::tile_size_offered(self.destination, self.grain) {
            rows.push(wire::PhotosMoreRow {
                key: chrome::MORE_TILE_SIZE.to_owned(),
                label: words::photos_tile_size(locale),
                meta: layout::RUNG_LABELS[layout::clamp_rung(self.rung) as usize].to_owned(),
                icon_key: "Grid".to_owned(),
                route: None,
            });
        }
        wire::PhotosMoreSheet {
            title: words::photos_more_title(locale),
            foot: words::photos_more_foot(locale),
            rows,
            free_up: self.free_up.offered.then(|| wire::PhotosFreeUpRow {
                title: words::photos_free_up_title(locale),
                meta: self.free_up.meta.clone(),
                reason: self.free_up.reason.clone(),
                action_label: self.free_up.action_label.clone(),
                enabled: self.free_up.enabled && !self.free_up.freeing,
                freeing: self.free_up.freeing,
                notice: self.free_up.notice.clone(),
                retention: super::keep_originals::retention_body(locale),
            }),
            close_label: words::photos_done(locale),
        }
    }
}

fn packed(tile: &layout::Packed) -> wire::PhotosPackedTile {
    wire::PhotosPackedTile {
        tile: u32::try_from(tile.index).unwrap_or(u32::MAX),
        width: tile.width,
        height: tile.height,
    }
}

fn refused(sentence: String) -> wire::StatusLine {
    wire::StatusLine {
        sentence,
        action_label: String::new(),
        refused: true,
    }
}

fn camera_roll(action: wire::camera_roll::Action) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::CameraRoll(wire::CameraRoll {
            action: action as i32,
        })),
    }
}

fn free_up(action: wire::free_up_space::Action) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::FreeUpSpace(wire::FreeUpSpace {
            action: action as i32,
        })),
    }
}

impl Screen for Home {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(E::Appeared(_)) => {
                self.read(ctx);
                // THE TILE SIZE ACROSS LAUNCHES (v0's `photos-rung-store.ts`): the
                // rung and ONLY the rung is remembered; the filter and the zoom are
                // session-scoped.
                return vec![wire::Effect {
                    kind: Some(wire::effect::Kind::Keychain(wire::KeychainOp {
                        op: wire::keychain_op::Op::Get as i32,
                        key: layout::RUNG_KEY.to_owned(),
                        value: Vec::new(),
                    })),
                }];
            }
            Some(E::EnvironmentChanged(_) | E::DataChanged(_)) => self.read(ctx),
            Some(E::EffectResult(result)) => self.on_effect(&result, ctx),
            Some(E::PhotosHome(home)) => {
                if let Some(kind) = home.kind {
                    return self.on_event(kind, ctx);
                }
            }
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let library = chrome::is_library(self.destination);
        let more_up = matches!(
            self.sheet,
            Sheet::More | Sheet::TileSize | Sheet::BackupDetail
        );
        let status = self.status.clone().or_else(|| self.selection.status());
        let mut state = wire::PhotosHomeState {
            destination: self.destination as i32,
            band: chrome::band(locale, self.destination, more_up),
            chips: chrome::chips(
                locale,
                self.destination,
                self.selection.selecting(),
                self.filter,
            ),
            chrome: Some(chrome::words_of(locale)),
            sheet: self.sheet as i32,
            import_banner: if library {
                self.roll.banner(locale, self.empty_library())
            } else {
                None
            },
            status,
            selection: Some(self.selection.view(locale)),
            album_choice: Some(self.choice.view(locale, self.link())),
            ..wire::PhotosHomeState::default()
        };
        match self.destination {
            Dest::Collections => {
                state.collections = Some(self.collections.view(locale, self.link()));
            }
            Dest::Search => state.search = Some(self.search.view(locale, self.link())),
            _ => state.library = Some(self.library_view(locale)),
        }
        match self.sheet {
            Sheet::More => state.more = Some(self.more_sheet(locale)),
            Sheet::TileSize => state.tile_size = Some(chrome::tile_sizes(locale, self.rung)),
            Sheet::BackupDetail => state.backup_detail = Some(self.roll.detail(locale)),
            Sheet::CopyPlace => {
                state.copy_place = Some(wire::PhotosCopyPlaceSheet {
                    title: sentences::library_copy_place_title(locale),
                    no_location_label: sentences::library_copy_no_location(locale),
                    exact_location_label: sentences::library_copy_exact_location(locale),
                    cancel_label: words::photos_cancel(locale),
                });
            }
            _ => {}
        }
        let _ = civil::epoch_day_of;
        wire::ViewState {
            kind: Some(wire::view_state::Kind::PhotosHome(Box::new(state))),
            ..wire::ViewState::default()
        }
    }
}
