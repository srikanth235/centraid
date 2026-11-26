//! THE DEVICE STORE (app-plane §10, D1–D12): what the core keeps outside the vault, and the
//! registry that lists every key a shell or the core writes.

pub mod draft;
pub mod inbox;
pub mod open_url;
pub mod registry;
pub mod store;

pub use draft::{Draft, DraftError, Drafts};
pub use registry::{DEVICE_KEYS, KeyDecl, KeyError, Owner, Place, Shape};
pub use store::{Checked, DeviceStore, DirStore, MemoryStore};
