//! Guarantees about the design tables, as tests (#1173).
//!
//! The TypeScript package these came from (`packages/design`) was retired with
//! the rest of the TypeScript design pipeline. Its `native-emission`,
//! `icons-contract`, `identity` and `native-contract` tests carried guarantees
//! that the Rust generator does not give by construction; the ones that are not
//! already a rule in `centraid_design::tokens::Tokens::validate` (all 55 roles
//! in both schemes, well-formed hex, the contrast floors), in `design_words`
//! (the kit's words are read from `strings/shared.rs` at emit time and the drift
//! check compares the result), in `crates/design/src/lib.rs` (the identity
//! functions and their golden rows) or in `crates/screens/tests/icon_keys.rs`
//! (every icon key a screen names is in `design/icons.toml`) are here.
//!
//! They read the committed tree, so a failure names the file to fix.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use centraid_design::tokens::{NATIVE_COLOR_ROLES, NATIVE_EFFECT_ROLES, Tokens, native_color};

use crate::design_emit;

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn tokens() -> Tokens {
    Tokens::load(&root()).expect("design/tokens.toml and design/icons.toml parse")
}

fn emitted_text(path: &str) -> String {
    let emitted = design_emit::emit(&root()).expect("the generator runs");
    String::from_utf8(
        emitted
            .files
            .get(path)
            .unwrap_or_else(|| panic!("the generator emits no {path}"))
            .clone(),
    )
    .expect("generated text")
}

const THEME_SWIFT: &str = "mobile/iosApp/Design/Theme.swift";
const CATALOG_SWIFT: &str = "mobile/iosApp/Design/Catalog.swift";
const TOKENS_KT: &str = "mobile/androidApp/src/main/kotlin/dev/centraid/android/design/Tokens.kt";
const CATALOG_KT: &str = "mobile/androidApp/src/main/kotlin/dev/centraid/android/design/Catalog.kt";

/// Icons the band, the lockup and the shell's chrome name outside the catalogue.
const SHELL_ICONS: [&str; 6] = ["Home", "Sparkle", "Backup", "Search", "NewChat", "Settings"];

#[test]
fn the_shared_swift_value_tables_are_checked_sendable() {
    for (path, names) in [
        (
            THEME_SWIFT,
            ["CentraidTypeStyle", "CentraidTheme"].as_slice(),
        ),
        (
            CATALOG_SWIFT,
            ["CentraidAppMeta", "CentraidAppMark", "CentraidIconPath"].as_slice(),
        ),
    ] {
        let text = emitted_text(path);
        for name in names {
            let declaration = format!("public struct {name}: Sendable {{");
            assert!(text.contains(&declaration), "{path}: {declaration}");
        }
    }
}

#[test]
fn both_schemes_carry_every_role_in_both_shells_and_none_is_transparent() {
    let tokens = tokens();
    let swift = emitted_text(THEME_SWIFT);
    let kotlin = emitted_text(TOKENS_KT);
    for (scheme, table) in [
        ("light", &tokens.native.colors.light),
        ("dark", &tokens.native.colors.dark),
    ] {
        for role in NATIVE_COLOR_ROLES {
            let value = table
                .get(role)
                .unwrap_or_else(|| panic!("{scheme} lacks {role}"));
            if NATIVE_EFFECT_ROLES.contains(&role) {
                continue;
            }
            let colour = native_color(value).unwrap_or_else(|| panic!("{scheme}.{role}: {value}"));
            // An alpha of zero paints transparent black, and no native role
            // means that: the native lowering has no `color-mix()` to lean on.
            assert!(colour.alpha > 0.0, "{scheme}.{role} is transparent");
        }
    }
    // ONCE PER SCHEME, COUNTED: a presence check over a file with two schemes in
    // it cannot tell a complete table from half of one.
    for role in NATIVE_COLOR_ROLES {
        if NATIVE_EFFECT_ROLES.contains(&role) {
            continue;
        }
        assert_eq!(
            swift.matches(&format!("\"{role}\": Color(")).count(),
            2,
            "Theme.swift {role}"
        );
        assert_eq!(
            kotlin.matches(&format!("\"{role}\" to 0x")).count(),
            2,
            "Tokens.kt {role}"
        );
    }
}

#[test]
fn three_roles_are_shadows_not_colours_and_say_so() {
    let tokens = tokens();
    assert_eq!(NATIVE_EFFECT_ROLES.len(), 3);
    for table in [&tokens.native.colors.light, &tokens.native.colors.dark] {
        for role in NATIVE_EFFECT_ROLES {
            assert!(table[role].contains("px"), "{role}: {}", table[role]);
        }
    }
}

#[test]
fn the_two_schemes_are_different_tables() {
    let tokens = tokens();
    assert_ne!(tokens.native.colors.light, tokens.native.colors.dark);
    let differing = NATIVE_COLOR_ROLES
        .iter()
        .filter(|role| tokens.native.colors.light[**role] != tokens.native.colors.dark[**role])
        .count();
    assert!(
        differing > NATIVE_COLOR_ROLES.len() / 2,
        "{differing} differ"
    );
}

#[test]
fn every_type_style_is_concrete_and_ready_to_render() {
    let tokens = tokens();
    assert!(!tokens.native.types.is_empty());
    for (name, style) in &tokens.native.types {
        assert!(
            tokens.native.faces.contains_key(&style.family),
            "{name}: no face for `{}`",
            style.family
        );
        assert!(style.font_size > 0.0, "{name} size");
        assert!(style.line_height >= style.font_size, "{name} line height");
        assert!((100..=900).contains(&style.weight), "{name} weight");
    }
}

#[test]
fn the_geometry_both_shells_read_is_present_and_sane() {
    let geometry = tokens().native.geometry;
    let get = |key: &str| *geometry.get(key).unwrap_or_else(|| panic!("no {key}"));
    assert_eq!(get("pageMargin"), 18.0);
    assert_eq!(get("hairline"), 1.0);
    assert_eq!(get("targetMinCoarse"), 44.0);
    assert!(get("targetMinFine") < get("targetMinCoarse"));
    assert!(get("iconChipTintDark") > get("iconChipTintLight"));
    // The mark's stroke stays above a real device pixel at the smallest size in
    // use (14 px in a 24 box).
    assert!(get("appMarkStroke") * 14.0 / get("appMarkViewBox") >= 0.75);
}

#[test]
fn homes_roster_is_the_catalogue() {
    let policy = std::fs::read_to_string(root().join("crates/screens/src/shell/policy.rs"))
        .expect("crates/screens/src/shell/policy.rs");
    let start = policy.find("pub const ORDER").expect("policy.rs ORDER");
    let body = &policy[start..];
    let body = &body[body.find('[').expect("ORDER's array") + 1..];
    let body = &body[body.find("= [").map_or(0, |at| at + 3)..];
    let list = &body[..body.find("];").expect("end of ORDER")];
    let ids: BTreeSet<String> = list
        .split('"')
        .enumerate()
        .filter(|(at, _)| at % 2 == 1)
        .map(|(_, id)| id.to_owned())
        .collect();
    let catalogue: BTreeSet<String> = tokens()
        .native
        .app
        .iter()
        .map(|app| app.id.clone())
        .collect();
    assert_eq!(ids, catalogue, "shell/policy.rs ORDER vs [[native.app]]");
    assert!(!ids.contains("tasks"), "Tasks lives inside Agenda");
}

#[test]
fn every_app_has_a_mark_in_both_schemes_and_a_chip_is_never_its_hue() {
    for app in tokens().native.app {
        let id = &app.id;
        assert_ne!(app.light_chip, app.light_hue, "{id} light chip is the hue");
        assert_ne!(app.dark_chip, app.dark_hue, "{id} dark chip is the hue");
        // The identity ring moves between light and dark.
        assert_ne!(
            app.light_hue, app.dark_hue,
            "{id} hue does not move in dark"
        );
    }
}

fn command_count(path: &str) -> usize {
    path.chars()
        .filter(|c| c.is_ascii_alphabetic() && !matches!(c, 'e' | 'E'))
        .count()
}

#[test]
fn every_icon_an_app_or_the_chrome_names_resolves_and_stays_legible() {
    let tokens = tokens();
    let mut names: Vec<&str> = tokens
        .native
        .app
        .iter()
        .map(|a| a.icon_key.as_str())
        .collect();
    names.extend(SHELL_ICONS);
    for name in &names {
        let paths = tokens
            .icons
            .get(*name)
            .unwrap_or_else(|| panic!("design/icons.toml has no `{name}`"));
        assert!(!paths.is_empty(), "{name} draws nothing");
    }
    // A detail-density ceiling that predicts illegibility at 14 px: the densest
    // app icon has 18 commands; this leaves margin.
    for app in &tokens.native.app {
        let commands: usize = tokens.icons[&app.icon_key]
            .iter()
            .map(|path| command_count(&path.d))
            .sum();
        assert!(
            commands <= 24,
            "{} has {commands} path commands",
            app.icon_key
        );
    }
}

fn shell_sources() -> Vec<PathBuf> {
    fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, out);
            } else if path
                .extension()
                .is_some_and(|ext| ext == "swift" || ext == "kt")
            {
                out.push(path);
            }
        }
    }
    let mut out = Vec::new();
    for dir in [
        "mobile/iosApp/Sources",
        "mobile/iosApp/Design",
        "mobile/androidApp/src",
    ] {
        walk(&root().join(dir), &mut out);
    }
    out
}

#[test]
fn no_shell_source_outside_the_catalogue_carries_path_data() {
    let sources = shell_sources();
    assert!(!sources.is_empty(), "the shell trees produced no sources");
    let emitted = [CATALOG_SWIFT, CATALOG_KT];
    let mut offenders = Vec::new();
    for path in &sources {
        let relative = path
            .strip_prefix(root())
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        if emitted.iter().any(|e| relative.ends_with(e)) {
            continue;
        }
        let text = std::fs::read_to_string(path).unwrap_or_default();
        // `"M…`: a silhouette in a 24 box is what a path literal IS.
        let has_path = text.match_indices("\"M").any(|(at, _)| {
            let rest = &text[at + 2..];
            let rest = rest.strip_prefix('-').unwrap_or(rest);
            let digits = rest
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .count();
            digits > 0 && rest[digits..].starts_with([' ', ','])
        });
        if has_path {
            offenders.push(relative);
        }
    }
    assert!(
        offenders.is_empty(),
        "SVG path data outside Catalog.*: {offenders:?}"
    );
}

#[test]
fn every_icon_key_a_shell_names_by_literal_resolves() {
    // `Icon.swift` and `Icon.kt` fall back to an EMPTY path list, so a key the
    // table does not hold renders a blank chip and nothing fails.
    let tokens = tokens();
    let mut named = 0;
    let mut missing = Vec::new();
    for path in shell_sources() {
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        for (at, _) in text.match_indices("iconKey") {
            let rest = text[at + "iconKey".len()..].trim_start();
            let Some(rest) = rest.strip_prefix([':', '=']) else {
                continue;
            };
            let Some(rest) = rest.trim_start().strip_prefix('"') else {
                continue;
            };
            let Some(end) = rest.find('"') else { continue };
            let key = &rest[..end];
            named += 1;
            if !tokens.icons.contains_key(key) {
                missing.push(format!("{}: `{key}`", path.display()));
            }
        }
    }
    assert!(named > 0, "no shell source names an icon key");
    assert!(missing.is_empty(), "unknown icon keys: {missing:?}");
}
