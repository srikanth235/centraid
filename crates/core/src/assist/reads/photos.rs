//! Photos' two reads, over the library window.
//!
//! Photos has no app query yet: its screens read the page door from the shell.
//! These two read through the crate's own loader, `load_library`, over the same
//! door (`VaultDoor`), and fold the window — newest first — in this module.
//!
//! **The search is over the newest [`SEARCH_WINDOW`] photographs, and says so.**
//! The FTS door has no photograph domain, and the loader's `search` takes hits
//! an index would supply. A bounded window folded here is the honest middle: it
//! reads what a member's last few months hold, and a headline names the window
//! when the library holds more than it reached.

use centraid_apps_photos::queries::{GridAsset, parse_instant_ms};
use centraid_apps_photos::{LibraryInput, load_library};
use centraid_assist::{App, Card, ReadError, ToolCall, ToolOutput};

use super::{Env, ROWS, clip, counted};
use crate::app_query::VaultDoor;

/// How many of the newest photographs a search folds. The loader clamps a
/// request to 20..=2000; this is a few months of a busy roll.
const SEARCH_WINDOW: usize = 200;

/// The window `recent` reads. The loader's floor is 20.
const RECENT_WINDOW: usize = 20;

/// Words too common to find a photograph by.
const STOPWORDS: [&str; 20] = [
    "a", "an", "and", "at", "for", "from", "in", "me", "my", "of", "on", "photo", "photos",
    "picture", "pictures", "show", "the", "to", "with", "pics",
];

fn window(env: &Env<'_>, size: usize) -> Result<centraid_apps_photos::LibraryData, ReadError> {
    let door = VaultDoor::new(env.vault);
    let now = parse_instant_ms(&env.vault.clock().now_text()).unwrap_or_default();
    let loaded = load_library(
        &door,
        &LibraryInput {
            limit: Some(size),
            before: None,
        },
        now,
    );
    // What the door itself reported wins over what the loader made of it.
    if let Some(failure) = door.take_failure() {
        return Err(ReadError(failure.to_string()));
    }
    loaded.map_err(|error| ReadError(format!("the photo library would not read: {error}")))
}

fn card(asset: &GridAsset) -> Card {
    let when = asset
        .taken_at
        .as_deref()
        .map(|taken| taken.chars().take(10).collect::<String>())
        .unwrap_or_default();
    let mut meta: Vec<String> = Vec::new();
    if let Some(place) = &asset.place {
        // A place a member never named is stored under its coordinates, and a
        // coordinate is not a phrase to print (`centraid_apps_photos::places`).
        let name = place
            .gazetteer
            .clone()
            .unwrap_or_else(|| place.name.clone());
        if !coordinate_shaped(&name) {
            meta.push(name);
        }
    }
    meta.extend(asset.album_titles.iter().cloned());
    let title = asset
        .asset
        .title
        .as_deref()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map_or_else(|| "Photograph".to_owned(), |title| clip(title, 80));
    Card::new(App::Photos, "photo", &asset.asset.asset_id, title)
        .subtitle(when)
        .meta(meta.join(", "))
}

/// Digits, signs, points, commas and spaces only: `37.4419, -122.1430`.
fn coordinate_shaped(name: &str) -> bool {
    !name.trim().is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | ',' | '-' | '+' | ' ' | '°'))
}

/// `photos.recent`.
pub(super) fn recent(env: &Env<'_>, _: &ToolCall) -> Result<ToolOutput, ReadError> {
    let library = window(env, RECENT_WINDOW)?;
    let rows: Vec<Card> = library
        .assets
        .iter()
        .take(ROWS as usize)
        .map(card)
        .collect();
    Ok(ToolOutput::of_rows(
        format!(
            "{} newest",
            counted(rows.len(), "photograph", "photographs")
        ),
        rows,
    ))
}

/// The lower-case words of a query, without the stop-list; a query of nothing
/// but stop words is matched whole.
fn words(query: &str) -> Vec<String> {
    let lowered = query.to_lowercase();
    let found: Vec<String> = lowered
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| word.chars().count() >= 2 && !STOPWORDS.contains(word))
        .map(str::to_owned)
        .collect();
    if found.is_empty() && !lowered.trim().is_empty() {
        vec![lowered.trim().to_owned()]
    } else {
        found
    }
}

/// How many of `words` the photograph answers to: its title, its labels, its
/// albums and its place.
fn score(asset: &GridAsset, words: &[String]) -> usize {
    let mut haystack = asset.asset.title.clone().unwrap_or_default();
    for tag in &asset.tags {
        haystack.push(' ');
        haystack.push_str(&tag.label);
    }
    for album in &asset.album_titles {
        haystack.push(' ');
        haystack.push_str(album);
    }
    if let Some(place) = asset
        .place
        .as_ref()
        .filter(|place| !coordinate_shaped(&place.name))
    {
        haystack.push(' ');
        haystack.push_str(&place.name);
        if let Some(gazetteer) = &place.gazetteer {
            haystack.push(' ');
            haystack.push_str(gazetteer);
        }
    }
    let haystack = haystack.to_lowercase();
    words
        .iter()
        .filter(|word| haystack.contains(word.as_str()))
        .count()
}

/// `photos.search`.
pub(super) fn search(env: &Env<'_>, call: &ToolCall) -> Result<ToolOutput, ReadError> {
    let term = call.arg("term").unwrap_or_default();
    let library = window(env, SEARCH_WINDOW)?;
    let wanted = words(term);
    let mut hits: Vec<(usize, &GridAsset)> = library
        .assets
        .iter()
        .map(|asset| (score(asset, &wanted), asset))
        .filter(|(score, _)| *score > 0)
        .collect();
    // Best match first; equal matches keep the library's newest-first order.
    hits.sort_by(|a, b| b.0.cmp(&a.0));
    let found = hits.len();
    let rows: Vec<Card> = hits
        .into_iter()
        .take(ROWS as usize)
        .map(|(_, asset)| card(asset))
        .collect();
    let mut headline = format!(
        "{} matching \"{term}\"",
        counted(found, "photograph", "photographs")
    );
    if library.truncated {
        headline.push_str(&format!(" in the newest {}", library.assets.len()));
    }
    let mut output = ToolOutput::of_rows(headline, rows);
    output.total = found;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_coordinate_is_not_a_place_name() {
        assert!(coordinate_shaped("37.4419, -122.1430"));
        assert!(coordinate_shaped("39.0021,-120.1131"));
        assert!(!coordinate_shaped("Sand Harbor"));
        assert!(!coordinate_shaped("Route 66"));
        assert!(!coordinate_shaped(""));
    }

    #[test]
    fn a_query_is_its_words_without_the_stop_list() {
        assert_eq!(words("photos of Sand Harbor"), ["sand", "harbor"]);
        assert_eq!(words("the coast road"), ["coast", "road"]);
        assert_eq!(
            words("of"),
            ["of"],
            "a query of nothing but stop words is matched whole"
        );
        assert!(words("  ").is_empty());
    }
}
