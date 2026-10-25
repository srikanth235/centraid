//! Support for the shelf's tests: a phone is a scratch directory, a fake shell's
//! two secret stores and the door a shell opens over that directory. Vaults are
//! real files laid down by a real core.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;

use centraid_api_proto::core_v1 as wire;
use centraid_core::{Core, CoreConfig};
use centraid_screens::custody::secrets::VaultSecrets;
use centraid_screens::people::{self, routes};
use centraid_screens::testing::{Driver, FakeShell};
use centraid_screens::vault::{self, Shelf};
use centraid_screens::{Registry, Runtime};

/// The public BIP-39 all-`abandon` seed, the demo's. Never anybody's.
pub const SEED: &str = "408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf70\
5489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840";

/// A second seed, for a vault kept on its own words.
pub fn own_seed() -> String {
    "cd".repeat(64)
}

/// A scratch directory for a phone's vaults, removed when it goes out of scope:
/// a vault is a megabyte and a suite lays down dozens.
pub struct Scratch(PathBuf);

impl std::ops::Deref for Scratch {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for Scratch {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A scratch directory for a phone's vaults.
pub fn scratch() -> Scratch {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    Scratch(dir)
}

/// A vault founded in `<dir>/<stem>/vault.db` by a real core, closed whole.
/// Answers the vault's id.
pub fn lay_down(dir: &Path, stem: &str, name: &str) -> String {
    let home = dir.join(stem);
    std::fs::create_dir_all(&home).expect("a vault directory");
    let handle = Core::open(CoreConfig::new(home.join(vault::files::VAULT_FILE))).expect("opens");
    let found = handle
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Found(wire::FoundRequest {
                display_name: name.to_owned(),
                owner_name: "Me".to_owned(),
                content: wire::FoundContent::Unspecified as i32,
            })),
        })
        .expect("the vault founds");
    let Some(wire::response::Kind::Found(found)) = found.kind else {
        panic!("a found answered {:?}", found.kind);
    };
    handle.close();
    handle.close_file().expect("the file closes whole");
    found.vault_id
}

/// A phone: the door a shell opens over a directory, the shelf behind it, the
/// secret stores the shell keeps, and the cache the screens share.
pub struct Phone {
    pub driver: Driver,
    pub shelf: Arc<Shelf>,
    pub secrets: VaultSecrets,
    pub shell: FakeShell,
    pub dir: PathBuf,
    /// The directory of a phone that made its own, removed after the rest of
    /// the phone (fields drop in order).
    _scratch: Option<Scratch>,
}

/// The tab People's home is rooted in, over the real People screens: a screen
/// that reads the vault in front, to see a switch follow.
pub fn runtime(shelf: &Arc<Shelf>, secrets: &VaultSecrets) -> Runtime {
    Runtime::new(
        people::registry().merge(vault::registry(shelf, secrets)),
        vec![(
            people::TAB.to_owned(),
            routes::home(wire::PeopleDestination::People),
        )],
    )
    .with_services(vault::services())
}

impl Phone {
    /// A phone over a fresh directory.
    pub fn new() -> Self {
        let dir = scratch();
        let mut phone = Self::on(&dir, None);
        phone._scratch = Some(dir);
        phone
    }

    /// A phone over `dir`, which may already hold vaults. Nothing is launched.
    pub fn on(dir: &Path, dev_seed: Option<&str>) -> Self {
        let secrets = VaultSecrets::new();
        let shelf = Shelf::new(&secrets);
        let driver = Driver::shelved(runtime(&shelf, &secrets), &shelf, dir, dev_seed);
        Self {
            driver,
            shelf,
            secrets,
            shell: FakeShell::default(),
            dir: dir.to_path_buf(),
            _scratch: None,
        }
    }

    /// A phone over `dir` whose runtime is `build`'s: the screens a test wants
    /// beside the shelf's own service.
    pub fn running(dir: &Path, build: impl FnOnce(&Arc<Shelf>, &VaultSecrets) -> Runtime) -> Self {
        let secrets = VaultSecrets::new();
        let shelf = Shelf::new(&secrets);
        let driver = Driver::shelved(build(&shelf, &secrets), &shelf, dir, None);
        Self {
            driver,
            shelf,
            secrets,
            shell: FakeShell::default(),
            dir: dir.to_path_buf(),
            _scratch: None,
        }
    }

    /// A phone whose cores are made ready by `prepare`, which can sabotage them
    /// to give the shelf a refusal it did not cause.
    pub fn prepared(dir: &Path, prepare: centraid_screens::vault::Prepare) -> Self {
        let secrets = VaultSecrets::new();
        let shelf = Shelf::new(&secrets);
        let driver = Driver::shelved_with(runtime(&shelf, &secrets), &shelf, dir, None, prepare);
        Self {
            driver,
            shelf,
            secrets,
            shell: FakeShell::default(),
            dir: dir.to_path_buf(),
            _scratch: None,
        }
    }

    /// The member's seed is on this phone (the synchronised store holds it).
    pub fn keep_seed(&mut self) {
        self.shell
            .synced
            .insert("recovery-seed".to_owned(), SEED.to_owned());
    }

    /// The device store holds `vault_id` at `index`, and the mark is past it.
    pub fn record_index(&mut self, vault_id: &str, index: u32) {
        self.shell
            .device
            .insert(format!("vault-index.{vault_id}"), index.to_string());
        let mark = self
            .shell
            .device
            .get("vault-index-high-water")
            .and_then(|raw| raw.parse::<u32>().ok())
            .map_or(index, |mark| mark.max(index));
        self.shell
            .device
            .insert("vault-index-high-water".to_owned(), mark.to_string());
    }

    /// Launch: the first call starts the shelf's service and the fake shell
    /// answers its secret reads until it has opened every vault.
    pub fn launch(&mut self) {
        self.driver.start();
        self.driver.serve(&mut self.shell);
    }

    /// Perform `writes` as a shell would and fold the answers into the cache,
    /// as the screen that sent them does.
    pub fn apply(&mut self, writes: &[wire::SecretOp]) {
        let answers = self
            .shell
            .batch(&wire::SecretBatch {
                ops: writes.to_vec(),
            })
            .answers;
        self.secrets.absorb(writes, &answers);
    }

    /// `shell.holdings`, through the door a shell uses.
    pub fn holdings(&self) -> wire::Holdings {
        let answered = self
            .driver
            .handle
            .call(&wire::Request {
                kind: Some(wire::request::Kind::Load(Box::new(wire::LoadRequest {
                    app: "shell".to_owned(),
                    query: "holdings".to_owned(),
                    ..Default::default()
                }))),
            })
            .expect("the holdings read answers");
        let Some(wire::response::Kind::Load(loaded)) = answered.kind else {
            panic!("a load answered {:?}", answered.kind);
        };
        assert_eq!(
            loaded.tables,
            ["shelf"],
            "the read is announced under `shelf`"
        );
        match loaded.answer.and_then(|a| a.answer) {
            Some(wire::app_query_response::Answer::Holdings(holdings)) => holdings,
            other => panic!("holdings answered {other:?}"),
        }
    }

    /// The held vault `vault_id`.
    pub fn held(&self, vault_id: &str) -> wire::HeldVault {
        self.holdings()
            .vaults
            .into_iter()
            .find(|vault| vault.vault_id == vault_id)
            .unwrap_or_else(|| panic!("no vault {vault_id} is held"))
    }

    /// The ids held, in the order the roster draws them.
    pub fn ids(&self) -> Vec<String> {
        self.holdings()
            .vaults
            .into_iter()
            .map(|v| v.vault_id)
            .collect()
    }

    /// The `vault-*` directories on disk.
    pub fn homes(&self) -> Vec<PathBuf> {
        vault::files::homes(&self.dir)
    }
}

/// Registry for tests that need none of the apps.
pub fn bare(shelf: &Arc<Shelf>, secrets: &VaultSecrets) -> Registry {
    vault::registry(shelf, secrets)
}
