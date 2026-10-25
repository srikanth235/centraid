//! The screen runtime (#1135, lane C2): every decision a person sees is made in
//! Rust. Screen state, finished strings, counts, navigation and timers live
//! here; SwiftUI and Compose draw `ViewState`, send `ScreenEvent`s and perform
//! `Effect`s (`screens.proto`). `docs/screens.md` is
//! the contract and the porting recipe.

pub mod agenda;
pub mod backup;
pub mod catalog;
pub mod chat;
pub mod custody;
pub mod docs;
pub mod field;
pub mod health;
pub mod imports;
pub mod kit;
pub mod locker;
pub mod money;
pub mod notes;
pub mod pairing;
pub mod passes;
pub mod people;
pub mod photos;
pub mod proof;
pub mod registry;
pub mod runtime;
pub mod screen;
pub mod shell;
pub mod strings;
pub mod testing;
pub mod vault;

pub use registry::Registry;
pub use runtime::Runtime;
pub use screen::{Ctx, Environment, Screen};

/// The runtime the shells attach: every app's screens and the shell's own, and
/// one tab, `home`, rooted at Home (`shell`). An app opens as a page pushed on
/// that tab, so back returns to Home; the chat and the backup add their own tabs
/// beside it. The band follows the tabs that exist.
#[must_use]
pub fn standard() -> Runtime {
    assemble().0
}

/// [`standard`], and the shelf of vaults its screens and the core share
/// (`vault`): the shell's core is bound to it by [`attach`].
#[must_use]
pub fn assemble() -> (Runtime, std::sync::Arc<vault::Shelf>) {
    // The vault plumbing's one cache of what the shell keeps secret: custody,
    // pairing, the backup screen and the pass service all read the same one.
    let secrets = custody::secrets::VaultSecrets::new();
    let shelf = vault::Shelf::new(&secrets);
    // The words screens found, restore and re-key through the shelf, and the
    // pass service asks it which vaults are held and for one's own core.
    let keeper = custody::keeper::KeeperSlot::with(shelf.clone());
    secrets.conductor().use_holdings(shelf.clone());
    let runtime = Runtime::new(
        Registry::default()
            .with(proof::NAME, proof::build)
            .merge(shell::registry())
            .merge(agenda::registry())
            .merge(locker::registry())
            .merge(money::registry())
            .merge(docs::registry())
            .merge(health::registry())
            .merge(notes::registry())
            .merge(people::registry())
            .merge(photos::registry())
            .merge(imports::registry())
            .merge(chat::registry())
            .merge(custody::registry_with(&secrets, &keeper))
            .merge(pairing::registry(&secrets))
            .merge(backup::registry(&secrets))
            .merge(passes::registry(&secrets))
            .merge(vault::registry(&shelf, &secrets)),
        vec![
            (shell::TAB.to_owned(), shell::routes::home()),
            (chat::TAB.to_owned(), chat::routes::home()),
            (shell::band::BACKUP.to_owned(), backup::routes::home()),
        ],
    )
    .with_band(shell::band::view)
    .with_services(
        [
            passes::services(),
            custody::services(),
            vault::services(),
            imports::roots()
                .into_iter()
                .map(|(_, route)| route)
                .collect(),
        ]
        .concat(),
    );
    (runtime, shelf)
}

/// Attach [`standard`] to a core. `centraid_open` calls this.
pub fn attach(handle: &centraid_core::Handle) {
    attach_with(handle, std::sync::Arc::new(vault::default_prepare));
}

/// [`attach`], with how each core the shelf opens is made ready (the byte
/// store, an engine the core crate cannot link). A core opened as the door to a
/// shelf of vaults is bound to the shelf; any other is a single-vault core.
pub fn attach_with(handle: &centraid_core::Handle, prepare: vault::Prepare) {
    let (runtime, shelf) = assemble();
    handle.attach_screens(std::sync::Arc::new(runtime));
    shelf.bind(handle, prepare);
}
