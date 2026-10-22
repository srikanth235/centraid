//! THE `locker` SCHEMA, END TO END, against a real founded vault — and the
//! custody it is written for: the command plane never holds `K` (#1020, wave 4
//! lane Locker; #1047, D-6).
//!
//! Three kinds of assertion live here and they are deliberately not mixed up:
//!
//! 1. **The lifecycle is v0's**, command for command: trash is reversible with
//!    a thirty-day window and a restore past it is refused, archive is *keep
//!    forever, hide from lists*, a purge takes the sidecars with it, a star is
//!    a tag, and a Locker tag lives in Locker's own scheme.
//! 2. **A secret cannot reach the vault file in the clear.** Every command that
//!    stores one refuses a plaintext value with a typed refusal, refuses a
//!    write under a key generation that is not the vault's one, and refuses a
//!    caller-minted id that is taken.
//! 3. **The reveal is receipted even though the command plane cannot perform
//!    it.** `locker.reveal_receipt` writes the row the access history reads,
//!    and it refuses to name a column that is not sealed.
//!
//! **One `Vault::open` per test**, like `media_commands.rs`, for lane X3's
//! reason: `SeededIds` restarts on reopen and the first write after a reopen
//! collides with the first write of the previous session.

mod common;

use centraid_vault::access::Principal;
use centraid_vault::clock::Clock as _;
use centraid_vault::commands::{Command, CommandStatus, Registry};

fn registry() -> Registry {
    Registry::with_system_commands().expect("the system commands register")
}

/// A base64 body long enough for `is_locker_ciphertext` — the structural
/// predicate wants at least a nonce plus a tag, so a short string is not
/// ciphertext no matter what it starts with.
fn ciphertext(seed: &str) -> String {
    use base64::Engine as _;
    let mut raw = vec![0_u8; 12 + 16 + 8];
    let span = raw.len();
    for (index, byte) in seed.bytes().enumerate() {
        raw[index % span] ^= byte;
    }
    format!(
        "lk1:{}",
        base64::engine::general_purpose::STANDARD.encode(raw)
    )
}

struct World {
    scratch: common::Scratch,
    registry: Registry,
}

impl World {
    /// A founded vault whose Locker key plane names its one generation.
    ///
    /// The `locker_key` row is written directly: it carries an **id and
    /// nothing else**, and `K` is the seed's leaf in the core's memory, never
    /// a file (#1047, D-6). A command test that needed key material would be
    /// asserting a custody these commands are written to not have.
    fn new(seed: &str, key_id: &str) -> Self {
        let scratch = common::Scratch::founded(seed).expect("a vault is founded");
        let registry = registry();
        if !key_id.is_empty() {
            scratch
                .vault
                .commit(|tx| {
                    tx.set_producer("test.fixture");
                    tx.connection().execute(
                        "INSERT INTO locker_key (key_id, created_at)
                         VALUES (?1, '2026-01-01T00:00:00.000Z')",
                        [key_id],
                    )?;
                    Ok(())
                })
                .expect("the key plane is founded");
        }
        Self { scratch, registry }
    }

    fn run(&self, name: &str, input: serde_json::Value) -> centraid_vault::CommandOutcome {
        self.scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("device-1"),
                &Command::new(name, input),
            )
            .expect("the command plane answers")
    }

    /// Run and expect success, returning the output.
    fn ok(&self, name: &str, input: serde_json::Value) -> serde_json::Value {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name} failed: {:?}",
            outcome.reason
        );
        outcome.output
    }

    /// Run and expect a refusal, returning its sentence.
    fn refused(&self, name: &str, input: serde_json::Value) -> String {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Failed,
            "{name} was expected to refuse and did not"
        );
        outcome.reason.unwrap_or_default()
    }

    fn one<T: rusqlite::types::FromSql>(&self, sql: &str, params: &[&str]) -> T {
        let values: Vec<&dyn rusqlite::ToSql> = params
            .iter()
            .map(|value| value as &dyn rusqlite::ToSql)
            .collect();
        self.scratch
            .vault
            .read(|connection| Ok(connection.query_row(sql, values.as_slice(), |row| row.get(0))?))
            .expect("the read answers")
    }

    /// One login, sealed, through the real command path, and tagged `money`.
    fn login(&self, item_id: &str, key_id: &str) -> serde_json::Value {
        self.ok(
            "locker.add_item",
            serde_json::json!({
                "item_id": item_id,
                "type": "login",
                "title": "The bank",
                "username": "ada@example.com",
                "url": "https://bank.example",
                "password": ciphertext(item_id),
                "password_rotated": true,
                "key_id": key_id
            }),
        );
        // A Locker tag is a vault tag, put on by the shared verb.
        self.ok(
            "tag.add",
            serde_json::json!({ "id": item_id, "label": "money" }),
        )
    }
}

// ---------------------------------------------------------------------------
// The catalogue itself.
// ---------------------------------------------------------------------------

/// WHAT INVOLVES A SECRET OR LOCKER'S OWN STRUCTURE, and nothing the vault's
/// shared verbs already do (#1135, the Locker lane): trash, restore, purge,
/// archive, star and tags are `entity.*`, `flag.*` and `tag.*` for a Locker
/// item as for every kind. v0's `locker.watchtower` is deleted with the
/// weak/reused scoring (Q-1047-16), and `locker.rotate_key` with the
/// multi-seat custody plane (#1047 slice D1).
#[test]
fn the_catalogue_is_what_involves_a_secret_plus_the_reveal_receipt() {
    use centraid_vault::commands::Idempotency;

    let definitions = centraid_vault::commands::locker::definitions();
    let names: Vec<&str> = definitions
        .iter()
        .map(|definition| definition.name)
        .collect();
    assert_eq!(names.len(), 13);
    assert!(!names.contains(&"locker.watchtower"));

    let kept = [
        "locker.add_item",
        "locker.edit_item",
        "locker.totp_code",
        "locker.set_memo",
        "locker.duplicate_item",
        "locker.set_field",
        "locker.remove_field",
        "locker.set_addresses",
        "locker.set_passkey",
        "locker.clear_passkey",
        "locker.counts",
        "locker.export",
    ];
    for name in kept {
        assert!(names.contains(&name), "{name} is not in the catalogue");
    }
    // THE VERBS THE VAULT ALREADY HAS ARE NOT SPELLED A SECOND TIME.
    for gone in [
        "locker.trash_item",
        "locker.restore_item",
        "locker.purge_item",
        "locker.star_item",
        "locker.unstar_item",
        "locker.archive_item",
        "locker.unarchive_item",
    ] {
        assert!(!names.contains(&gone), "{gone} duplicates a shared verb");
    }
    // The one add, and only that one.
    let added: Vec<&&str> = names.iter().filter(|name| !kept.contains(name)).collect();
    assert_eq!(added, [&"locker.reveal_receipt"]);

    let class_of = |name: &str| {
        definitions
            .iter()
            .find(|definition| definition.name == name)
            .map(|definition| definition.idempotency)
            .expect("a definition")
    };
    let mut idempotent = 0;
    let mut once = 0;
    let mut retry_safe = 0;
    for name in kept {
        match class_of(name) {
            Idempotency::Idempotent => idempotent += 1,
            Idempotency::Once => once += 1,
            Idempotency::RetrySafe => retry_safe += 1,
        }
    }
    assert_eq!(
        (idempotent, once, retry_safe),
        (7, 2, 3),
        "the locker schema's idempotency split moved"
    );
    // The add writes once: a receipt per reveal.
    assert_eq!(class_of("locker.reveal_receipt"), Idempotency::Once);
}

/// THE TWO CONFIRMATION GATES, KEPT DISTINCT (census §A0).
///
/// `confirm` on a definition parks a NON-OWNER invocation regardless of risk.
/// Locker's own catalogue carries it on `locker.export` alone: a permanent
/// delete is the vault's one `entity.purge` / `entity.empty_trash`, and those
/// carry the same confirmation and the same risk for EVERY kind, Locker's
/// included (the Locker lane, L5).
#[test]
fn a_permanent_delete_is_confirmed_the_same_for_every_kind() {
    let definitions = centraid_vault::commands::locker::definitions();
    let confirmed: Vec<&str> = definitions
        .iter()
        .filter(|definition| definition.confirm)
        .map(|definition| definition.name)
        .collect();
    assert_eq!(confirmed, ["locker.export"]);
    use centraid_vault::commands::Risk;
    let risk_of = |name: &str| {
        definitions
            .iter()
            .find(|definition| definition.name == name)
            .map(|definition| definition.risk)
            .expect("a definition")
    };
    // Risk is SALIENCE ONLY and never an approval trigger.
    assert_eq!(risk_of("locker.export"), Risk::High);

    let shared = centraid_vault::commands::entity::definitions();
    for name in ["entity.purge", "entity.empty_trash"] {
        let definition = shared
            .iter()
            .find(|definition| definition.name == name)
            .expect("a shared delete");
        assert!(definition.confirm, "{name} is not confirmed");
        assert_eq!(definition.risk, Risk::Medium, "{name}");
    }
    for name in ["entity.trash", "entity.restore", "entity.retitle"] {
        let definition = shared
            .iter()
            .find(|definition| definition.name == name)
            .expect("a shared verb");
        assert!(!definition.confirm, "{name} is confirmed and is reversible");
    }
}

/// The journal records keyed hashes at the sealed paths, never values (#293) —
/// and after wave 4 the "value" at those paths is ciphertext, which is still
/// not something a journal should carry a second copy of.
#[test]
fn every_sealed_input_path_is_declared() {
    let definitions = centraid_vault::commands::locker::definitions();
    let sealed_of = |name: &str| {
        definitions
            .iter()
            .find(|definition| definition.name == name)
            .map(|definition| definition.sealed_input)
            .expect("a definition")
    };
    let five = ["password", "otp_seed", "card_number", "cvv", "content"];
    assert_eq!(sealed_of("locker.add_item"), five);
    assert_eq!(sealed_of("locker.edit_item"), five);
    // The copy's re-sealed custom fields ride the same command, so their values
    // are declared too: a nested ciphertext is tokenised like a top-level one.
    assert_eq!(
        sealed_of("locker.duplicate_item"),
        [
            "password",
            "otp_seed",
            "card_number",
            "cvv",
            "content",
            "fields[].value"
        ]
    );
    assert_eq!(sealed_of("locker.set_field"), ["value"]);
    assert_eq!(sealed_of("locker.set_passkey"), ["private_key"]);
}

// ---------------------------------------------------------------------------
// The custody guards — the wave 4 half.
// ---------------------------------------------------------------------------

/// A PLAINTEXT SECRET CANNOT REACH THE GATEWAY. This is the refusal that makes
/// "blind for secrets" a property of the write path and not only of the reads.
#[test]
fn a_plaintext_secret_is_refused_at_every_door_that_takes_one() {
    let world = World::new("locker-plaintext", "key-1");

    let reason = world.refused(
        "locker.add_item",
        serde_json::json!({
            "item_id": "item-1",
            "type": "login",
            "title": "The bank",
            "password": "correct-horse-battery-staple",
            "password_rotated": true,
            "key_id": "key-1"
        }),
    );
    assert!(
        reason.contains("must arrive sealed under the member key"),
        "{reason}"
    );
    // And the refusal does NOT quote the value, which is the one value this
    // refusal is most likely to be handed.
    assert!(
        !reason.contains("correct-horse"),
        "the refusal quoted the password: {reason}"
    );
    assert_eq!(
        world.one::<i64>("SELECT COUNT(*) FROM locker_item", &[]),
        0,
        "a refused write left a row behind"
    );

    world.login("item-1", "key-1");
    let reason = world.refused(
        "locker.edit_item",
        serde_json::json!({
            "item_id": "item-1",
            "password": "another-plaintext",
            "password_rotated": true,
            "key_id": "key-1"
        }),
    );
    assert!(reason.contains("must arrive sealed"), "{reason}");

    let reason = world.refused(
        "locker.set_field",
        serde_json::json!({
            "item_id": "item-1",
            "field_id": "field-1",
            "label": "Recovery code",
            "kind": "sealed",
            "value": "0000-1111",
            "key_id": "key-1"
        }),
    );
    assert!(reason.contains("must arrive sealed"), "{reason}");

    let reason = world.refused(
        "locker.set_passkey",
        serde_json::json!({
            "item_id": "item-1",
            "rp_id": "bank.example",
            "private_key": "-----BEGIN PRIVATE KEY-----",
            "key_id": "key-1"
        }),
    );
    assert!(reason.contains("must arrive sealed"), "{reason}");
}

/// A WRITE UNDER ANOTHER GENERATION IS REFUSED, because storing it would put a
/// row under a key nothing can open — and the command plane cannot re-seal it.
#[test]
fn a_write_under_a_stale_key_generation_is_refused_with_the_repair() {
    let world = World::new("locker-stale", "key-2");
    let reason = world.refused(
        "locker.add_item",
        serde_json::json!({
            "item_id": "item-1",
            "type": "login",
            "title": "The bank",
            "password": ciphertext("item-1"),
            "password_rotated": true,
            "key_id": "key-1"
        }),
    );
    assert!(reason.contains("re-enter this secret"), "{reason}");
    assert!(
        reason.contains("key-2"),
        "the refusal names the live key: {reason}"
    );
}

/// A VAULT WITH NO KEY PLANE HOLDS NO SECRETS — `MemberKeyAbsent`, never a
/// silent plaintext (D-1020-L1).
#[test]
fn a_vault_with_no_member_key_refuses_a_secret_and_still_takes_a_plain_item() {
    let world = World::new("locker-unfounded", "");
    let reason = world.refused(
        "locker.add_item",
        serde_json::json!({
            "item_id": "item-1",
            "type": "login",
            "title": "The bank",
            "password": ciphertext("item-1"),
            "password_rotated": true,
            "key_id": "key-1"
        }),
    );
    assert!(reason.contains("no Locker key plane"), "{reason}");

    // …and a SECRET-FREE item is still fine, because listing is not
    // unlocking: a vault with no generation can hold a passport item's template
    // rows and show them.
    world.ok(
        "locker.add_item",
        serde_json::json!({
            "item_id": "item-2",
            "type": "passport",
            "title": "Passport"
        }),
    );
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM locker_item_field WHERE item_id = ?1",
            &["item-2"]
        ),
        7,
        "the passport template's seven rows are minted without a key"
    );
}

/// THE CALLER MINTS THE ID, AND THE VAULT STILL REFUSES A BAD ONE (D-1020-L9).
#[test]
fn a_caller_minted_id_must_be_fresh_and_well_formed() {
    let world = World::new("locker-ids", "key-1");
    world.login("item-1", "key-1");

    let reason = world.refused(
        "locker.add_item",
        serde_json::json!({
            "item_id": "item-1",
            "type": "note",
            "title": "Another"
        }),
    );
    assert!(reason.contains("already in this vault"), "{reason}");

    let reason = world.refused(
        "locker.add_item",
        serde_json::json!({
            "item_id": "item one",
            "type": "note",
            "title": "Another"
        }),
    );
    assert!(reason.contains("letters, digits"), "{reason}");
}

/// A PASSWORD WRITE MUST SAY WHETHER THE VALUE CHANGED (D-1020-L10b).
///
/// The command plane cannot compare two ciphertexts — a fresh nonce per value
/// means the same plaintext encrypts differently every time — so the claim is
/// the core's and it is required rather than defaulted.
#[test]
fn a_password_write_without_the_rotation_claim_is_refused() {
    let world = World::new("locker-rotation-claim", "key-1");
    let reason = world.refused(
        "locker.add_item",
        serde_json::json!({
            "item_id": "item-1",
            "type": "login",
            "title": "The bank",
            "password": ciphertext("item-1"),
            "key_id": "key-1"
        }),
    );
    assert!(reason.contains("whether the value CHANGED"), "{reason}");

    world.login("item-1", "key-1");
    let before: String = world.one(
        "SELECT password_set_at FROM locker_item WHERE id = ?1",
        &["item-1"],
    );

    // A RETAG MUST NOT MAKE A THREE-YEAR-OLD PASSWORD LOOK FRESH — and a
    // retag is a FULL DRAFT with new tags, because `editItemWrite` always
    // sends `itemPayload(draft)` and an edit REWRITES the type's fields
    // (see `an_edit_rewrites_the_types_fields_rather_than_patching_them`). A
    // tags-only edit is not a gesture the product has, and it would clear the
    // password rather than retag the item.
    world.ok(
        "locker.edit_item",
        serde_json::json!({
            "item_id": "item-1",
            "username": "ada@example.com",
            "url": "https://bank.example",
            "password": "«sealed»"
        }),
    );
    // The retag itself is the vault's verb, and cannot touch the password's age.
    world.ok(
        "tag.add",
        serde_json::json!({ "id": "item-1", "label": "rotated" }),
    );
    let after: String = world.one(
        "SELECT password_set_at FROM locker_item WHERE id = ?1",
        &["item-1"],
    );
    assert_eq!(before, after, "a retag re-stamped the password's age");

    // A round-tripped placeholder means "leave the secret alone" and is not a
    // rotation either.
    world.ok(
        "locker.edit_item",
        serde_json::json!({
            "item_id": "item-1",
            "username": "ada@example.com",
            "url": "https://bank.example",
            "password": "«sealed»"
        }),
    );
    let untouched: String = world.one(
        "SELECT password FROM locker_item WHERE id = ?1",
        &["item-1"],
    );
    assert_eq!(
        untouched,
        ciphertext("item-1"),
        "the placeholder overwrote the secret"
    );

    // A declared rotation DOES re-stamp it, and the answer says so.
    world.scratch.clock.advance_ms(60_000);
    let output = world.ok(
        "locker.edit_item",
        serde_json::json!({
            "item_id": "item-1",
            "username": "ada@example.com",
            "url": "https://bank.example",
            "password": ciphertext("rotated"),
            "password_rotated": true,
            "key_id": "key-1"
        }),
    );
    assert_eq!(output["rotated"], serde_json::json!(true));
    let rotated: String = world.one(
        "SELECT password_set_at FROM locker_item WHERE id = ?1",
        &["item-1"],
    );
    assert_ne!(before, rotated, "a real rotation did not re-stamp the age");
}

// ---------------------------------------------------------------------------
// The lifecycle, which did not change.
// ---------------------------------------------------------------------------

/// AN EDIT REPLACES THE TYPE'S FIELDS AND DOES NOT PATCH THEM — AND SAYS SO
/// (L4, ruled 2026-10-15).
///
/// v0's contract, named by v0's own test: *"edit_item rewrites the type fields
/// and replaces tags"*. An edit carrying only a password clears the username,
/// the url, the OTP seed and the notes, because every column of the type is
/// written, `NULL` for the omitted ones.
///
/// The owner ruled it stays a replace and is stated where callers read: the
/// command's schema (`the_edit_commands_schema_says_it_replaces`), the
/// manifest's `edit-item`, the editor's proto comment and the Locker README.
/// This test holds the behaviour: the clearing, what an omission leaves alone
/// (title, the compromised flag), and what keeps a secret through a
/// replace, the placeholder.
#[test]
fn an_edit_rewrites_the_types_fields_rather_than_patching_them() {
    let world = World::new("locker-replace", "key-1");
    world.login("item-1", "key-1");
    assert_eq!(
        world.one::<String>(
            "SELECT username FROM locker_item WHERE id = ?1",
            &["item-1"]
        ),
        "ada@example.com"
    );

    world.ok(
        "locker.edit_item",
        serde_json::json!({
            "item_id": "item-1",
            "password": ciphertext("rotated"),
            "password_rotated": true,
            "key_id": "key-1"
        }),
    );
    // THE OMITTED COLUMNS ARE CLEARED. This is the contract.
    for column in ["username", "url", "otp_seed", "notes"] {
        let value: Option<String> = world.one(
            &format!("SELECT {column} FROM locker_item WHERE id = ?1"),
            &["item-1"],
        );
        assert_eq!(value, None, "{column} survived a rewrite");
    }
    // …and the title, which is NOT a type field, is untouched.
    assert_eq!(
        world.one::<String>("SELECT title FROM entity WHERE id = ?1", &["item-1"]),
        "The bank"
    );
    // THE TAGS ARE NOT A TYPE FIELD EITHER, and not this command's at all:
    // they are the vault's `tagged` edges, put on and taken off by `tag.*`, so
    // an edit leaves them alone.
    let tags = |world: &World| {
        world.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'tagged'",
            &["item-1"],
        )
    };
    assert_eq!(tags(&world), 1, "an edit changed the tags");
    world.ok(
        "locker.edit_item",
        serde_json::json!({ "item_id": "item-1", "password": "«sealed»" }),
    );
    assert_eq!(tags(&world), 1, "an edit changed the tags");
    world.ok(
        "tag.remove",
        serde_json::json!({ "id": "item-1", "label": "money" }),
    );
    assert_eq!(tags(&world), 0, "tag.remove did not clear the tag");
    // A COMPROMISED FLAG THE EDIT DOES NOT STATE IS LEFT ALONE, too.
    world.ok(
        "locker.edit_item",
        serde_json::json!({ "item_id": "item-1", "password": "«sealed»", "compromised": true }),
    );
    world.ok(
        "locker.edit_item",
        serde_json::json!({ "item_id": "item-1", "password": "«sealed»" }),
    );
    assert_eq!(
        world.one::<i64>(
            "SELECT compromised FROM locker_item WHERE id = ?1",
            &["item-1"]
        ),
        1,
        "an edit that stated no flag changed it"
    );

    // A FULL DRAFT — which is what the UI sends — keeps everything.
    world.ok(
        "locker.edit_item",
        serde_json::json!({
            "item_id": "item-1",
            "username": "ada@example.com",
            "url": "https://bank.example",
            "notes": "the joint account",
            "password": "«sealed»"
        }),
    );
    assert_eq!(
        world.one::<String>(
            "SELECT username FROM locker_item WHERE id = ?1",
            &["item-1"]
        ),
        "ada@example.com"
    );
    // The placeholder left the secret alone.
    assert_eq!(
        world.one::<String>(
            "SELECT password FROM locker_item WHERE id = ?1",
            &["item-1"]
        ),
        ciphertext("rotated")
    );
}

/// THE COMMAND SAYS IT REPLACES, WHERE A CALLER READS (L4, ruled 2026-10-15).
///
/// `describe` serves a command's input schema to whoever builds a form or a
/// tool call from it, and an assistant or an API caller reads it as the
/// contract. The root `description` is where "replaces, does not patch" lives,
/// so a caller who takes the optional fields for a patch API is told before it
/// loses data. Held here so a rewrite of the schema cannot drop the sentence
/// while the behaviour above stays.
#[test]
fn the_edit_commands_schema_says_it_replaces() {
    let registry = registry();
    let schema = registry
        .get("locker.edit_item")
        .expect("the command is registered")
        .schema();
    let said = schema["description"]
        .as_str()
        .expect("the schema carries a description at its root");
    for phrase in ["REPLACES, does not patch", "CLEARED", "«sealed»"] {
        assert!(
            said.contains(phrase),
            "the description lost `{phrase}`: {said}"
        );
    }
}

/// THE COMPROMISED FLAG IS THE MEMBER'S, AND A NEW PASSWORD ANSWERS IT
/// (#1047, R-1047-F7). Nothing produces the flag automatically: the member
/// sets and clears it through `edit_item`. A **rotation** — the core's
/// `password_rotated: true` — clears it, because the fix Review asks for has
/// been made; a re-typed password, a placeholder or a plain edit leaves it
/// alone; and a write that states `compromised` itself wins over the rule.
#[test]
fn the_member_flags_a_compromised_item_and_a_rotation_clears_it() {
    let world = World::new("locker-compromised", "key-1");
    world.login("item-1", "key-1");
    let flagged = |world: &World| {
        world.one::<i64>(
            "SELECT compromised FROM locker_item WHERE id = ?1",
            &["item-1"],
        )
    };
    let draft = |extra: serde_json::Value| {
        let mut input = serde_json::json!({
            "item_id": "item-1",
            "username": "ada@example.com",
            "url": "https://bank.example",
        });
        for (key, value) in extra.as_object().expect("an object") {
            input[key] = value.clone();
        }
        input
    };
    assert_eq!(flagged(&world), 0);

    world.ok(
        "locker.edit_item",
        draft(serde_json::json!({ "compromised": true, "password": "«sealed»" })),
    );
    assert_eq!(flagged(&world), 1, "the member flagged it");

    // A PLAIN EDIT AND A RE-TYPED PASSWORD are not the fix.
    world.ok(
        "locker.edit_item",
        draft(serde_json::json!({ "title": "My bank", "password": "«sealed»" })),
    );
    world.ok(
        "locker.edit_item",
        draft(serde_json::json!({
            "password": ciphertext("item-1"),
            "password_rotated": false,
            "key_id": "key-1"
        })),
    );
    assert_eq!(flagged(&world), 1, "nothing rotated, so the flag stays");

    // A ROTATION IS.
    let rotated = world.ok(
        "locker.edit_item",
        draft(serde_json::json!({
            "password": ciphertext("fresh"),
            "password_rotated": true,
            "key_id": "key-1"
        })),
    );
    assert_eq!(rotated["rotated"], serde_json::json!(true));
    assert_eq!(flagged(&world), 0, "a new password clears the flag");

    // AN EXPLICIT FLAG IN THE SAME WRITE WINS: the member said so.
    world.ok(
        "locker.edit_item",
        draft(serde_json::json!({
            "compromised": true,
            "password": ciphertext("fresher"),
            "password_rotated": true,
            "key_id": "key-1"
        })),
    );
    assert_eq!(flagged(&world), 1);
    world.ok(
        "locker.edit_item",
        draft(serde_json::json!({ "compromised": false, "password": "«sealed»" })),
    );
    assert_eq!(flagged(&world), 0, "and the member clears it by hand");
}

#[test]
fn trash_is_reversible_and_a_lapsed_window_is_not() {
    let world = World::new("locker-trash", "key-1");
    world.login("item-1", "key-1");

    world.ok("entity.trash", serde_json::json!({ "id": "item-1" }));
    let purge_at: String = world.one("SELECT purge_at FROM entity WHERE id = ?1", &["item-1"]);
    assert!(purge_at > world.scratch.clock.now_text());

    world.ok("entity.restore", serde_json::json!({ "id": "item-1" }));
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE id = ?1 AND deleted_at IS NULL",
            &["item-1"]
        ),
        1
    );

    // A RESTORE PAST THE WINDOW RESURRECTS WHAT THE MEMBER WAS TOLD HAD BEEN
    // DELETED (#916, review 1.5).
    world.ok("entity.trash", serde_json::json!({ "id": "item-1" }));
    world.scratch.clock.advance_ms(31 * 86_400_000);
    let reason = world.refused("entity.restore", serde_json::json!({ "id": "item-1" }));
    assert!(reason.contains("past its grace window"), "{reason}");
}

/// ARCHIVE IS A FLAG, NOT A TRASH, AND TRASH WINS OVER IT — as for every kind
/// (the Locker lane, L5). The schema no longer makes archived-and-trashed
/// unrepresentable: a trashed item may be archived and a restore returns an
/// archived item to the archive.
#[test]
fn archive_is_not_trash_and_trash_wins_over_it() {
    let world = World::new("locker-archive", "key-1");
    world.login("item-1", "key-1");
    world.ok(
        "flag.set",
        serde_json::json!({ "id": "item-1", "flag": "archived" }),
    );
    let purge_at: Option<String> =
        world.one("SELECT purge_at FROM entity WHERE id = ?1", &["item-1"]);
    assert_eq!(purge_at, None, "archive set a purge date");
    let archived = |world: &World| {
        world.one::<i64>(
            "SELECT COUNT(*) FROM edge
              WHERE from_id = ?1 AND rel = 'tagged' AND to_id = 'flag:archived'",
            &["item-1"],
        )
    };
    assert_eq!(archived(&world), 1);

    // TRASH WINS: an archived item can be trashed, and it counts as trashed.
    world.ok("entity.trash", serde_json::json!({ "id": "item-1" }));
    let counts = world.ok("locker.counts", serde_json::json!({}));
    assert_eq!(
        (
            counts["live"].as_i64(),
            counts["archived"].as_i64(),
            counts["trashed"].as_i64()
        ),
        (Some(0), Some(0), Some(1)),
        "a trashed, archived item is trashed and nothing else"
    );
    // …and RESTORE RETURNS IT TO THE ARCHIVE.
    world.ok("entity.restore", serde_json::json!({ "id": "item-1" }));
    assert_eq!(archived(&world), 1, "a restore lost the archive");
    let counts = world.ok("locker.counts", serde_json::json!({}));
    assert_eq!(counts["archived"].as_i64(), Some(1));

    world.ok(
        "flag.clear",
        serde_json::json!({ "id": "item-1", "flag": "archived" }),
    );
    assert_eq!(archived(&world), 0);
}

/// A PURGE TAKES THE SIDECARS, THE TAGS AND THE MEMO WITH IT, explicitly —
/// because a cascade fires no `AFTER DELETE` trigger unless
/// `recursive_triggers` is on, and an offline phone would keep rows whose item
/// is gone. It is the vault's `entity.purge`, which asks for the trash first.
#[test]
fn a_purge_deletes_every_sidecar_in_the_same_transaction() {
    let world = World::new("locker-purge", "key-1");
    world.login("item-1", "key-1");
    world.ok(
        "flag.set",
        serde_json::json!({ "id": "item-1", "flag": "starred" }),
    );
    world.ok(
        "locker.set_memo",
        serde_json::json!({ "item_id": "item-1", "note": "the joint account" }),
    );
    world.ok(
        "locker.set_field",
        serde_json::json!({
            "item_id": "item-1",
            "label": "Account number",
            "kind": "text",
            "value": "12345"
        }),
    );
    world.ok(
        "locker.set_addresses",
        serde_json::json!({
            "item_id": "item-1",
            "addresses": [{ "url": "https://m.bank.example" }]
        }),
    );
    world.ok(
        "locker.set_passkey",
        serde_json::json!({
            "item_id": "item-1",
            "rp_id": "bank.example",
            "private_key": ciphertext("passkey"),
            "key_id": "key-1"
        }),
    );
    world.ok(
        "locker.reveal_receipt",
        serde_json::json!({
            "object_type": "locker.item",
            "item_id": "item-1",
            "columns": ["password"],
            "kind": "reveal"
        }),
    );

    // Not from the live shelf: the trash comes first, as for every kind.
    let reason = world.refused("entity.purge", serde_json::json!({ "id": "item-1" }));
    assert!(reason.contains("is not in the trash"), "{reason}");
    world.ok("entity.trash", serde_json::json!({ "id": "item-1" }));
    world.ok("entity.purge", serde_json::json!({ "id": "item-1" }));
    for (table, column) in [
        ("entity", "id"),
        ("locker_item", "id"),
        ("locker_item_field", "item_id"),
        ("locker_item_address", "item_id"),
        ("locker_item_passkey", "item_id"),
        ("locker_item_alias", "item_id"),
        ("edge", "from_id"),
    ] {
        assert_eq!(
            world.one::<i64>(
                &format!("SELECT COUNT(*) FROM {table} WHERE {column} = ?1"),
                &["item-1"]
            ),
            0,
            "{table} kept a row whose item is gone"
        );
    }
    // The receipts stay: they are evidence, and name the item by value.
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM receipt WHERE item_id = ?1",
            &["item-1"]
        ),
        1,
        "a purge erased the evidence of a reveal"
    );
}

/// A STAR IS A FLAG AND A LABEL IS A VAULT TAG (#1135, the Locker lane): a
/// Locker item is an entity, so the shared verbs tag and star it, and the same
/// words reach the vault's own tag rail. Nothing of its secrets rides along.
#[test]
fn a_star_is_a_flag_and_a_label_is_a_vault_tag() {
    let world = World::new("locker-tags", "key-1");
    world.login("item-1", "key-1");
    let starred = |world: &World| {
        world.one::<i64>(
            "SELECT COUNT(*) FROM edge
              WHERE from_id = ?1 AND rel = 'tagged' AND to_id = 'flag:starred'",
            &["item-1"],
        )
    };
    assert_eq!(starred(&world), 0);
    world.ok(
        "flag.set",
        serde_json::json!({ "id": "item-1", "flag": "starred" }),
    );
    assert_eq!(starred(&world), 1);
    // The word `money` is a vault tag, one concept however it is spelt.
    world.ok(
        "tag.add",
        serde_json::json!({ "id": "item-1", "label": "  MONEY " }),
    );
    assert_eq!(
        world.one::<i64>("SELECT COUNT(*) FROM entity WHERE kind = 'tag'", &[]),
        1,
        "the tag is the vault's, one concept"
    );
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND to_id = 'tag:money'",
            &["item-1"]
        ),
        1
    );

    // Unstarring clears the edge and leaves the tag.
    world.ok(
        "flag.clear",
        serde_json::json!({ "id": "item-1", "flag": "starred" }),
    );
    assert_eq!(starred(&world), 0);
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'tagged'",
            &["item-1"]
        ),
        1
    );
    // A retitle is the shared verb too.
    world.ok(
        "entity.retitle",
        serde_json::json!({ "id": "item-1", "title": "Joint account" }),
    );
    assert_eq!(
        world.one::<String>("SELECT title FROM entity WHERE id = ?1", &["item-1"]),
        "Joint account"
    );
}

/// AN ALIAS IS UNIQUE AMONG LIVE ITEMS, and an empty one clears the binding.
#[test]
fn an_alias_is_unique_among_live_items_and_clearable() {
    let world = World::new("locker-alias", "key-1");
    world.login("item-1", "key-1");
    world.ok(
        "locker.add_item",
        serde_json::json!({
            "item_id": "item-2",
            "type": "login",
            "title": "The other bank",
            "alias": "bank"
        }),
    );
    let reason = world.refused(
        "locker.edit_item",
        serde_json::json!({ "item_id": "item-1", "alias": "bank" }),
    );
    assert!(
        reason.contains("already used by another live item"),
        "{reason}"
    );

    world.ok(
        "locker.edit_item",
        serde_json::json!({ "item_id": "item-2", "alias": "" }),
    );
    assert_eq!(
        world.one::<i64>("SELECT COUNT(*) FROM locker_item_alias", &[]),
        0
    );
    // …and now it is free.
    world.ok(
        "locker.edit_item",
        serde_json::json!({ "item_id": "item-1", "alias": "bank" }),
    );
    assert_eq!(
        world.one::<String>(
            "SELECT item_id FROM locker_item_alias WHERE alias = ?1",
            &["bank"]
        ),
        "item-1"
    );
}

/// A DUPLICATE CARRIES THE CORE'S RE-SEALED CELLS AND NOT THE ALIAS.
#[test]
fn a_duplicate_takes_the_re_sealed_cells_and_leaves_the_alias_behind() {
    let world = World::new("locker-duplicate", "key-1");
    world.login("item-1", "key-1");
    world.ok(
        "locker.edit_item",
        serde_json::json!({ "item_id": "item-1", "alias": "bank" }),
    );
    world.ok(
        "flag.set",
        serde_json::json!({ "id": "item-1", "flag": "starred" }),
    );
    world.ok(
        "locker.set_addresses",
        serde_json::json!({
            "item_id": "item-1",
            "addresses": [{ "url": "https://m.bank.example" }]
        }),
    );

    let output = world.ok(
        "locker.duplicate_item",
        serde_json::json!({
            "item_id": "item-1",
            "new_item_id": "item-copy",
            "password": ciphertext("item-copy"),
            "key_id": "key-1"
        }),
    );
    assert_eq!(output["title"], serde_json::json!("The bank copy"));
    // The COPY's ciphertext is the caller's, sealed against the new row.
    assert_eq!(
        world.one::<String>(
            "SELECT password FROM locker_item WHERE id = ?1",
            &["item-copy"]
        ),
        ciphertext("item-copy")
    );
    // The alias did NOT come along — a copy carrying it would steal the
    // connector binding.
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM locker_item_alias WHERE item_id = ?1",
            &["item-copy"]
        ),
        0
    );
    // Nor the star.
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND to_id = 'flag:starred'",
            &["item-copy"]
        ),
        0
    );
    // The addresses and the tags did.
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM locker_item_address WHERE item_id = ?1",
            &["item-copy"]
        ),
        1
    );
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND to_id = 'tag:money'",
            &["item-copy"]
        ),
        1
    );
    // A plaintext cell in a duplicate is refused like anywhere else.
    let reason = world.refused(
        "locker.duplicate_item",
        serde_json::json!({
            "item_id": "item-1",
            "new_item_id": "item-copy-2",
            "password": "plaintext"
        }),
    );
    assert!(reason.contains("must arrive sealed"), "{reason}");
}

/// A SEALED CUSTOM FIELD NEEDS THE CALLER'S ID; A PLAIN ONE DOES NOT.
#[test]
fn a_new_sealed_field_must_carry_the_id_it_was_sealed_against() {
    let world = World::new("locker-fields", "key-1");
    world.login("item-1", "key-1");

    let reason = world.refused(
        "locker.set_field",
        serde_json::json!({
            "item_id": "item-1",
            "label": "Recovery code",
            "kind": "sealed",
            "value": ciphertext("field-1"),
            "key_id": "key-1"
        }),
    );
    assert!(reason.contains("sealed against"), "{reason}");

    world.ok(
        "locker.set_field",
        serde_json::json!({
            "item_id": "item-1",
            "field_id": "field-1",
            "label": "Recovery code",
            "kind": "sealed",
            "value": ciphertext("field-1"),
            "key_id": "key-1"
        }),
    );
    assert_eq!(
        world.one::<String>(
            "SELECT key_id FROM locker_item_field WHERE field_id = ?1",
            &["field-1"]
        ),
        "key-1"
    );
    // A PLAIN field's id may be the vault's, because nothing is sealed
    // against it.
    let output = world.ok(
        "locker.set_field",
        serde_json::json!({
            "item_id": "item-1",
            "label": "Sort code",
            "kind": "text",
            "value": "00-00-00"
        }),
    );
    assert!(output["field_id"].as_str().is_some_and(|id| !id.is_empty()));

    // The placeholder leaves a stored secret alone.
    world.ok(
        "locker.set_field",
        serde_json::json!({
            "item_id": "item-1",
            "field_id": "field-1",
            "label": "Recovery code",
            "kind": "sealed",
            "value": "«sealed»"
        }),
    );
    assert_eq!(
        world.one::<String>(
            "SELECT value_sealed FROM locker_item_field WHERE field_id = ?1",
            &["field-1"]
        ),
        ciphertext("field-1")
    );

    world.ok(
        "locker.remove_field",
        serde_json::json!({ "item_id": "item-1", "field_id": "field-1" }),
    );
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM locker_item_field WHERE field_id = ?1",
            &["field-1"]
        ),
        0
    );
}

// ---------------------------------------------------------------------------
// The derivations, the receipt, and the rotation.
// ---------------------------------------------------------------------------

/// THE RECEIPT A REVEAL IN THE CORE OWES (D-1020-L3), and the refusals that
/// keep it honest.
#[test]
fn a_reveal_receipt_names_a_sealed_column_and_lands_where_the_history_reads() {
    let world = World::new("locker-reveal", "key-1");
    world.login("item-1", "key-1");

    world.ok(
        "locker.reveal_receipt",
        serde_json::json!({
            "object_type": "locker.item",
            "item_id": "item-1",
            "columns": ["password"],
            "kind": "reveal"
        }),
    );
    let (item, act, journal): (String, String, String) = world
        .scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT r.item_id, r.act, j.command
                   FROM receipt r JOIN journal j ON j.seq = r.journal_seq
                  ORDER BY r.seq DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .expect("the receipt is there");
    assert_eq!(item, "item-1");
    assert_eq!(act, "reveal password", "the verb, then the cells it opened");
    assert_eq!(
        journal, "locker.reveal_receipt",
        "the receipt names the journal row that explains it"
    );

    // A RECEIPT THAT NAMES A PLAIN COLUMN IS A LIE about what was revealed.
    let reason = world.refused(
        "locker.reveal_receipt",
        serde_json::json!({
            "object_type": "locker.item",
            "item_id": "item-1",
            "columns": ["title"]
        }),
    );
    assert!(reason.contains("is not a sealed Locker cell"), "{reason}");

    // There is no fill (R-1047-D3): the kind is not representable.
    let reason = world.refused(
        "locker.reveal_receipt",
        serde_json::json!({
            "object_type": "locker.item",
            "item_id": "item-1",
            "columns": ["password"],
            "kind": "fill"
        }),
    );
    assert!(!reason.is_empty(), "a fill receipt was accepted");

    // An unlock is about the vault, not about one item.
    let reason = world.refused(
        "locker.reveal_receipt",
        serde_json::json!({
            "object_type": "locker.auth",
            "item_id": "item-1",
            "columns": ["password"]
        }),
    );
    assert!(reason.contains("about the vault"), "{reason}");

    // And an unlock receipt itself lands, naming no item.
    world.ok(
        "locker.reveal_receipt",
        serde_json::json!({
            "object_type": "locker.auth",
            "columns": ["session"],
            "kind": "auth"
        }),
    );
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM receipt WHERE act = 'unlock' AND item_id IS NULL",
            &[]
        ),
        1
    );
}

/// THE COUNTS THE FOOT LINE READS, counted inside the vault.
#[test]
fn the_counts_are_exact_and_partitioned() {
    let world = World::new("locker-counts", "key-1");
    world.login("item-1", "key-1");
    world.ok(
        "locker.add_item",
        serde_json::json!({ "item_id": "item-2", "type": "note", "title": "A note" }),
    );
    world.ok(
        "locker.add_item",
        serde_json::json!({ "item_id": "item-3", "type": "note", "title": "Another" }),
    );
    world.ok(
        "flag.set",
        serde_json::json!({ "id": "item-2", "flag": "archived" }),
    );
    world.ok("entity.trash", serde_json::json!({ "id": "item-3" }));

    let counts = world.ok("locker.counts", serde_json::json!({}));
    assert_eq!(counts["live"], serde_json::json!(1));
    assert_eq!(counts["archived"], serde_json::json!(1));
    assert_eq!(counts["trashed"], serde_json::json!(1));
    // `by_type` counts the LIVE shelf only, which is what the rail shows.
    let by_type = counts["by_type"].as_array().expect("by_type");
    assert_eq!(by_type.len(), 1);
    assert_eq!(by_type[0]["type"], serde_json::json!("login"));
}

/// EXPORT KEEPS ITS CONFIRM AND ITS RISK, and answers the plain half plus the
/// ciphertext's addresses (D-1020-L7).
#[test]
fn an_export_is_confirmed_receipted_and_carries_no_plaintext() {
    let world = World::new("locker-export", "key-1");
    world.login("item-1", "key-1");

    // The `const: true` gate: a `false` confirm fails input validation.
    let outcome = world.run("locker.export", serde_json::json!({ "confirm": false }));
    assert_eq!(outcome.status, CommandStatus::Failed);

    let output = world.ok("locker.export", serde_json::json!({ "confirm": true }));
    assert_eq!(output["item_count"], serde_json::json!(1));
    let items = output["items"].as_array().expect("items");
    assert_eq!(items[0]["key_id"], serde_json::json!("key-1"));
    assert_eq!(items[0]["title"], serde_json::json!("The bank"));
    // THE PLAINTEXT IS NOT HERE and cannot be: no sealed cell rides the
    // answer, only the addresses a core holding `K` unseals.
    let body = serde_json::to_string(&output).expect("the answer serialises");
    for column in ["password", "otp_seed", "card_number", "cvv", "content"] {
        assert!(
            !items[0]
                .as_object()
                .expect("an object")
                .contains_key(column),
            "{column} rode the export answer"
        );
    }
    assert!(
        !body.contains("lk1:"),
        "the export answer carried ciphertext"
    );
    assert!(output.get("unseals_on").is_none());

    // And the one receipt a mass reveal owes.
    let act: String = world.one(
        "SELECT act FROM receipt WHERE item_id IS NULL ORDER BY seq DESC LIMIT 1",
        &[],
    );
    assert_eq!(act, "export");
}

/// THE TOTP DOOR IS A RECEIPT DOOR NOW, and its precondition is a PRESENCE
/// check — a column read that reads no value.
#[test]
fn the_totp_door_receipts_and_refuses_an_item_with_no_seed() {
    let world = World::new("locker-totp", "key-1");
    world.login("item-1", "key-1");
    let reason = world.refused(
        "locker.totp_code",
        serde_json::json!({ "item_id": "item-1" }),
    );
    assert!(reason.contains("no one-time-code seed"), "{reason}");

    world.ok(
        "locker.edit_item",
        serde_json::json!({
            "item_id": "item-1",
            "otp_seed": ciphertext("seed"),
            "key_id": "key-1"
        }),
    );
    let output = world.ok(
        "locker.totp_code",
        serde_json::json!({ "item_id": "item-1" }),
    );
    assert_eq!(output["period"], serde_json::json!(30));
    assert!(output.get("derived_on").is_none());
    // The digits are NOT here: the command plane cannot compute them.
    assert!(output.get("code").is_none());
}

/// A CUSTOM FIELD'S REVEAL IS RECEIPTED AGAINST ITS ITEM AND NAMES THE FIELD
/// (#1047 T2): the field's id and `value_sealed` — never its label or value —
/// and whether the value was shown or copied.
#[test]
fn a_field_reveal_receipt_names_the_field_and_what_the_value_was_for() {
    let world = World::new("locker-field-receipt", "key-1");
    world.login("item-1", "key-1");

    world.ok(
        "locker.reveal_receipt",
        serde_json::json!({
            "object_type": "locker.item",
            "item_id": "item-1",
            "columns": ["value_sealed"],
            "field_id": "field-1",
            "use": "copy",
            "kind": "reveal"
        }),
    );
    let act: String = world.one("SELECT act FROM receipt ORDER BY seq DESC LIMIT 1", &[]);
    assert_eq!(
        act, "copy value_sealed field-1",
        "a copy, of the field's one sealed cell"
    );

    // A FIELD RECEIPT THAT NAMES AN ITEM CELL is a lie about what opened.
    let reason = world.refused(
        "locker.reveal_receipt",
        serde_json::json!({
            "object_type": "locker.item",
            "item_id": "item-1",
            "columns": ["password"],
            "field_id": "field-1"
        }),
    );
    assert!(reason.contains("value_sealed"), "{reason}");
    // And a use that is neither shown nor copied is not representable.
    let outcome = world.run(
        "locker.reveal_receipt",
        serde_json::json!({
            "object_type": "locker.item",
            "item_id": "item-1",
            "columns": ["password"],
            "use": "fill"
        }),
    );
    assert_eq!(outcome.status, CommandStatus::Failed);

    // A CODE'S RECEIPT SAYS WHETHER IT WAS SHOWN OR COPIED, too.
    world.ok(
        "locker.edit_item",
        serde_json::json!({
            "item_id": "item-1",
            "otp_seed": ciphertext("seed"),
            "key_id": "key-1"
        }),
    );
    world.ok(
        "locker.totp_code",
        serde_json::json!({ "item_id": "item-1", "use": "copy" }),
    );
    let act: String = world.one("SELECT act FROM receipt ORDER BY seq DESC LIMIT 1", &[]);
    assert_eq!(act, "code_copy otp_seed");
}

/// THE SEALED-FIELD DOOR (#1047 T2): a live item's sealed field, with the
/// generation it names; nothing for a plain field, another item's field or a
/// trashed item's.
#[test]
fn the_sealed_field_door_answers_a_live_items_sealed_field_only() {
    let world = World::new("locker-field-door", "key-1");
    world.login("item-1", "key-1");
    world.login("item-2", "key-1");
    world.ok(
        "locker.set_field",
        serde_json::json!({
            "item_id": "item-1",
            "field_id": "field-1",
            "label": "Recovery code",
            "kind": "sealed",
            "value": ciphertext("field-1"),
            "key_id": "key-1"
        }),
    );
    let text = world.ok(
        "locker.set_field",
        serde_json::json!({
            "item_id": "item-1",
            "label": "Branch",
            "kind": "text",
            "value": "Leeds"
        }),
    );
    let vault = &world.scratch.vault;
    let cell = vault
        .locker_sealed_field_cell("item-1", "field-1")
        .expect("the door answers")
        .expect("the field is there");
    assert_eq!(
        cell.ciphertext.as_deref(),
        Some(ciphertext("field-1").as_str())
    );
    assert_eq!(cell.key_id.as_deref(), Some("key-1"));
    let text_id = text["field_id"].as_str().expect("a field id");
    assert!(
        vault
            .locker_sealed_field_cell("item-1", text_id)
            .expect("the door answers")
            .is_none(),
        "a plain field answered as sealed"
    );
    assert!(
        vault
            .locker_sealed_field_cell("item-2", "field-1")
            .expect("the door answers")
            .is_none(),
        "another item's field answered"
    );
    world.ok("entity.trash", serde_json::json!({ "id": "item-1" }));
    assert!(
        vault
            .locker_sealed_field_cell("item-1", "field-1")
            .expect("the door answers")
            .is_none(),
        "a trashed item's field still reveals"
    );
}

/// A PASSKEY RENAMED WITH THE PLACEHOLDER KEEPS ITS KEY AND ITS GENERATION
/// (#1047 T2). The phone never holds the key, so it has no generation to
/// name; the stored one stays with the ciphertext it describes.
#[test]
fn a_passkey_renamed_with_the_placeholder_keeps_its_key_and_generation() {
    let world = World::new("locker-passkey-rename", "key-1");
    world.login("item-1", "key-1");
    world.ok(
        "locker.set_passkey",
        serde_json::json!({
            "item_id": "item-1",
            "rp_id": "bank.example",
            "user_handle": "ada",
            "display_name": "Ada",
            "credential_id": "cred-1",
            "algorithm": "ES256",
            "private_key": ciphertext("key"),
            "key_id": "key-1"
        }),
    );
    world.ok(
        "locker.set_passkey",
        serde_json::json!({
            "item_id": "item-1",
            "rp_id": "bank.example",
            "user_handle": "ada",
            "display_name": "Ada at the bank",
            "credential_id": "cred-1",
            "algorithm": "ES256",
            "private_key": "«sealed»"
        }),
    );
    assert_eq!(
        world.one::<String>(
            "SELECT display_name FROM locker_item_passkey WHERE item_id = ?1",
            &["item-1"]
        ),
        "Ada at the bank"
    );
    assert_eq!(
        world.one::<String>(
            "SELECT private_key FROM locker_item_passkey WHERE item_id = ?1",
            &["item-1"]
        ),
        ciphertext("key")
    );
    assert_eq!(
        world.one::<String>(
            "SELECT key_id FROM locker_item_passkey WHERE item_id = ?1",
            &["item-1"]
        ),
        "key-1"
    );
}

// ---------------------------------------------------------------------------
// The assistant has no way into Locker, through ANY verb (the Locker lane, L5).
// ---------------------------------------------------------------------------

impl World {
    fn run_as_assistant(
        &self,
        name: &str,
        input: serde_json::Value,
    ) -> centraid_vault::CommandOutcome {
        self.scratch
            .vault
            .execute(
                &self.registry,
                &Principal::assistant("device-1"),
                &Command::new(name, input),
            )
            .expect("the command plane answers")
    }
}

/// A Locker item is an entity, so every shared verb could name it by id. The
/// gate refuses the assistant at the id, so a verb added later is closed too —
/// and the refusal carries no title, no kind row and no secret.
#[test]
fn any_command_under_the_assistants_principal_refuses_a_locker_item() {
    let world = World::new("locker-assistant", "key-1");
    world.login("item-1", "key-1");
    world.ok(
        "note.create",
        serde_json::json!({ "title": "A note", "body": "" }),
    );
    let before: i64 = world.one(
        "SELECT COUNT(*) FROM journal WHERE outcome = 'executed'",
        &[],
    );

    for (name, input) in [
        (
            "entity.retitle",
            serde_json::json!({ "id": "item-1", "title": "x" }),
        ),
        ("entity.trash", serde_json::json!({ "id": "item-1" })),
        ("entity.restore", serde_json::json!({ "id": "item-1" })),
        ("entity.purge", serde_json::json!({ "id": "item-1" })),
        (
            "entity.empty_trash",
            serde_json::json!({ "kind": "locker_item" }),
        ),
        (
            "tag.add",
            serde_json::json!({ "id": "item-1", "label": "spy" }),
        ),
        (
            "tag.remove",
            serde_json::json!({ "id": "item-1", "label": "money" }),
        ),
        (
            "flag.set",
            serde_json::json!({ "id": "item-1", "flag": "starred" }),
        ),
        (
            "flag.clear",
            serde_json::json!({ "id": "item-1", "flag": "starred" }),
        ),
        (
            "edge.add",
            serde_json::json!({ "from": "item-1", "rel": "attached", "to": "item-1" }),
        ),
        // A `locker.*` command is closed whether or not it names an item.
        ("locker.counts", serde_json::json!({})),
        (
            "locker.edit_item",
            serde_json::json!({ "item_id": "item-1", "title": "x" }),
        ),
    ] {
        let outcome = world.run_as_assistant(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Failed,
            "{name} reached Locker"
        );
        assert_eq!(
            outcome.predicate.as_deref(),
            Some(centraid_vault::commands::ASSISTANT_CLOSED_OUT),
            "{name}: {:?}",
            outcome.reason
        );
        let said = outcome.reason.unwrap_or_default();
        assert!(
            !said.contains("The bank") && !said.contains("lk1:"),
            "{said}"
        );
    }
    // Nothing moved: the same item, still live, still tagged as it was.
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE id = 'item-1' AND deleted_at IS NULL AND title = 'The bank'",
            &[]
        ),
        1
    );
    assert_eq!(
        world.one::<i64>("SELECT COUNT(*) FROM edge WHERE from_id = 'item-1'", &[]),
        1
    );
    assert_eq!(
        before,
        world.one::<i64>(
            "SELECT COUNT(*) FROM journal WHERE outcome = 'executed'",
            &[]
        )
    );

    // The assistant is not shut out of the rest of the vault.
    let outcome = world.run_as_assistant(
        "entity.retitle",
        serde_json::json!({ "id": world.one::<String>("SELECT id FROM entity WHERE kind = 'note'", &[]), "title": "Renamed" }),
    );
    assert_eq!(
        outcome.status,
        CommandStatus::Executed,
        "{:?}",
        outcome.reason
    );
}

/// A NOTE'S `[[title]]` CAN NAME A LOCKER ITEM (#1135) — for the member. The
/// compile is a way to learn that a title exists, so under the assistant's
/// principal it resolves everything but Locker.
#[test]
fn a_wikilink_resolves_a_locker_item_for_the_member_and_never_for_the_assistant() {
    let world = World::new("locker-wikilink", "key-1");
    world.login("item-1", "key-1");
    let linked = |note: &str| -> i64 {
        world.one(
            "SELECT COUNT(*) FROM edge WHERE from_id = ?1 AND rel = 'links' AND to_id = 'item-1'",
            &[note],
        )
    };
    let owner = world.ok(
        "note.create",
        serde_json::json!({ "title": "Mine", "body": "see [[The bank]]" }),
    )["id"]
        .as_str()
        .expect("a note id")
        .to_owned();
    assert_eq!(linked(&owner), 1);
    let outcome = world.run_as_assistant(
        "note.create",
        serde_json::json!({ "title": "Its", "body": "see [[The bank]]" }),
    );
    assert_eq!(
        outcome.status,
        CommandStatus::Executed,
        "{:?}",
        outcome.reason
    );
    let its = outcome.output["id"].as_str().expect("a note id").to_owned();
    assert_eq!(linked(&its), 0, "the assistant's compile reached Locker");
}

/// THE ASSISTANT'S EMPTY-TRASH NEVER REACHES LOCKER'S, even when it names no
/// kind at all: every other kind's trash is emptied and the Locker item stays.
#[test]
fn the_assistants_empty_trash_leaves_lockers_trash_alone() {
    let world = World::new("locker-assistant-trash", "key-1");
    world.login("item-1", "key-1");
    let note = world.ok(
        "note.create",
        serde_json::json!({ "title": "A note", "body": "" }),
    );
    let note_id = note["id"].as_str().expect("an id").to_owned();
    world.ok("entity.trash", serde_json::json!({ "id": "item-1" }));
    world.ok("entity.trash", serde_json::json!({ "id": note_id }));

    let outcome = world.run_as_assistant("entity.empty_trash", serde_json::json!({}));
    assert_eq!(
        outcome.status,
        CommandStatus::Executed,
        "{:?}",
        outcome.reason
    );
    assert_eq!(
        world.one::<i64>("SELECT COUNT(*) FROM entity WHERE id = 'item-1'", &[]),
        1,
        "the assistant emptied Locker's trash"
    );
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM entity WHERE id = ?1",
            &[note_id.as_str()]
        ),
        0,
        "the other kinds' trash was not emptied"
    );
}

/// A RE-SEALED CUSTOM FIELD IN A DUPLICATE IS TOKENISED IN THE JOURNAL like a
/// top-level cell: the nested `fields[].value` path is declared.
#[test]
fn a_duplicates_nested_field_ciphertext_never_lands_in_the_journal() {
    let world = World::new("locker-duplicate-journal", "key-1");
    world.login("item-1", "key-1");
    let sealed = ciphertext("copied-field");
    world.ok(
        "locker.duplicate_item",
        serde_json::json!({
            "item_id": "item-1",
            "new_item_id": "item-copy",
            "password": ciphertext("item-copy"),
            "key_id": "key-1",
            "fields": [{
                "field_id": "copied-field",
                "section": "",
                "label": "Recovery code",
                "kind": "sealed",
                "value": sealed
            }]
        }),
    );
    let journal: String = world.one(
        "SELECT input FROM journal WHERE command = 'locker.duplicate_item'",
        &[],
    );
    assert!(
        !journal.contains(&sealed),
        "the nested ciphertext is in the journal"
    );
    assert!(!journal.contains(&ciphertext("item-copy")), "{journal}");
    assert!(journal.contains("sealed:blake3:"), "{journal}");
}
