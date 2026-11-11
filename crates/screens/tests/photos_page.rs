//! Photos' reads on the shared page state (#1185): a read that came to nothing is the failure and
//! never an empty grid, on every screen that reads.

use centraid_api_proto::core_v1 as wire;
use centraid_screens::photos;
use centraid_screens::testing::Driver;
use wire::page_state::State;

fn failed(page: &Option<wire::PageState>) -> bool {
    matches!(
        page.as_ref().and_then(|page| page.state.as_ref()),
        Some(State::Failed(_))
    )
}

fn open(route: wire::Route) -> (Driver, u64) {
    let mut d = Driver::unfounded(photos::runtime());
    d.start();
    let at = d.push(photos::TAB, route);
    (d, at)
}

#[test]
fn a_shelf_that_cannot_be_read_is_failed_and_never_empty() {
    let (d, at) = open(photos::routes::shelf(
        wire::PhotosShelfKind::Favorites,
        "",
        "Favorites",
    ));
    let Some(wire::view_state::Kind::PhotosShelf(state)) = &d.view(at).kind else {
        panic!("a shelf");
    };
    assert!(failed(&state.page));
    assert!(state.data.is_none());
}

#[test]
fn places_that_cannot_be_read_are_failed_and_never_empty() {
    let (d, at) = open(photos::routes::places());
    let Some(wire::view_state::Kind::PhotosPlaces(state)) = &d.view(at).kind else {
        panic!("places");
    };
    assert!(failed(&state.page));
    assert!(state.data.is_none());
}

#[test]
fn a_picker_that_cannot_be_read_is_failed_and_never_empty() {
    let (d, at) = open(photos::routes::picker("album", "Portugal"));
    let Some(wire::view_state::Kind::PhotosPicker(state)) = &d.view(at).kind else {
        panic!("a picker");
    };
    assert!(failed(&state.page));
    assert!(state.data.is_none());
}

#[test]
fn a_library_that_cannot_be_read_is_failed_and_never_an_empty_grid() {
    let (d, at) = open(photos::routes::home(wire::PhotosDestination::Library, None));
    let Some(wire::view_state::Kind::PhotosHome(state)) = &d.view(at).kind else {
        panic!("home");
    };
    let library = state.library.as_ref().expect("the library");
    assert!(failed(&library.page));
    assert!(library.data.is_none());
}

#[test]
fn collections_that_cannot_be_read_are_failed_and_never_empty() {
    let (d, at) = open(photos::routes::home(
        wire::PhotosDestination::Collections,
        None,
    ));
    let Some(wire::view_state::Kind::PhotosHome(state)) = &d.view(at).kind else {
        panic!("home");
    };
    let collections = state.collections.as_ref().expect("collections");
    assert!(failed(&collections.page));
    assert!(collections.data.is_none());
}

#[test]
fn a_photograph_that_cannot_be_read_is_failed_and_never_blank() {
    let (d, at) = open(photos::routes::lightbox("some-photo", &[], ""));
    let Some(wire::view_state::Kind::PhotosLightbox(state)) = &d.view(at).kind else {
        panic!("the lightbox");
    };
    assert!(failed(&state.page));
    assert!(state.photo.is_none());
}
