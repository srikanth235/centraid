//! THE DOOR THE ROOM RUNTIME STANDS ON (app-plane §1): the core hands a room host its one write
//! path, the time, and a way to show the shell a room it did not ask for. `crates/screens`
//! depends on this crate, so the runtime attaches itself through [`RoomHost`]; nothing here
//! knows what a room is beyond the wire.

use centraid_api_proto::core_v1 as wire;

use crate::error::Result;

pub trait RoomCtx {
    /// The mounted vault's clock, in milliseconds.
    fn now_ms(&self) -> i64;

    /// Run one vault command under `invoke_key`, through the one write path.
    ///
    /// # Errors
    /// The vault's refusal, or a failure that is not one.
    fn command(
        &self,
        name: &str,
        input: &serde_json::Value,
        invoke_key: &str,
    ) -> Result<centraid_vault::commands::CommandOutcome>;

    /// One request of the core's own (the backup status, a drain), answered inline.
    ///
    /// # Errors
    /// The core's refusal.
    fn call(&self, request: &wire::Request) -> Result<wire::Response>;

    /// The device store.
    ///
    /// # Errors
    /// The store cannot be opened.
    fn device(&self) -> Result<std::sync::Arc<crate::device::Checked<crate::device::DirStore>>>;

    /// What a draft is kept under for the vault in front.
    fn vault_id(&self) -> String;

    /// A read-only door onto the vault file, guarded by the SQLite authorizer.
    ///
    /// # Errors
    /// The vault file cannot be opened for reading.
    fn reader(&self) -> Result<centraid_domain::read::Reader>;

    /// Show the shell a room.
    fn push(&self, shown: wire::RoomShown);
}

pub trait RoomHost: Send + Sync {
    /// Answer one request from the shell.
    ///
    /// # Errors
    /// A refusal the shell should see as a typed error.
    fn call(&self, ctx: &dyn RoomCtx, request: &wire::RoomRequest) -> Result<wire::RoomResponse>;

    /// A commit wrote these tables: rooms that read them are built again and shown.
    fn changed(&self, ctx: &dyn RoomCtx, tables: &[String]);
}
