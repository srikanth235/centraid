use std::collections::BTreeMap;

use centraid_api_proto::core_v1 as wire;
use centraid_domain::apps::{entity as entity_reads, photos as reads};
use centraid_domain::read::Args;
use rand::RngCore as _;
use serde_json::{Value, json};

use super::blocks::{self, Confirm, glyph};
use super::door::Door;
use super::first;
use super::form::{self, Explicit, Save};
use super::frame::{self, room};
use super::screen::{Build, Event, Input, Outcome, Registry, RoomScreen};
use super::search_view;
use super::selector::{Act, Handler, Sel};
use crate::strings::{Locale, fill, home as home_words, photos as words, shared};

pub const PHOTOS: &str = "photos";
pub const ALBUMS: &str = "photos/albums";
pub const PLACES: &str = "photos/places";
pub const NEW_ALBUM: &str = "photos/albums/new";
pub const NEW_PLACE: &str = "photos/places/new";
pub const TRASH: &str = "photos/trash";

const EN: Locale = Locale::En;
const VIEW_PREF_KEY: &str = "view.photos";
const MAX_NAME_CHARS: usize = 200;
const FILTER_VIDEOS: &str = "filter/videos";
const FILTER_SCANS: &str = "filter/scans";
const FILTER_STARRED: &str = "filter/starred";

#[must_use]
pub fn registry() -> Registry {
    Registry::new()
        .exact(PHOTOS, || Box::new(LibraryPage::default()))
        .exact(ALBUMS, || Box::new(AlbumsList))
        .exact(PLACES, || Box::new(PlacesList::default()))
        .exact(NEW_ALBUM, || Box::new(NewAlbumForm::default()))
        .exact(NEW_PLACE, || Box::new(NewPlaceForm::default()))
        .exact(TRASH, || Box::new(PhotosTrash::default()))
        .exact("photos/trash/empty", || Box::new(EmptyTrashConfirm))
        .with(Box::new(|key| {
            if let Some(id) = key.strip_prefix("photos/trash/purge/") {
                return Some(Box::new(PurgeConfirm { id: id.to_owned() }));
            }
            if let Some(id) = key.strip_prefix("photos/slideshow/") {
                return Some(Box::new(SlideshowStage { id: id.to_owned() }));
            }
            if let Some(rest) = key.strip_prefix("photos/photo/") {
                if let Some(id) = rest.strip_suffix("/link") {
                    return Some(Box::new(super::link_picker::LinkPicker::new(
                        id.to_owned(),
                        format!("photos/photo/{id}"),
                        words::title(EN),
                    )));
                }
                if let Some(id) = rest.strip_suffix("/edited-copy") {
                    return Some(Box::new(EditedCopyPage {
                        source_id: id.to_owned(),
                    }));
                }
                if let Some(id) = rest.strip_suffix("/versions") {
                    return Some(super::versions::page(
                        &format!("photos/photo/{id}/versions"),
                        id,
                        &words::title(EN),
                    ));
                }
                if let Some(id) = rest.strip_suffix("/albums") {
                    return Some(Box::new(PickAlbumForPhoto {
                        photo_id: id.to_owned(),
                    }));
                }
                if let Some(id) = rest.strip_suffix("/place") {
                    return Some(Box::new(PickPlaceForPhoto {
                        photo_id: id.to_owned(),
                    }));
                }
                return Some(Box::new(PhotoViewer {
                    id: rest.to_owned(),
                    details_open: false,
                }));
            }
            if let Some(rest) = key.strip_prefix("photos/album/") {
                if let Some(id) = rest.strip_suffix("/add") {
                    return Some(Box::new(AddPhotosToAlbum {
                        album_id: id.to_owned(),
                    }));
                }
                if let Some(id) = rest.strip_suffix("/trash-confirm") {
                    return Some(Box::new(TrashAlbumConfirm { id: id.to_owned() }));
                }
                return Some(Box::new(AlbumDetail {
                    id: rest.to_owned(),
                    loaded: 50,
                }));
            }
            if let Some(rest) = key.strip_prefix("photos/place/") {
                if let Some(id) = rest.strip_suffix("/rename") {
                    return Some(Box::new(RenamePlaceForm::new(id.to_owned())));
                }
                if let Some((from, into)) = rest.split_once("/merge/") {
                    return Some(Box::new(MergePlaceConfirm {
                        from: from.to_owned(),
                        into: into.to_owned(),
                    }));
                }
                if let Some(id) = rest.strip_suffix("/merge") {
                    return Some(Box::new(MergePlacePick { id: id.to_owned() }));
                }
                return Some(Box::new(PlaceDetail {
                    id: rest.to_owned(),
                }));
            }
            None
        }))
}

fn mint_uuid_v7(now_ms: i64) -> String {
    let mut bytes = [0u8; 16];
    let ts = u64::try_from(now_ms.max(0)).unwrap_or(0);
    bytes[0] = ((ts >> 40) & 0xff) as u8;
    bytes[1] = ((ts >> 32) & 0xff) as u8;
    bytes[2] = ((ts >> 24) & 0xff) as u8;
    bytes[3] = ((ts >> 16) & 0xff) as u8;
    bytes[4] = ((ts >> 8) & 0xff) as u8;
    bytes[5] = (ts & 0xff) as u8;
    rand::rng().fill_bytes(&mut bytes[6..]);
    bytes[6] = (bytes[6] & 0x0f) | 0x70;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}

fn draft_key(door: &dyn Door, kind: &str) -> Option<String> {
    let vault = door.vault_id();
    if vault.is_empty() {
        None
    } else {
        Some(format!("draft.{vault}.{kind}"))
    }
}

fn load_zoom(door: &dyn Door) -> wire::RoomPhotoZoom {
    let Some(raw) = door.device_get(VIEW_PREF_KEY) else {
        return wire::RoomPhotoZoom::Months;
    };
    let Ok(val) = serde_json::from_str::<Value>(&raw) else {
        return wire::RoomPhotoZoom::Months;
    };
    match val.get("zoom").and_then(Value::as_str) {
        Some("years") => wire::RoomPhotoZoom::Years,
        Some("all") => wire::RoomPhotoZoom::All,
        _ => wire::RoomPhotoZoom::Months,
    }
}

fn save_zoom(door: &dyn Door, zoom: wire::RoomPhotoZoom) {
    let label = match zoom {
        wire::RoomPhotoZoom::Years => "years",
        wire::RoomPhotoZoom::All => "all",
        _ => "months",
    };
    let payload = json!({ "v": 1, "zoom": label }).to_string();
    let _ = door.device_put(VIEW_PREF_KEY, &payload);
}

fn originals_unbacked_up(door: &dyn Door) -> bool {
    let Ok(resp) = door.call(&wire::Request {
        kind: Some(wire::request::Kind::BackupStatus(
            wire::BackupStatusRequest {},
        )),
    }) else {
        return true;
    };
    match resp.kind {
        Some(wire::response::Kind::BackupStatus(status)) => {
            status.destinations.is_empty()
                || status.acked_at_ms.is_none()
                || status.pending_bytes > 0
        }
        _ => true,
    }
}

fn short_day(iso: &str) -> &str {
    iso.get(..10).unwrap_or(iso)
}

fn format_bytes(bytes: i64) -> String {
    crate::kit::quantity::Quantity::bytes(bytes.max(0))
        .words(EN, crate::kit::quantity::UnitsPref::Metric)
}

fn format_duration(seconds: Option<f64>) -> String {
    let Some(secs) = seconds else {
        return String::new();
    };
    let total = secs.max(0.0).round() as u64;
    let mins = total / 60;
    let rem = total % 60;
    format!("{mins}:{rem:02}")
}

fn aspect_milli(width: Option<i64>, height: Option<i64>) -> u32 {
    match (width, height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => ((w * 1000) / h).clamp(300, 3000) as u32,
        _ => 1000,
    }
}

fn tile_kind(form: &str) -> wire::RoomPhotoTileKind {
    match form {
        "video" => wire::RoomPhotoTileKind::Video,
        "scan" => wire::RoomPhotoTileKind::Scan,
        _ => wire::RoomPhotoTileKind::Photo,
    }
}

fn media_kind(form: &str) -> wire::RoomMediaKind {
    match form {
        "video" => wire::RoomMediaKind::Video,
        "scan" => wire::RoomMediaKind::Scan,
        _ => wire::RoomMediaKind::Image,
    }
}

fn section_heading_for(at: &str, zoom: wire::RoomPhotoZoom) -> String {
    match zoom {
        wire::RoomPhotoZoom::Years => at.get(..4).unwrap_or(at).to_owned(),
        wire::RoomPhotoZoom::Months => at.get(..7).unwrap_or(at).to_owned(),
        _ => words::zoom_all(EN),
    }
}

fn build_photo_sections(
    sel: &mut Sel,
    rows: &[reads::PhotoTile],
    zoom: wire::RoomPhotoZoom,
    selecting: bool,
    is_picked: impl Fn(&str) -> bool,
) -> Vec<wire::RoomPhotoSection> {
    let mut grouped: BTreeMap<String, Vec<wire::RoomPhotoTile>> = BTreeMap::new();
    for tile in rows {
        let stamp = tile.taken_at.as_deref().unwrap_or(&tile.at);
        let heading = section_heading_for(stamp, zoom);
        let id = &tile.id;
        let handler = if selecting {
            Handler::Pick(id.clone())
        } else {
            Handler::Open(format!("photos/photo/{id}"))
        };
        let label = if tile.title.is_empty() {
            short_day(stamp).to_owned()
        } else {
            tile.title.clone()
        };
        grouped
            .entry(heading)
            .or_default()
            .push(wire::RoomPhotoTile {
                selector_id: sel.on(format!("tile/{id}"), handler),
                kind: tile_kind(&tile.form) as i32,
                thumb: Some(wire::RoomThumb {
                    r#ref: tile.id.clone(),
                    alt: label.clone(),
                    hue_key: "photos".to_owned(),
                }),
                aspect_milli: aspect_milli(tile.width, tile.height),
                duration_label: format_duration(tile.duration_s),
                starred: tile.starred,
                selected: is_picked(id),
                a11y_label: label,
            });
    }
    grouped
        .into_iter()
        .rev()
        .map(|(heading, tiles)| wire::RoomPhotoSection { heading, tiles })
        .collect()
}

fn photos_band(b: &mut Build<'_>, active_tab: &str) -> wire::RoomBand {
    let follow_rows = super::follow::items(b, "camera_roll");
    let sel = &mut b.sel;
    let tabs = vec![
        frame::tab(
            sel,
            "tab/library",
            &words::tab_library(EN),
            "Image",
            active_tab == PHOTOS,
        ),
        frame::tab(
            sel,
            "tab/albums",
            &words::tab_albums(EN),
            "Layers",
            active_tab == ALBUMS,
        ),
        frame::tab(
            sel,
            "tab/places",
            &words::tab_places(EN),
            "MapPin",
            active_tab == PLACES,
        ),
    ];
    let mut more_trash = blocks::menu_item(
        sel,
        "more/trash",
        &shared::trash_entry(EN),
        Handler::Open(TRASH.to_owned()),
    );
    more_trash.secondary = shared::trash_entry_meta(EN);
    let mut more_items = vec![
        blocks::menu_item(
            sel,
            "more/export",
            &words::more_export(EN),
            Handler::Tag("more:export".to_owned()),
        ),
        more_trash,
    ];
    more_items.splice(0..0, follow_rows);
    let more_menu = blocks::menu(
        "band/more/menu",
        vec![blocks::menu_section("", more_items)],
        sel,
    );
    let mut band = frame::band(
        tabs,
        Some(Handler::Tag("nav:home".to_owned())),
        Some(Handler::SearchOpen),
        sel,
    );
    band.more_selector_id = sel.anchor("band/more");
    band.more = Some(more_menu);
    band
}

fn handle_more_or_nav(e: &mut Event<'_>, tag: &str) -> Option<Outcome> {
    if let Some(outcome) = super::follow::handle(e, tag) {
        return Some(outcome);
    }
    match tag {
        "nav:home" => Some(Outcome::replace(super::shell::HOME)),
        "tab:tab/library" => Some(Outcome::replace(PHOTOS)),
        "tab:tab/albums" => Some(Outcome::replace(ALBUMS)),
        "tab:tab/places" => Some(Outcome::replace(PLACES)),
        "more:export" => Some(super::export::ask(
            "photo.export_zip",
            json!({}),
            &shared::owner_reason_export(EN),
        )),
        _ => None,
    }
}

fn selection_actions(sel: &mut Sel, ids: &[String]) -> Vec<wire::RoomMenuItem> {
    if ids.is_empty() {
        return Vec::new();
    }
    let mut trash = blocks::menu_item(
        sel,
        "selection/trash",
        &shared::trash_move(EN),
        Handler::Act(Act::new("entity.trash", json!({ "ids": ids }))),
    );
    trash.destructive = true;
    vec![
        blocks::menu_item(
            sel,
            "selection/organize",
            &shared::organize(EN),
            Handler::Open(super::organize::route(ids)),
        ),
        blocks::menu_item(
            sel,
            "selection/star",
            &words::menu_star(EN),
            Handler::Act(Act::new(
                "flag.set/starred",
                json!({ "flag": "starred", "ids": ids }),
            )),
        ),
        trash,
    ]
}

struct LibraryPage {
    loaded: usize,
    zoom: Option<wire::RoomPhotoZoom>,
}

impl Default for LibraryPage {
    fn default() -> Self {
        Self {
            loaded: 50,
            zoom: None,
        }
    }
}

impl RoomScreen for LibraryPage {
    fn key(&self) -> String {
        PHOTOS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let zoom = *self.zoom.get_or_insert_with(|| load_zoom(b.door));
        let only_videos = b.ui.is_filtered(FILTER_VIDEOS);
        let only_scans = b.ui.is_filtered(FILTER_SCANS);
        let only_starred = b.ui.is_filtered(FILTER_STARRED);
        let term = b.ui.search_term().trim().to_owned();

        let answer = if only_starred {
            b.reload(&reads::STARRED, &Args::new(), self.loaded)
        } else if only_videos {
            b.reload(
                &reads::BY_FORM,
                &Args::new().text("form", "video"),
                self.loaded,
            )
        } else if only_scans {
            b.reload(
                &reads::BY_FORM,
                &Args::new().text("form", "scan"),
                self.loaded,
            )
        } else {
            b.reload(&reads::LIBRARY_GRID, &Args::new(), self.loaded)
        };
        let answer = match answer {
            Ok(answer) => answer,
            Err(err) => {
                return room(wire::RoomKind::AppPlace, PHOTOS)
                    .title(&words::title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };

        let rows = answer.rows;
        if !term.is_empty()
            && let Err(sentence) =
                search_view::load(b.ui, b.door, &["photo", "album", "place"], &term)
        {
            return room(wire::RoomKind::AppPlace, PHOTOS)
                .title(&words::title(EN))
                .failed(&mut b.sel, &sentence, &shared::kit_retry(EN))
                .build();
        }

        let ids: Vec<String> = if term.is_empty() {
            rows.iter().map(|r| r.id.clone()).collect()
        } else {
            b.ui.search_hits().iter().map(|r| r.id.clone()).collect()
        };
        b.ui.list(ids);

        let selecting = b.ui.selecting();
        let picked: Vec<String> = b.ui.picked().map(str::to_owned).collect();
        let count_str = words::photos_count(
            EN,
            if term.is_empty() {
                rows.len()
            } else {
                b.ui.search_hits().len()
            } as u64,
        );

        let mut f_videos = blocks::menu_item(
            &mut b.sel,
            FILTER_VIDEOS,
            &words::filter_videos(EN),
            Handler::Filter(FILTER_VIDEOS.to_owned()),
        );
        f_videos.checked = only_videos;
        let mut f_scans = blocks::menu_item(
            &mut b.sel,
            FILTER_SCANS,
            &words::filter_scans(EN),
            Handler::Filter(FILTER_SCANS.to_owned()),
        );
        f_scans.checked = only_scans;
        let mut f_starred = blocks::menu_item(
            &mut b.sel,
            FILTER_STARRED,
            &words::filter_starred(EN),
            Handler::Filter(FILTER_STARRED.to_owned()),
        );
        f_starred.checked = only_starred;

        let filter_menu = blocks::menu(
            "photos-filter-menu",
            vec![blocks::menu_section(
                &words::filter_section_show(EN),
                vec![f_videos, f_scans, f_starred],
            )],
            &mut b.sel,
        );

        let mut content = Vec::new();
        if !term.is_empty() {
            content = search_view::rows(&mut b.sel, b.ui, selecting);
            if content.is_empty() {
                let body = fill(&words::empty_search_body(EN), &[("term", &term)]);
                content.push(blocks::empty(
                    glyph("Search", "photos"),
                    &words::empty_search_title(EN),
                    &body,
                    None,
                ));
            }
        } else if rows.is_empty() {
            if term.is_empty() {
                let add = blocks::action(
                    &mut b.sel,
                    "empty/add",
                    &words::add_photo(EN),
                    "Plus",
                    Handler::Tag("add:photo".to_owned()),
                );
                let _ = add;
                let refused = first::refused(b.door, "photos").then(|| {
                    (
                        home_words::refused_photos_title(EN),
                        home_words::refused_photos_body(EN),
                    )
                });
                content.push(first::first_open(
                    b,
                    first::FirstOpen {
                        app: "photos",
                        icon: "Image",
                        hue: "photos",
                        sentence: home_words::first_open_photos(EN),
                        action: Some((
                            first::import("photos"),
                            home_words::first_open_import_photos(EN),
                        )),
                        tail: first::Tail::OrAdd,
                        refused,
                    },
                ));
            } else {
                let body = fill(&words::empty_search_body(EN), &[("term", &term)]);
                content.push(blocks::empty(
                    glyph("Search", "photos"),
                    &words::empty_search_title(EN),
                    &body,
                    None,
                ));
            }
        } else {
            let zoom_choice = blocks::choice(
                &mut b.sel,
                "zoom",
                &words::zoom_label(EN),
                wire::RoomChoiceStyle::Segmented,
                false,
                vec![
                    blocks::option(
                        "years",
                        &words::zoom_years(EN),
                        zoom == wire::RoomPhotoZoom::Years,
                    ),
                    blocks::option(
                        "months",
                        &words::zoom_months(EN),
                        zoom == wire::RoomPhotoZoom::Months,
                    ),
                    blocks::option(
                        "all",
                        &words::zoom_all(EN),
                        zoom == wire::RoomPhotoZoom::All,
                    ),
                ],
                "zoom",
            );
            content.push(blocks::choice_block(zoom_choice));

            let sections =
                build_photo_sections(&mut b.sel, &rows, zoom, selecting, |id| b.ui.is_picked(id));
            let next_page = if answer.next.is_some() {
                b.sel.on("grid/more", Handler::NextPage("grid".to_owned()))
            } else {
                String::new()
            };
            content.push(blocks::photo_grid(wire::RoomPhotoGrid {
                zoom: zoom as i32,
                sections,
                next_page_selector_id: next_page,
                viewer: None,
            }));
        }

        let sel_actions = selection_actions(&mut b.sel, &picked);
        let sel_label = words::selected_count(EN, picked.len() as u64);
        let band = photos_band(b, PHOTOS);

        let mut built = room(wire::RoomKind::AppPlace, PHOTOS)
            .title(&words::title(EN))
            .subtitle(&count_str)
            .filter(&mut b.sel, filter_menu, b.ui)
            .key(
                &mut b.sel,
                "header/add",
                wire::RoomKeyRole::Add,
                "Plus",
                &words::add_photo(EN),
                Handler::Tag("add:photo".to_owned()),
            )
            .key(
                &mut b.sel,
                "header/select",
                wire::RoomKeyRole::Tool,
                "Check",
                &shared::menu_select(EN),
                Handler::SelectMode(true),
            )
            .band(band)
            .search(&mut b.sel, b.ui, &words::search_placeholder(EN))
            .selection(&mut b.sel, b.ui, &sel_label, sel_actions)
            .ready(content)
            .build();
        if let Some(search) = built.search.as_mut() {
            search_view::decorate(&mut b.sel, search, b.ui);
        }
        built
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        if let Some(outcome) = super::attachments::handle(e, tag, input) {
            return outcome;
        }
        if let Some(out) = super::export::handle(e, tag, input) {
            return out;
        }
        if let Some(out) = handle_more_or_nav(e, tag) {
            return out;
        }
        if tag == "selection/trash" {
            let ids: Vec<String> = e.ui.picked().map(str::to_owned).collect();
            if ids.is_empty() {
                return Outcome::default();
            }
            return match e.door.act(&Act::new("entity.trash", json!({ "ids": ids }))) {
                Ok(done) => {
                    e.ui.select_mode(false);
                    Outcome::done(&done.sentence, done.undo)
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        if tag == "selection/star" {
            let ids: Vec<String> = e.ui.picked().map(str::to_owned).collect();
            if ids.is_empty() {
                return Outcome::default();
            }
            return match e.door.act(&Act::new(
                "flag.set/starred",
                json!({ "flag": "starred", "ids": ids }),
            )) {
                Ok(done) => {
                    e.ui.select_mode(false);
                    Outcome::done(&done.sentence, done.undo)
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        if tag == "zoom"
            && let Input::Option(opt) = input
        {
            let next = match opt.as_str() {
                "years" => wire::RoomPhotoZoom::Years,
                "all" => wire::RoomPhotoZoom::All,
                _ => wire::RoomPhotoZoom::Months,
            };
            self.zoom = Some(next);
            save_zoom(e.door, next);
            return Outcome::default();
        }
        if let Input::Canvas(wire::room_canvas_event::Kind::PhotoZoom(z)) = input {
            let next = wire::RoomPhotoZoom::try_from(z.zoom).unwrap_or(wire::RoomPhotoZoom::Months);
            self.zoom = Some(next);
            save_zoom(e.door, next);
            return Outcome::default();
        }
        if tag == "add:photo" {
            return super::attachments::ask("photo", "");
        }
        if tag == "next:search/more" {
            e.ui.advance_search_page();
            return Outcome::default();
        }
        if tag.starts_with("next:") {
            self.loaded = (self.loaded + 50).min(500);
        }
        Outcome::default()
    }
}

struct PhotoViewer {
    id: String,
    details_open: bool,
}

impl RoomScreen for PhotoViewer {
    fn key(&self) -> String {
        format!("photos/photo/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let detail = match b.run(&reads::BY_ID, &Args::new().text("id", &self.id)) {
            Ok(answer) => answer.rows.into_iter().next(),
            Err(err) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&words::title(EN))
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let Some(photo) = detail else {
            return room(wire::RoomKind::PushedPage, &self.key())
                .title(&words::title(EN))
                .back(&mut b.sel, &words::title(EN))
                .ready(vec![blocks::empty(
                    glyph("Image", "photos"),
                    &words::not_found(EN),
                    "",
                    None,
                )])
                .build();
        };

        let all = b
            .run(&reads::LIBRARY_GRID, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();
        let pos = all.iter().position(|r| r.id == self.id).unwrap_or(0);
        let prev_ref = pos
            .checked_sub(1)
            .and_then(|i| all.get(i))
            .map(|r| r.blob.clone())
            .unwrap_or_default();
        let next_ref = all.get(pos + 1).map(|r| r.blob.clone()).unwrap_or_default();

        let mut facts = vec![
            blocks::fact(
                &words::fact_taken(EN),
                short_day(photo.taken_at.as_deref().unwrap_or(&photo.created_at)),
                wire::RoomFactKind::Date,
            ),
            blocks::fact(
                &words::fact_type(EN),
                &photo.media_type,
                wire::RoomFactKind::Text,
            ),
            blocks::fact(
                &words::fact_size(EN),
                &format_bytes(photo.size),
                wire::RoomFactKind::Text,
            ),
        ];
        if let (Some(w), Some(h)) = (photo.width, photo.height) {
            facts.push(blocks::fact(
                &words::fact_dimensions(EN),
                &format!("{w} × {h}"),
                wire::RoomFactKind::Text,
            ));
        }
        if let Some(place_title) = photo.place_title.as_deref() {
            let mut f = blocks::fact(
                &words::fact_place(EN),
                place_title,
                wire::RoomFactKind::Address,
            );
            if let Some(pid) = photo.place_id.as_deref() {
                f = blocks::fact_actions(
                    &mut b.sel,
                    f,
                    "fact/place",
                    Some(Handler::Open(format!("photos/place/{pid}"))),
                    None,
                );
            }
            facts.push(f);
        }
        if let (Some(source_id), Some(source_title)) = (
            photo.edited_from.as_deref(),
            photo.edited_from_title.as_deref(),
        ) {
            let source = blocks::fact(
                &words::fact_edited_from(EN),
                source_title,
                wire::RoomFactKind::Text,
            );
            facts.push(blocks::fact_actions(
                &mut b.sel,
                source,
                "fact/edited-from",
                Some(Handler::Open(format!("photos/photo/{source_id}"))),
                None,
            ));
        }

        let mut details_blocks = vec![blocks::facts(facts)];

        if let Ok(rev) = b.run(
            &entity_reads::REVISION_HEAD,
            &Args::new().text("id", &self.id),
        ) && let Some(head) = rev.rows.first()
            && head.count > 0
        {
            details_blocks.push(blocks::earlier_versions(
                &mut b.sel,
                &shared::versions_summary(EN, head.count as u64),
                u32::try_from(head.count).unwrap_or(u32::MAX),
                Handler::Open(format!("photos/photo/{}/versions", self.id)),
            ));
        }

        if let Ok(links) = b.run(&entity_reads::LINKED, &Args::new().text("id", &self.id)) {
            let mut linked_rows = Vec::new();
            for target_id in links.rows {
                if let Ok(meta) = b.run(
                    &entity_reads::META_BY_ID,
                    &Args::new().text("id", &target_id),
                ) && let Some(target) = meta.rows.into_iter().next()
                {
                    linked_rows.push(
                        blocks::row(
                            &mut b.sel,
                            &format!("linked/{}", target.id),
                            &target.title,
                            Handler::Tag(format!("open:{}:{}", target.kind, target.id)),
                        )
                        .menu(super::link_picker::unlink_menu(&mut b.sel, &target.id))
                        .build(),
                    );
                }
            }
            let add = blocks::action(
                &mut b.sel,
                "footer/linked/add",
                &shared::link_add(EN),
                "",
                Handler::Tag("link:add".to_owned()),
            );
            details_blocks.push(blocks::linked(
                &words::footer_linked(EN),
                linked_rows,
                Some(add),
            ));
        }

        if let Ok(backlinks) = b.run(
            &entity_reads::MENTIONED_IN,
            &Args::new().text("id", &self.id),
        ) && !backlinks.rows.is_empty()
        {
            let items: Vec<_> = backlinks
                .rows
                .iter()
                .map(|row| {
                    blocks::row(
                        &mut b.sel,
                        &format!("backlink/{}", row.id),
                        &row.title,
                        Handler::Open(format!("notes/note/{}", row.id)),
                    )
                    .build()
                })
                .collect();
            details_blocks.push(blocks::mentioned_in(&words::footer_mentioned(EN), items));
        }

        if let Some(label) = photo.arrived_label.as_deref() {
            let line = fill(&shared::origin_line(EN), &[("label", label)]);
            details_blocks.push(blocks::origin(&mut b.sel, &line, None));
        }

        let star_act = if photo.starred {
            Act::new(
                "flag.clear/starred",
                json!({ "flag": "starred", "ids": [&self.id] }),
            )
        } else {
            Act::new(
                "flag.set/starred",
                json!({ "flag": "starred", "ids": [&self.id] }),
            )
        };
        let mut trash = blocks::menu_item(
            &mut b.sel,
            "viewer/menu/trash",
            &shared::trash_move(EN),
            Handler::Tag("trash".to_owned()),
        );
        trash.destructive = true;
        let star_label = if photo.starred {
            words::menu_unstar(EN)
        } else {
            words::menu_star(EN)
        };
        let mut menu_items = vec![
            blocks::menu_item(
                &mut b.sel,
                "viewer/menu/star",
                &star_label,
                Handler::Act(star_act),
            ),
            blocks::menu_item(
                &mut b.sel,
                "viewer/menu/details",
                &words::menu_details(EN),
                Handler::Tag("details:toggle".to_owned()),
            ),
            blocks::menu_item(
                &mut b.sel,
                "viewer/menu/organize",
                &shared::organize(EN),
                Handler::Open(super::organize::route(std::slice::from_ref(&self.id))),
            ),
            blocks::menu_item(
                &mut b.sel,
                "viewer/menu/slideshow",
                &words::menu_slideshow(EN),
                Handler::Open(format!("photos/slideshow/{}", self.id)),
            ),
            blocks::menu_item(
                &mut b.sel,
                "viewer/menu/album",
                &words::menu_add_to_album(EN),
                Handler::Open(format!("photos/photo/{}/albums", self.id)),
            ),
            blocks::menu_item(
                &mut b.sel,
                "viewer/menu/place",
                &words::menu_set_place(EN),
                Handler::Open(format!("photos/photo/{}/place", self.id)),
            ),
        ];
        if photo.form == "photo" {
            menu_items.push(blocks::menu_item(
                &mut b.sel,
                "viewer/menu/edited-copy",
                &words::edited_copy_action(EN),
                Handler::Tag("edited-copy".to_owned()),
            ));
        }
        menu_items.extend([
            blocks::menu_item(
                &mut b.sel,
                "viewer/menu/download",
                &words::menu_download(EN),
                Handler::Tag("download".to_owned()),
            ),
            trash,
        ]);
        let menu = blocks::menu(
            "viewer/menu",
            vec![blocks::menu_section("", menu_items)],
            &mut b.sel,
        );

        let mut current = blocks::media(
            &mut b.sel,
            "viewer/media",
            media_kind(&photo.form),
            wire::RoomThumb {
                r#ref: photo.id.clone(),
                alt: photo.title.clone(),
                hue_key: "photos".to_owned(),
            },
            Handler::Tag("details:toggle".to_owned()),
        );
        current.aspect_milli = aspect_milli(photo.width, photo.height);
        current.caption = photo.title.clone();
        current.duration_label = format_duration(photo.duration_s);

        let viewer = wire::RoomPhotoViewer {
            tile_selector_id: format!("tile/{}", self.id),
            index: pos as u32,
            count: all.len().max(1) as u32,
            current: Some(current),
            previous_ref: prev_ref,
            next_ref,
            menu: Some(menu.clone()),
            details: details_blocks,
            details_open: self.details_open,
            slideshow: false,
        };

        let page_title = if photo.title.is_empty() {
            short_day(photo.taken_at.as_deref().unwrap_or(&photo.created_at)).to_owned()
        } else {
            photo.title
        };

        let grid = blocks::photo_grid(wire::RoomPhotoGrid {
            zoom: wire::RoomPhotoZoom::All as i32,
            sections: Vec::new(),
            next_page_selector_id: String::new(),
            viewer: Some(viewer),
        });

        room(wire::RoomKind::PushedPage, &self.key())
            .title(&page_title)
            .back(&mut b.sel, &words::title(EN))
            .menu_key(&mut b.sel, "header/more", &words::menu_more(EN), menu)
            .ready(vec![grid])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        if let Some(outcome) = super::export::handle(e, tag, input) {
            return outcome;
        }
        if let Some(outcome) = super::link_picker::handle_unlink(e, tag, &self.id) {
            return outcome;
        }
        if tag == "link:add" {
            return Outcome::push(&format!("photos/photo/{}/link", self.id));
        }
        if tag == "edited-copy" {
            return Outcome::push(&format!("photos/photo/{}/edited-copy", self.id));
        }
        match tag {
            "details:toggle" => {
                self.details_open = !self.details_open;
                Outcome::default()
            }
            "download" => {
                let reader = match e.door.reader() {
                    Ok(reader) => reader,
                    Err(_) => return Outcome::refuse(&shared::read_failed(EN)),
                };
                let photo = match reader.run(&reads::BY_ID, &Args::new().text("id", &self.id)) {
                    Ok(answer) => answer.rows.into_iter().next(),
                    Err(_) => return Outcome::refuse(&shared::read_failed(EN)),
                };
                let Some(photo) = photo else {
                    return Outcome::refuse(&words::not_found(EN));
                };
                super::export::download_original(e, &photo.blob)
            }
            "trash" => {
                let act = Act::new("entity.trash", json!({ "ids": [&self.id] }));
                match e.door.act(&act) {
                    Ok(done) => {
                        let mut out = Outcome::done(&done.sentence, done.undo);
                        out.nav = super::screen::Nav::Pop;
                        out
                    }
                    Err(refused) => Outcome::refuse(&refused.0),
                }
            }
            _ => Outcome::default(),
        }
    }
}

struct SlideshowStage {
    id: String,
}

struct EditedCopyPage {
    source_id: String,
}

impl RoomScreen for EditedCopyPage {
    fn key(&self) -> String {
        format!("photos/photo/{}/edited-copy", self.source_id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let photo = match b.run(&reads::BY_ID, &Args::new().text("id", &self.source_id)) {
            Ok(answer) => answer.rows.into_iter().next(),
            Err(refused) => {
                return room(wire::RoomKind::Sheet, &self.key())
                    .title(&words::edited_copy_title(EN))
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &refused.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let Some(photo) = photo else {
            return room(wire::RoomKind::Sheet, &self.key())
                .title(&words::edited_copy_title(EN))
                .back(&mut b.sel, &words::title(EN))
                .failed(&mut b.sel, &words::not_found(EN), &shared::kit_done(EN))
                .build();
        };
        if photo.form != "photo" {
            return room(wire::RoomKind::Sheet, &self.key())
                .title(&words::edited_copy_title(EN))
                .back(&mut b.sel, &words::title(EN))
                .ready(vec![blocks::prose(&words::edited_copy_source_invalid(EN))])
                .build();
        }
        let action = blocks::row(
            &mut b.sel,
            "edited-copy/choose",
            &words::edited_copy_choose(EN),
            Handler::Tag("choose".to_owned()),
        )
        .into_block();
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::edited_copy_title(EN))
            .subtitle(&photo.title)
            .back(&mut b.sel, &words::title(EN))
            .ready(vec![blocks::prose(&words::edited_copy_body(EN)), action])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, input: &Input) -> Outcome {
        if let Some(mut outcome) = super::attachments::handle(e, tag, input) {
            if outcome
                .status
                .as_ref()
                .is_some_and(|status| !status.refused)
            {
                outcome.nav = super::screen::Nav::Pop;
            }
            return outcome;
        }
        if tag == "choose" {
            return super::attachments::ask("edited", &self.source_id);
        }
        Outcome::default()
    }
}

impl RoomScreen for SlideshowStage {
    fn key(&self) -> String {
        format!("photos/slideshow/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let detail = b
            .run(&reads::BY_ID, &Args::new().text("id", &self.id))
            .ok()
            .and_then(|a| a.rows.into_iter().next());
        let Some(photo) = detail else {
            return room(wire::RoomKind::Stage, &self.key())
                .ready(vec![blocks::empty(
                    glyph("Image", "photos"),
                    &words::not_found(EN),
                    "",
                    None,
                )])
                .build();
        };
        let mut current = blocks::media(
            &mut b.sel,
            "stage/media",
            media_kind(&photo.form),
            wire::RoomThumb {
                r#ref: photo.id.clone(),
                alt: photo.title.clone(),
                hue_key: "photos".to_owned(),
            },
            Handler::Back,
        );
        current.aspect_milli = aspect_milli(photo.width, photo.height);
        current.caption = photo.title;
        current.duration_label = format_duration(photo.duration_s);
        let grid = blocks::photo_grid(wire::RoomPhotoGrid {
            zoom: wire::RoomPhotoZoom::All as i32,
            sections: Vec::new(),
            next_page_selector_id: String::new(),
            viewer: Some(wire::RoomPhotoViewer {
                tile_selector_id: format!("tile/{}", self.id),
                index: 0,
                count: 1,
                current: Some(current),
                previous_ref: String::new(),
                next_ref: String::new(),
                menu: None,
                details: Vec::new(),
                details_open: false,
                slideshow: true,
            }),
        });
        room(wire::RoomKind::Stage, &self.key())
            .ready(vec![grid])
            .build()
    }
}

struct PickAlbumForPhoto {
    photo_id: String,
}

impl RoomScreen for PickAlbumForPhoto {
    fn key(&self) -> String {
        format!("photos/photo/{}/albums", self.photo_id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let albums = b
            .run(&reads::ALBUMS, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();
        let mut content = Vec::new();
        if albums.is_empty() {
            content.push(blocks::empty(
                glyph("Layers", "photos"),
                &words::empty_albums_title(EN),
                &words::empty_albums_body(EN),
                None,
            ));
        } else {
            let rows: Vec<_> = albums
                .iter()
                .map(|album| {
                    blocks::row(
                        &mut b.sel,
                        &format!("album/{}", album.id),
                        &album.title,
                        Handler::Tag(format!("add:{}", album.id)),
                    )
                    .mark(blocks::glyph_mark("Layers", "photos"))
                    .into_block()
                })
                .collect();
            content.push(
                blocks::section(&mut b.sel, "section/albums", &words::section_albums(EN))
                    .blocks(rows)
                    .into_block(),
            );
        }
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::add_to_album(EN))
            .ready(content)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if let Some(album_id) = tag.strip_prefix("add:") {
            let act = Act::new(
                "edge.add",
                json!({ "from": album_id, "rel": "contains", "to": self.photo_id }),
            );
            return match e.door.act(&act) {
                Ok(_) => {
                    let mut out = Outcome::done(&words::added_to_album(EN), true);
                    out.nav = super::screen::Nav::Pop;
                    out
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct PickPlaceForPhoto {
    photo_id: String,
}

impl RoomScreen for PickPlaceForPhoto {
    fn key(&self) -> String {
        format!("photos/photo/{}/place", self.photo_id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let places = b
            .run(&reads::PLACES, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();
        let mut content = Vec::new();
        if places.is_empty() {
            content.push(blocks::empty(
                glyph("MapPin", "photos"),
                &words::empty_places_title(EN),
                &words::empty_places_body(EN),
                None,
            ));
        } else {
            let rows: Vec<_> = places
                .iter()
                .map(|place| {
                    blocks::row(
                        &mut b.sel,
                        &format!("place/{}", place.id),
                        &place.title,
                        Handler::Tag(format!("set:{}", place.id)),
                    )
                    .mark(blocks::glyph_mark("MapPin", "photos"))
                    .into_block()
                })
                .collect();
            content.push(
                blocks::section(&mut b.sel, "section/places", &words::section_places(EN))
                    .blocks(rows)
                    .into_block(),
            );
        }
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::menu_set_place(EN))
            .ready(content)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if let Some(place_id) = tag.strip_prefix("set:") {
            let act = Act::new(
                "photo.set_place",
                json!({ "id": self.photo_id, "place_id": place_id }),
            );
            return match e.door.act(&act) {
                Ok(done) => {
                    let mut out = Outcome::done(&done.sentence, done.undo);
                    out.nav = super::screen::Nav::Pop;
                    out
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct AlbumsList;

impl RoomScreen for AlbumsList {
    fn key(&self) -> String {
        ALBUMS.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let albums = match b.run(&reads::ALBUMS, &Args::new()) {
            Ok(answer) => answer.rows,
            Err(err) => {
                return room(wire::RoomKind::AppPlace, ALBUMS)
                    .title(&words::albums_title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let count_str = words::albums_count(EN, albums.len() as u64);
        let mut content = Vec::new();
        if albums.is_empty() {
            let add = blocks::action(
                &mut b.sel,
                "empty/add",
                &words::add_album(EN),
                "Plus",
                Handler::Open(NEW_ALBUM.to_owned()),
            );
            content.push(blocks::empty(
                glyph("Layers", "photos"),
                &words::empty_albums_title(EN),
                &words::empty_albums_body(EN),
                Some(add),
            ));
        } else {
            let rows: Vec<_> = albums
                .iter()
                .map(|album| {
                    let id = &album.id;
                    let mut trash = blocks::menu_item(
                        &mut b.sel,
                        &format!("album/{id}/menu/trash"),
                        &shared::trash_move(EN),
                        Handler::Open(format!("photos/album/{id}/trash-confirm")),
                    );
                    trash.destructive = true;
                    let menu = blocks::menu(
                        &format!("album/{id}/menu"),
                        vec![blocks::menu_section(
                            "",
                            vec![
                                blocks::menu_item(
                                    &mut b.sel,
                                    &format!("album/{id}/menu/open"),
                                    &shared::kit_open(EN),
                                    Handler::Open(format!("photos/album/{id}")),
                                ),
                                trash,
                            ],
                        )],
                        &mut b.sel,
                    );
                    let mark = match album.cover.as_deref() {
                        Some(cover) => blocks::thumb_mark(cover, &album.title, "photos"),
                        None => blocks::glyph_mark("Layers", "photos"),
                    };
                    blocks::row(
                        &mut b.sel,
                        &format!("album/{id}"),
                        &album.title,
                        Handler::Open(format!("photos/album/{id}")),
                    )
                    .mark(mark)
                    .menu(menu)
                    .into_block()
                })
                .collect();
            content.push(
                blocks::section(&mut b.sel, "section/albums", &words::section_albums(EN))
                    .blocks(rows)
                    .into_block(),
            );
        }

        let band = photos_band(b, ALBUMS);
        room(wire::RoomKind::AppPlace, ALBUMS)
            .title(&words::albums_title(EN))
            .subtitle(&count_str)
            .key(
                &mut b.sel,
                "header/add",
                wire::RoomKeyRole::Add,
                "Plus",
                &words::add_album(EN),
                Handler::Open(NEW_ALBUM.to_owned()),
            )
            .band(band)
            .ready(content)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        handle_more_or_nav(e, tag).unwrap_or_default()
    }
}

struct AlbumDetail {
    id: String,
    loaded: usize,
}

impl RoomScreen for AlbumDetail {
    fn key(&self) -> String {
        format!("photos/album/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let meta = match b.run(&entity_reads::META_BY_ID, &Args::new().text("id", &self.id)) {
            Ok(answer) => answer.rows.into_iter().next(),
            Err(err) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&words::albums_title(EN))
                    .back(&mut b.sel, &words::albums_title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let Some(album) = meta else {
            return room(wire::RoomKind::PushedPage, &self.key())
                .title(&words::albums_title(EN))
                .back(&mut b.sel, &words::albums_title(EN))
                .ready(vec![blocks::empty(
                    glyph("Layers", "photos"),
                    &words::album_not_found(EN),
                    "",
                    None,
                )])
                .build();
        };
        let members = match b.reload(
            &reads::ALBUM_MEMBERS,
            &Args::new().text("album", &self.id),
            self.loaded,
        ) {
            Ok(answer) => answer,
            Err(err) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&album.title)
                    .back(&mut b.sel, &words::albums_title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };

        let add_route = format!("photos/album/{}/add", self.id);
        let count_str = words::photos_count(EN, members.rows.len() as u64);
        let mut content = Vec::new();
        if members.rows.is_empty() {
            let add = blocks::action(
                &mut b.sel,
                "empty/add",
                &words::add_to_album(EN),
                "Plus",
                Handler::Open(add_route.clone()),
            );
            content.push(blocks::empty(
                glyph("Image", "photos"),
                &words::empty_album_title(EN),
                &words::empty_album_body(EN),
                Some(add),
            ));
        } else {
            let sections = build_photo_sections(
                &mut b.sel,
                &members.rows,
                wire::RoomPhotoZoom::All,
                false,
                |_| false,
            );
            let next_page = if members.next.is_some() {
                b.sel.on("grid/more", Handler::NextPage("grid".to_owned()))
            } else {
                String::new()
            };
            content.push(blocks::photo_grid(wire::RoomPhotoGrid {
                zoom: wire::RoomPhotoZoom::All as i32,
                sections,
                next_page_selector_id: next_page,
                viewer: None,
            }));
        }

        let mut trash = blocks::menu_item(
            &mut b.sel,
            "header/menu/trash",
            &shared::trash_move(EN),
            Handler::Open(format!("photos/album/{}/trash-confirm", self.id)),
        );
        trash.destructive = true;
        let menu = blocks::menu(
            "header/menu",
            vec![blocks::menu_section(
                "",
                vec![
                    blocks::menu_item(
                        &mut b.sel,
                        "header/menu/add",
                        &words::add_to_album(EN),
                        Handler::Open(add_route),
                    ),
                    trash,
                ],
            )],
            &mut b.sel,
        );

        room(wire::RoomKind::PushedPage, &self.key())
            .title(&album.title)
            .subtitle(&count_str)
            .back(&mut b.sel, &words::albums_title(EN))
            .menu_key(&mut b.sel, "header/more", &words::menu_more(EN), menu)
            .ready(content)
            .build()
    }

    fn on(&mut self, _e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag.starts_with("next:") {
            self.loaded = (self.loaded + 50).min(500);
        }
        Outcome::default()
    }
}

struct AddPhotosToAlbum {
    album_id: String,
}

impl RoomScreen for AddPhotosToAlbum {
    fn key(&self) -> String {
        format!("photos/album/{}/add", self.album_id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let library = b
            .run(&reads::LIBRARY_GRID, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();
        let mut content = Vec::new();
        if library.is_empty() {
            content.push(blocks::empty(
                glyph("Image", "photos"),
                &words::empty_library_title(EN),
                &words::empty_library_body(EN),
                None,
            ));
        } else {
            let rows: Vec<_> = library
                .iter()
                .map(|photo| {
                    let label = if photo.title.is_empty() {
                        short_day(&photo.at).to_owned()
                    } else {
                        photo.title.clone()
                    };
                    blocks::row(
                        &mut b.sel,
                        &format!("pick/{}", photo.id),
                        &label,
                        Handler::Tag(format!("add:{}", photo.id)),
                    )
                    .mark(blocks::thumb_mark(&photo.blob, &label, "photos"))
                    .into_block()
                })
                .collect();
            content.push(
                blocks::section(&mut b.sel, "section/photos", &words::section_photos(EN))
                    .blocks(rows)
                    .into_block(),
            );
        }
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::add_to_album(EN))
            .ready(content)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if let Some(photo_id) = tag.strip_prefix("add:") {
            let act = Act::new(
                "edge.add",
                json!({ "from": self.album_id, "rel": "contains", "to": photo_id }),
            );
            return match e.door.act(&act) {
                Ok(_) => {
                    let mut out = Outcome::done(&words::added_to_album(EN), true);
                    out.nav = super::screen::Nav::Pop;
                    out
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

#[derive(Default)]
struct NewAlbumForm {
    loaded_draft: bool,
    error: Option<String>,
}

impl RoomScreen for NewAlbumForm {
    fn key(&self) -> String {
        NEW_ALBUM.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        if !self.loaded_draft {
            self.loaded_draft = true;
            if let Some(key) = draft_key(b.door, "album")
                && let Some(raw) = b.door.device_get(&key)
                && let Ok(val) = serde_json::from_str::<Value>(&raw)
                && let Some(name) = val
                    .get("fields")
                    .and_then(|f| f.get("name"))
                    .and_then(Value::as_str)
            {
                b.ui.fields.get_or("name", name);
            }
        }
        let mut field = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "name",
            &words::field_album_name(EN),
            wire::RoomTextKind::Line,
            "",
            MAX_NAME_CHARS,
        )
        .required()
        .focused();
        if let Some(err) = &self.error {
            field = field.error(err);
        }
        let save_label = shared::kit_save(EN);
        let cancel_label = shared::kit_cancel(EN);
        let name_val = b.ui.fields.value("name").unwrap_or("");
        let save = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &save_label,
                cancel_label: &cancel_label,
                save_enabled: !name_val.trim().is_empty(),
                dirty: !name_val.is_empty(),
                drafted: false,
                save: Handler::Tag("save".to_owned()),
                cancel: Handler::Tag("cancel".to_owned()),
            },
        );
        let block = form::form(vec![field.build()], Vec::new(), Save::Explicit(save));
        room(wire::RoomKind::Sheet, NEW_ALBUM)
            .title(&words::new_album_title(EN))
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag == "cancel" {
            if let Some(key) = draft_key(e.door, "album") {
                let _ = e.door.device_delete(&key);
            }
            return Outcome::pop();
        }
        if tag == "save" {
            let name = e.ui.fields.value("name").unwrap_or("").trim().to_owned();
            if name.is_empty() {
                self.error = Some(words::field_name_required(EN));
                return Outcome::default();
            }
            let id = mint_uuid_v7(e.door.now_ms());
            let act = Act::new(
                "container.create",
                json!({ "id": id, "kind": "album", "title": name }),
            );
            return match e.door.act(&act) {
                Ok(_) => {
                    if let Some(key) = draft_key(e.door, "album") {
                        let _ = e.door.device_delete(&key);
                    }
                    let mut out = Outcome::done(&words::album_created(EN), true);
                    out.nav = super::screen::Nav::Pop;
                    out
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct TrashAlbumConfirm {
    id: String,
}

impl RoomScreen for TrashAlbumConfirm {
    fn key(&self) -> String {
        format!("photos/album/{}/trash-confirm", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let title = b
            .run(&entity_reads::META_BY_ID, &Args::new().text("id", &self.id))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|m| m.title)
            .unwrap_or_else(|| shared::trash_untitled(EN));
        // N12: albums never take their members on delete.
        let body = fill(&words::trash_album_body(EN), &[("title", &title)]);
        let block = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &words::trash_album_title(EN),
                body: &body,
                warning: "",
                confirm_label: &words::trash_album_confirm(EN),
                confirm: Handler::Tag("confirm".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::trash_album_title(EN))
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag == "confirm" {
            let act = Act::new("entity.trash", json!({ "ids": [&self.id] }));
            return match e.door.act(&act) {
                Ok(done) => {
                    let mut out = Outcome::done(&done.sentence, done.undo);
                    out.nav = super::screen::Nav::Pop;
                    out
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct PlacesList {
    loaded: usize,
}

impl Default for PlacesList {
    fn default() -> Self {
        Self { loaded: 50 }
    }
}

impl RoomScreen for PlacesList {
    fn key(&self) -> String {
        PLACES.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let answer = match b.reload(&reads::PLACES, &Args::new(), self.loaded) {
            Ok(answer) => answer,
            Err(err) => {
                return room(wire::RoomKind::AppPlace, PLACES)
                    .title(&words::places_title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let count_str = words::places_count(EN, answer.rows.len() as u64);
        let mut content = Vec::new();
        if answer.rows.is_empty() {
            let add = blocks::action(
                &mut b.sel,
                "empty/add",
                &words::add_place(EN),
                "Plus",
                Handler::Open(NEW_PLACE.to_owned()),
            );
            content.push(blocks::empty(
                glyph("MapPin", "photos"),
                &words::empty_places_title(EN),
                &words::empty_places_body(EN),
                Some(add),
            ));
        } else {
            let rows: Vec<_> = answer
                .rows
                .iter()
                .map(|place| {
                    let id = &place.id;
                    let meta = place
                        .locality
                        .as_deref()
                        .or(place.address.as_deref())
                        .unwrap_or("");
                    let menu = blocks::menu(
                        &format!("place/{id}/menu"),
                        vec![blocks::menu_section(
                            "",
                            vec![
                                blocks::menu_item(
                                    &mut b.sel,
                                    &format!("place/{id}/menu/open"),
                                    &shared::kit_open(EN),
                                    Handler::Open(format!("photos/place/{id}")),
                                ),
                                blocks::menu_item(
                                    &mut b.sel,
                                    &format!("place/{id}/menu/rename"),
                                    &words::menu_rename(EN),
                                    Handler::Open(format!("photos/place/{id}/rename")),
                                ),
                                blocks::menu_item(
                                    &mut b.sel,
                                    &format!("place/{id}/menu/merge"),
                                    &words::menu_merge(EN),
                                    Handler::Open(format!("photos/place/{id}/merge")),
                                ),
                            ],
                        )],
                        &mut b.sel,
                    );
                    blocks::row(
                        &mut b.sel,
                        &format!("place/{id}"),
                        &place.title,
                        Handler::Open(format!("photos/place/{id}")),
                    )
                    .meta(meta)
                    .mark(blocks::glyph_mark("MapPin", "photos"))
                    .menu(menu)
                    .into_block()
                })
                .collect();
            let mut sec = blocks::section(&mut b.sel, "section/places", &words::section_places(EN))
                .blocks(rows);
            if answer.next.is_some() {
                sec = sec.next_page(&mut b.sel, "section/places/more");
            }
            content.push(sec.into_block());
        }

        let band = photos_band(b, PLACES);
        room(wire::RoomKind::AppPlace, PLACES)
            .title(&words::places_title(EN))
            .subtitle(&count_str)
            .key(
                &mut b.sel,
                "header/add",
                wire::RoomKeyRole::Add,
                "Plus",
                &words::add_place(EN),
                Handler::Open(NEW_PLACE.to_owned()),
            )
            .band(band)
            .ready(content)
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if let Some(out) = handle_more_or_nav(e, tag) {
            return out;
        }
        if tag.starts_with("next:") {
            self.loaded = (self.loaded + 50).min(500);
        }
        Outcome::default()
    }
}

struct PlaceDetail {
    id: String,
}

impl RoomScreen for PlaceDetail {
    fn key(&self) -> String {
        format!("photos/place/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let place = match b.run(&reads::PLACE_BY_ID, &Args::new().text("id", &self.id)) {
            Ok(answer) => answer.rows.into_iter().next(),
            Err(err) => {
                return room(wire::RoomKind::PushedPage, &self.key())
                    .title(&words::places_title(EN))
                    .back(&mut b.sel, &words::places_title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let Some(place) = place else {
            return room(wire::RoomKind::PushedPage, &self.key())
                .title(&words::places_title(EN))
                .back(&mut b.sel, &words::places_title(EN))
                .ready(vec![blocks::empty(
                    glyph("MapPin", "photos"),
                    &words::place_not_found(EN),
                    "",
                    None,
                )])
                .build();
        };

        let photos = b
            .run(
                &reads::AT_PLACE_PHOTOS,
                &Args::new().text("place", &self.id),
            )
            .map(|a| a.rows)
            .unwrap_or_default();
        let events = b
            .run(
                &reads::AT_PLACE_EVENTS,
                &Args::new().text("place", &self.id),
            )
            .map(|a| a.rows)
            .unwrap_or_default();
        let workouts = b
            .run(
                &reads::AT_PLACE_WORKOUTS,
                &Args::new().text("place", &self.id),
            )
            .map(|a| a.rows)
            .unwrap_or_default();
        let touches = b
            .run(
                &reads::AT_PLACE_TOUCHES,
                &Args::new().text("place", &self.id),
            )
            .map(|a| a.rows)
            .unwrap_or_default();

        let mut content = Vec::new();
        let mut facts = Vec::new();
        if let Some(addr) = place.address.as_deref().filter(|s| !s.is_empty()) {
            facts.push(blocks::fact(
                &words::fact_address(EN),
                addr,
                wire::RoomFactKind::Address,
            ));
        }
        if let Some(loc) = place.locality.as_deref().filter(|s| !s.is_empty()) {
            facts.push(blocks::fact(
                &words::fact_locality(EN),
                loc,
                wire::RoomFactKind::Text,
            ));
        }
        if !facts.is_empty() {
            content.push(
                blocks::section(&mut b.sel, "section/details", &words::section_details(EN))
                    .block(blocks::facts(facts))
                    .into_block(),
            );
        }

        if photos.is_empty() && events.is_empty() && workouts.is_empty() && touches.is_empty() {
            content.push(blocks::empty(
                glyph("MapPin", "photos"),
                &words::empty_place_title(EN),
                &words::empty_place_body(EN),
                None,
            ));
        } else {
            if !photos.is_empty() {
                let rows: Vec<_> = photos
                    .iter()
                    .map(|p| {
                        let label = if p.title.is_empty() {
                            short_day(&p.at).to_owned()
                        } else {
                            p.title.clone()
                        };
                        blocks::row(
                            &mut b.sel,
                            &format!("photo/{}", p.id),
                            &label,
                            Handler::Open(format!("photos/photo/{}", p.id)),
                        )
                        .meta(short_day(&p.at))
                        .mark(blocks::thumb_mark(&p.blob, &label, "photos"))
                        .into_block()
                    })
                    .collect();
                content.push(
                    blocks::section(&mut b.sel, "section/photos", &words::section_photos(EN))
                        .blocks(rows)
                        .into_block(),
                );
            }
            if !events.is_empty() {
                let rows: Vec<_> = events
                    .iter()
                    .map(|ev| {
                        blocks::row(
                            &mut b.sel,
                            &format!("event/{}", ev.id),
                            &ev.title,
                            Handler::Open(format!("calendar/event/{}", ev.id)),
                        )
                        .meta(short_day(&ev.at))
                        .mark(blocks::glyph_mark("Calendar", "calendar"))
                        .into_block()
                    })
                    .collect();
                content.push(
                    blocks::section(&mut b.sel, "section/events", &words::section_events(EN))
                        .blocks(rows)
                        .into_block(),
                );
            }
            if !workouts.is_empty() {
                let rows: Vec<_> = workouts
                    .iter()
                    .map(|w| {
                        blocks::row(
                            &mut b.sel,
                            &format!("workout/{}", w.id),
                            &w.title,
                            Handler::Open(format!("health/workout/{}", w.id)),
                        )
                        .meta(short_day(&w.at))
                        .mark(blocks::glyph_mark("Activity", "health"))
                        .into_block()
                    })
                    .collect();
                content.push(
                    blocks::section(&mut b.sel, "section/workouts", &words::section_workouts(EN))
                        .blocks(rows)
                        .into_block(),
                );
            }
            if !touches.is_empty() {
                let rows: Vec<_> = touches
                    .iter()
                    .map(|t| {
                        blocks::still_row(&mut b.sel, &format!("touch/{}", t.id), &t.title)
                            .meta(short_day(&t.at))
                            .mark(blocks::glyph_mark("Users", "people"))
                            .into_block()
                    })
                    .collect();
                content.push(
                    blocks::section(&mut b.sel, "section/touches", &words::section_touches(EN))
                        .blocks(rows)
                        .into_block(),
                );
            }
        }

        let menu = blocks::menu(
            "header/menu",
            vec![blocks::menu_section(
                "",
                vec![
                    blocks::menu_item(
                        &mut b.sel,
                        "header/menu/rename",
                        &words::menu_rename(EN),
                        Handler::Open(format!("photos/place/{}/rename", self.id)),
                    ),
                    blocks::menu_item(
                        &mut b.sel,
                        "header/menu/merge",
                        &words::menu_merge(EN),
                        Handler::Open(format!("photos/place/{}/merge", self.id)),
                    ),
                ],
            )],
            &mut b.sel,
        );

        room(wire::RoomKind::PushedPage, &self.key())
            .title(&place.title)
            .back(&mut b.sel, &words::places_title(EN))
            .menu_key(&mut b.sel, "header/more", &words::menu_more(EN), menu)
            .ready(content)
            .build()
    }
}

#[derive(Default)]
struct NewPlaceForm {
    error: Option<String>,
}

impl RoomScreen for NewPlaceForm {
    fn key(&self) -> String {
        NEW_PLACE.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let mut name_field = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "name",
            &words::field_place_name(EN),
            wire::RoomTextKind::Line,
            "",
            MAX_NAME_CHARS,
        )
        .required()
        .focused();
        if let Some(err) = &self.error {
            name_field = name_field.error(err);
        }
        let addr_field = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "address",
            &words::field_place_address(EN),
            wire::RoomTextKind::Line,
            "",
            MAX_NAME_CHARS,
        );
        let save_label = shared::kit_save(EN);
        let cancel_label = shared::kit_cancel(EN);
        let name_val = b.ui.fields.value("name").unwrap_or("");
        let save = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &save_label,
                cancel_label: &cancel_label,
                save_enabled: !name_val.trim().is_empty(),
                dirty: !name_val.is_empty(),
                drafted: false,
                save: Handler::Tag("save".to_owned()),
                cancel: Handler::Back,
            },
        );
        let block = form::form(
            vec![name_field.build(), addr_field.build()],
            Vec::new(),
            Save::Explicit(save),
        );
        room(wire::RoomKind::Sheet, NEW_PLACE)
            .title(&words::new_place_title(EN))
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag == "save" {
            let name = e.ui.fields.value("name").unwrap_or("").trim().to_owned();
            if name.is_empty() {
                self.error = Some(words::field_name_required(EN));
                return Outcome::default();
            }
            let addr = e.ui.fields.value("address").unwrap_or("").trim().to_owned();
            let id = mint_uuid_v7(e.door.now_ms());
            let mut input = json!({ "id": id, "title": name });
            if !addr.is_empty() {
                input["address"] = json!(addr);
            }
            return match e.door.act(&Act::new("place.add", input)) {
                Ok(_) => {
                    let mut out = Outcome::done(&words::place_created(EN), true);
                    out.nav = super::screen::Nav::Pop;
                    out
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct RenamePlaceForm {
    id: String,
    initialized: bool,
    error: Option<String>,
}

impl RenamePlaceForm {
    fn new(id: String) -> Self {
        Self {
            id,
            initialized: false,
            error: None,
        }
    }
}

impl RoomScreen for RenamePlaceForm {
    fn key(&self) -> String {
        format!("photos/place/{}/rename", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        if !self.initialized {
            self.initialized = true;
            if let Ok(answer) = b.run(&reads::PLACE_BY_ID, &Args::new().text("id", &self.id))
                && let Some(place) = answer.rows.into_iter().next()
            {
                b.ui.fields.get_or("name", &place.title);
            }
        }
        let mut field = form::text(
            &mut b.sel,
            &mut b.ui.fields,
            "name",
            &words::field_place_name(EN),
            wire::RoomTextKind::Line,
            "",
            MAX_NAME_CHARS,
        )
        .required()
        .focused();
        if let Some(err) = &self.error {
            field = field.error(err);
        }
        let save_label = shared::kit_save(EN);
        let cancel_label = shared::kit_cancel(EN);
        let name_val = b.ui.fields.value("name").unwrap_or("");
        let save = form::explicit(
            &mut b.sel,
            Explicit {
                save_label: &save_label,
                cancel_label: &cancel_label,
                save_enabled: !name_val.trim().is_empty(),
                dirty: true,
                drafted: false,
                save: Handler::Tag("save".to_owned()),
                cancel: Handler::Back,
            },
        );
        let block = form::form(vec![field.build()], Vec::new(), Save::Explicit(save));
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::rename_place_title(EN))
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag == "save" {
            let name = e.ui.fields.value("name").unwrap_or("").trim().to_owned();
            if name.is_empty() {
                self.error = Some(words::field_name_required(EN));
                return Outcome::default();
            }
            let act = Act::new("entity.retitle", json!({ "id": self.id, "title": name }));
            return match e.door.act(&act) {
                Ok(_) => {
                    let mut out = Outcome::done(&words::place_renamed(EN), true);
                    out.nav = super::screen::Nav::Pop;
                    out
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct MergePlacePick {
    id: String,
}

impl RoomScreen for MergePlacePick {
    fn key(&self) -> String {
        format!("photos/place/{}/merge", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let from_title = b
            .run(&reads::PLACE_BY_ID, &Args::new().text("id", &self.id))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|p| p.title)
            .unwrap_or_default();
        let places = b
            .run(&reads::PLACES, &Args::new())
            .map(|a| a.rows)
            .unwrap_or_default();
        let others: Vec<_> = places.into_iter().filter(|p| p.id != self.id).collect();
        let mut content = Vec::new();
        if others.is_empty() {
            content.push(blocks::empty(
                glyph("MapPin", "photos"),
                &words::merge_empty_title(EN),
                &words::merge_empty_body(EN),
                None,
            ));
        } else {
            let heading = fill(&words::merge_pick_heading(EN), &[("title", &from_title)]);
            let rows: Vec<_> = others
                .iter()
                .map(|target| {
                    blocks::row(
                        &mut b.sel,
                        &format!("target/{}", target.id),
                        &target.title,
                        Handler::Open(format!("photos/place/{}/merge/{}", self.id, target.id)),
                    )
                    .mark(blocks::glyph_mark("MapPin", "photos"))
                    .into_block()
                })
                .collect();
            content.push(
                blocks::section(&mut b.sel, "section/targets", &heading)
                    .blocks(rows)
                    .into_block(),
            );
        }
        room(wire::RoomKind::PushedPage, &self.key())
            .title(&words::merge_place_title(EN))
            .back(&mut b.sel, &words::places_title(EN))
            .ready(content)
            .build()
    }
}

struct MergePlaceConfirm {
    from: String,
    into: String,
}

impl RoomScreen for MergePlaceConfirm {
    fn key(&self) -> String {
        format!("photos/place/{}/merge/{}", self.from, self.into)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let from_title = b
            .run(&reads::PLACE_BY_ID, &Args::new().text("id", &self.from))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|p| p.title)
            .unwrap_or_default();
        let into_title = b
            .run(&reads::PLACE_BY_ID, &Args::new().text("id", &self.into))
            .ok()
            .and_then(|a| a.rows.into_iter().next())
            .map(|p| p.title)
            .unwrap_or_default();
        let body = fill(
            &words::merge_confirm_body(EN),
            &[("from", &from_title), ("into", &into_title)],
        );
        let block = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &words::merge_confirm_title(EN),
                body: &body,
                warning: "",
                confirm_label: &words::merge_confirm_action(EN),
                confirm: Handler::Tag("confirm".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&words::merge_confirm_title(EN))
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag == "confirm" {
            let act = Act::new(
                "place.merge",
                json!({ "from": self.from, "into": self.into }),
            );
            return match e.door.act(&act) {
                Ok(_) => {
                    let mut out = Outcome::done(&words::place_merged(EN), false);
                    out.nav = super::screen::Nav::Replace(PLACES.to_owned());
                    out
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct PhotosTrash {
    loaded: usize,
}

impl Default for PhotosTrash {
    fn default() -> Self {
        Self { loaded: 50 }
    }
}

impl RoomScreen for PhotosTrash {
    fn key(&self) -> String {
        TRASH.to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let answer = match b.reload(&reads::TRASH, &Args::new(), self.loaded) {
            Ok(answer) => answer,
            Err(err) => {
                return room(wire::RoomKind::PushedPage, TRASH)
                    .title(&shared::trash_title(EN))
                    .back(&mut b.sel, &words::title(EN))
                    .failed(&mut b.sel, &err.0, &shared::kit_retry(EN))
                    .build();
            }
        };
        let count = answer.rows.len() as u64;
        let heading = if count == 0 {
            shared::trash_title(EN)
        } else {
            shared::trash_count(EN, count)
        };
        let mut content = Vec::new();
        if answer.rows.is_empty() {
            content.push(blocks::empty(
                glyph("Trash", "photos"),
                &shared::trash_empty_headline(EN),
                &shared::trash_empty_state_body(EN),
                None,
            ));
        } else {
            let rows: Vec<_> = answer
                .rows
                .iter()
                .map(|row| {
                    let title = if row.title.is_empty() {
                        shared::trash_untitled(EN)
                    } else {
                        row.title.clone()
                    };
                    let meta = format!(
                        "{} {} · {} {}",
                        shared::trash_deleted(EN),
                        short_day(&row.deleted_at),
                        shared::trash_erased(EN),
                        short_day(&row.purge_at)
                    );
                    blocks::trash_row(
                        &mut b.sel,
                        &format!("trash/{}", row.id),
                        &title,
                        &meta,
                        Handler::Act(Act::new("entity.restore", json!({ "ids": [&row.id] }))),
                        Handler::Open(format!("photos/trash/purge/{}", row.id)),
                    )
                })
                .collect();
            let empty_btn = blocks::destructive(
                &mut b.sel,
                "trash/empty",
                &shared::trash_empty_action(EN),
                "Trash",
                Handler::Open("photos/trash/empty".to_owned()),
            );
            let mut trash = blocks::trash(
                &heading,
                &shared::trash_entry_meta(EN),
                rows,
                Some(empty_btn),
            );
            if answer.next.is_some() {
                trash.next_page_selector_id = b
                    .sel
                    .on("trash/more", Handler::NextPage("trash".to_owned()));
            }
            content.push(blocks::trash_block(trash));
        }
        room(wire::RoomKind::PushedPage, TRASH)
            .title(&heading)
            .back(&mut b.sel, &words::title(EN))
            .ready(content)
            .build()
    }

    fn on(&mut self, _e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag.starts_with("next:") {
            self.loaded = (self.loaded + 50).min(500);
        }
        Outcome::default()
    }
}

struct PurgeConfirm {
    id: String,
}

impl RoomScreen for PurgeConfirm {
    fn key(&self) -> String {
        format!("photos/trash/purge/{}", self.id)
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let title = fill(
            &shared::trash_purge_title(EN),
            &[("noun", &shared::trash_noun_photo(EN))],
        );
        let body = format!(
            "{} {}",
            shared::trash_purge_lead(EN),
            shared::trash_cannot_undo(EN)
        );
        // #1209: warn before deleting an original not confirmed held whole at a backup device.
        let warning = if originals_unbacked_up(b.door) {
            words::unbacked_up_warning_one(EN)
        } else {
            String::new()
        };
        let block = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &title,
                body: &body,
                warning: &warning,
                confirm_label: &shared::trash_purge(EN),
                confirm: Handler::Tag("confirm".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&title)
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag == "confirm" {
            let act = Act::new("entity.purge", json!({ "id": self.id }));
            return match e.door.act(&act) {
                Ok(done) => {
                    let mut out = Outcome::done(&done.sentence, false);
                    out.nav = super::screen::Nav::Pop;
                    out
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}

struct EmptyTrashConfirm;

impl RoomScreen for EmptyTrashConfirm {
    fn key(&self) -> String {
        "photos/trash/empty".to_owned()
    }

    fn build(&mut self, b: &mut Build<'_>) -> wire::Room {
        let warning = if originals_unbacked_up(b.door) {
            words::unbacked_up_empty_warning(EN)
        } else {
            String::new()
        };
        let block = blocks::confirm(
            &mut b.sel,
            Confirm {
                class: wire::RoomConfirmClass::Outlined,
                title: &shared::trash_empty_title(EN),
                body: &shared::trash_empty_body(EN),
                warning: &warning,
                confirm_label: &shared::trash_empty_action(EN),
                confirm: Handler::Tag("confirm".to_owned()),
                cancel_label: &shared::kit_cancel(EN),
                cancel: Handler::Back,
            },
        );
        room(wire::RoomKind::Sheet, &self.key())
            .title(&shared::trash_empty_title(EN))
            .ready(vec![block])
            .build()
    }

    fn on(&mut self, e: &mut Event<'_>, tag: &str, _input: &Input) -> Outcome {
        if tag == "confirm" {
            let act = Act::new(
                "entity.empty_trash",
                json!({ "kinds": ["photo", "album", "place"] }),
            );
            return match e.door.act(&act) {
                Ok(done) => {
                    let mut out = Outcome::done(&done.sentence, false);
                    out.nav = super::screen::Nav::Pop;
                    out
                }
                Err(refused) => Outcome::refuse(&refused.0),
            };
        }
        Outcome::default()
    }
}
