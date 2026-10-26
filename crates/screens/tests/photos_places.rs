//! `photos.places`, through a real core: the port of `PlacesSpec`. The three
//! passes the Kotlin machine joined are the core's one `photos.places` answer, so
//! what is tested here is the screen: cards or a map, naming, the plate's
//! geometry and the sentences.

mod photos_w2_support;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::photos;
use centraid_screens::photos::places::{PIN_CEILING, PIN_FLOOR, plot};
use centraid_screens::testing::Driver;
use photos_w2_support::*;
use wire::photos_places_event as ev;
use wire::photos_places_state::Presentation;

fn state(d: &Driver, instance: u64) -> &wire::PhotosPlacesState {
    match &d.view(instance).kind {
        Some(wire::view_state::Kind::PhotosPlaces(state)) => state,
        other => panic!("not places: {other:?}"),
    }
}

fn data(d: &Driver, instance: u64) -> &wire::PhotosPlacesData {
    match &state(d, instance).content {
        Some(wire::photos_places_state::Content::Data(data)) => data,
        other => panic!("no data: {other:?}"),
    }
}

fn send(d: &mut Driver, instance: u64, kind: ev::Kind) {
    d.send(
        instance,
        wire::screen_event::Kind::PhotosPlaces(wire::PhotosPlacesEvent { kind: Some(kind) }),
    );
}

fn card(lat: Option<f64>, lng: Option<f64>, count: u32) -> wire::PhotosPlaceCard {
    wire::PhotosPlaceCard {
        place: Some(wire::PhotosPlace {
            place_id: "p".to_owned(),
            lat,
            lng,
            ..wire::PhotosPlace::default()
        }),
        count,
        ..wire::PhotosPlaceCard::default()
    }
}

// -- The screen ----------------------------------------------------------------

#[test]
fn the_places_screen_lists_every_place_with_a_phrase_a_count_and_its_shelf() {
    let mut d = driver();
    let places = d.push(photos::TAB, photos::routes::places());
    let view = state(&d, places);
    assert_eq!(view.title, "Places");
    assert_eq!(view.presentation, Presentation::Cards as i32);
    assert_eq!(
        (view.cards_label.as_str(), view.map_label.as_str()),
        ("Cards", "Map")
    );
    let rows = &data(&d, places).places;
    assert!(!rows.is_empty(), "the scenario has places");
    for row in rows {
        assert!(!row.title.is_empty());
        // A phrase, never digits-as-coordinates.
        assert!(!row.title.contains(", -") && !row.spoken.is_empty());
        let Some(wire::route::Args::PhotosShelf(shelf)) = row.open.clone().and_then(|r| r.args)
        else {
            panic!("a place opens its shelf");
        };
        assert_eq!(shelf.kind, wire::PhotosShelfKind::Place as i32);
        assert_eq!(shelf.id, row.place_id);
    }
}

#[test]
fn cards_or_map_is_a_parameter_and_costs_no_read() {
    let mut d = driver();
    let places = d.push(photos::TAB, photos::routes::places());
    let before = data(&d, places).places.len();
    send(
        &mut d,
        places,
        ev::Kind::Presentation(ev::PresentationChanged {
            presentation: Presentation::Map as i32,
        }),
    );
    assert_eq!(state(&d, places).presentation, Presentation::Map as i32);
    assert_eq!(data(&d, places).places.len(), before);
    assert!(!data(&d, places).north_label.is_empty());
    send(
        &mut d,
        places,
        ev::Kind::Presentation(ev::PresentationChanged {
            presentation: Presentation::Cards as i32,
        }),
    );
    assert_eq!(state(&d, places).presentation, Presentation::Cards as i32);
}

#[test]
fn naming_a_place_is_the_vaults_rename_and_a_blank_name_is_not_sent() {
    let mut d = driver();
    let places = d.push(photos::TAB, photos::routes::places());
    let id = data(&d, places).places[0].place_id.clone();
    send(
        &mut d,
        places,
        ev::Kind::NameRequested(ev::NameRequested {
            place_id: id.clone(),
        }),
    );
    let sheet = state(&d, places).name_sheet.clone().expect("a sheet");
    assert_eq!(sheet.place_id, id);
    assert_eq!(sheet.title, "Name this place");

    // Blank: the sheet goes, nothing is written, nothing is refused.
    send(
        &mut d,
        places,
        ev::Kind::Renamed(ev::Renamed {
            place_id: id.clone(),
            name: "   ".to_owned(),
        }),
    );
    assert!(state(&d, places).name_sheet.is_none() && state(&d, places).status.is_none());

    send(
        &mut d,
        places,
        ev::Kind::NameRequested(ev::NameRequested {
            place_id: id.clone(),
        }),
    );
    send(
        &mut d,
        places,
        ev::Kind::Renamed(ev::Renamed {
            place_id: id.clone(),
            name: "  The cabin ".to_owned(),
        }),
    );
    assert!(state(&d, places).name_sheet.is_none());
    let row = data(&d, places)
        .places
        .iter()
        .find(|r| r.place_id == id)
        .expect("still listed")
        .clone();
    assert_eq!(row.title, "The cabin");
    assert_eq!(row.current_name, "The cabin");
    assert!(state(&d, places).status.is_none());
}

#[test]
fn a_refused_rename_says_why_and_keeps_the_list() {
    let mut d = driver();
    let places = d.push(photos::TAB, photos::routes::places());
    let before = data(&d, places).places.len();
    send(
        &mut d,
        places,
        ev::Kind::Renamed(ev::Renamed {
            place_id: "no-such-place".to_owned(),
            name: "Nowhere".to_owned(),
        }),
    );
    let status = state(&d, places)
        .status
        .clone()
        .expect("the vault's sentence");
    assert!(status.refused && !status.sentence.is_empty());
    assert_eq!(data(&d, places).places.len(), before);
    // Naming again clears the old sentence.
    send(
        &mut d,
        places,
        ev::Kind::NameRequested(ev::NameRequested {
            place_id: "x".to_owned(),
        }),
    );
    assert!(state(&d, places).status.is_none());
}

#[test]
fn unplaced_photographs_are_counted_and_open_their_shelf() {
    let mut d = driver();
    let places = d.push(photos::TAB, photos::routes::places());
    let view = data(&d, places);
    if view.unplaced_label.is_empty() {
        assert!(view.unplaced_open.is_none());
    } else {
        assert!(
            view.unplaced_label.ends_with("no place."),
            "{}",
            view.unplaced_label
        );
        let Some(wire::route::Args::PhotosShelf(shelf)) =
            view.unplaced_open.clone().and_then(|r| r.args)
        else {
            panic!("it opens a shelf");
        };
        assert_eq!(shelf.kind, wire::PhotosShelfKind::Unplaced as i32);
        assert_eq!(view.unplaced_open_label, "Open them.");
    }
}

// -- The plate ------------------------------------------------------------------

#[test]
fn the_plot_puts_north_at_the_top_and_west_at_the_left() {
    let cards = [
        card(Some(10.0), Some(-20.0), 1),
        card(Some(50.0), Some(40.0), 1),
    ];
    let pins = plot(&cards);
    let (south_west, north_east) = (pins[0].unwrap(), pins[1].unwrap());
    assert_eq!(
        (south_west.0, south_west.1),
        (0.0, 1.0),
        "x west to east, y north at 0"
    );
    assert_eq!((north_east.0, north_east.1), (1.0, 0.0));
}

#[test]
fn zero_zero_is_a_place_and_a_half_pin_is_not() {
    let cards = [
        card(Some(0.0), Some(0.0), 1),
        card(Some(5.0), None, 1),
        card(None, Some(5.0), 1),
        card(None, None, 1),
    ];
    let pins = plot(&cards);
    assert!(pins[0].is_some(), "the Gulf of Guinea is not no location");
    assert!(pins[1].is_none() && pins[2].is_none() && pins[3].is_none());
}

#[test]
fn one_place_or_several_at_one_spot_land_in_the_middle() {
    let one = plot(&[card(Some(48.8), Some(2.3), 3)]);
    assert_eq!(one[0].map(|p| (p.0, p.1)), Some((0.5, 0.5)));
    let same = plot(&[card(Some(1.0), Some(1.0), 3), card(Some(1.0), Some(1.0), 1)]);
    assert!(
        same.iter()
            .all(|p| p.map(|p| (p.0, p.1)) == Some((0.5, 0.5)))
    );
    assert!(plot(&[]).is_empty());
}

#[test]
fn a_pin_grows_with_the_root_of_its_count_between_the_floor_and_the_ceiling() {
    let cards = [
        card(Some(0.0), Some(0.0), 100),
        card(Some(1.0), Some(1.0), 25),
        card(Some(2.0), Some(2.0), 1),
    ];
    let sizes: Vec<f64> = plot(&cards).into_iter().map(|p| p.unwrap().2).collect();
    assert!((sizes[0] - PIN_CEILING).abs() < 1e-9);
    assert!((sizes[1] - (PIN_FLOOR + (PIN_CEILING - PIN_FLOOR) * 0.5)).abs() < 1e-9);
    assert!(sizes[2] > PIN_FLOOR && sizes[2] < sizes[1]);
    // All the same size: the floor, not a division by zero.
    let alone = plot(&[card(Some(0.0), Some(0.0), 1), card(Some(1.0), Some(1.0), 1)]);
    assert!(
        alone
            .iter()
            .all(|p| (p.unwrap().2 - PIN_FLOOR).abs() < 1e-9)
    );
}
