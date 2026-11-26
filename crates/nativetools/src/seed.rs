//! WORLD SEEDING: a JSON world description written into a fresh vault, deterministically. The Eval
//! and Data steps seed with this and never write SQL.
//!
//! ```json
//! { "me": "Sam Park", "epoch": "2026-01-05T09:00", "seed": "w1", "currency": "EUR" }
//! ```
//!
//! `currency` is the vault's default (base) currency, set at founding; USD when absent. The world's
//! sections are the rows of the kinds the catalogue declares, and it declares none yet, so a
//! section is an error and not a silent drop. Times are `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, floating
//! (no zone).

use std::path::Path;

use serde_json::Value;

use crate::dates::Stamp;
use crate::vaultio::{Handle, SetClock, millis_of};

fn at(text: &str) -> Result<i64, String> {
    let stamp =
        Stamp::parse(text).ok_or_else(|| format!("\"{text}\" is not YYYY-MM-DD[THH:MM]"))?;
    Ok(millis_of(stamp.at()))
}

fn str_of<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

/// The top-level keys a world may carry: the scalars. `today` is the day the sessions on the world
/// run; the Python tools read it and the seeder does not.
const SECTIONS: &[&str] = &["me", "epoch", "seed", "currency", "today"];

/// A section the seeder does not read is an error, never a silent drop.
fn reject_unknown_sections(world: &Value) -> Result<(), String> {
    let Some(object) = world.as_object() else {
        return Err("a world is a JSON object".to_owned());
    };
    let unknown: Vec<&str> = object
        .keys()
        .map(String::as_str)
        .filter(|key| !SECTIONS.contains(key))
        .collect();
    if unknown.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "the world has sections the seeder does not read: {} (known: {})",
            unknown.join(", "),
            SECTIONS.join(", ")
        ))
    }
}

/// Seed `world` into a fresh vault at `path`. Returns every key's kind and id.
pub fn seed(world: &Value, path: &Path) -> Result<Value, String> {
    seed_report(world, path).map(|(keys, _)| keys)
}

/// [`seed`], plus the `key.field` values the vault could not hold.
pub fn seed_report(world: &Value, path: &Path) -> Result<(Value, Vec<String>), String> {
    reject_unknown_sections(world)?;
    let me = str_of(world, "me").unwrap_or("Me");
    let epoch = at(str_of(world, "epoch").unwrap_or("2026-01-01T09:00"))?;
    let clock = SetClock::at(epoch);
    let seed = format!("nativetools:seed:{}", str_of(world, "seed").unwrap_or("0"));
    // THE VAULT'S DEFAULT CURRENCY, set once at founding.
    let currency = str_of(world, "currency").unwrap_or("USD").to_uppercase();
    if currency.len() != 3 || !currency.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err(format!(
            "currency is a three-letter ISO code, not \"{currency}\""
        ));
    }
    Handle::create_in(path, clock, &seed, me, &currency)?;
    Ok((Value::Object(serde_json::Map::new()), Vec::new()))
}
