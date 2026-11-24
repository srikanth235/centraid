//! One vault with a content store, a device state and a staging area beside it, for the backup
//! tests (#1209). Each test binary compiles this whole module.
#![allow(dead_code)]

use centraid_media::sealed::{BackupKeys, Name, PlaintextHash};
use centraid_vault::Vault;
use centraid_vault::backup::directory::Directory;
use centraid_vault::backup::engine::{Env, Policy};
use centraid_vault::backup::snapshot::{self, Options, Taken};
use centraid_vault::backup::staging::Staging;
use centraid_vault::backup::state::{DeviceState, Gateway};
use centraid_vault::backup::store::{MemoryStore, Store as _};

#[path = "../common/mod.rs"]
pub mod common;

pub struct Rig {
    pub scratch: common::Scratch,
    pub state: DeviceState,
    pub staging: Staging,
    pub keys: BackupKeys,
    pub directory: Directory,
}

pub const T0: u64 = 1_800_000_000_000;

impl Rig {
    pub fn new(seed: &str) -> Self {
        let scratch = common::Scratch::founded_with_blobs(seed).expect("a vault");
        let state = DeviceState::open_beside(scratch.vault.path()).expect("a device state");
        let staging =
            Staging::open(scratch.join("vault.staging"), 512 * 1024 * 1024).expect("staging");
        Self {
            scratch,
            state,
            staging,
            keys: BackupKeys::from_root(&[0x42; 32]),
            directory: Directory::new(Vec::new()).expect("a directory"),
        }
    }

    pub fn vault(&self) -> &Vault {
        &self.scratch.vault
    }

    pub fn snapshot(&self, now_ms: u64) -> Taken {
        self.snapshot_with(Options::at(now_ms))
    }

    pub fn snapshot_with(&self, options: Options<'_>) -> Taken {
        snapshot::take(
            self.vault(),
            &self.keys,
            &self.state,
            &self.staging,
            &self.directory,
            options,
        )
        .expect("a snapshot is taken")
    }

    pub fn pair(&self, store: &MemoryStore) {
        self.state
            .add_gateway(&Gateway::paired(
                store.gateway_id().to_owned(),
                vec!["192.168.1.20:7443".to_owned()],
                vec![0x30],
                format!("gateway {}", store.gateway_id()),
                store.epoch(),
                T0,
            ))
            .expect("pairs");
    }

    pub fn env(&self, now_ms: u64) -> Env<'_> {
        Env::new(
            self.vault(),
            &self.keys,
            &self.state,
            &self.staging,
            Policy::WIFI,
            now_ms,
        )
    }

    /// A claim on bytes the content store holds: an original.
    pub fn add_original(&self, bytes: &[u8]) -> PlaintextHash {
        let id = self
            .vault()
            .blobs()
            .expect("a content store")
            .put(bytes)
            .expect("stores");
        self.vault()
            .commit(|tx| {
                tx.connection().execute(
                    "INSERT INTO blob (hash, size) VALUES (?1, ?2)",
                    rusqlite::params![id, bytes.len() as i64],
                )?;
                Ok(())
            })
            .expect("a claim");
        PlaintextHash::from_hex(&id).expect("a hash")
    }

    /// A thumbnail of `of`, made `created_at`.
    pub fn add_thumbnail(
        &self,
        of: &PlaintextHash,
        bytes: &[u8],
        created_at: &str,
    ) -> PlaintextHash {
        let id = self
            .vault()
            .blobs()
            .expect("a content store")
            .put(bytes)
            .expect("stores");
        self.vault()
            .commit(|tx| {
                tx.connection().execute(
                    "INSERT INTO blob (hash, size) VALUES (?1, ?2)",
                    rusqlite::params![id, bytes.len() as i64],
                )?;
                tx.connection().execute(
                    "INSERT INTO derivative (blob, variant, out, media_type, created_at)
                     VALUES (?1, 'thumb', ?2, 'image/jpeg', ?3)",
                    rusqlite::params![of.to_hex(), id, created_at],
                )?;
                Ok(())
            })
            .expect("a derivative");
        PlaintextHash::from_hex(&id).expect("a hash")
    }

    /// The phone is killed and its device state and staging area are gone: a re-pair and a
    /// re-ask. The vault, the keys and the gateways are what is left.
    pub fn lose_state(&mut self, gateways: &[&MemoryStore]) {
        let path = DeviceState::path_for(self.vault().path());
        let stand_in =
            DeviceState::open(self.scratch.join("stand-in.state.db")).expect("a stand-in");
        drop(std::mem::replace(&mut self.state, stand_in));
        for suffix in ["", "-wal", "-shm"] {
            let mut file = path.clone().into_os_string();
            file.push(suffix);
            let _ = std::fs::remove_file(file);
        }
        self.state = DeviceState::open_beside(self.vault().path()).expect("a fresh state");
        let staging = self.scratch.join("vault.staging");
        let _ = std::fs::remove_dir_all(&staging);
        self.staging = Staging::open(staging, 512 * 1024 * 1024).expect("staging");
        for store in gateways {
            self.pair(store);
        }
    }

    /// Grow the vault so it holds many ranges.
    pub fn grow(&self, rounds: usize, tag: &str) {
        for round in 0..rounds {
            common::insert_note(self.vault(), &format!("{tag} {round} {}", "x".repeat(900)))
                .expect("commits");
        }
    }

    /// A second connection to the vault file, as another process would hold, that never
    /// checkpoints on its own.
    pub fn raw(&self) -> rusqlite::Connection {
        let connection = rusqlite::Connection::open(self.vault().path()).expect("opens");
        connection
            .pragma_update(None, "wal_autocheckpoint", 0)
            .expect("no autocheckpoint");
        connection
    }
}

pub fn name(seed: u8) -> Name {
    Name::from_hex(&format!("{seed:02x}").repeat(32)).expect("a name")
}
