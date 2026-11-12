//! `photos.places`: EVERY PLACE, AS CARDS OR A MAP (#1029, #1135).
//!
//! Cards or a map is a parameter, not a screen: v0 read the same rows twice for
//! two draws, and a member's own words for the choice are "show me this as a
//! map", which is a control on one screen. A place is a facet of the library, so
//! its row is the core's `photos.places` card: the phrase for where it is (a name,
//! `near <city>`, a bearing; never digits), the live photographs in it and its
//! newest one.
//!
//! The map is a private plate: no basemap and no request to anyone, only the
//! member's own coordinates, projected here into the unit square ([`plot`]) so
//! the arithmetic is tested once and neither shell restates it.
//!
//! A rename is the vault's `name-place` under a fresh key per tap. A blank name
//! is refused here rather than sent to be refused there, and a refusal lands in
//! `status`, never in the read's `Failure`, so the list a member was renaming
//! from stays.
//!
//! Dropped with the Kotlin architecture: the three-pass join (the places read,
//! the counting pass over the library and the names pass: the core's one answer
//! is already joined), the seat, cursors, and the row-id filter on changes.

use centraid_api_proto::core_v1 as wire;
use wire::app_query_response::Answer;
use wire::photos_places_event::Kind as E;
use wire::photos_places_state::Presentation;
use wire::screen_event::Kind as S;

use super::cells::{self, Link};
use super::routes;
use crate::catalog::{act, load};
use crate::kit::act as kit_act;
use crate::kit::read::{self, Page, Reading};
use crate::kit::stale;
use crate::kit::undo::Undo;
use crate::screen::{Ctx, Screen};
use crate::strings::{Locale, chat_confirm, fill, photos as words, photos_shelf as shelf_words};

/// A pin's side in points: the floor for the least photographed place and the
/// ceiling for the most, growing with the square root of the count.
pub const PIN_FLOOR: f64 = 40.0;
pub const PIN_CEILING: f64 = 64.0;

#[must_use]
pub fn build(route: &wire::Route) -> Option<Box<dyn Screen>> {
    let Some(wire::route::Args::PhotosPlaces(_)) = &route.args else {
        return None;
    };
    Some(Box::new(Places {
        presentation: Presentation::Cards,
        page: Page::loading(),
        places: Vec::new(),
        unplaced: 0,
        naming: None,
        naming_rev: None,
        undo: Undo::default(),
    }))
}

struct Places {
    presentation: Presentation,
    /// The read: `places` is its data. Nothing to show at all is drawn as [`Page::Empty`] by
    /// [`Places::drawn`], never as ready data.
    page: Page<()>,
    places: Vec<wire::PhotosPlaceCard>,
    unplaced: u32,
    /// The place the name sheet is open over.
    naming: Option<String>,
    /// The place's revision when the name sheet opened: what a rename names as the one it
    /// replaces (#1185).
    naming_rev: Option<i64>,
    /// The status line and what its Undo reverses (the kit's one door).
    undo: Undo,
}

/// Where each pinned place stands on the plate: `x` and `y` in the unit square
/// (0,0 top left, y growing SOUTH), and the pin's side in points. A place with no
/// coordinate has no pin, and 0°N 0°E IS a place (a half-pin is not). One place,
/// or several at one spot, lands in the middle rather than dividing by zero.
#[must_use]
pub fn plot(cards: &[wire::PhotosPlaceCard]) -> Vec<Option<(f64, f64, f64)>> {
    let pin = |card: &wire::PhotosPlaceCard| {
        let place = card.place.as_ref()?;
        Some((place.lat?, place.lng?))
    };
    let pinned: Vec<(f64, f64, u32)> = cards
        .iter()
        .filter_map(|card| pin(card).map(|(lat, lng)| (lat, lng, card.count)))
        .collect();
    if pinned.is_empty() {
        return vec![None; cards.len()];
    }
    let fold = |pick: fn(f64, f64) -> f64, of: fn(&(f64, f64, u32)) -> f64| {
        pinned.iter().map(of).fold(of(&pinned[0]), pick)
    };
    let (min_lat, max_lat) = (fold(f64::min, |p| p.0), fold(f64::max, |p| p.0));
    let (min_lng, max_lng) = (fold(f64::min, |p| p.1), fold(f64::max, |p| p.1));
    let largest = pinned.iter().map(|p| p.2).max().unwrap_or(0);
    let spread = |value: f64, low: f64, high: f64, flip: bool| {
        if (high - low).abs() < f64::EPSILON {
            0.5
        } else if flip {
            (high - value) / (high - low)
        } else {
            (value - low) / (high - low)
        }
    };
    cards
        .iter()
        .map(|card| {
            let (lat, lng) = pin(card)?;
            let size = if largest <= 1 || card.count == 0 {
                PIN_FLOOR
            } else {
                PIN_FLOOR
                    + (PIN_CEILING - PIN_FLOOR) * f64::from(card.count).sqrt()
                        / f64::from(largest).sqrt()
            };
            Some((
                spread(lng, min_lng, max_lng, false),
                spread(lat, min_lat, max_lat, true),
                size,
            ))
        })
        .collect()
}

/// Six disjoint areas keep the private plate selectable even when thousands of places
/// project into the same neighbourhood. A group menu preserves every original shelf route.
#[must_use]
pub fn map_pins(rows: &[wire::PhotosPlaceRow], locale: Locale) -> Vec<wire::PhotosPlaceRow> {
    let mut areas = std::collections::BTreeMap::<(u8, u8), Vec<wire::PhotosPlaceRow>>::new();
    for row in rows.iter().filter(|row| row.pinned) {
        let x = if row.pin_x < 1.0 / 3.0 {
            0
        } else if row.pin_x < 2.0 / 3.0 {
            1
        } else {
            2
        };
        let y = u8::from(row.pin_y >= 0.5);
        areas.entry((x, y)).or_default().push(row.clone());
    }
    areas
        .into_iter()
        .filter_map(|((x, y), choices)| {
            let mut pin = choices.first()?.clone();
            pin.pin_x = (f64::from(x) + 0.5) / 3.0;
            pin.pin_y = (f64::from(y) + 0.5) / 2.0;
            if choices.len() > 1 {
                pin.place_id = format!("area-{x}-{y}");
                pin.title = words::photos_places_cluster(locale, choices.len() as u64);
                pin.spoken.clone_from(&pin.title);
                pin.count_mark = choices.len().to_string();
                pin.pin_size = PIN_CEILING;
                pin.open = None;
                pin.choices = choices;
            }
            Some(pin)
        })
        .collect()
}

impl Places {
    fn reload(&mut self, ctx: &Ctx) {
        let reading = read::read(
            ctx,
            load::photos::Places::default(),
            |answer| match answer {
                Answer::PhotosPlaces(places) => Some(places),
                _ => None,
            },
        );
        match reading {
            Reading::Data(places) => {
                self.places = places.places;
                self.unplaced = places.unplaced;
                self.page = Page::Ready {
                    data: (),
                    note: None,
                };
            }
            Reading::Denied(denial) => {
                self.places.clear();
                self.page = Page::Refused(denial);
            }
            // The places on screen are still true: they stay under a note.
            Reading::Failed => self.refresh_failed(ctx.locale()),
        }
    }

    /// A refresh that did not come: photographs or places shown stay under a note; with nothing
    /// shown (an empty page included) it is the failure itself.
    fn refresh_failed(&mut self, locale: Locale) {
        let mut held = std::mem::replace(&mut self.page, Page::loading());
        if held.data().is_some() && self.holds_nothing() {
            held = Page::Empty;
        }
        self.page = held.after(Reading::Failed, locale, |()| false);
        if self.page.data().is_none() {
            self.places.clear();
        }
    }

    fn rename(&mut self, place_id: &str, name: &str, ctx: &Ctx) {
        let name = name.trim();
        // The sheet goes either way; a blank name is not a write.
        self.naming = None;
        if place_id.is_empty() || name.is_empty() {
            return;
        }
        let key = kit_act::key(&["name-place", place_id, name], kit_act::fresh());
        let settled = self.undo.act(
            ctx,
            act::photos::NamePlace {
                place_id: place_id.to_owned(),
                title: name.to_owned(),
                expected_rev: self.naming_rev,
            },
            &key,
            shelf_words::place_named,
        );
        // The place changed, or went to the trash, since the sheet opened: the name typed is kept
        // as an earlier version and the page reads the place as it is now (#1185).
        let said = settled.stale().map(|stale| {
            stale::on_button(
                ctx,
                &chat_confirm::noun_place(ctx.locale()),
                place_id,
                stale,
                vec![("entity.title".to_owned(), name.into())],
            )
        });
        self.reload(ctx);
        if let Some(said) = said {
            self.undo.refuse(said);
        }
    }

    fn title_of(card: &wire::PhotosPlaceCard, locale: Locale) -> String {
        if card.phrase.is_empty() {
            words::place_unnamed(locale)
        } else {
            card.phrase.clone()
        }
    }

    fn row(
        card: &wire::PhotosPlaceCard,
        pin: Option<(f64, f64, f64)>,
        locale: Locale,
    ) -> wire::PhotosPlaceRow {
        let place_id = card
            .place
            .as_ref()
            .map(|place| place.place_id.clone())
            .unwrap_or_default();
        let title = Self::title_of(card, locale);
        let spoken = if card.count > 0 {
            fill(
                &words::photos_places_spoken(locale),
                &[("name", &title), ("count", &card.count.to_string())],
            )
        } else {
            title.clone()
        };
        wire::PhotosPlaceRow {
            open: Some(routes::shelf(
                wire::PhotosShelfKind::Place,
                &place_id,
                &title,
            )),
            count_label: if card.count > 0 {
                cells::count_phrase(locale, card.count, false)
            } else {
                String::new()
            },
            cover: card
                .cover
                .as_ref()
                .map(|cover| cells::tile(cover, Link::default(), locale)),
            count_mark: if card.count > 0 {
                card.count.to_string()
            } else {
                String::new()
            },
            name_label: words::photos_places_name_this(locale),
            current_name: card.name.clone().unwrap_or_default(),
            pinned: pin.is_some(),
            pin_x: pin.map_or(0.0, |p| p.0),
            pin_y: pin.map_or(0.0, |p| p.1),
            pin_size: pin.map_or(0.0, |p| p.2),
            place_id,
            title,
            spoken,
            choices: Vec::new(),
        }
    }

    /// Nothing to show: no place, and no photograph without one to open either (a screen that
    /// still has that door is not empty).
    fn holds_nothing(&self) -> bool {
        self.places.is_empty() && self.unplaced == 0
    }

    /// The page as drawn: ready means there is something to show.
    fn drawn(&self) -> Page<()> {
        if self.page.data().is_some() && self.holds_nothing() {
            Page::Empty
        } else {
            self.page.clone()
        }
    }

    /// NOTHING HERE, AND WHY: places come from where a photograph was taken.
    fn empty(locale: Locale) -> wire::EmptyState {
        wire::EmptyState {
            headline: words::photos_places_empty(locale),
            body: words::photos_places_empty_caption(locale),
            ..wire::EmptyState::default()
        }
    }

    fn data(&self, locale: Locale) -> wire::PhotosPlacesData {
        let pins = plot(&self.places);
        let rows: Vec<wire::PhotosPlaceRow> = self
            .places
            .iter()
            .zip(pins)
            .map(|(card, pin)| Self::row(card, pin, locale))
            .collect();
        let unpinned = rows.iter().filter(|row| !row.pinned).count();
        let unplaced = u64::from(self.unplaced);
        let photos = cells::count_phrase(locale, self.unplaced, false);
        let map = self.presentation == Presentation::Map;
        wire::PhotosPlacesData {
            map_empty: (map && !rows.is_empty() && unpinned == rows.len()).then(|| {
                wire::EmptyState {
                    headline: words::photos_places_map_empty(locale),
                    body: words::photos_places_map_empty_caption(locale),
                    ..wire::EmptyState::default()
                }
            }),
            unplaced_label: if unplaced == 0 {
                String::new()
            } else {
                fill(
                    &if unplaced == 1 {
                        words::photos_places_unplaced_one(locale)
                    } else {
                        words::photos_places_unplaced_many(locale)
                    },
                    &[("photos", &photos)],
                )
            },
            unplaced_open_label: words::photos_places_open_them(locale),
            unplaced_open: (unplaced > 0)
                .then(|| routes::shelf(wire::PhotosShelfKind::Unplaced, "", "")),
            unpinned_label: if map && unpinned > 0 {
                if unpinned == 1 {
                    words::photos_places_unpinned_one(locale)
                } else {
                    fill(
                        &words::photos_places_unpinned_many(locale),
                        &[("count", &unpinned.to_string())],
                    )
                }
            } else {
                String::new()
            },
            map_note: words::photos_places_map_note(locale),
            north_label: words::photos_places_north(locale),
            map_pins: map_pins(&rows, locale),
            places: rows,
        }
    }

    fn sheet(&self, locale: Locale) -> Option<wire::PhotosPlaceNameSheet> {
        let id = self.naming.as_ref()?;
        let card = self.places.iter().find(|card| {
            card.place
                .as_ref()
                .is_some_and(|place| &place.place_id == id)
        })?;
        Some(wire::PhotosPlaceNameSheet {
            place_id: id.clone(),
            title: words::photos_places_name_this(locale),
            field_label: words::photos_place_name(locale),
            current: card.name.clone().unwrap_or_default(),
            save_label: words::photos_save(locale),
            cancel_label: words::photos_cancel(locale),
        })
    }
}

impl Screen for Places {
    fn update(&mut self, event: wire::ScreenEvent, ctx: &Ctx) -> Vec<wire::Effect> {
        match event.kind {
            Some(S::Appeared(_) | S::DataChanged(_) | S::EnvironmentChanged(_)) => {
                self.reload(ctx);
            }
            Some(S::PhotosPlaces(places)) => match places.kind {
                Some(E::Presentation(changed)) => {
                    self.presentation = match Presentation::try_from(changed.presentation) {
                        Ok(Presentation::Map) => Presentation::Map,
                        _ => Presentation::Cards,
                    };
                }
                Some(E::NameRequested(asked)) => {
                    self.undo.clear();
                    self.naming_rev = stale::read_rev(ctx, &asked.place_id);
                    self.naming = Some(asked.place_id);
                }
                Some(E::NameDismissed(_)) => self.naming = None,
                Some(E::Refreshed(_)) => self.reload(ctx),
                Some(E::Renamed(renamed)) => self.rename(&renamed.place_id, &renamed.name, ctx),
                None => {}
            },
            Some(S::StatusActed(_)) => {
                if self.undo.acted(ctx) {
                    self.reload(ctx);
                }
            }
            Some(S::Left(_)) => self.undo.clear(),
            _ => {}
        }
        Vec::new()
    }

    fn view(&self, ctx: &Ctx) -> wire::ViewState {
        let locale = ctx.locale();
        let page = self.drawn();
        wire::ViewState {
            kind: Some(wire::view_state::Kind::PhotosPlaces(Box::new(
                wire::PhotosPlacesState {
                    title: words::photos_places(locale),
                    presentation: self.presentation as i32,
                    cards_label: words::photos_places_cards(locale),
                    map_label: words::photos_places_map(locale),
                    page: Some(page.wire(
                        locale,
                        |denial| super::denied(locale, denial),
                        || Self::empty(locale),
                    )),
                    content: page.data().map(|()| {
                        wire::photos_places_state::Content::Data(Box::new(self.data(locale)))
                    }),
                    status: self.undo.status(),
                    name_sheet: self.sheet(locale),
                },
            ))),
            ..wire::ViewState::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wire::page_state::State;

    const EN: Locale = Locale::En;

    fn ready(places: Vec<wire::PhotosPlaceCard>, unplaced: u32) -> Places {
        Places {
            presentation: Presentation::Cards,
            page: Page::Ready {
                data: (),
                note: None,
            },
            places,
            unplaced,
            naming: None,
            naming_rev: None,
            undo: Undo::default(),
        }
    }

    fn wired(places: &Places) -> wire::PageState {
        places.drawn().wire(
            EN,
            |denial| super::super::denied(EN, denial),
            || Places::empty(EN),
        )
    }

    #[test]
    fn no_places_and_no_photograph_without_one_is_the_empty_state_with_its_sentence() {
        let places = ready(Vec::new(), 0);
        match wired(&places).state {
            Some(State::Empty(empty)) => {
                assert_eq!(empty.headline, "No places yet.");
                assert_eq!(empty.body, "Places come from where a photo was taken.");
            }
            other => panic!("expected the empty state, found {other:?}"),
        }
    }

    #[test]
    fn photographs_with_no_place_keep_their_door_so_the_page_is_not_empty() {
        let places = ready(Vec::new(), 3);
        assert!(wired(&places).state.is_none(), "ready draws the door");
    }

    #[test]
    fn a_failed_read_over_nothing_is_failed_and_never_empty() {
        let mut places = ready(Vec::new(), 0);
        places.refresh_failed(EN);
        assert!(matches!(wired(&places).state, Some(State::Failed(_))));
    }
}
