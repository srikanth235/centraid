//! `Handle` CROSSES THREADS, and this file is why anyone can rely on it.
//!
//! A comment in `crates/centraid/src/run.rs` asserted the opposite — that the
//! vault's boxed `Clock` and `Ids` were not `Send` — and on the strength of it
//! the gateway's seat lane was left unbuilt for two waves: nothing vault-shaped
//! could go into a `tokio::spawn`, so an admitted seat was logged and dropped.
//! The claim was wrong. Both traits are declared `Send + Sync`.
//!
//! A prose claim about auto traits is a claim that rots silently, because
//! adding one `Rc` to a private field changes the answer and no reader of the
//! comment is told. So it is asserted where the compiler checks it.

#[test]
fn a_vault_and_a_handle_can_be_moved_and_shared_across_threads() {
    const fn assert_send<T: Send>() {}
    const fn assert_sync<T: Sync>() {}

    // The vault itself moves — a dedicated thread can own one.
    assert_send::<centraid_vault::file::Vault>();
    // And the handle both moves AND is shared, which is the stronger claim:
    // `Arc<Handle>` in several tasks at once is what a gateway serving more
    // than one seat is made of.
    assert_send::<centraid_core::Handle>();
    assert_sync::<centraid_core::Handle>();
}
