//! THE ORIGINALS ON THIS PHONE, AND THE ALBUMS WHOSE ORIGINALS STAY (#1029,
//! the photos port — v0's `album-keep-originals.ts`, `photos-library-pins.ts`
//! and `free-up-space.ts`).
//!
//! `originals.proto` states the shapes and why none of them is a command. This
//! module is the core's half: the keep list, where it lives, and the census.
//!
//! # WHERE THE KEEP LIST LIVES, AND WHY IT IS NOT IN THE VAULT
//!
//! Beside the vault file, as `<stem>.keep-originals.json` — the same place
//! `<stem>.bytes` is, and for the reason [`crate::phone::Laptop`] gives in more
//! words: "keep this album's originals **on this phone**" is a fact about one
//! device's disk. Written into the vault it would be sealed into a base,
//! carried to the laptop and restored onto the next phone as a promise about a
//! disk that phone never had. v0 kept it in the device store for the same
//! reason (`KEEP_ORIGINALS_KEY`), and a vault row would also have cost a
//! migration rung for a list of ids.
//!
//! It is NOT under the backup home: that directory is derived state a phone may
//! lose and rebuild ("lose it and the phone re-pairs"), and a member's choice is
//! not derived from anything. It is inside the vault directory the iOS shell's
//! protection sweep walks, so the OS backup excludes it like every other path
//! the vault owns (R-1029-8).
//!
//! # AN UNREADABLE LIST IS AN ERROR, NEVER AN EMPTY ONE
//!
//! The list exists to hold albums BACK from a release. Read as empty when it
//! would not parse, it would hand every kept album to the first verb that frees
//! space — the one reading of a corrupt file that destroys something. So a file
//! that is there and will not parse refuses every ask, exactly as
//! [`crate::phone::Laptop::read`] refuses to read a broken record as "not
//! paired".
//!
//! # A WRITE IS WHOLE OR IT DID NOT HAPPEN
//!
//! Temp file, `fsync`, rename — the rule `backup::store` states for a blob. A
//! crash mid-write leaves the old list, never a prefix of the new one, which
//! would be the unreadable file above and every ask refused until someone
//! deleted it.

use std::collections::BTreeSet;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use centraid_api_proto::core_v1 as wire;
use centraid_vault::Vault;

use crate::error::{CoreError, Result};

/// The albums whose originals stay on this phone.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct KeptAlbums {
    /// Album ids, sorted and unique. An id may outlive its album on purpose:
    /// `media.restore_album` brings an album back under the same id, and a pin
    /// that died with the delete would bring it back unkept.
    pub album_ids: BTreeSet<String>,
}

impl KeptAlbums {
    /// Where the list sits for a vault at `vault_file`.
    #[must_use]
    pub fn path_for(vault_file: &Path) -> PathBuf {
        vault_file.with_extension("keep-originals.json")
    }

    /// Read it. **No file is an empty list** — a member who never kept an
    /// album has kept none.
    ///
    /// # Errors
    /// [`CoreError::Invariant`] when the file is there and will not read or
    /// parse. See the module header for why that is never an empty list.
    pub fn read(vault_file: &Path) -> Result<Self> {
        let path = Self::path_for(vault_file);
        let text = match std::fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Self::default());
            }
            Err(error) => {
                return Err(CoreError::Invariant {
                    context: format!("the keep list at {} will not read: {error}", path.display()),
                });
            }
        };
        serde_json::from_str(&text).map_err(|error| CoreError::Invariant {
            context: format!(
                "the keep list at {} will not parse: {error}",
                path.display()
            ),
        })
    }

    /// Write it whole, or leave the old one. See the module header.
    ///
    /// # Errors
    /// [`CoreError::Invariant`] when the file cannot be written, synced or
    /// renamed into place.
    pub fn write(&self, vault_file: &Path) -> Result<()> {
        let path = Self::path_for(vault_file);
        let fault = |step: &str, error: &dyn std::fmt::Display| CoreError::Invariant {
            context: format!("{step} the keep list at {}: {error}", path.display()),
        };
        let text = serde_json::to_string_pretty(self).map_err(|error| fault("encoding", &error))?;
        let temp = path.with_extension("keep-originals.json.tmp");
        let mut file = std::fs::File::create(&temp).map_err(|error| fault("creating", &error))?;
        file.write_all(text.as_bytes())
            .map_err(|error| fault("writing", &error))?;
        file.sync_all().map_err(|error| fault("syncing", &error))?;
        drop(file);
        std::fs::rename(&temp, &path).map_err(|error| fault("renaming", &error))
    }
}

/// **Answer one `OriginalsRequest`.**
///
/// Takes the vault because every arm is about this vault's albums, and the
/// handle's vault lock is what serialises two toggles: a read-modify-write of
/// the list outside it would let two taps race and lose one.
///
/// # Errors
/// [`CoreError::InvalidRequest`] for a request with no op or a keep with no
/// album; [`CoreError::Invariant`] for a list that will not read or write; and
/// whatever the census's read refused.
pub fn answer(
    vault: &Vault,
    vault_file: &Path,
    request: &wire::OriginalsRequest,
) -> Result<wire::OriginalsResponse> {
    use wire::originals_request::Op;
    let mut kept = KeptAlbums::read(vault_file)?;
    let mut census = None;
    match request.op.as_ref() {
        Some(Op::Kept(_)) => {}
        Some(Op::Keep(keep)) => {
            let album = keep.album_id.trim();
            if album.is_empty() {
                return Err(CoreError::InvalidRequest {
                    detail: "keeping originals names an album".to_owned(),
                });
            }
            // WRITTEN ONLY WHEN IT CHANGES. A second tap on a kept album is a
            // no-op, and a rename per no-op is a write a phone does not need.
            let changed = if keep.keep {
                kept.album_ids.insert(album.to_owned())
            } else {
                kept.album_ids.remove(album)
            };
            if changed {
                kept.write(vault_file)?;
            }
        }
        Some(Op::Census(_)) => {
            census = centraid_vault::originals::census(vault, &kept.album_ids)?.map(|found| {
                wire::OriginalsCensus {
                    on_phone: Some(totals(found.on_device)),
                    kept: Some(totals(found.kept)),
                }
            });
        }
        None => {
            return Err(CoreError::InvalidRequest {
                detail: "an originals request carries one of kept, keep or census".to_owned(),
            });
        }
    }
    Ok(wire::OriginalsResponse {
        kept_album_ids: kept.album_ids.into_iter().collect(),
        census,
    })
}

const fn totals(found: centraid_vault::originals::Totals) -> wire::OriginalsTotals {
    wire::OriginalsTotals {
        count: found.count,
        bytes: found.bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> (PathBuf, Vault) {
        let dir = centraid_ontology::golden::scratch_dir();
        std::fs::create_dir_all(&dir).expect("the directory is made");
        let file = dir.join("vault.sqlite3");
        let vault = Vault::create(&file).expect("a vault");
        vault.found("Test", "Owner").expect("founded");
        (file, vault)
    }

    fn keep(album: &str, keep: bool) -> wire::OriginalsRequest {
        wire::OriginalsRequest {
            op: Some(wire::originals_request::Op::Keep(
                wire::KeepAlbumOriginals {
                    album_id: album.to_owned(),
                    keep,
                },
            )),
        }
    }

    fn kept() -> wire::OriginalsRequest {
        wire::OriginalsRequest {
            op: Some(wire::originals_request::Op::Kept(wire::KeptAlbumsRead {})),
        }
    }

    /// **A KEEP LANDS BESIDE THE VAULT, SURVIVES A RE-READ, AND COMES OFF.**
    /// Every answer carries the list as it now stands.
    #[test]
    fn a_kept_album_is_written_beside_the_vault_and_taken_off_again() {
        let (file, vault) = scratch();
        assert!(
            answer(&vault, &file, &kept())
                .expect("reads")
                .kept_album_ids
                .is_empty()
        );

        answer(&vault, &file, &keep("album-b", true)).expect("keeps");
        let on = answer(&vault, &file, &keep("album-a", true)).expect("keeps");
        assert_eq!(
            on.kept_album_ids,
            vec!["album-a", "album-b"],
            "sorted, both"
        );
        assert!(
            KeptAlbums::path_for(&file).exists(),
            "the list is beside the vault"
        );
        assert_eq!(
            KeptAlbums::path_for(&file)
                .file_name()
                .and_then(|name| name.to_str()),
            Some("vault.keep-originals.json")
        );

        // A SECOND KEEP IS A NO-OP, and so is taking off an album never kept.
        answer(&vault, &file, &keep("album-a", true)).expect("idempotent");
        answer(&vault, &file, &keep("never-kept", false)).expect("idempotent");
        let off = answer(&vault, &file, &keep("album-b", false)).expect("unkeeps");
        assert_eq!(off.kept_album_ids, vec!["album-a"]);
        assert_eq!(
            answer(&vault, &file, &kept())
                .expect("reads")
                .kept_album_ids,
            vec!["album-a"]
        );
    }

    /// **A LIST THAT WILL NOT PARSE REFUSES; IT IS NEVER READ AS EMPTY.** Read
    /// as empty it would release every kept album's originals to the first verb
    /// that frees space.
    #[test]
    fn a_keep_list_that_will_not_parse_refuses_every_ask() {
        let (file, vault) = scratch();
        std::fs::write(KeptAlbums::path_for(&file), "{ not json").expect("a broken file");
        assert!(matches!(
            answer(&vault, &file, &kept()),
            Err(CoreError::Invariant { .. })
        ));
        assert!(matches!(
            answer(&vault, &file, &keep("album-a", true)),
            Err(CoreError::Invariant { .. })
        ));
    }

    /// **NO ALBUM, NO KEEP; NO OP, NO ANSWER.**
    #[test]
    fn a_keep_with_no_album_and_a_request_with_no_op_are_refused() {
        let (file, vault) = scratch();
        assert!(matches!(
            answer(&vault, &file, &keep("  ", true)),
            Err(CoreError::InvalidRequest { .. })
        ));
        assert!(matches!(
            answer(&vault, &file, &wire::OriginalsRequest { op: None }),
            Err(CoreError::InvalidRequest { .. })
        ));
    }

    /// **A CORE WITH NO CONTENT STORE ANSWERS "NOT COUNTED".** The census is
    /// absent, never a zero, and the keep list still rides the answer.
    #[test]
    fn a_census_without_a_content_store_is_absent_and_not_zero() {
        let (file, vault) = scratch();
        answer(&vault, &file, &keep("album-a", true)).expect("keeps");
        let answer = answer(
            &vault,
            &file,
            &wire::OriginalsRequest {
                op: Some(wire::originals_request::Op::Census(
                    wire::OriginalsCensusRead {},
                )),
            },
        )
        .expect("a census answers");
        assert_eq!(answer.census, None);
        assert_eq!(answer.kept_album_ids, vec!["album-a"]);
    }
}
