//! THE NOTIFICATION SERVICE (app-plane §9): one scheduler in the core over the vault's alert
//! index, and the replay of what a notification's buttons did while the app was away. A shell
//! applies the set it is handed, tells the core what the operating system did, and sends each
//! press from its outbox; it decides nothing.

pub mod desired;
pub mod outbox;
pub mod scheduler;

pub use desired::{Desired, Extra, Inputs, Words, categories, category_of, id_of};
pub use outbox::{DeviceLedger, Ledger, MemoryLedger, Ran, Runner, replay};
pub use scheduler::{Offer, Scheduler, watches};

pub mod service;
pub use service::Service;
