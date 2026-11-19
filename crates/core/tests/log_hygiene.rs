//! NO VAULT CONTENT IN THE LOG (#1202, S10).
//!
//! A representative run of the core is driven against a real gateway with seeded secrets in every
//! place a member keeps one: a note's title and body, a Locker item's password (offered in the
//! clear, which the Locker refuses), and the recovery words the vault's keys come from. Every
//! `tracing` line, at TRACE, from every thread, is captured, and none may hold any of them.
//!
//! The run covers the paths that log: pairing, a pass, a gateway that goes away mid-pass, a
//! refused command, a command that errors, forgetting the gateway. The capture is a process-wide
//! default subscriber (the one place a callsite's cached interest cannot hide a line), so this
//! file holds one test.

mod common;

use std::io::Write;
use std::sync::{Arc, Mutex};

use serde_json::json;

use common::*;

#[derive(Clone, Default)]
struct Kept(Arc<Mutex<Vec<u8>>>);

impl Write for Kept {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.0
            .lock()
            .expect("the log lock")
            .extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl tracing_subscriber::fmt::MakeWriter<'_> for Kept {
    type Writer = Self;

    fn make_writer(&self) -> Self::Writer {
        self.clone()
    }
}

const TITLE: &str = "SECRET-TITLE-hk4w9q-visa-pin";
const BODY: &str = "SECRET-BODY-r2m8zt-the-safe-is-under-the-stairs";
const PASSWORD: &str = "SECRET-PASSWORD-v6n3xj-hunter2";
const LABEL: &str = "SECRET-LABEL-p5c7ld-bank";

#[test]
fn a_driven_run_writes_no_vault_content_to_the_log() {
    let kept = Kept::default();
    tracing::subscriber::set_global_default(
        tracing_subscriber::fmt()
            .with_writer(kept.clone())
            .with_max_level(tracing::Level::TRACE)
            .with_ansi(false)
            .finish(),
    )
    .expect("this binary installs one subscriber");
    tracing::callsite::rebuild_interest_cache();

    let gateway = gateway();
    let dir = tempfile::tempdir().expect("a directory");
    let phone = phone(dir.path());
    let id = pair(&phone, &gateway)
        .destination
        .expect("a destination")
        .gateway_id;
    drain(&phone, at_home());

    // Secrets in a note, and a photograph whose bytes are named for one.
    command(
        &phone,
        "note.create",
        &json!({ "title": TITLE, "body": BODY, "format": "plain" }),
        "note:secret",
    );
    for index in 0..3 {
        let bytes = bytes_of(&format!("{LABEL} {index}"), 1 << 20);
        let staged = stage(&phone, owned("image/heic", &bytes), &bytes);
        add_asset(&phone, &staged, "photo");
    }
    // A gateway that goes away mid-pass: the warn and debug lines of the failure paths.
    gateway.cable().cut_after(1 << 19);
    drain(&phone, quietly());
    gateway.cable().mend();
    drain(&phone, quietly());

    // A refused command and an errored one, each carrying the secrets in its input.
    for (name, input) in [
        (
            "locker.add_item",
            json!({ "item_id": "lk-x", "type": "login", "title": TITLE, "username": LABEL,
                    "password": PASSWORD, "body": BODY }),
        ),
        (
            "note.create",
            json!({ "title": TITLE, "body": BODY, "format": PASSWORD }),
        ),
        (
            "not.a.command",
            json!({ "title": TITLE, "body": BODY, "password": PASSWORD }),
        ),
    ] {
        let _ = phone.command(name, &input, &format!("refused:{name}"));
    }

    forget(&phone, &id);
    drop(phone);

    let log = String::from_utf8_lossy(&kept.0.lock().expect("the log lock")).into_owned();
    assert!(
        log.lines().count() > 3,
        "the capture saw the run's own lines, or this proves nothing: {log}"
    );
    for secret in [TITLE, BODY, PASSWORD, LABEL, WORDS, "abandon abandon"] {
        assert!(!log.contains(secret), "the log holds `{secret}`:\n{log}");
    }
}
