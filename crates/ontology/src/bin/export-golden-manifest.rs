//! Regenerate a golden corpus's `manifest.json` from the corpus itself.
//!
//! ```sh
//! cargo run -p centraid-ontology --bin export-golden-manifest -- \
//!   contracts/golden/issue-1020 > contracts/golden/issue-1020/manifest.json
//! ```
//!
//! ## WHY THIS EXISTS (#1025 S4)
//!
//! The manifest is a GENERATED fixture — the frozen row digests
//! `tests/golden_vault.rs` compares a migrated corpus against — and its
//! generator was v0's own freezer, which the v0 retirement deleted. So the two
//! manifests under `contracts/golden/` were fixtures nobody could reproduce,
//! which is the same thing as fixtures nobody may change: S4 moves
//! `snapshot::digest_values` from SHA-256 to BLAKE3, and every digest in both
//! files had to move with it. Hand-editing 26 KB of digests is not a thing a
//! reviewer can check. This is.
//!
//! The IDENTITY fields — `label`, `frozenAt`, `ontologyVersion` — are read back
//! off the existing manifest and passed through, because a re-generation is not
//! a re-freeze: the corpus was frozen when it was frozen, and this program only
//! restates what is in it. `userVersion` comes from the file's own
//! `PRAGMA user_version`, which is the one identity fact the corpus can answer
//! for itself and therefore the one worth re-reading rather than trusting.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use centraid_ontology::golden::{inflate, read_manifest, scratch_dir};
use centraid_ontology::snapshot::snapshot_vault;
use centraid_ontology::vault::Vault;

fn main() -> ExitCode {
    let mut args = std::env::args_os().skip(1);
    let Some(target) = args.next() else {
        eprintln!(
            "usage: export-golden-manifest <path to a contracts/golden/<label> directory>\n\
             writes that corpus's manifest.json to stdout"
        );
        return ExitCode::FAILURE;
    };
    match render(Path::new(&target)) {
        Ok(text) => {
            print!("{text}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("export-golden-manifest: {error}");
            ExitCode::FAILURE
        }
    }
}

fn render(dir: &Path) -> centraid_ontology::Result<String> {
    let existing = read_manifest(dir)?;
    // Never open the committed file in place — `docs/traps/wal-checkpoint.md`.
    let scratch = scratch_dir();
    let db: PathBuf = inflate(&dir.join("vault.db.gz"), &scratch)?;
    let vault = Vault::open(&db)?;
    let user_version: i64 = vault
        .connection()
        .query_row("PRAGMA user_version", [], |row| row.get(0))?;
    let tables = snapshot_vault(vault.connection())?;
    drop(vault);
    let _ = std::fs::remove_dir_all(&scratch);

    let document = serde_json::json!({
        "label": existing.label,
        "frozenAt": existing.frozen_at,
        "ontologyVersion": existing.ontology_version,
        "userVersion": user_version,
        "tables": tables,
    });
    let mut text = serde_json::to_string_pretty(&document).map_err(|source| {
        centraid_ontology::OntologyError::Json {
            context: "rendering the manifest".to_owned(),
            source,
        }
    })?;
    text.push('\n');
    Ok(text)
}
