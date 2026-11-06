//! Tests for the dark mockup generator: the role classifier, the context rules,
//! the serialiser's habits, the TOML guards, and the committed boards.

use std::path::Path;

use super::*;

/// A table small enough to read, with the same shape as the real one.
const FIXTURE: &str = r##"
[mockups.dark]
title_suffix = " (dark)"
colors = [
  { light = "#1C1B19", text = "#F2EFEA", fill = "#3A3733", line = "#F2EFEA" },
  { light = "#FFFFFF", fill = "#1F1E1C" },
  { light = "#E4E0D8", fill = "#3A3733", line = "#3A3733" },
  { light = "#266FC4", text = "#569EF7", fill = "#3077CD", line = "#569EF7" },
  { light = "#00AA98", ink = "#00F6DC" },
]
keep = ["#F3EDE2", "#D7D3CC"]

[mockups.dark.paper]
background = "#FFFFFF"
min_height = 100
max_radius = 8

[mockups.dark.knob]
background = "#FFFFFF"
size = 26

[mockups.dark.tile]
background = "#1C1B19"

[mockups.dark.glass]
from = [255, 255, 255]
to = [44, 42, 39]
min_alpha = "0.72"

[mockups.dark.shade]
min_alpha = "0.5"

[mockups.dark.icon]
white = "#FFFFFF"
ground = "#1C1B19"
tile_view_box = "0 0 120 120"
"##;

fn map() -> DarkMap {
    DarkMap::parse(FIXTURE).expect("the fixture table parses")
}

fn dark(html: &str) -> String {
    dark_board(html, &map()).expect("the fixture board converts")
}

fn root() -> &'static Path {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("crates/xtask sits two levels under the root")
}

#[test]
fn the_same_hex_takes_its_value_from_the_role() {
    let html =
        r#"<div style="color: #1C1B19; background: #1C1B19; border: 1px solid #1C1B19;"></div>"#;
    assert_eq!(
        dark(html),
        r#"<div style="color: #F2EFEA; background: #3A3733; border: 1px solid #F2EFEA;"></div>"#
    );
}

#[test]
fn a_role_the_entry_leaves_out_keeps_the_light_value() {
    // White text stays white; white as a fill and as a line do not both move.
    let html =
        r#"<div style="color: #FFFFFF; background: #FFFFFF; border: 1px solid #FFFFFF;"></div>"#;
    assert_eq!(
        dark(html),
        r#"<div style="color: #FFFFFF; background: #1F1E1C; border: 1px solid #FFFFFF;"></div>"#
    );
}

#[test]
fn svg_ink_follows_text_unless_the_entry_overrides_it() {
    let html = r##"<svg fill="none" stroke="#266FC4"><path fill="#00AA98" d="M0 0"/></svg>"##;
    assert_eq!(
        dark(html),
        r##"<svg fill="none" stroke="#569EF7"><path fill="#00F6DC" d="M0 0"/></svg>"##
    );
}

#[test]
fn gradient_stops_and_shorthand_values_map_every_colour_in_them() {
    let html =
        r#"<div style="background: linear-gradient(135deg, #266FC4 0%, #FFFFFF 100%);"></div>"#;
    assert_eq!(
        dark(html),
        r#"<div style="background: linear-gradient(135deg, #3077CD 0%, #1F1E1C 100%);"></div>"#
    );
}

#[test]
fn glass_is_never_less_opaque_than_the_floor_and_shadows_get_heavier() {
    let html = concat!(
        r#"<a style="background: rgba(255,255,255,0.5); border: 1px solid rgba(255,255,255,0.9);"></a>"#,
        r#"<b style="box-shadow: 0 6px 20px rgba(0,0,0,0.08); background: rgba(0,0,0,0.6);"></b>"#,
        r#"<i style="background: rgba(10,20,30,0.3);"></i>"#,
    );
    assert_eq!(
        dark(html),
        concat!(
            r#"<a style="background: rgba(44,42,39,0.72); border: 1px solid rgba(44,42,39,0.9);"></a>"#,
            r#"<b style="box-shadow: 0 6px 20px rgba(0,0,0,0.5); background: rgba(0,0,0,0.6);"></b>"#,
            r#"<i style="background: rgba(10,20,30,0.3);"></i>"#,
        )
    );
}

#[test]
fn a_kept_colour_stays_and_an_unlisted_one_is_an_error() {
    assert_eq!(
        dark(r#"<i style="background: #F3EDE2;"></i>"#),
        r#"<i style="background: #F3EDE2;"></i>"#
    );
    let error = dark_board(r#"<i style="background: #123456;"></i>"#, &map())
        .expect_err("an unlisted colour is refused");
    assert!(format!("{error:#}").contains("#123456"), "{error:#}");
}

#[test]
fn a_colour_in_a_property_with_no_role_is_an_error() {
    let error = dark_board(r#"<i style="mask-color: #266FC4;"></i>"#, &map())
        .expect_err("an unclassified property is refused");
    assert!(format!("{error:#}").contains("mask-color"), "{error:#}");
}

#[test]
fn a_document_page_and_everything_inside_it_stay_light() {
    let html = concat!(
        r#"<div style="width: 96px; height: 120px; border-radius: 8px; background: #FFFFFF; border: 1px solid #E4E0D8;">"#,
        r#"<div style="height: 8px; background: #1C1B19;"></div>"#,
        r#"<span style="position: absolute; background: #1C1B19; color: #FFFFFF;">PDF</span>"#,
        r#"</div>"#,
        r#"<div style="background: #1C1B19;"></div>"#,
    );
    assert_eq!(
        dark(html),
        concat!(
            // The page and its bar are content; the badge laid over it is chrome.
            r#"<div style="width: 96px; height: 120px; border-radius: 8px; background: #FFFFFF; border: 1px solid #E4E0D8;">"#,
            r#"<div style="height: 8px; background: #1C1B19;"></div>"#,
            r#"<span style="position: absolute; background: #3A3733; color: #FFFFFF;">PDF</span>"#,
            r#"</div>"#,
            // After the page closes, the scope is over.
            r#"<div style="background: #3A3733;"></div>"#,
        )
    );
}

#[test]
fn a_tall_white_card_with_a_big_radius_is_not_a_page() {
    let html = r#"<div style="height: 200px; border-radius: 16px; background: #FFFFFF;"></div>"#;
    assert_eq!(
        dark(html),
        r#"<div style="height: 200px; border-radius: 16px; background: #1F1E1C;"></div>"#
    );
}

#[test]
fn only_the_26_px_switch_thumb_stays_white() {
    let thumb = |size: u32| {
        format!(
            r#"<span style="position: absolute; width: {size}px; height: {size}px; border-radius: {}px; background: #FFFFFF;"></span>"#,
            size / 2
        )
    };
    assert_eq!(dark(&thumb(26)), thumb(26));
    assert_eq!(dark(&thumb(22)), thumb(22).replace("#FFFFFF", "#1F1E1C"));
}

#[test]
fn a_square_centred_ink_tile_keeps_its_fill_but_a_badge_does_not() {
    let tile = r#"<span style="width: 36px; height: 36px; background: #1C1B19; display: flex; justify-content: center;"></span>"#;
    assert_eq!(dark(tile), tile);
    let badge = r#"<span style="padding: 2px 5px; background: #1C1B19;"></span>"#;
    assert_eq!(dark(badge), badge.replace("#1C1B19", "#3A3733"));
}

#[test]
fn the_brand_icon_swaps_its_white_and_the_tile_form_drops_its_hairline() {
    let mark = r##"<svg viewBox="22 22 76 76" data-centraid-icon="1"><path d="M0 0" fill="#00AA98"/><path d="M1 1" stroke="#FFFFFF"/></svg>"##;
    assert_eq!(
        dark(mark),
        r##"<svg viewBox="22 22 76 76" data-centraid-icon="1"><path d="M0 0" fill="#00F6DC"/><path d="M1 1" stroke="#1C1B19"/></svg>"##
    );
    let tile = concat!(
        r##"<svg viewBox="0 0 120 120" data-centraid-icon="1"><rect width="120" height="120" fill="#FFFFFF"></rect>"##,
        r##"<rect x=".75" fill="none" stroke="#E4E0D8"></rect><path d="M0 0" fill="#00AA98"></path></svg>"##,
    );
    assert_eq!(
        dark(tile),
        r##"<svg viewBox="0 0 120 120" data-centraid-icon="1"><rect width="120" height="120" fill="#1C1B19"/><path d="M0 0" fill="#00AA98"/></svg>"##
    );
}

#[test]
fn the_serialiser_habits_of_the_committed_boards_are_kept() {
    let html = concat!(
        "<title>Agenda event</title>",
        r#"<svg><path d="M0 0"></path><circle r="1"></circle></svg>"#,
        r#"<p>a<br>b</p><button disabled="" aria-hidden="true">x</button>"#,
        r#"<a href="Today.dc.html">t</a><a href="https://example.com/Today.dc.html">u</a>"#,
        r#"<a href="TodayDark.dc.html">d</a><meta charset="utf-8">"#,
    );
    assert_eq!(
        dark(html),
        concat!(
            "<title>Agenda event (dark)</title>",
            r#"<svg><path d="M0 0"/><circle r="1"/></svg>"#,
            r#"<p>a<br/>b</p><button disabled aria-hidden="true">x</button>"#,
            r#"<a href="TodayDark.dc.html">t</a><a href="https://example.com/Today.dc.html">u</a>"#,
            r#"<a href="TodayDark.dc.html">d</a><meta charset="utf-8">"#,
        )
    );
}

#[test]
fn a_link_to_a_screen_without_a_twin_is_left_alone() {
    let twins = BTreeSet::from(["Today.dc.html".to_string()]);
    let map = map().with_twins(twins);
    let html = r#"<a href="Today.dc.html"></a><a href="Backup.dc.html"></a>"#;
    assert_eq!(
        dark_board(html, &map).expect("converts"),
        r#"<a href="TodayDark.dc.html"></a><a href="Backup.dc.html"></a>"#
    );
}

#[test]
fn script_bodies_and_comments_are_copied_untouched() {
    let html =
        "<!-- #1C1B19 --><script>const c = '#1C1B19';</script><style>a{color:#266FC4}</style>";
    assert_eq!(dark(html), html);
}

#[test]
fn a_greater_than_inside_a_quoted_attribute_does_not_end_the_tag() {
    let html = r##"<div title="a > b" style="color: #1C1B19;"></div>"##;
    assert_eq!(
        dark(html),
        r##"<div title="a > b" style="color: #F2EFEA;"></div>"##
    );
}

#[test]
fn the_table_is_refused_when_it_is_malformed() {
    let duplicate = FIXTURE.replace(
        "{ light = \"#FFFFFF\", fill = \"#1F1E1C\" },",
        "{ light = \"#FFFFFF\", fill = \"#1F1E1C\" }, { light = \"#ffffff\", fill = \"#000000\" },",
    );
    let error = DarkMap::parse(&duplicate).expect_err("a light colour listed twice");
    assert!(format!("{error:#}").contains("listed twice"), "{error:#}");

    let bad = FIXTURE.replace("#3077CD", "blue");
    let error = DarkMap::parse(&bad).expect_err("a value that is not a hex colour");
    assert!(format!("{error:#}").contains("blue"), "{error:#}");
}

#[test]
fn the_first_difference_names_the_line() {
    let text = first_difference("a\nb\nc\n", "a\nB\nc\n");
    assert!(text.starts_with("line 2:"), "{text}");
}

/// One small committed pair, byte for byte: the real table over a real board.
#[test]
fn a_committed_pair_round_trips_exactly() {
    let map = DarkMap::load(root()).expect("design/tokens.toml parses");
    let light = std::fs::read_to_string(root().join("design/mockups/AgendaEvent.dc.html"))
        .expect("the light board");
    let committed = std::fs::read_to_string(root().join("design/mockups/AgendaEventDark.dc.html"))
        .expect("the dark board");
    assert_eq!(dark_board(&light, &map).expect("converts"), committed);
}

/// Every dark board in the repository is what the generator writes: the same
/// comparison as `cargo xtask design-dark --check`, so no gate can go green
/// over a hand-edited dark screen.
#[test]
fn every_committed_dark_board_is_current() {
    let report = generate_all(root(), true).expect("the boards convert");
    assert!(
        report.changed.is_empty(),
        "{} of {} dark boards drifted: {:#?}",
        report.changed.len(),
        report.total,
        report.changed
    );
    assert_eq!(report.identical, report.total);
}
