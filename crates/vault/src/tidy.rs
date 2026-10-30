//! The launch tidy: what a vault does once, right after it opens, to finish
//! what the last run could not ([#1146](https://github.com/srikanth235/centraid/issues/1146)).
//!
//! Two passes, each **bounded** so a caller can run them off the request path
//! in batches and hold the vault only for one batch at a time:
//!
//! - [`Vault::empty_overdue_trash`] purges what has waited out its window. Until
//!   it runs, an overdue row is a trashed row like any other: nothing hides it
//!   and `entity.restore` still brings it back.
//! - [`Vault::sweep_unclaimed_files`] deletes the files in the byte store that no
//!   `blob` row claims: the debris of a command that failed after the stage door
//!   stored its bytes, or of a delete that could not remove its file.
//!
//! **The sweep never takes a file a staging owns.** The stage door stores bytes
//! before any command names them, so for a moment a good file has no row. A
//! file is swept only if it is older than `before`, the instant this process
//! started: anything staged since is newer, and staging an identical file
//! again refreshes the older file's time (`centraid_blobs::ByteStore`).

use std::time::SystemTime;

use crate::commands::{Command, CommandStatus, Registry};
use crate::error::{Result, VaultError};
use crate::file::Vault;

/// What one bounded pass of the trash did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Emptied {
    /// Entities purged, the ones that went with them included.
    pub purged: usize,
    /// More is overdue than this pass took: run another.
    pub more: bool,
}

/// What one bounded sweep of the byte store did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Swept {
    /// The hashes whose files were deleted.
    pub removed: Vec<String>,
    /// Where the next sweep resumes (pass it as `after`), or `None` when the
    /// store has been looked through to its end.
    pub next: Option<String>,
}

impl Vault {
    /// Purge at most `limit` of the entities whose `purge_at` has passed, as
    /// `entity.empty_trash` does for the member: the same command, the same
    /// release of bytes, in one commit.
    ///
    /// # Errors
    /// The command's own refusal or failure.
    pub fn empty_overdue_trash(&self, registry: &Registry, limit: usize) -> Result<Emptied> {
        // THE COMMON LAUNCH FINDS NOTHING OVERDUE, and then writes nothing: one
        // indexed read (`entity_purge`) instead of a commit.
        let now = self.clock().now_text();
        let due: bool = self.read(|connection| {
            Ok(connection.query_row(
                "SELECT EXISTS (SELECT 1 FROM entity WHERE purge_at <= ?1)",
                [&now],
                |row| row.get(0),
            )?)
        })?;
        if !due {
            return Ok(Emptied {
                purged: 0,
                more: false,
            });
        }
        let outcome = self.execute(
            registry,
            &crate::access::Principal::owner("launch"),
            &Command::new(
                "entity.empty_trash",
                serde_json::json!({ "due_only": true, "limit": limit.max(1) }),
            ),
        )?;
        if outcome.status != CommandStatus::Executed {
            return Err(VaultError::Invariant {
                context: format!(
                    "the launch pass of the trash was refused: {}",
                    outcome.reason.unwrap_or_default()
                ),
            });
        }
        Ok(Emptied {
            purged: outcome
                .output
                .get("purged")
                .and_then(serde_json::Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .unwrap_or(0),
            more: outcome
                .output
                .get("more")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
        })
    }

    /// Look at the next `limit` files of the byte store after `after` (in hash
    /// order; `""` starts) and delete those that no `blob` row claims and that
    /// were written before `before`.
    ///
    /// **`limit` bounds the files looked at, not the files deleted**: a store of
    /// thousands of claimed files costs one batch each hundreds, and a caller
    /// holding the vault per batch never holds it for the whole store.
    ///
    /// # Errors
    /// The vault's read, or the store refusing to list or delete.
    pub fn sweep_unclaimed_files(
        &self,
        before: SystemTime,
        after: &str,
        limit: usize,
    ) -> Result<Swept> {
        let Some(store) = self.blobs() else {
            return Ok(Swept {
                removed: Vec::new(),
                next: None,
            });
        };
        let invariant = |what: &str, error: &dyn std::fmt::Display| VaultError::Invariant {
            context: format!("the byte store could not {what}: {error}"),
        };
        let mut removed = Vec::new();
        let mut looked = 0usize;
        let mut last = String::new();
        for id in store.ids().map_err(|e| invariant("list its files", &e))? {
            if id.as_str() <= after {
                continue;
            }
            if looked >= limit {
                return Ok(Swept {
                    removed,
                    next: Some(last),
                });
            }
            looked += 1;
            last.clone_from(&id);
            let Ok(Some(path)) = store.path_of(&id) else {
                continue;
            };
            let Ok(written) = std::fs::metadata(&path).and_then(|m| m.modified()) else {
                continue;
            };
            if written >= before {
                continue;
            }
            // One primary-key lookup per old file, not a read of the whole table.
            let claimed: bool = self.read(|connection| {
                Ok(connection.query_row(
                    "SELECT EXISTS (SELECT 1 FROM blob WHERE hash = ?1)",
                    [&id],
                    |row| row.get(0),
                )?)
            })?;
            if !claimed
                && store
                    .remove(&id)
                    .map_err(|e| invariant("delete a file", &e))?
            {
                removed.push(id);
            }
        }
        Ok(Swept {
            removed,
            next: None,
        })
    }
}
