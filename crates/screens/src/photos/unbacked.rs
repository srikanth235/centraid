//! THE DELETE WARNING (#1209, R4): before a photograph is deleted for good, the member is told
//! when no backup device holds it whole. The member can still delete; the warning is one amber
//! line above the confirm's body and nothing else about the confirm changes.
//!
//! "Held whole" is the Backup screen's own test for "Photos and files" (every chunk of the
//! original confirmed at a backup device), asked of the core in ONE read for the whole set, so
//! the cost is one pass over each device's tree however many photographs are asked about. The
//! read dials nobody. A read that fails counts every photograph as not held: a warning that
//! should not have shown costs a look, a missing one costs a photograph.

use centraid_api_proto::core_v1 as wire;
use centraid_core::screens::VaultRequest;

use crate::screen::Ctx;
use crate::strings::{Locale, fill, photos as words};

fn unhex(text: &str) -> Option<Vec<u8>> {
    if text.len() != 64 || !text.is_ascii() {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(&text[at..at + 2], 16).ok())
        .collect()
}

/// How many of these photographs (by the hash of their original; an empty one has nothing to
/// lose and is not counted) no backup device holds whole.
#[must_use]
pub fn count(ctx: &Ctx, content_ids: &[String]) -> u32 {
    let hashed: Vec<(&String, Vec<u8>)> = content_ids
        .iter()
        .filter_map(|id| unhex(id).map(|raw| (id, raw)))
        .collect();
    if hashed.is_empty() {
        return 0;
    }
    let asked = wire::HeldWholeRequest {
        content_hash: Vec::new(),
        content_hashes: hashed.iter().map(|(_, raw)| raw.clone()).collect(),
    };
    let not_held: Option<Vec<Vec<u8>>> = match ctx.vault(VaultRequest::HeldWhole(asked)) {
        Ok(wire::Response {
            kind: Some(wire::response::Kind::HeldWhole(answer)),
        }) => Some(answer.not_held),
        _ => None,
    };
    let lost = hashed
        .iter()
        .filter(|(_, raw)| not_held.as_ref().is_none_or(|none| none.contains(raw)))
        .count();
    u32::try_from(lost).unwrap_or(u32::MAX)
}

/// The amber line over a confirm that deletes `of` photographs, `lost` of them not backed up.
/// Empty when all are backed up.
#[must_use]
pub fn warning(locale: Locale, of: usize, lost: u32) -> String {
    if lost == 0 {
        String::new()
    } else if of == 1 {
        words::photos_unbacked_one(locale)
    } else {
        fill(
            &words::photos_unbacked_some(locale, u64::from(lost)),
            &[("count", &lost.to_string())],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_said_of_a_photograph_that_is_backed_up() {
        assert_eq!(warning(Locale::En, 1, 0), "");
        assert_eq!(warning(Locale::En, 12, 0), "");
    }

    #[test]
    fn one_photo_and_several_are_worded_for_their_count() {
        assert_eq!(
            warning(Locale::En, 1, 1),
            "This photo isn\u{2019}t backed up yet. No backup device can bring it back."
        );
        assert_eq!(
            warning(Locale::En, 12, 3),
            "3 of these photos aren\u{2019}t backed up yet. No backup device can bring them back."
        );
        assert_eq!(
            warning(Locale::En, 12, 1),
            "1 of these photos isn\u{2019}t backed up yet. No backup device can bring it back."
        );
    }

    #[test]
    fn a_hash_is_64_hex_characters_or_it_is_not_counted() {
        assert!(unhex(&"ab".repeat(32)).is_some());
        assert!(unhex("abc").is_none());
        assert!(unhex(&"zz".repeat(32)).is_none());
    }
}
