//! `<stem>.state.db`: the device state of a phone's backup
//! (spec §6.1, [#1209](https://github.com/srikanth235/centraid/issues/1209)).
//!
//! It lives beside the vault and never inside it, so a snapshot never carries
//! the state of its own upload. It is derived: a reset is a re-pair and a
//! re-ask. **There is no outbox**: what a gateway is owed is the difference
//! between the newest tree and the one it confirmed (`conf`, `troot`,
//! `oroot`), computed from the node cache.
//!
//! The file carries `application_id = CBS2` ([`STATE_APPLICATION_ID`]) and a
//! `user_version` that counts the rungs of `state_ladder/`, which is one:
//! v0 has nothing to upgrade from.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use centraid_media::sealed::{Class, Digest, Name, PlaintextHash, Ref};
use rusqlite::{Connection, OptionalExtension as _, params};

use super::tree::NodeSource;
use super::{Result, invariant};

/// `CBS2`: this file is a backup device state.
pub const STATE_APPLICATION_ID: i64 = 0x4342_5332;

/// The rungs of the ladder, in order. `user_version` is how many are applied.
const LADDER: &[&str] = &[include_str!("state_ladder/001_founding.sql")];

/// Whether a gateway can be reached, as the last pass found it (spec §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reach {
    Ok,
    Unreachable,
    Untrusted,
    TooOld,
    PairAgain,
    Moved,
    Frozen,
    Busy,
}

impl Reach {
    /// The word the column holds.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Unreachable => "unreachable",
            Self::Untrusted => "untrusted",
            Self::TooOld => "too_old",
            Self::PairAgain => "pair_again",
            Self::Moved => "moved",
            Self::Frozen => "frozen",
            Self::Busy => "busy",
        }
    }

    fn parse(word: &str) -> Result<Self> {
        Ok(match word {
            "ok" => Self::Ok,
            "unreachable" => Self::Unreachable,
            "untrusted" => Self::Untrusted,
            "too_old" => Self::TooOld,
            "pair_again" => Self::PairAgain,
            "moved" => Self::Moved,
            "frozen" => Self::Frozen,
            "busy" => Self::Busy,
            other => return Err(invariant(format!("an unknown reach `{other}`"))),
        })
    }
}

/// Persistent per-gateway housekeeping and health notes (spec §6).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GatewayNotesRecord {
    pub collected_ms: u64,
    pub held_count: u64,
    pub held_purge_at_ms: Option<i64>,
    pub refusal_code: Option<i32>,
    pub damaged: bool,
    pub sample_checked: u64,
    pub sample_of: u64,
    pub manifest_unreadable: bool,
}

/// One paired gateway, as the phone keeps it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Gateway {
    pub gateway_id: String,
    pub addrs: Vec<String>,
    pub cert_der: Vec<u8>,
    pub label: String,
    pub epoch: u64,
    pub generation: u64,
    /// The head this phone last confirmed there, and when.
    pub conf: Option<(Name, u64)>,
    /// The root whose thumbnails are confirmed whole there, and when.
    pub troot: Option<(Name, u64)>,
    /// The root whose originals are confirmed whole there, and when.
    pub oroot: Option<(Name, u64)>,
    pub reach: Reach,
    pub moved_epoch: Option<u64>,
    pub reach_ms: Option<u64>,
    pub paired_ms: u64,
    pub sample_counter: u64,
    pub scrub_cursor: Option<Name>,
    pub directory_dirty: bool,
    /// The last head that was not `conf` had gone backwards; cleared when a new head is confirmed.
    pub regressed: bool,
    /// Persistent housekeeping and health notes for this gateway.
    pub notes: GatewayNotesRecord,
}

impl Gateway {
    /// A gateway just paired.
    #[must_use]
    pub const fn paired(
        gateway_id: String,
        addrs: Vec<String>,
        cert_der: Vec<u8>,
        label: String,
        epoch: u64,
        now_ms: u64,
    ) -> Self {
        Self {
            gateway_id,
            addrs,
            cert_der,
            label,
            epoch,
            generation: 0,
            conf: None,
            troot: None,
            oroot: None,
            reach: Reach::Ok,
            moved_epoch: None,
            reach_ms: None,
            paired_ms: now_ms,
            sample_counter: 0,
            scrub_cursor: None,
            directory_dirty: true,
            regressed: false,
            notes: GatewayNotesRecord {
                collected_ms: 0,
                held_count: 0,
                held_purge_at_ms: None,
                refusal_code: None,
                damaged: false,
                sample_checked: 0,
                sample_of: 0,
                manifest_unreadable: false,
            },
        }
    }
}

/// Where a hash's bytes are kept on this device (`local_bytes.source`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalSource {
    /// The operating system's library, under [`LocalBytes::os_ref`].
    Os,
    /// The app's own content store.
    Store,
}

impl LocalSource {
    /// The word the column holds.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Os => "os",
            Self::Store => "store",
        }
    }

    fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "os" => Self::Os,
            "store" => Self::Store,
            _ => return None,
        })
    }
}

/// One row of `local_bytes`: where a hash's bytes are on this device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalBytes {
    pub hash: PlaintextHash,
    pub source: LocalSource,
    /// The library's own identifier for the item, for [`LocalSource::Os`] only: the shell
    /// resolves it, and it means nothing on another phone.
    pub os_ref: Option<String>,
    /// The member edited the item in the library: the rendition backed up is its current one.
    pub edited: bool,
}

/// The one `device` row.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Device {
    pub newest: Option<(Name, u64)>,
    pub since_full: u64,
    pub full_ms: Option<u64>,
    /// Pages written during the last pin, as page numbers.
    pub carry: Vec<u32>,
}

/// A file in staging.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Staged {
    pub name: Name,
    pub path: String,
    pub size: u64,
}

/// The device state database.
pub struct DeviceState {
    connection: Connection,
    path: PathBuf,
}

fn signed(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn unsigned(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

fn name_of(text: &str) -> Result<Name> {
    Name::from_hex(text).map_err(Into::into)
}

fn optional_name(text: Option<String>) -> Result<Option<Name>> {
    text.as_deref().map(name_of).transpose()
}

fn pair_of(name: Option<String>, ms: Option<i64>) -> Result<Option<(Name, u64)>> {
    Ok(optional_name(name)?.zip(ms.map(unsigned)))
}

const GATEWAY_COLUMNS: &str = "gateway_id, addrs, cert_der, label, epoch, generation, conf, conf_ms, \
     troot, troot_ms, oroot, oroot_ms, reach, moved_epoch, reach_ms, paired_ms, sample_counter, \
     scrub_cursor, directory_dirty, regressed, collected_ms, held_count, held_purge_at_ms, \
     refusal_code, damaged_flag, sample_checked, sample_of, manifest_unreadable";

impl DeviceState {
    /// Open (founding when new) the state at `path`.
    ///
    /// # Errors
    /// SQLite's refusal, or a file that is not a backup device state.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let connection = Connection::open(path.as_ref())?;
        connection.pragma_update(None, "journal_mode", "wal")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.pragma_update(None, "foreign_keys", "ON")?;
        let application_id: i64 =
            connection.query_row("PRAGMA application_id", [], |row| row.get(0))?;
        let version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        let rungs = i64::try_from(LADDER.len()).unwrap_or(i64::MAX);
        let fresh = version == 0 && application_id == 0;
        if !fresh && application_id != STATE_APPLICATION_ID {
            return Err(invariant("this file is not a backup device state"));
        }
        if version > rungs {
            return Err(invariant("this device state is from a newer build"));
        }
        for (index, rung) in LADDER
            .iter()
            .enumerate()
            .skip(usize::try_from(version).unwrap_or(0))
        {
            connection.execute_batch("BEGIN IMMEDIATE")?;
            let applied = connection.execute_batch(rung).and_then(|()| {
                connection.pragma_update(None, "application_id", STATE_APPLICATION_ID)?;
                connection.pragma_update(
                    None,
                    "user_version",
                    i64::try_from(index + 1).unwrap_or(1),
                )
            });
            match applied {
                Ok(()) => connection.execute_batch("COMMIT")?,
                Err(error) => {
                    let _ = connection.execute_batch("ROLLBACK");
                    return Err(error.into());
                }
            }
        }
        Ok(Self {
            connection,
            path: path.as_ref().to_owned(),
        })
    }

    /// `<stem>.state.db` beside the vault file.
    #[must_use]
    pub fn path_for(vault_path: &Path) -> PathBuf {
        vault_path.with_extension("state.db")
    }

    /// Open the state beside `vault_path`, creating it when absent.
    ///
    /// # Errors
    /// As [`Self::open`].
    pub fn open_beside(vault_path: &Path) -> Result<Self> {
        Self::open(Self::path_for(vault_path))
    }

    /// The file this state is in.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The connection, for a test that writes the bad row with raw SQL.
    #[doc(hidden)]
    #[must_use]
    pub const fn connection(&self) -> &Connection {
        &self.connection
    }

    // ── gateways ──

    /// Pair a gateway, or refresh the pairing of one already here (addresses,
    /// certificate, label and epoch; what it confirmed is kept, unless the
    /// epoch moved, which is a new writer and a new ask).
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn add_gateway(&self, gateway: &Gateway) -> Result<()> {
        let addrs = serde_json::to_string(&gateway.addrs)
            .map_err(|error| invariant(format!("the addresses: {error}")))?;
        self.connection.execute(
            "INSERT INTO gateway (gateway_id, addrs, cert_der, label, epoch, paired_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (gateway_id) DO UPDATE SET
               addrs = excluded.addrs, cert_der = excluded.cert_der, label = excluded.label,
               conf = CASE WHEN gateway.epoch = excluded.epoch THEN gateway.conf END,
               conf_ms = CASE WHEN gateway.epoch = excluded.epoch THEN gateway.conf_ms END,
               troot = CASE WHEN gateway.epoch = excluded.epoch THEN gateway.troot END,
               troot_ms = CASE WHEN gateway.epoch = excluded.epoch THEN gateway.troot_ms END,
               oroot = CASE WHEN gateway.epoch = excluded.epoch THEN gateway.oroot END,
               oroot_ms = CASE WHEN gateway.epoch = excluded.epoch THEN gateway.oroot_ms END,
               generation = CASE WHEN gateway.epoch = excluded.epoch THEN gateway.generation ELSE 0 END,
               regressed = CASE WHEN gateway.epoch = excluded.epoch THEN gateway.regressed ELSE 0 END,
               epoch = excluded.epoch, directory_dirty = 1",
            params![
                gateway.gateway_id,
                addrs,
                gateway.cert_der,
                gateway.label,
                signed(gateway.epoch),
                signed(gateway.paired_ms)
            ],
        )?;
        Ok(())
    }

    fn gateway_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<(Gateway, Vec<String>)> {
        let addrs: String = row.get(1)?;
        let reach: String = row.get(12)?;
        let gateway = Gateway {
            gateway_id: row.get(0)?,
            addrs: Vec::new(),
            cert_der: row.get(2)?,
            label: row.get(3)?,
            epoch: unsigned(row.get(4)?),
            generation: unsigned(row.get(5)?),
            conf: None,
            troot: None,
            oroot: None,
            reach: Reach::Ok,
            moved_epoch: row.get::<_, Option<i64>>(13)?.map(unsigned),
            reach_ms: row.get::<_, Option<i64>>(14)?.map(unsigned),
            paired_ms: unsigned(row.get(15)?),
            sample_counter: unsigned(row.get(16)?),
            scrub_cursor: None,
            directory_dirty: row.get::<_, i64>(18)? != 0,
            regressed: row.get::<_, i64>(19)? != 0,
            notes: GatewayNotesRecord {
                collected_ms: unsigned(row.get(20)?),
                held_count: unsigned(row.get(21)?),
                held_purge_at_ms: row.get(22)?,
                refusal_code: row
                    .get::<_, Option<i64>>(23)?
                    .map(|code| i32::try_from(code).unwrap_or(i32::MAX)),
                damaged: row.get::<_, i64>(24)? != 0,
                sample_checked: unsigned(row.get(25)?),
                sample_of: unsigned(row.get(26)?),
                manifest_unreadable: row.get::<_, i64>(27)? != 0,
            },
        };
        // The text columns are parsed by the caller, which can fail with the plane's error.
        let texts = vec![
            addrs,
            reach,
            row.get::<_, Option<String>>(6)?.unwrap_or_default(),
            row.get::<_, Option<i64>>(7)?
                .map_or_else(String::new, |ms| ms.to_string()),
            row.get::<_, Option<String>>(8)?.unwrap_or_default(),
            row.get::<_, Option<i64>>(9)?
                .map_or_else(String::new, |ms| ms.to_string()),
            row.get::<_, Option<String>>(10)?.unwrap_or_default(),
            row.get::<_, Option<i64>>(11)?
                .map_or_else(String::new, |ms| ms.to_string()),
            row.get::<_, Option<String>>(17)?.unwrap_or_default(),
        ];
        Ok((gateway, texts))
    }

    fn finish_gateway((mut gateway, texts): (Gateway, Vec<String>)) -> Result<Gateway> {
        gateway.addrs = serde_json::from_str(&texts[0])
            .map_err(|error| invariant(format!("the addresses: {error}")))?;
        gateway.reach = Reach::parse(&texts[1])?;
        let pair = |name: &str, ms: &str| -> Result<Option<(Name, u64)>> {
            if name.is_empty() {
                return Ok(None);
            }
            let ms = ms
                .parse::<u64>()
                .map_err(|_| invariant("a confirmation without its time"))?;
            Ok(Some((name_of(name)?, ms)))
        };
        gateway.conf = pair(&texts[2], &texts[3])?;
        gateway.troot = pair(&texts[4], &texts[5])?;
        gateway.oroot = pair(&texts[6], &texts[7])?;
        gateway.scrub_cursor = if texts[8].is_empty() {
            None
        } else {
            Some(name_of(&texts[8])?)
        };
        Ok(gateway)
    }

    /// One gateway.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn gateway(&self, gateway_id: &str) -> Result<Option<Gateway>> {
        let row = self
            .connection
            .query_row(
                &format!("SELECT {GATEWAY_COLUMNS} FROM gateway WHERE gateway_id = ?1"),
                [gateway_id],
                Self::gateway_from,
            )
            .optional()?;
        row.map(Self::finish_gateway).transpose()
    }

    /// Every gateway, by id.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn gateways(&self) -> Result<Vec<Gateway>> {
        let mut statement = self.connection.prepare(&format!(
            "SELECT {GATEWAY_COLUMNS} FROM gateway ORDER BY gateway_id"
        ))?;
        let rows = statement
            .query_map([], Self::gateway_from)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().map(Self::finish_gateway).collect()
    }

    /// Unpair a gateway, with what it confirmed.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn remove_gateway(&self, gateway_id: &str) -> Result<()> {
        self.connection
            .execute("DELETE FROM gateway WHERE gateway_id = ?1", [gateway_id])?;
        Ok(())
    }

    /// Records are held whole at `head`: `conf`.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn confirm_records(&self, gateway_id: &str, head: &Name, now_ms: u64) -> Result<()> {
        self.connection.execute(
            "UPDATE gateway SET conf = ?2, conf_ms = ?3, regressed = 0 WHERE gateway_id = ?1",
            params![gateway_id, head.to_hex(), signed(now_ms)],
        )?;
        Ok(())
    }

    /// Record whether the head last read at a gateway, which was not `conf`, had gone backwards.
    /// Cleared by [`Self::confirm_records`], not by a pass that finds nothing to compare.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn set_regressed(&self, gateway_id: &str, regressed: bool) -> Result<()> {
        self.connection.execute(
            "UPDATE gateway SET regressed = ?2 WHERE gateway_id = ?1",
            params![gateway_id, i64::from(regressed)],
        )?;
        Ok(())
    }

    /// Thumbnails are held whole for the tree at `root`: `troot`.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn confirm_thumbnails(&self, gateway_id: &str, root: &Name, now_ms: u64) -> Result<()> {
        self.connection.execute(
            "UPDATE gateway SET troot = ?2, troot_ms = ?3 WHERE gateway_id = ?1",
            params![gateway_id, root.to_hex(), signed(now_ms)],
        )?;
        Ok(())
    }

    /// Originals are held whole for the tree at `root`: `oroot`.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn confirm_originals(&self, gateway_id: &str, root: &Name, now_ms: u64) -> Result<()> {
        self.connection.execute(
            "UPDATE gateway SET oroot = ?2, oroot_ms = ?3 WHERE gateway_id = ?1",
            params![gateway_id, root.to_hex(), signed(now_ms)],
        )?;
        Ok(())
    }

    /// Drop `conf`, `troot` and `oroot` (and so every status claim) for a
    /// gateway: the next pass is a recovery pass.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn withdraw(&self, gateway_id: &str) -> Result<()> {
        self.connection.execute(
            "UPDATE gateway SET conf = NULL, conf_ms = NULL, troot = NULL, troot_ms = NULL,
                    oroot = NULL, oroot_ms = NULL WHERE gateway_id = ?1",
            [gateway_id],
        )?;
        Ok(())
    }

    /// Record how a gateway answered.
    ///
    /// # Errors
    /// SQLite's refusal; `moved_epoch` must be given exactly with `Reach::Moved`.
    pub fn set_reach(
        &self,
        gateway_id: &str,
        reach: Reach,
        moved_epoch: Option<u64>,
        now_ms: u64,
    ) -> Result<()> {
        self.connection.execute(
            "UPDATE gateway SET reach = ?2, moved_epoch = ?3, reach_ms = ?4 WHERE gateway_id = ?1",
            params![
                gateway_id,
                reach.as_str(),
                moved_epoch.map(signed),
                signed(now_ms)
            ],
        )?;
        Ok(())
    }

    /// The signed generation counter this phone last used there.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn set_generation(&self, gateway_id: &str, generation: u64) -> Result<()> {
        self.connection.execute(
            "UPDATE gateway SET generation = ?2 WHERE gateway_id = ?1",
            params![gateway_id, signed(generation)],
        )?;
        Ok(())
    }

    /// Advance the read-back draw counter, which a pass's result records in
    /// the same transaction.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn set_sample_counter(&self, gateway_id: &str, counter: u64) -> Result<()> {
        self.connection.execute(
            "UPDATE gateway SET sample_counter = ?2 WHERE gateway_id = ?1",
            params![gateway_id, signed(counter)],
        )?;
        Ok(())
    }

    /// Where the read-back's ordered walk of names stands.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn set_scrub_cursor(&self, gateway_id: &str, cursor: Option<&Name>) -> Result<()> {
        self.connection.execute(
            "UPDATE gateway SET scrub_cursor = ?2 WHERE gateway_id = ?1",
            params![gateway_id, cursor.map(Name::to_hex)],
        )?;
        Ok(())
    }

    /// Whether the directory the head names is out of date for this gateway.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn set_directory_dirty(&self, gateway_id: &str, dirty: bool) -> Result<()> {
        self.connection.execute(
            "UPDATE gateway SET directory_dirty = ?2 WHERE gateway_id = ?1",
            params![gateway_id, i64::from(dirty)],
        )?;
        Ok(())
    }

    /// Persistent notes for `gateway_id`; returns defaults when the gateway is not paired.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn gateway_notes(&self, gateway_id: &str) -> Result<GatewayNotesRecord> {
        let row = self
            .connection
            .query_row(
                "SELECT collected_ms, held_count, held_purge_at_ms, refusal_code, damaged_flag,
                        sample_checked, sample_of, manifest_unreadable
                 FROM gateway WHERE gateway_id = ?1",
                [gateway_id],
                |row| {
                    Ok(GatewayNotesRecord {
                        collected_ms: unsigned(row.get(0)?),
                        held_count: unsigned(row.get(1)?),
                        held_purge_at_ms: row.get(2)?,
                        refusal_code: row
                            .get::<_, Option<i64>>(3)?
                            .map(|code| i32::try_from(code).unwrap_or(i32::MAX)),
                        damaged: row.get::<_, i64>(4)? != 0,
                        sample_checked: unsigned(row.get(5)?),
                        sample_of: unsigned(row.get(6)?),
                        manifest_unreadable: row.get::<_, i64>(7)? != 0,
                    })
                },
            )
            .optional()?;
        Ok(row.unwrap_or_default())
    }

    /// Persist `notes` on `gateway_id`.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn set_gateway_notes(&self, gateway_id: &str, notes: &GatewayNotesRecord) -> Result<()> {
        self.connection.execute(
            "UPDATE gateway SET
                collected_ms = ?2,
                held_count = ?3,
                held_purge_at_ms = ?4,
                refusal_code = ?5,
                damaged_flag = ?6,
                sample_checked = ?7,
                sample_of = ?8,
                manifest_unreadable = ?9
             WHERE gateway_id = ?1",
            params![
                gateway_id,
                signed(notes.collected_ms),
                signed(notes.held_count),
                notes.held_purge_at_ms,
                notes.refusal_code.map(i64::from),
                i64::from(notes.damaged),
                signed(notes.sample_checked),
                signed(notes.sample_of),
                i64::from(notes.manifest_unreadable),
            ],
        )?;
        Ok(())
    }

    // ── the node cache ──

    /// Keep a tree node's plaintext. Idempotent.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn put_node(&self, name: &Name, plaintext: &[u8]) -> Result<()> {
        self.connection.execute(
            "INSERT INTO node (name, plaintext) VALUES (?1, ?2) ON CONFLICT (name) DO NOTHING",
            params![name.to_hex(), plaintext],
        )?;
        Ok(())
    }

    /// A node's plaintext.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn get_node(&self, name: &Name) -> Result<Option<Vec<u8>>> {
        Ok(self
            .connection
            .query_row(
                "SELECT plaintext FROM node WHERE name = ?1",
                [name.to_hex()],
                |row| row.get(0),
            )
            .optional()?)
    }

    /// How many nodes are cached.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn node_count(&self) -> Result<u64> {
        Ok(unsigned(self.connection.query_row(
            "SELECT count(*) FROM node",
            [],
            |row| row.get(0),
        )?))
    }

    /// Forget every cached node not in `keep`; how many went.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn forget_nodes_except(&self, keep: &BTreeSet<Name>) -> Result<usize> {
        let held: Vec<String> = {
            let mut statement = self.connection.prepare("SELECT name FROM node")?;
            statement
                .query_map([], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?
        };
        let mut gone = 0;
        for name in held {
            if !keep.contains(&name_of(&name)?) {
                self.connection
                    .execute("DELETE FROM node WHERE name = ?1", [name])?;
                gone += 1;
            }
        }
        Ok(gone)
    }

    // ── staging rows ──

    /// Record a file that reached its name in staging.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn stage(&self, name: &Name, path: &str, size: u64) -> Result<()> {
        self.connection.execute(
            "INSERT INTO staged (name, path, size) VALUES (?1, ?2, ?3)
             ON CONFLICT (name) DO UPDATE SET path = excluded.path, size = excluded.size",
            params![name.to_hex(), path, signed(size)],
        )?;
        Ok(())
    }

    /// One staged file.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn staged(&self, name: &Name) -> Result<Option<Staged>> {
        self.connection
            .query_row(
                "SELECT path, size FROM staged WHERE name = ?1",
                [name.to_hex()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?
            .map(|(path, size)| {
                Ok(Staged {
                    name: *name,
                    path,
                    size: unsigned(size),
                })
            })
            .transpose()
    }

    /// Every staged file.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn staged_all(&self) -> Result<Vec<Staged>> {
        let mut statement = self
            .connection
            .prepare("SELECT name, path, size FROM staged ORDER BY name")?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(name, path, size)| {
                Ok(Staged {
                    name: name_of(&name)?,
                    path,
                    size: unsigned(size),
                })
            })
            .collect()
    }

    /// Forget a staged file's row.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn unstage(&self, name: &Name) -> Result<()> {
        self.connection
            .execute("DELETE FROM staged WHERE name = ?1", [name.to_hex()])?;
        Ok(())
    }

    // ── the device row ──

    /// The device row.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn device(&self) -> Result<Device> {
        let (newest, newest_ms, since_full, full_ms, carry): (
            Option<String>,
            Option<i64>,
            i64,
            Option<i64>,
            Vec<u8>,
        ) = self.connection.query_row(
            "SELECT newest, newest_ms, since_full, full_ms, carry FROM device WHERE id = 1",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )?;
        Ok(Device {
            newest: pair_of(newest, newest_ms)?,
            since_full: unsigned(since_full),
            full_ms: full_ms.map(unsigned),
            carry: carry
                .chunks_exact(4)
                .map(|chunk| u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
                .collect(),
        })
    }

    /// Write the device row. Clears `disk_mark` until the caller records the post-checkpoint
    /// fingerprint via [`Self::set_disk_mark`].
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn set_device(&self, device: &Device) -> Result<()> {
        let carry: Vec<u8> = device
            .carry
            .iter()
            .flat_map(|page| page.to_be_bytes())
            .collect();
        self.connection.execute(
            "UPDATE device SET newest = ?1, newest_ms = ?2, since_full = ?3, full_ms = ?4, carry = ?5,
                    disk_mark = NULL
              WHERE id = 1",
            params![
                device.newest.map(|(name, _)| name.to_hex()),
                device.newest.map(|(_, ms)| signed(ms)),
                signed(device.since_full),
                device.full_ms.map(signed),
                carry
            ],
        )?;
        Ok(())
    }

    /// The fingerprint of the main vault file after the last checkpoint, or `None` when none has
    /// been recorded yet (or a checkpoint did not complete).
    ///
    /// # Errors
    /// SQLite's refusal, or a stored mark that is not 32 bytes.
    pub fn disk_mark(&self) -> Result<Option<[u8; 32]>> {
        let bytes: Option<Vec<u8>> =
            self.connection
                .query_row("SELECT disk_mark FROM device WHERE id = 1", [], |row| {
                    row.get(0)
                })?;
        bytes
            .map(|raw| {
                <[u8; 32]>::try_from(raw.as_slice())
                    .map_err(|_| invariant("the stored disk_mark is not 32 bytes"))
            })
            .transpose()
    }

    /// Record the fingerprint of the main vault file after a checkpoint.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn set_disk_mark(&self, mark: Option<&[u8; 32]>) -> Result<()> {
        self.connection.execute(
            "UPDATE device SET disk_mark = ?1 WHERE id = 1",
            params![mark.map(<[u8; 32]>::as_slice)],
        )?;
        Ok(())
    }

    /// Whether the newest snapshot left video originals out of the originals class.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn exclude_videos(&self) -> Result<bool> {
        let flag: i64 = self.connection.query_row(
            "SELECT exclude_videos FROM device WHERE id = 1",
            [],
            |row| row.get(0),
        )?;
        Ok(flag != 0)
    }

    /// Record whether the newest snapshot left video originals out of the originals class.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn set_exclude_videos(&self, exclude: bool) -> Result<()> {
        self.connection.execute(
            "UPDATE device SET exclude_videos = ?1 WHERE id = 1",
            params![i64::from(exclude)],
        )?;
        Ok(())
    }

    // ── where bytes are ──

    /// Record where a hash's bytes are on this device. A library row needs an identifier, a store
    /// row must not carry one, and only a library row can be edited.
    ///
    /// # Errors
    /// A row that breaks those, or SQLite's refusal.
    pub fn put_local(&self, local: &LocalBytes) -> Result<()> {
        let identified = local.os_ref.as_deref().is_some_and(|text| !text.is_empty());
        if (local.edited && local.source != LocalSource::Os)
            || identified != (local.source == LocalSource::Os)
        {
            return Err(invariant(format!(
                "a `{}` row for {} is not a valid local bytes row",
                local.source.as_str(),
                local.hash
            )));
        }
        // RECORDED LAST IS RECORDED NEWEST: a hash recorded again moves to the end of the order.
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "DELETE FROM local_bytes WHERE hash = ?1",
            [local.hash.to_hex()],
        )?;
        transaction.execute(
            "INSERT INTO local_bytes (hash, source, ref, edited) VALUES (?1, ?2, ?3, ?4)",
            params![
                local.hash.to_hex(),
                local.source.as_str(),
                local.os_ref,
                i64::from(local.edited)
            ],
        )?;
        transaction.commit()?;
        Ok(())
    }

    fn local_from(row: &rusqlite::Row<'_>) -> rusqlite::Result<LocalBytes> {
        let hash: String = row.get(0)?;
        let source: String = row.get(1)?;
        let bad = |what: &str| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                what.to_owned().into(),
            )
        };
        Ok(LocalBytes {
            hash: PlaintextHash::from_hex(&hash).map_err(|_| bad("a local hash"))?,
            source: LocalSource::parse(&source).ok_or_else(|| bad("a local source"))?,
            os_ref: row.get(2)?,
            edited: row.get::<_, i64>(3)? != 0,
        })
    }

    /// Where a hash's bytes are, as recorded. `None` is no record: ask the store.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn local(&self, hash: &PlaintextHash) -> Result<Option<LocalBytes>> {
        Ok(self
            .connection
            .query_row(
                "SELECT hash, source, ref, edited FROM local_bytes WHERE hash = ?1",
                [hash.to_hex()],
                Self::local_from,
            )
            .optional()?)
    }

    /// Every recorded hash, oldest record first.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn locals(&self) -> Result<Vec<LocalBytes>> {
        let mut statement = self
            .connection
            .prepare("SELECT hash, source, ref, edited FROM local_bytes ORDER BY rowid")?;
        let rows = statement.query_map([], Self::local_from)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// The bytes left this device: forget where they were.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn forget_local(&self, hash: &PlaintextHash) -> Result<()> {
        self.connection
            .execute("DELETE FROM local_bytes WHERE hash = ?1", [hash.to_hex()])?;
        Ok(())
    }

    // ── sealed chunk refs per blob and class ──

    /// Record the sealed chunks of `hash` under `class` (`Class::Thumbnails` or `Class::Originals`),
    /// in order. Replaces any earlier record for `(hash, class)`.
    ///
    /// # Errors
    /// `Class::Records` (which is not a content blob class), or SQLite's refusal.
    pub fn put_blob_chunks(&self, hash: &PlaintextHash, class: Class, refs: &[Ref]) -> Result<()> {
        if class == Class::Records {
            return Err(invariant(
                "blob_chunk stores only thumbnails and originals, not records",
            ));
        }
        let hex = hash.to_hex();
        let class_byte = i64::from(class.byte());
        let transaction = self.connection.unchecked_transaction()?;
        transaction.execute(
            "DELETE FROM blob_chunk WHERE hash = ?1 AND class = ?2",
            params![hex, class_byte],
        )?;
        for (index, reference) in refs.iter().enumerate() {
            transaction.execute(
                "INSERT INTO blob_chunk (hash, class, idx, name, digest, len)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    hex,
                    class_byte,
                    signed(index as u64),
                    reference.name.to_hex(),
                    reference.digest.to_hex(),
                    i64::from(reference.len),
                ],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// The recorded chunks of `hash` under `class`, in order; empty when none were recorded or
    /// when `class` is `Class::Records`.
    ///
    /// # Errors
    /// SQLite's refusal, or a row that will not read back.
    pub fn blob_chunks(&self, hash: &PlaintextHash, class: Class) -> Result<Vec<Ref>> {
        if class == Class::Records {
            return Ok(Vec::new());
        }
        let mut statement = self.connection.prepare(
            "SELECT name, digest, len FROM blob_chunk WHERE hash = ?1 AND class = ?2 ORDER BY idx",
        )?;
        let rows = statement.query_map(params![hash.to_hex(), i64::from(class.byte())], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (name, digest, len) = row?;
            let bad = || invariant("a blob_chunk row does not read back");
            out.push(Ref {
                name: Name::from_hex(&name).map_err(|_| bad())?,
                digest: Digest::from_hex(&digest).map_err(|_| bad())?,
                len: u32::try_from(len).map_err(|_| bad())?,
                class,
            });
        }
        Ok(out)
    }

    /// Remove every recorded chunk ref for `hash` across all classes.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn remove_blob_chunks(&self, hash: &PlaintextHash) -> Result<()> {
        self.connection
            .execute("DELETE FROM blob_chunk WHERE hash = ?1", [hash.to_hex()])?;
        Ok(())
    }

    /// Record the sealed chunks of the original `hash`, in order, whose bytes only the OS photo
    /// library holds: what the snapshot lists for it. Replaces any earlier record.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn put_os_chunks(&self, hash: &PlaintextHash, refs: &[Ref]) -> Result<()> {
        self.put_blob_chunks(hash, Class::Originals, refs)
    }

    /// The recorded chunks of `hash`, in order; empty when none were recorded.
    ///
    /// # Errors
    /// SQLite's refusal, or a row that will not read back.
    pub fn os_chunks(&self, hash: &PlaintextHash) -> Result<Vec<Ref>> {
        self.blob_chunks(hash, Class::Originals)
    }

    // ── folded WAL dirty ranges ──

    /// Every 64 KiB range index folded from an oversized WAL and awaiting the next snapshot.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn dirty_ranges(&self) -> Result<BTreeSet<u64>> {
        let mut statement = self
            .connection
            .prepare("SELECT range_index FROM dirty_range ORDER BY range_index")?;
        let rows = statement
            .query_map([], |row| row.get::<_, i64>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().map(unsigned).collect())
    }

    /// Persist `ranges` folded from the WAL at `now_ms` so the next snapshot still reads them.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn add_dirty_ranges(
        &self,
        ranges: impl IntoIterator<Item = u64>,
        now_ms: u64,
    ) -> Result<()> {
        let transaction = self.connection.unchecked_transaction()?;
        for range in ranges {
            transaction.execute(
                "INSERT INTO dirty_range (range_index, noted_ms) VALUES (?1, ?2)
                 ON CONFLICT (range_index) DO UPDATE SET noted_ms = excluded.noted_ms",
                params![signed(range), signed(now_ms)],
            )?;
        }
        transaction.commit()?;
        Ok(())
    }

    /// Clear folded dirty ranges once a snapshot has recorded them.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn clear_dirty_ranges(&self) -> Result<()> {
        self.connection.execute("DELETE FROM dirty_range", [])?;
        Ok(())
    }

    // ── undo ──

    /// Names an Undo lifted the hold on, kept from deletion until `until_ms`.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn undone_add(&self, gateway_id: &str, names: &[Name], until_ms: u64) -> Result<()> {
        for name in names {
            self.connection.execute(
                "INSERT INTO undone (gateway_id, name, until_ms) VALUES (?1, ?2, ?3)
                 ON CONFLICT (gateway_id, name) DO UPDATE SET until_ms = excluded.until_ms",
                params![gateway_id, name.to_hex(), signed(until_ms)],
            )?;
        }
        Ok(())
    }

    /// The names still kept from deletion at `now_ms`; the lapsed rows go.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn undone_names(&self, gateway_id: &str, now_ms: u64) -> Result<BTreeSet<Name>> {
        self.connection.execute(
            "DELETE FROM undone WHERE gateway_id = ?1 AND until_ms <= ?2",
            params![gateway_id, signed(now_ms)],
        )?;
        let mut statement = self
            .connection
            .prepare("SELECT name FROM undone WHERE gateway_id = ?1")?;
        let names = statement
            .query_map([gateway_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        names.iter().map(|name| name_of(name)).collect()
    }

    // ── OS background bundles ──

    /// Record a bundle file written into staging for the OS background session (§6.5).
    /// Persisted immediately so a crash before rotation still leaves it tracked.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn put_os_bundle(&self, name: &Name, path: &str) -> Result<()> {
        self.connection.execute(
            "INSERT INTO os_bundle (name, path) VALUES (?1, ?2)
             ON CONFLICT (name) DO UPDATE SET path = excluded.path",
            params![name.to_hex(), path],
        )?;
        Ok(())
    }

    /// Every persisted OS bundle file, by name.
    ///
    /// # Errors
    /// SQLite's refusal, or a row that will not read back.
    pub fn os_bundles(&self) -> Result<Vec<(Name, PathBuf)>> {
        let mut statement = self
            .connection
            .prepare("SELECT name, path FROM os_bundle ORDER BY name")?;
        let rows = statement
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(name, path)| Ok((name_of(&name)?, PathBuf::from(path))))
            .collect()
    }

    /// Replace the persisted set of OS bundle files with `current` and return the paths from
    /// the previous set that are no longer in `current`, so the caller can unlink them without
    /// ever deleting a file still referenced by `current`.
    ///
    /// # Errors
    /// SQLite's refusal.
    pub fn rotate_os_bundles(&self, current: &[(Name, PathBuf)]) -> Result<Vec<PathBuf>> {
        let transaction = self.connection.unchecked_transaction()?;
        let previous: Vec<PathBuf> = {
            let mut statement = transaction.prepare("SELECT path FROM os_bundle ORDER BY name")?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows.into_iter().map(PathBuf::from).collect()
        };
        transaction.execute("DELETE FROM os_bundle", [])?;
        for (name, path) in current {
            transaction.execute(
                "INSERT INTO os_bundle (name, path) VALUES (?1, ?2)
                 ON CONFLICT (name) DO UPDATE SET path = excluded.path",
                params![name.to_hex(), path.to_string_lossy().as_ref()],
            )?;
        }
        transaction.commit()?;
        let keep: BTreeSet<&Path> = current.iter().map(|(_, path)| path.as_path()).collect();
        let mut seen: BTreeSet<PathBuf> = BTreeSet::new();
        let mut gone = Vec::new();
        for path in previous {
            if !keep.contains(path.as_path()) && seen.insert(path.clone()) {
                gone.push(path);
            }
        }
        Ok(gone)
    }
}

impl NodeSource for DeviceState {
    fn plaintext(&self, name: &Name) -> Result<Option<Vec<u8>>> {
        self.get_node(name)
    }
}
