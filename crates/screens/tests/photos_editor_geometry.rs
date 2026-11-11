//! ONE EDITOR GEOMETRY, THREE READERS (#1185): `contracts/photos/editor-geometry.json` holds
//! cases of (source size, edit plan) -> the rectangle the saved photograph is cut with.
//! `editor::crop_pixels` (after `clamp_crop`) is the oracle; this test makes the file from it
//! and fails on any difference. The Android `PhotosEditGeometryTest` and the iOS
//! `PhotoEditGeometryTests` read the same file and hold the shells' own `cropPixels` to it.
//!
//! The crop is in fractions of the ROTATED frame, so each case also carries that frame
//! (`rotated_box`, rounded half up). `flip` never moves a rectangle; the flip cases pin that.
//!
//! `CENTRAID_UPDATE_FIXTURES=1 cargo test -p centraid-screens --test photos_editor_geometry`
//! rewrites the file (a deliberate change to the law, reviewed as one); otherwise it only compares.

use std::fmt::Write as _;

use centraid_api_proto::core_v1 as wire;
use centraid_screens::photos::editor;

const PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../contracts/photos/editor-geometry.json"
);

struct Case {
    name: &'static str,
    source: (i64, i64),
    quarters: u32,
    straighten: i32,
    flip: &'static str,
    crop: Option<(f64, f64, f64, f64)>,
}

const fn case(
    name: &'static str,
    source: (i64, i64),
    quarters: u32,
    straighten: i32,
    flip: &'static str,
    crop: Option<(f64, f64, f64, f64)>,
) -> Case {
    Case {
        name,
        source,
        quarters,
        straighten,
        flip,
        crop,
    }
}

fn cases() -> Vec<Case> {
    let c = Some((0.1, 0.2, 0.5, 0.5));
    vec![
        case("identity", (4032, 3024), 0, 0, "none", None),
        case("crop_only", (4000, 3000), 0, 0, "none", c),
        case("quarter_1", (4000, 3000), 1, 0, "none", c),
        case("quarter_2", (4000, 3000), 2, 0, "none", c),
        case("quarter_3", (4000, 3000), 3, 0, "none", c),
        case("quarter_4_is_none", (4000, 3000), 4, 0, "none", c),
        case("flip_horizontal", (4000, 3000), 0, 0, "horizontal", c),
        case("flip_vertical", (4000, 3000), 0, 0, "vertical", c),
        case(
            "crop_rotation_flip",
            (4000, 3000),
            3,
            0,
            "horizontal",
            Some((0.25, 0.05, 0.6, 0.9)),
        ),
        case(
            "portrait_thirds",
            (1080, 2400),
            0,
            0,
            "none",
            Some((1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0)),
        ),
        case(
            "portrait_quarter_1",
            (1080, 2400),
            1,
            0,
            "none",
            Some((0.0, 0.5, 1.0, 0.5)),
        ),
        case(
            "straighten_3",
            (3000, 2000),
            0,
            3,
            "none",
            Some((0.05, 0.05, 0.9, 0.9)),
        ),
        // THE STRAIGHTENED FRAME'S SIZE (#1185): the box grows, so the frame the crop is measured in
        // is the rotated box, either way of level, on a quarter turn, and at the slider's limit.
        case(
            "straighten_minus_10_full_frame",
            (4000, 3000),
            0,
            -10,
            "none",
            None,
        ),
        case(
            "straighten_7_after_a_quarter_turn",
            (4000, 3000),
            1,
            7,
            "none",
            Some((0.1, 0.1, 0.8, 0.8)),
        ),
        case(
            "straighten_at_the_limit_portrait",
            (1080, 2400),
            0,
            editor::clamp_straighten(i32::MAX),
            "none",
            Some((0.2, 0.2, 0.6, 0.6)),
        ),
        case(
            "tie_x_half_pixel_goes_up",
            (8, 8),
            0,
            0,
            "none",
            Some((0.0625, 0.0, 0.5, 0.5)),
        ),
        case(
            "tie_w_two_and_a_half_goes_up",
            (8, 8),
            0,
            0,
            "none",
            Some((0.0, 0.0, 0.3125, 0.5)),
        ),
        case(
            "rectangle_never_leaves_the_bitmap",
            (3, 3),
            0,
            0,
            "none",
            Some((0.5, 0.5, 0.5, 0.5)),
        ),
        case(
            "off_frame_and_too_thin_is_clamped",
            (1000, 1000),
            0,
            0,
            "none",
            Some((0.95, -0.2, 0.01, 2.0)),
        ),
        case(
            "tiny_source",
            (1, 1),
            0,
            0,
            "none",
            Some((0.2, 0.2, 0.3, 0.3)),
        ),
    ]
}

fn line(case: &Case) -> String {
    let (sw, sh) = case.source;
    let degrees = editor::total_rotation(case.quarters, case.straighten);
    let (bw, bh) = editor::rotated_box(sw as f64, sh as f64, degrees);
    let frame = ((bw + 0.5).floor() as i64, (bh + 0.5).floor() as i64);
    let (crop_json, rect) = match case.crop {
        None => ("null".to_owned(), editor::FULL_CROP),
        Some((x, y, w, h)) => (
            format!("{{\"x\": {x:?}, \"y\": {y:?}, \"w\": {w:?}, \"h\": {h:?}}}"),
            wire::PhotosEditCrop { x, y, w, h },
        ),
    };
    let (x, y, w, h) = editor::crop_pixels(editor::clamp_crop(rect), frame.0, frame.1);
    format!(
        "    {{\"name\": \"{}\", \"source\": [{sw}, {sh}], \"quarters\": {}, \"straighten\": {}, \
         \"flip\": \"{}\", \"crop\": {crop_json}, \"frame\": [{}, {}], \"expected\": [{x}, {y}, {w}, {h}]}}",
        case.name, case.quarters, case.straighten, case.flip, frame.0, frame.1
    )
}

fn render() -> String {
    let mut out = String::from(
        "{\n  \"about\": \"Generated by crates/screens/tests/photos_editor_geometry.rs from editor::crop_pixels \
         (after clamp_crop). frame = rotated_box rounded half up; crop is in fractions of the frame; \
         expected = [x, y, w, h] in frame pixels. Regenerate: CENTRAID_UPDATE_FIXTURES=1 cargo test -p \
         centraid-screens --test photos_editor_geometry. One case per line: the shells read it with a line regex.\",\n  \"cases\": [\n",
    );
    let lines: Vec<String> = cases().iter().map(line).collect();
    let _ = write!(out, "{}", lines.join(",\n"));
    out.push_str("\n  ]\n}\n");
    out
}

#[test]
fn the_editor_geometry_fixture_is_what_crop_pixels_says() {
    let want = render();
    if std::env::var_os("CENTRAID_UPDATE_FIXTURES").is_some() {
        std::fs::create_dir_all(std::path::Path::new(PATH).parent().unwrap()).unwrap();
        std::fs::write(PATH, &want).unwrap();
    }
    let have = std::fs::read_to_string(PATH).unwrap_or_default();
    assert_eq!(
        have, want,
        "contracts/photos/editor-geometry.json disagrees with editor::crop_pixels; if the change is \
         deliberate regenerate with CENTRAID_UPDATE_FIXTURES=1 and update both shells' cropPixels"
    );
}
