//! THE VAULTS A PHONE HOLDS, AS THE CORE SEES THEM (#1135, lane H2).
//!
//! A phone holds several vaults, each a file opened by its own [`Handle`]. The
//! shell holds ONE handle, the front: a core opened over a directory
//! ([`crate::config::ShelfConfig`]) that holds no vault of its own. The shelf
//! that opens, rests, wakes and freezes the others lives in `crates/screens`
//! (it needs the phone's secrets to key each open); this module is the trait it
//! implements and the core calls, the way [`crate::screens::ScreenHost`] is the
//! runtime's.
//!
//! ## What the front does with it
//!
//! * **A request that is about a vault goes to the vault in front.** Every
//!   `call` that is not the front's own business (the screen runtime, the
//!   words, a restore, the handshake) is answered by [`Vaults::foreground_core`]'s
//!   core, and so is `load`, `act` and the Locker session the screens reach
//!   through [`crate::screens::ScreenCtx`]. A shell written against one core
//!   works against the shelf without knowing it: switching the vault in front
//!   is the shelf's, never the shell's.
//! * **The front's event queue carries the foreground vault's events**, which
//!   the shelf forwards; `next_event` on the front is the only event door.
//! * **`shell.holdings`** is the front's own read ([`Vaults::holdings`]).

use centraid_api_proto::core_v1 as wire;

use crate::handle::Handle;

/// The table name a change to the shelf is announced under: a screen that read
/// `shell.holdings` hears `DataChanged` for it when a vault is added, forgotten,
/// renamed, frozen, rested or brought to the front.
pub const SHELF_TABLE: &str = "shelf";

/// One vault the phone holds, as a pass needs it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldVault {
    pub vault_id: String,
    /// A pass may run on it: its core is open and the vault has not moved.
    /// Writes to a moved vault are refused by the gateway, so a pass would
    /// only be refused.
    pub drainable: bool,
}

/// The shelf, as the core calls it. Every method is quick and none waits on a
/// gateway; a door that does is run by the caller on a worker thread with the
/// [`Handle`] [`Self::core_of`] answered.
pub trait Vaults: Send + Sync {
    /// The id of the vault in front, if the phone holds any.
    fn foreground_id(&self) -> Option<String>;

    /// The core of the vault in front. A resting foreground is woken (the
    /// foreground rests only by being switched away from).
    fn foreground_core(&self) -> Option<Handle>;

    /// Every held vault, the one in front first.
    fn held(&self) -> Vec<HeldVault>;

    /// The core of `vault_id`, waking it if it rests: how a pass reaches a
    /// vault that is not in front. `None` for an id nothing holds, or a file
    /// that will not reopen.
    fn core_of(&self, vault_id: &str) -> Option<Handle>;

    /// Every core that is open now, for the rule that applies to all of them
    /// (the Locker relocks when the app leaves the foreground).
    fn awake(&self) -> Vec<Handle>;

    /// What `shell.holdings` answers.
    fn holdings(&self) -> wire::Holdings;

    /// Put `vault_id` in front, waking it if it rests. `false` when nothing
    /// holds that id or its file will not reopen, in which case the shelf
    /// stays where it was.
    fn bring_to_front(&self, vault_id: &str) -> bool;

    /// The vault moved to another phone: writes are refused and the date and
    /// the count of what no gateway acknowledged are shown. Deletes nothing,
    /// closes nothing, and there is no way back.
    fn freeze(&self, vault_id: &str, at: &str, unacked: u64);

    /// Close every core: the front is closing.
    fn close_all(&self);
}
