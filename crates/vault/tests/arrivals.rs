//! The ways an item comes in from outside (#1214, S10): each shared or imported type lands with the
//! `arrived_via` its format names, and a way in that does not bring in that kind is refused by
//! the command and by the file.

mod common;

use common::world::World;
use serde_json::{Value, json};

fn world(seed: &str) -> World {
    World {
        scratch: common::Scratch::founded_with_blobs(seed).expect("a vault"),
        registry: centraid_vault::commands::Registry::with_system_commands().expect("a registry"),
    }
}

fn bytes(w: &World, seed: &str) -> String {
    let hash = centraid_vault::blob::content_digest(seed.as_bytes());
    w.ok("blob.stage", json!({ "hash": hash, "size": seed.len() }));
    hash
}

fn via(w: &World, kind: &str) -> Vec<String> {
    w.strings(
        "SELECT arrived_via || ':' || arrived_label FROM entity WHERE kind = ?1 AND arrived_via IS NOT NULL",
        &[kind],
    )
}

fn shared(via: &str, label: &str) -> Value {
    json!({ "arrived_via": via, "arrived_label": label })
}

fn with(mut input: Value, extra: Value) -> Value {
    for (key, value) in extra.as_object().expect("an object") {
        input[key] = value.clone();
    }
    input
}

#[test]
fn each_shared_type_lands_with_the_arrival_its_format_names() {
    let w = world("arrivals_share");
    w.ok(
        "document.add",
        with(
            json!({ "title": "Lease", "blob": bytes(&w, "lease"), "media_type": "application/pdf" }),
            shared("share", "lease.pdf"),
        ),
    );
    w.ok(
        "photo.add",
        with(
            json!({ "blob": bytes(&w, "photo"), "media_type": "image/jpeg" }),
            shared("share", "IMG_1.jpg"),
        ),
    );
    w.ok(
        "note.import",
        with(
            json!({ "files": [{ "path": "Idea.md", "text": "An idea." }] }),
            shared("share", "Idea.md"),
        ),
    );
    w.ok(
        "event.propose",
        with(
            json!({ "title": "Dinner", "starts": "2026-03-05T19:00", "timing": "floating" }),
            shared("ics", "invite.ics"),
        ),
    );
    w.ok(
        "person.import_vcf",
        with(
            json!({ "cards": "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Maya Rao\r\nN:Rao;Maya;;;\r\nEND:VCARD\r\n" }),
            shared("vcard", "maya.vcf"),
        ),
    );
    assert_eq!(via(&w, "document"), ["share:lease.pdf"]);
    assert_eq!(via(&w, "photo"), ["share:IMG_1.jpg"]);
    assert_eq!(via(&w, "note"), ["share:Idea.md"]);
    assert_eq!(via(&w, "event"), ["ics:invite.ics"]);
    assert_eq!(via(&w, "person"), ["vcard:maya.vcf"]);
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM origin", &[]), 0);
}

#[test]
fn a_way_in_that_does_not_bring_in_that_kind_is_refused() {
    let w = world("arrivals_refused");
    let cards = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Maya Rao\r\nN:Rao;Maya;;;\r\nEND:VCARD\r\n";
    for (command, input) in [
        (
            "person.import_vcf",
            with(json!({ "cards": cards }), shared("share", "maya.vcf")),
        ),
        (
            "document.add",
            with(
                json!({ "title": "D", "blob": bytes(&w, "d"), "media_type": "application/pdf" }),
                shared("ics", "d.ics"),
            ),
        ),
        (
            "event.propose",
            with(
                json!({ "title": "E", "starts": "2026-03-05T19:00", "timing": "floating" }),
                shared("share", "e.ics"),
            ),
        ),
        (
            "photo.add",
            with(
                json!({ "blob": bytes(&w, "p"), "media_type": "image/jpeg" }),
                shared("ics", "p.ics"),
            ),
        ),
    ] {
        let error = w
            .vault()
            .execute(
                &w.registry,
                &centraid_vault::Principal::owner("phone"),
                &centraid_vault::Command::new(command, input),
            )
            .expect_err(command);
        assert!(
            error.to_string().contains("does not bring in"),
            "{command}: {error}"
        );
    }
    let from_the_file = w.scratch.vault.commit(|tx| {
        let id = w.mint();
        tx.connection().execute(
            "INSERT INTO entity (id, kind, title, arrived_via, arrived_label, created_at, updated_at)
             VALUES (?1, 'person', 'P', 'ics', 'x', '2026-03-01T09:00:00.000Z', '2026-03-01T09:00:00.000Z')",
            [&id],
        )?;
        Ok(())
    });
    assert!(from_the_file.is_err(), "the file refuses the pair too");
}
