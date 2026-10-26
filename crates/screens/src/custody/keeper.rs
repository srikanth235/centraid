//! THE SHELF, as enrollment needs it (#1135, lane H2): founding a vault, holding
//! what a restore laid down, re-keying, and what this phone holds.
//!
//! The multi-vault shelf is not this module's: enrollment is coded against this
//! trait, the real shelf implements it, and the tests use [`FakeKeeper`]. The
//! methods are synchronous: a screen calls them from `update`, and a shelf that
//! must write a secret before or after returns the writes it needs the shell to
//! perform ([`Effected::writes`]); the screen sends them in one batch and then
//! reloads its cache, so the next decision reads what the platform stored.

use std::sync::{Arc, Mutex, RwLock};

use centraid_api_proto::core_v1 as wire;

/// A result and the secret writes the shell must perform because of it.
#[derive(Debug)]
pub struct Effected<T> {
    pub value: T,
    pub writes: Vec<wire::SecretOp>,
}

impl<T> Effected<T> {
    #[must_use]
    pub fn new(value: T) -> Self {
        Self {
            value,
            writes: Vec::new(),
        }
    }
}

/// Why a vault was not founded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FoundRefusal {
    /// No core could be opened to found into.
    NoCore,
    /// The core refused the found.
    NotFounded,
    /// The file already holds a vault.
    AlreadyHeld,
}

/// What founding came to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Found {
    /// The vault exists and is in front. The name comes out of the vault.
    Made(String),
    Refused(FoundRefusal),
    /// The session is not open yet: try again in a moment.
    NoSession,
}

/// One vault a restore laid down: where, the index it was found at, and the
/// entry it was restored from when it is on its own words (R-1047-E18).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Restored {
    pub path: String,
    pub index: u32,
    pub own: Option<String>,
}

/// The vault in front.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Foreground {
    pub vault_id: String,
    pub name: String,
}

/// The shelf's half of enrollment.
pub trait Keeper: Send + Sync {
    /// Found a vault: on the member's seed, or (`own` set) on that entry's
    /// (R-1047-E18), named `name`.
    fn found(&self, own: Option<&str>, name: &str) -> Effected<Found>;

    /// Hold what a restore laid down, keyed; answers how many were added. The
    /// seed is already stored.
    fn adopt_restored(&self, restored: &[Restored]) -> Effected<usize>;

    /// Reopen this phone's vaults with the words handed back; answers how many
    /// are keyed now.
    fn rekey(&self) -> usize;

    /// How many vaults have a recorded index.
    fn indexed_holdings(&self) -> usize;

    /// Whether any vault is on this phone.
    fn holds_a_vault(&self) -> bool;

    /// The vault in front, if any.
    fn foreground(&self) -> Option<Foreground>;
}

/// Where the screens find the keeper. Cheap to clone: every clone is the same
/// slot, so the shelf is installed once and every custody screen sees it. Empty
/// until installed, and a screen then says the session is still opening.
#[derive(Clone, Default)]
pub struct KeeperSlot {
    keeper: Arc<RwLock<Option<Arc<dyn Keeper>>>>,
}

impl KeeperSlot {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// A slot already holding `keeper`.
    #[must_use]
    pub fn with(keeper: Arc<dyn Keeper>) -> Self {
        let slot = Self::new();
        slot.install(keeper);
        slot
    }

    pub fn install(&self, keeper: Arc<dyn Keeper>) {
        *self
            .keeper
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(keeper);
    }

    #[must_use]
    pub fn get(&self) -> Option<Arc<dyn Keeper>> {
        self.keeper
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

/// What a slot with nothing in it answers: no session, no vault, nothing keyed.
pub(crate) struct Absent;

impl Keeper for Absent {
    fn found(&self, _own: Option<&str>, _name: &str) -> Effected<Found> {
        Effected::new(Found::NoSession)
    }
    fn adopt_restored(&self, _restored: &[Restored]) -> Effected<usize> {
        Effected::new(0)
    }
    fn rekey(&self) -> usize {
        0
    }
    fn indexed_holdings(&self) -> usize {
        0
    }
    fn holds_a_vault(&self) -> bool {
        false
    }
    fn foreground(&self) -> Option<Foreground> {
        None
    }
}

/// A recording keeper for tests: what it was asked, in order, and what it
/// answers.
#[derive(Default)]
pub struct FakeKeeper {
    inner: Mutex<FakeState>,
    /// The cache the screens share, when the test wants the log to say whether
    /// a seed was stored at the moment of each call.
    secrets: Option<super::secrets::VaultSecrets>,
}

#[derive(Default)]
struct FakeState {
    log: Vec<String>,
    indexed: usize,
    holds: bool,
    found: Option<Found>,
    foreground: Option<Foreground>,
}

impl FakeKeeper {
    #[must_use]
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// A fake whose log says `seed=true|false` of `secrets` at each call.
    #[must_use]
    pub fn watching(secrets: &super::secrets::VaultSecrets) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::default(),
            secrets: Some(secrets.clone()),
        })
    }

    fn seen(&self) -> String {
        self.secrets.as_ref().map_or_else(String::new, |secrets| {
            format!(" seed={}", secrets.seed().is_some())
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, FakeState> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// How many vaults the shelf says have an index.
    pub fn set_indexed(&self, indexed: usize) {
        self.lock().indexed = indexed;
    }

    pub fn set_holds(&self, holds: bool) {
        self.lock().holds = holds;
    }

    /// What the next founds answer (default: a vault named as asked).
    pub fn set_found(&self, found: Option<Found>) {
        self.lock().found = found;
    }

    pub fn set_foreground(&self, vault_id: &str, name: &str) {
        self.lock().foreground = Some(Foreground {
            vault_id: vault_id.to_owned(),
            name: name.to_owned(),
        });
    }

    /// Every call so far, as a line.
    #[must_use]
    pub fn log(&self) -> Vec<String> {
        self.lock().log.clone()
    }
}

impl Keeper for FakeKeeper {
    fn found(&self, own: Option<&str>, name: &str) -> Effected<Found> {
        let mut state = self.lock();
        let seen = self.seen();
        state
            .log
            .push(format!("found own={own:?} name={name}{seen}"));
        let found = state
            .found
            .clone()
            .unwrap_or_else(|| Found::Made(name.to_owned()));
        if matches!(found, Found::Made(_)) {
            state.holds = true;
        }
        Effected::new(found)
    }

    fn adopt_restored(&self, restored: &[Restored]) -> Effected<usize> {
        let mut state = self.lock();
        let at: Vec<String> = restored
            .iter()
            .map(|vault| match &vault.own {
                Some(own) => format!("{}@{own}", vault.index),
                None => vault.index.to_string(),
            })
            .collect();
        let seen = self.seen();
        state.log.push(format!("adopt [{}]{seen}", at.join(", ")));
        if !restored.is_empty() {
            state.holds = true;
        }
        Effected::new(restored.len())
    }

    fn rekey(&self) -> usize {
        let seen = self.seen();
        let mut state = self.lock();
        state.log.push(format!("rekey{seen}"));
        state.indexed
    }

    fn indexed_holdings(&self) -> usize {
        self.lock().indexed
    }

    fn holds_a_vault(&self) -> bool {
        self.lock().holds
    }

    fn foreground(&self) -> Option<Foreground> {
        self.lock().foreground.clone()
    }
}
