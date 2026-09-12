//! The verbs lane R owns: `backup`, `recover`, `export` (#1020, D-1020-R5/R6),
//! and wave 3 lane G's `gateway install` + `doctor` (D-1020-G1).
//!
//! Each is a **client**. The gateway holds the one writable connection and the
//! keys, so a CLI that built a generation or fenced an epoch itself would be a
//! second gateway with its own idea of what is committed. What lives here is
//! argument handling, the facts an operator reads, and the JSON a script reads
//! — the work happens in `centraid_vault::backup`.
//!
//! ## Facts to stderr, JSON to stdout
//!
//! One rule across all three. An operator watching a restore reads stderr; a
//! script reads stdout and gets one JSON document and nothing else. A progress
//! line on stdout would make the report unparseable exactly when it matters.

pub mod backup;
pub mod capture;
pub mod doctor;
pub mod export;
pub mod gateway_install;
pub mod native_host;
pub mod recover;
pub mod seat;
pub mod units;

use std::path::{Path, PathBuf};

/// Where a vault file lives inside a data directory.
///
/// One layout, stated once: `<data-dir>/vault/<vaultId>/vault.db`, with
/// `<data-dir>/keys` beside it and `<data-dir>/blobs` for the store. The
/// `keys/` sibling is deliberate — it is the directory export, backup and copy
/// gestures do **not** move, which is what makes a copied vault ciphertext.
pub fn vault_dir_in(data_dir: &Path) -> PathBuf {
    data_dir.join("vault")
}

pub fn keys_dir_in(data_dir: &Path) -> PathBuf {
    data_dir.join("keys")
}

pub fn blobs_dir_in(data_dir: &Path) -> PathBuf {
    data_dir.join("blobs")
}

/// The one vault file under a data directory, or a message saying why not.
///
/// A data directory with two vaults is refused rather than guessed at: picking
/// one would be picking which of the owner's vaults to restore over.
pub fn sole_vault_file(data_dir: &Path) -> Result<PathBuf, String> {
    let root = vault_dir_in(data_dir);
    let entries = std::fs::read_dir(&root)
        .map_err(|error| format!("no vault directory at {}: {error}", root.display()))?;
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let candidate = entry.path().join("vault.db");
        if candidate.is_file() {
            found.push(candidate);
        }
    }
    found.sort();
    match found.len() {
        0 => Err(format!("no vault under {}", root.display())),
        1 => Ok(found.remove(0)),
        _ => Err(format!(
            "{} holds {} vaults — name one with --vault",
            root.display(),
            found.len()
        )),
    }
}

/// Parse `YYYY-MM-DDTHH:MM:SS[.mmm]Z` to milliseconds since the Unix epoch.
///
/// Hand-rolled rather than a date crate, because this is the **only** date
/// parsing the binary does and the accepted shape is exactly the one the schema
/// writes (`strftime('%Y-%m-%dT%H:%M:%fZ','now')`). A looser parser would
/// accept a local-time string and silently restore to the wrong moment, which
/// for a point-in-time recovery is the worst possible kind of "it worked".
pub fn parse_iso_ms(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    if bytes[10] != b'T' || bytes[13] != b':' || bytes[16] != b':' {
        return None;
    }
    if *bytes.last()? != b'Z' {
        return None;
    }
    let number = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    let millis = match &text[19..text.len() - 1] {
        "" => 0,
        fraction if fraction.starts_with('.') => {
            let digits = &fraction[1..];
            if digits.is_empty() || digits.len() > 3 || !digits.bytes().all(|b| b.is_ascii_digit())
            {
                return None;
            }
            // `.5` is 500 ms, not 5.
            digits.parse::<i64>().ok()? * 10_i64.pow(3 - digits.len() as u32)
        }
        _ => return None,
    };
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        // A leap second is a real ISO timestamp and a real moment.
        || second > 60
    {
        return None;
    }
    Some(
        (days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second) * 1_000
            + millis,
    )
}

/// Howard Hinnant's `days_from_civil`. Proleptic Gregorian, no table.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_epoch_and_a_known_moment_parse_exactly() {
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_iso_ms("2026-07-18T00:00:00.000Z"),
            Some(1_784_332_800_000)
        );
        assert_eq!(
            parse_iso_ms("2026-07-18T00:00:00.456Z"),
            Some(1_784_332_800_456)
        );
        // A fraction is milliseconds, so `.5` is 500 and not 5.
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.5Z"), Some(500));
        assert_eq!(parse_iso_ms("1970-01-01T00:00:00.05Z"), Some(50));
        // Before the epoch, which a restore of an imported archive can name.
        assert_eq!(parse_iso_ms("1969-12-31T23:59:59.000Z"), Some(-1_000));
        // A leap day, because 2024 is one and 1900 is not.
        assert_eq!(
            parse_iso_ms("2024-02-29T12:00:00.000Z").unwrap()
                - parse_iso_ms("2024-02-28T12:00:00.000Z").unwrap(),
            86_400_000
        );
    }

    #[test]
    fn anything_that_is_not_an_utc_instant_is_refused() {
        for bad in [
            "",
            "2026-07-18",
            "2026-07-18T00:00:00",       // no zone: would be local time
            "2026-07-18T00:00:00+02:00", // an offset is not this shape
            "2026-07-18 00:00:00Z",      // a space, not a T
            "2026-13-01T00:00:00Z",      // month 13
            "2026-07-32T00:00:00Z",      // day 32
            "2026-07-18T24:00:00Z",      // hour 24
            "2026-07-18T00:60:00Z",      // minute 60
            "2026-07-18T00:00:00.1234Z", // more than milliseconds
            "2026-07-18T00:00:00.Z",
            "not a date at all!!",
        ] {
            assert_eq!(parse_iso_ms(bad), None, "{bad:?} must not parse");
        }
        // A leap second does parse: it is a real moment on a real clock.
        assert!(parse_iso_ms("2016-12-31T23:59:60.000Z").is_some());
    }

    #[test]
    fn the_data_directory_layout_is_stated_once() {
        let root = Path::new("/srv/centraid");
        assert_eq!(vault_dir_in(root), Path::new("/srv/centraid/vault"));
        assert_eq!(keys_dir_in(root), Path::new("/srv/centraid/keys"));
        assert_eq!(blobs_dir_in(root), Path::new("/srv/centraid/blobs"));
    }

    #[test]
    fn a_data_directory_with_two_vaults_is_refused_rather_than_guessed_at() {
        let dir = tempfile::tempdir().unwrap();
        assert!(sole_vault_file(dir.path()).is_err());
        for id in ["v1", "v2"] {
            let vault = vault_dir_in(dir.path()).join(id);
            std::fs::create_dir_all(&vault).unwrap();
            std::fs::write(vault.join("vault.db"), b"").unwrap();
        }
        let error = sole_vault_file(dir.path()).unwrap_err();
        assert!(error.contains("holds 2 vaults"), "{error}");
        std::fs::remove_dir_all(vault_dir_in(dir.path()).join("v2")).unwrap();
        assert!(
            sole_vault_file(dir.path())
                .unwrap()
                .ends_with("v1/vault.db")
        );
    }
}
