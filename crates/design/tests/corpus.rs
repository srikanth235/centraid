//! THE LOWERING, ASSERTED ROW BY ROW against what `packages/design` answered.
//!
//! `design/identity-corpus.json` is emitted by
//! `contracts/tools/export-native-theme.ts`, which RUNS the real
//! `partyHueKey`/`partyHueValue`/`identityInitials` and Tally's `figureTone`
//! over a fixed, deliberately hostile corpus (non-ASCII names, an empty name, a
//! one-emoji name, every shape of stored `avatar_color`) and writes inputs and
//! outputs. This test is the other half: every row, no sampling, and the count
//! is asserted so a corpus that shrank is a failure rather than a quiet pass
//! (#1020, D-1020-T1).

use std::fs;
use std::path::{Path, PathBuf};

use centraid_design::{
    BRAND, FigureTone, assert_native_color_role_contract, figure_tone, identity_initials_units,
    native_themes, party_hue_key, party_hue_value,
};
use serde_json::Value;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .to_path_buf()
}

fn emitted(name: &str) -> Value {
    let path = root().join("design").join(name);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} is not readable: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("{} is not JSON: {error}", path.display()))
}

#[test]
fn every_hue_row_agrees_with_packages_design() {
    let corpus = emitted("identity-corpus.json");
    assert_eq!(
        corpus["brand"].as_str(),
        Some(BRAND),
        "the ink brand moved in packages/design and not here"
    );
    let rows = corpus["hues"].as_array().expect("hues is a list");
    assert!(
        rows.len() >= 180,
        "a corpus this small is not a corpus: {} rows",
        rows.len()
    );
    for row in rows {
        let party_id = row["party_id"].as_str().expect("a party id");
        let absent = row["avatar_color_absent"].as_bool().unwrap_or(false);
        let stored = if absent {
            None
        } else {
            Some(row["avatar_color"].as_str().unwrap_or(""))
        };
        let key = party_hue_key(party_id, stored);
        assert_eq!(
            key,
            row["hue_key"].as_str(),
            "hue key for {party_id:?} with {stored:?}"
        );
        let color = key.map(party_hue_value);
        assert_eq!(
            color.as_deref(),
            row["color"].as_str(),
            "hue value for {party_id:?} with {stored:?}"
        );
    }
}

#[test]
fn every_initials_row_agrees_including_the_half_surrogate() {
    let corpus = emitted("identity-corpus.json");
    let rows = corpus["initials"].as_array().expect("initials is a list");
    assert!(rows.len() >= 25, "{} rows", rows.len());
    let mut astral = 0usize;
    for row in rows {
        let name = row["name"].as_str().expect("a name");
        let wanted: Vec<u16> = row["units"]
            .as_array()
            .expect("units is a list")
            .iter()
            .map(|unit| u16::try_from(unit.as_u64().expect("a code unit")).expect("16 bits"))
            .collect();
        assert_eq!(
            identity_initials_units(name),
            wanted,
            "initials for {name:?}"
        );
        // THE FINDING, ASSERTED SO IT CANNOT BE "FIXED" BY ACCIDENT: at least
        // one row's answer is half a surrogate pair. If a future
        // `identityInitials` becomes grapheme-aware, this count drops and the
        // divergence is caught here rather than in a fixture nobody reads.
        if wanted.iter().any(|unit| (0xD800..0xE000).contains(unit)) {
            astral += 1;
        }
    }
    assert!(
        astral >= 1,
        "v0's slice(0,1) cuts a UTF-16 unit; a corpus with no astral name proves nothing about it"
    );
}

#[test]
fn every_tone_row_agrees_with_tallys_one_sign_convention() {
    let corpus = emitted("identity-corpus.json");
    let rows = corpus["tones"].as_array().expect("tones is a list");
    assert!(rows.len() >= 25, "{} rows", rows.len());
    for row in rows {
        let net = row["net_minor"].as_i64().expect("minor units are integers");
        let wanted = match row["tone"].as_str().expect("a tone") {
            "net" => FigureTone::Net,
            "owed" => FigureTone::Owed,
            "settled" => FigureTone::Settled,
            other => panic!("{other} is not a tone packages/design emits"),
        };
        assert_eq!(figure_tone(net), wanted, "tone for {net}");
    }
}

#[test]
fn the_emitted_theme_still_satisfies_the_colour_role_contract() {
    let themes = native_themes(&emitted("native-theme.json")).expect("the emitted theme reads");
    assert_eq!(
        themes.schemes.len(),
        2,
        "light and dark, and nothing else, is what the native lowering emits"
    );
    assert!(
        themes.color_role_contract.len() >= 40,
        "the contract lists {} roles",
        themes.color_role_contract.len()
    );
    assert_native_color_role_contract(&themes).expect("every role reaches every scheme");
}

/// A DEMONSTRATED RED: a theme missing a contracted role is refused, by name.
#[test]
fn a_theme_that_dropped_a_role_is_refused_and_says_which() {
    let mut value = emitted("native-theme.json");
    value["schemes"]["light"]["colors"]
        .as_object_mut()
        .expect("colours are an object")
        .remove("net");
    let themes = native_themes(&value).expect("still readable");
    let error = assert_native_color_role_contract(&themes).expect_err("a dropped role is refused");
    let sentence = error.to_string();
    assert!(sentence.contains("net"), "{sentence}");
    assert!(sentence.contains("light"), "{sentence}");
}
