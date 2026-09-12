//! THE `locker` SCHEMA, END TO END, against a real founded vault — and the
//! custody change it was rewritten for (#1020, wave 4 lane Locker).
//!
//! Three kinds of assertion live here and they are deliberately not mixed up:
//!
//! 1. **The lifecycle is v0's**, command for command: trash is reversible with
//!    a thirty-day window and a restore past it is refused, archive is *keep
//!    forever, hide from lists*, a purge takes the sidecars with it, a star is
//!    a tag, and a Locker tag lives in Locker's own scheme.
//! 2. **A secret cannot reach the gateway in the clear.** Every command that
//!    stores one refuses a plaintext value with a typed refusal, refuses a
//!    write under a key generation the vault has rotated past, and refuses a
//!    seat-minted id that is taken.
//! 3. **The reveal is receipted even though the gateway cannot perform it.**
//!    `locker.reveal_receipt` writes the row the access history reads, and it
//!    refuses to name a column that is not sealed.
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
    /// A founded vault whose Locker key plane names one live generation.
    ///
    /// The `locker_key` row is written directly rather than through
    /// `custody::found_locker_key`, and that is the point of this wave: the
    /// row carries an **id and nothing else**, and no key file exists anywhere
    /// the gateway can reach. `crates/seat`'s own tests cover the minting; a
    /// command test that needed a key file would be asserting the custody
    /// these commands are written to not have.
    fn new(seed: &str, key_id: &str) -> Self {
        let scratch = common::Scratch::founded(seed).expect("a vault is founded");
        let registry = registry();
        registry
            .install(&scratch.vault)
            .expect("the record installs");
        if !key_id.is_empty() {
            scratch
                .vault
                .commit(|tx| {
                    tx.set_producer("test.fixture");
                    tx.connection().execute(
                        "INSERT INTO locker_key (key_id, created_at, retired_at)
                         VALUES (?1, '2026-01-01T00:00:00.000Z', NULL)",
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

    /// One login, sealed, through the real command path.
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
                "key_id": key_id,
                "tags": ["money", "money", " "]
            }),
        )
    }
}

// ---------------------------------------------------------------------------
// The catalogue itself.
// ---------------------------------------------------------------------------

/// TWENTY OF V0'S, PLUS TWO — and the split is asserted, not assumed.
#[test]
fn the_catalogue_is_v0s_twenty_plus_the_two_custody_adds() {
    use centraid_vault::commands::Idempotency;

    let definitions = centraid_vault::commands::locker::definitions();
    let names: Vec<&str> = definitions
        .iter()
        .map(|definition| definition.name)
        .collect();
    assert_eq!(names.len(), 22);

    // v0's twenty, by name, in `locker.ts` + `locker-extras.ts` +
    // `locker-export.ts` order.
    let v0 = [
        "locker.add_item",
        "locker.edit_item",
        "locker.trash_item",
        "locker.restore_item",
        "locker.purge_item",
        "locker.star_item",
        "locker.unstar_item",
        "locker.totp_code",
        "locker.watchtower",
        "locker.set_memo",
        "locker.archive_item",
        "locker.unarchive_item",
        "locker.duplicate_item",
        "locker.set_field",
        "locker.remove_field",
        "locker.set_addresses",
        "locker.set_passkey",
        "locker.clear_passkey",
        "locker.counts",
        "locker.export",
    ];
    for name in v0 {
        assert!(names.contains(&name), "{name} is not in the catalogue");
    }
    // The two adds, and only those two.
    let added: Vec<&&str> = names.iter().filter(|name| !v0.contains(name)).collect();
    assert_eq!(added, [&"locker.reveal_receipt", &"locker.rotate_key"]);

    // V0'S IDEMPOTENCY SPLIT, EXACTLY: 13 idempotent / 3 once / 4 retry-safe
    // over the twenty (census §A0's tally).
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
    for name in v0 {
        match class_of(name) {
            Idempotency::Idempotent => idempotent += 1,
            Idempotency::Once => once += 1,
            Idempotency::RetrySafe => retry_safe += 1,
        }
    }
    assert_eq!(
        (idempotent, once, retry_safe),
        (13, 3, 4),
        "v0's idempotency split for the locker schema moved"
    );
    // Both adds write once: a receipt per reveal and a rotation per key.
    assert_eq!(class_of("locker.reveal_receipt"), Idempotency::Once);
    assert_eq!(class_of("locker.rotate_key"), Idempotency::Once);
}

/// THE TWO CONFIRMATION GATES, KEPT DISTINCT (census §A0).
///
/// `confirm` on a definition parks a NON-OWNER invocation regardless of risk.
/// v0 carries it on exactly two of the twenty, and the census's own tally says
/// three — which is this lane's finding: the third
/// (`locker.import_secret`/`locker.rogue_probe`) exists only in
/// `packages/vault/src/gateway/sealed.test.ts` as a test fixture and is not a
/// product command. `locker.rotate_key` is the wave-4 third.
#[test]
fn exactly_two_of_v0s_twenty_park_a_non_owner_and_rotate_key_is_the_third() {
    let definitions = centraid_vault::commands::locker::definitions();
    let confirmed: Vec<&str> = definitions
        .iter()
        .filter(|definition| definition.confirm)
        .map(|definition| definition.name)
        .collect();
    assert_eq!(
        confirmed,
        ["locker.purge_item", "locker.export", "locker.rotate_key"]
    );
    // Risk is SALIENCE ONLY and never an approval trigger: `export` is high
    // risk and `purge_item` is medium, and neither is what parks them.
    let risk_of = |name: &str| {
        definitions
            .iter()
            .find(|definition| definition.name == name)
            .map(|definition| definition.risk)
            .expect("a definition")
    };
    use centraid_vault::commands::Risk;
    assert_eq!(risk_of("locker.export"), Risk::High);
    assert_eq!(risk_of("locker.purge_item"), Risk::Medium);
    assert_eq!(risk_of("locker.trash_item"), Risk::Low);
}

/// `online_only` on the command side must cover v0's five actions' commands
/// and the two adds that produce or move a secret.
#[test]
fn every_command_that_touches_a_secret_refuses_to_be_queued() {
    let definitions = centraid_vault::commands::locker::definitions();
    let online: Vec<&str> = definitions
        .iter()
        .filter(|definition| definition.online_only)
        .map(|definition| definition.name)
        .collect();
    assert_eq!(
        online,
        [
            "locker.add_item",
            "locker.edit_item",
            "locker.totp_code",
            "locker.watchtower",
            "locker.set_field",
            "locker.set_passkey",
            "locker.export",
            "locker.rotate_key",
        ]
    );
    // The eleven metadata commands queue, because a member on a train must be
    // able to trash a login.
    for name in [
        "locker.trash_item",
        "locker.restore_item",
        "locker.purge_item",
        "locker.star_item",
        "locker.unstar_item",
        "locker.archive_item",
        "locker.unarchive_item",
        "locker.duplicate_item",
        "locker.remove_field",
        "locker.set_addresses",
        "locker.clear_passkey",
        "locker.counts",
        "locker.reveal_receipt",
    ] {
        let definition = definitions
            .iter()
            .find(|definition| definition.name == name)
            .expect("a definition");
        assert!(!definition.online_only, "{name} refuses to queue");
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
    assert_eq!(sealed_of("locker.duplicate_item"), five);
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

/// A WRITE UNDER A ROTATED-PAST KEY IS REFUSED, because storing it would put a
/// row under a key nothing can open — and the gateway cannot re-seal it.
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
    // unlocking: a vault with no seats can hold a passport item's template
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

/// THE SEAT MINTS THE ID, AND THE GATEWAY STILL REFUSES A BAD ONE (D-1020-L9).
#[test]
fn a_seat_minted_id_must_be_fresh_and_well_formed() {
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
/// The gateway cannot compare two ciphertexts — a fresh nonce per value means
/// the same plaintext encrypts differently every time — so the claim is the
/// seat's and it is required rather than defaulted.
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
        "SELECT password_set_at FROM locker_item WHERE item_id = ?1",
        &["item-1"],
    );

    // A RETAG MUST NOT MAKE A THREE-YEAR-OLD PASSWORD LOOK FRESH.
    world.ok(
        "locker.edit_item",
        serde_json::json!({ "item_id": "item-1", "tags": ["rotated"] }),
    );
    let after: String = world.one(
        "SELECT password_set_at FROM locker_item WHERE item_id = ?1",
        &["item-1"],
    );
    assert_eq!(before, after, "a retag re-stamped the password's age");

    // A round-tripped placeholder means "leave the secret alone" and is not a
    // rotation either.
    world.ok(
        "locker.edit_item",
        serde_json::json!({ "item_id": "item-1", "password": "«sealed»" }),
    );
    let untouched: String = world.one(
        "SELECT password FROM locker_item WHERE item_id = ?1",
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
            "password": ciphertext("rotated"),
            "password_rotated": true,
            "key_id": "key-1"
        }),
    );
    assert_eq!(output["rotated"], serde_json::json!(true));
    let rotated: String = world.one(
        "SELECT password_set_at FROM locker_item WHERE item_id = ?1",
        &["item-1"],
    );
    assert_ne!(before, rotated, "a real rotation did not re-stamp the age");
}

// ---------------------------------------------------------------------------
// The lifecycle, which did not change.
// ---------------------------------------------------------------------------

#[test]
fn trash_is_reversible_and_a_lapsed_window_is_not() {
    let world = World::new("locker-trash", "key-1");
    world.login("item-1", "key-1");

    world.ok(
        "locker.trash_item",
        serde_json::json!({ "item_id": "item-1" }),
    );
    let purge_at: String = world.one(
        "SELECT purge_at FROM locker_item WHERE item_id = ?1",
        &["item-1"],
    );
    assert!(purge_at > world.scratch.clock.now_text());

    world.ok(
        "locker.restore_item",
        serde_json::json!({ "item_id": "item-1" }),
    );
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM locker_item WHERE item_id = ?1 AND deleted_at IS NULL",
            &["item-1"]
        ),
        1
    );

    // A RESTORE PAST THE WINDOW RESURRECTS WHAT THE MEMBER WAS TOLD HAD BEEN
    // DELETED (#916, review 1.5).
    world.ok(
        "locker.trash_item",
        serde_json::json!({ "item_id": "item-1" }),
    );
    world.scratch.clock.advance_ms(31 * 86_400_000);
    let reason = world.refused(
        "locker.restore_item",
        serde_json::json!({ "item_id": "item-1" }),
    );
    assert!(reason.contains("30 days have run out"), "{reason}");
}

#[test]
fn archive_is_not_trash_and_carries_no_purge_date() {
    let world = World::new("locker-archive", "key-1");
    world.login("item-1", "key-1");
    world.ok(
        "locker.archive_item",
        serde_json::json!({ "item_id": "item-1" }),
    );
    let purge_at: Option<String> = world.one(
        "SELECT purge_at FROM locker_item WHERE item_id = ?1",
        &["item-1"],
    );
    assert_eq!(purge_at, None, "archive set a purge date");
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM locker_item
              WHERE item_id = ?1 AND archived_at IS NOT NULL AND deleted_at IS NULL",
            &["item-1"]
        ),
        1
    );
    world.ok(
        "locker.unarchive_item",
        serde_json::json!({ "item_id": "item-1" }),
    );
    let archived_at: Option<String> = world.one(
        "SELECT archived_at FROM locker_item WHERE item_id = ?1",
        &["item-1"],
    );
    assert_eq!(archived_at, None);
}

/// A PURGE TAKES THE SIDECARS, THE TAGS AND THE MEMO WITH IT, explicitly —
/// because a cascade fires no `AFTER DELETE` trigger unless
/// `recursive_triggers` is on, and an offline phone would keep rows whose item
/// is gone.
#[test]
fn a_purge_deletes_every_sidecar_in_the_same_transaction() {
    let world = World::new("locker-purge", "key-1");
    world.login("item-1", "key-1");
    world.ok(
        "locker.star_item",
        serde_json::json!({ "item_id": "item-1" }),
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
        "locker.purge_item",
        serde_json::json!({ "item_id": "item-1" }),
    );
    for (table, column) in [
        ("locker_item", "item_id"),
        ("locker_item_field", "item_id"),
        ("locker_item_address", "item_id"),
        ("locker_item_passkey", "item_id"),
        ("locker_item_alias", "item_id"),
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
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM core_tag WHERE target_id = ?1",
            &["item-1"]
        ),
        0,
        "core_tag is polymorphic and no CASCADE reaches it"
    );
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM knowledge_annotation WHERE target_id = ?1",
            &["item-1"]
        ),
        0
    );
}

/// A STAR IS A TAG AND A LOCKER TAG IS LOCKER'S OWN (#274, #310).
#[test]
fn a_star_is_a_flags_tag_and_a_label_is_a_locker_tag() {
    let world = World::new("locker-tags", "key-1");
    world.login("item-1", "key-1");
    world.ok(
        "locker.star_item",
        serde_json::json!({ "item_id": "item-1" }),
    );

    let flags: i64 = world.one(
        "SELECT COUNT(*) FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_id = ?1 AND s.uri = 'https://centraid.dev/schemes/flags'",
        &["item-1"],
    );
    assert_eq!(flags, 1);
    // Locker's own scheme, not the shared `centraid:tags:v1` one: labels are
    // as private as the item, and they never appear in another app's rail.
    let locker: i64 = world.one(
        "SELECT COUNT(*) FROM core_tag t
           JOIN core_concept c ON c.concept_id = t.concept_id
           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
          WHERE t.target_id = ?1 AND s.uri = 'https://centraid.dev/schemes/locker-tags'",
        &["item-1"],
    );
    // "money" twice and a blank one: deduplicated and trimmed away.
    assert_eq!(locker, 1);
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM core_concept_scheme WHERE uri = 'centraid:tags:v1'",
            &[]
        ),
        0,
        "a Locker tag reached the shared tags scheme"
    );

    // Unstarring removes the flag and leaves the label.
    world.ok(
        "locker.unstar_item",
        serde_json::json!({ "item_id": "item-1" }),
    );
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM core_tag t
               JOIN core_concept c ON c.concept_id = t.concept_id
               JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
              WHERE t.target_id = ?1 AND s.uri = 'https://centraid.dev/schemes/flags'",
            &["item-1"]
        ),
        0
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

/// A DUPLICATE CARRIES THE SEAT'S RE-SEALED CELLS AND NOT THE ALIAS.
#[test]
fn a_duplicate_takes_the_re_sealed_cells_and_leaves_the_alias_behind() {
    let world = World::new("locker-duplicate", "key-1");
    world.login("item-1", "key-1");
    world.ok(
        "locker.edit_item",
        serde_json::json!({ "item_id": "item-1", "alias": "bank" }),
    );
    world.ok(
        "locker.star_item",
        serde_json::json!({ "item_id": "item-1" }),
    );
    world.ok(
        "locker.set_addresses",
        serde_json::json!({
            "item_id": "item-1",
            "addresses": [{ "url": "https://m.bank.example", "match_policy": "exact-host" }]
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
    // The COPY's ciphertext is the seat's, sealed against the new row.
    assert_eq!(
        world.one::<String>(
            "SELECT password FROM locker_item WHERE item_id = ?1",
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
            "SELECT COUNT(*) FROM core_tag t
               JOIN core_concept c ON c.concept_id = t.concept_id
               JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
              WHERE t.target_id = ?1 AND s.uri = 'https://centraid.dev/schemes/flags'",
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
            "SELECT COUNT(*) FROM core_tag WHERE target_id = ?1",
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

/// A SEALED CUSTOM FIELD NEEDS THE SEAT'S ID; A PLAIN ONE DOES NOT.
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
    // A PLAIN field's id may be the gateway's, because nothing is sealed
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

/// WATCHTOWER ANSWERS ADDRESSES, NOT SCORES (D-1020-L6), and its row set is
/// v0's row set — archived items in, secret-free notes out.
#[test]
fn watchtower_answers_the_row_set_and_receipts_the_reveal() {
    let world = World::new("locker-watchtower", "key-1");
    world.login("item-1", "key-1");
    world.ok(
        "locker.add_item",
        serde_json::json!({ "item_id": "item-2", "type": "note", "title": "A note" }),
    );
    world.ok(
        "locker.add_item",
        serde_json::json!({ "item_id": "item-3", "type": "wifi", "title": "Home wifi" }),
    );
    world.ok(
        "locker.add_item",
        serde_json::json!({
            "item_id": "item-4",
            "type": "card",
            "title": "The card",
            "card_number": ciphertext("item-4"),
            "key_id": "key-1"
        }),
    );
    world.ok(
        "locker.archive_item",
        serde_json::json!({ "item_id": "item-4" }),
    );

    let output = world.ok("locker.watchtower", serde_json::json!({}));
    let rows = output["rows"].as_array().expect("rows");
    let ids: Vec<&str> = rows
        .iter()
        .filter_map(|row| row["item_id"].as_str())
        .collect();
    // The login and the ARCHIVED card are in; the note is not, and neither is
    // the wifi item, because it has no password.
    assert_eq!(ids, ["item-1", "item-4"]);
    assert_eq!(output["derived_on"], serde_json::json!("seat"));
    assert!(
        output["receipt_id"]
            .as_str()
            .is_some_and(|id| !id.is_empty())
    );

    // The receipt the access history reads.
    let kind: String = world.one(
        "SELECT json_extract(detail_json, '$.context.derivation') FROM access_receipt
          WHERE object_type = 'locker.item' ORDER BY seq DESC LIMIT 1",
        &[],
    );
    assert_eq!(kind, "watchtower");
}

/// THE RECEIPT A SEAT-SIDE REVEAL OWES (D-1020-L3), and the two refusals that
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
            "kind": "fill",
            "origin": "https://bank.example"
        }),
    );
    let (object_type, object_id, origin): (String, String, String) = world
        .scratch
        .vault
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT object_type, object_id,
                        json_extract(detail_json, '$.context.origin')
                   FROM access_receipt WHERE action = 'reveal locker.item'
                  ORDER BY seq DESC LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )?)
        })
        .expect("the receipt is there");
    assert_eq!(object_type, "locker.item");
    assert_eq!(object_id, "item-1");
    assert_eq!(origin, "https://bank.example");

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

    // A fill happened on a page, and the receipt names which one.
    let reason = world.refused(
        "locker.reveal_receipt",
        serde_json::json!({
            "object_type": "locker.item",
            "item_id": "item-1",
            "columns": ["password"],
            "kind": "fill"
        }),
    );
    assert!(reason.contains("names which one"), "{reason}");

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
            "SELECT COUNT(*) FROM access_receipt
              WHERE object_type = 'locker.auth' AND object_id IS NULL",
            &[]
        ),
        1
    );
}

/// ROTATION IS ONE BATCH OR IT IS NOTHING (D-1020-L4).
#[test]
fn a_rotation_applies_every_cell_or_refuses() {
    let world = World::new("locker-rotate", "key-1");
    world.login("item-1", "key-1");
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

    // A BATCH THAT LEAVES A CELL BEHIND IS REFUSED, and the vault still names
    // one live key — the old one.
    let reason = world.refused(
        "locker.rotate_key",
        serde_json::json!({
            "key_id": "key-2",
            "previous_key_id": "key-1",
            "cells": [{
                "table": "locker_item",
                "row_id": "item-1",
                "column": "password",
                "value": ciphertext("item-1-k2")
            }]
        }),
    );
    assert!(
        reason.contains("the whole vault or it is nothing"),
        "{reason}"
    );
    assert_eq!(
        world.one::<String>(
            "SELECT key_id FROM locker_key WHERE retired_at IS NULL",
            &[]
        ),
        "key-1",
        "a refused rotation moved the live key"
    );
    assert_eq!(
        world.one::<i64>("SELECT COUNT(*) FROM locker_key", &[]),
        1,
        "a refused rotation left a key row behind"
    );

    // THE WHOLE BATCH.
    let output = world.ok(
        "locker.rotate_key",
        serde_json::json!({
            "key_id": "key-2",
            "previous_key_id": "key-1",
            "cells": [
                {
                    "table": "locker_item",
                    "row_id": "item-1",
                    "column": "password",
                    "value": ciphertext("item-1-k2")
                },
                {
                    "table": "locker_item_field",
                    "row_id": "field-1",
                    "column": "value_sealed",
                    "value": ciphertext("field-1-k2")
                }
            ]
        }),
    );
    assert_eq!(output["cells"], serde_json::json!(2));
    assert_eq!(
        world.one::<String>(
            "SELECT key_id FROM locker_key WHERE retired_at IS NULL",
            &[]
        ),
        "key-2"
    );
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM locker_key WHERE retired_at IS NOT NULL",
            &[]
        ),
        1
    );
    assert_eq!(
        world.one::<String>(
            "SELECT key_id FROM locker_item WHERE item_id = ?1",
            &["item-1"]
        ),
        "key-2"
    );

    // AT NO POINT ARE TWO ROWS LIVE, and the index is what says so.
    assert_eq!(
        world.one::<i64>(
            "SELECT COUNT(*) FROM locker_key WHERE retired_at IS NULL",
            &[]
        ),
        1
    );

    // A ROTATION FROM A KEY THAT IS NOT LIVE IS TWO SEATS ROTATING AT ONCE.
    let reason = world.refused(
        "locker.rotate_key",
        serde_json::json!({
            "key_id": "key-3",
            "previous_key_id": "key-1",
            "cells": []
        }),
    );
    assert!(reason.contains("another seat rotated first"), "{reason}");

    // A plaintext cell in a rotation is refused like anywhere else.
    let reason = world.refused(
        "locker.rotate_key",
        serde_json::json!({
            "key_id": "key-3",
            "previous_key_id": "key-2",
            "cells": [{
                "table": "locker_item",
                "row_id": "item-1",
                "column": "password",
                "value": "plaintext"
            }]
        }),
    );
    assert!(reason.contains("is not sealed"), "{reason}");

    // And a cell outside the registry — ciphertext into `title` — is refused
    // by the schema itself, before the handler runs.
    let outcome = world.run(
        "locker.rotate_key",
        serde_json::json!({
            "key_id": "key-3",
            "previous_key_id": "key-2",
            "cells": [{
                "table": "locker_item",
                "row_id": "item-1",
                "column": "title",
                "value": ciphertext("evil")
            }]
        }),
    );
    assert_eq!(outcome.status, CommandStatus::Failed);
    assert!(
        outcome
            .reason
            .unwrap_or_default()
            .contains("not a cell sealed under K")
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
        "locker.archive_item",
        serde_json::json!({ "item_id": "item-2" }),
    );
    world.ok(
        "locker.trash_item",
        serde_json::json!({ "item_id": "item-3" }),
    );

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
    // answer, only the addresses the seat unseals.
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
    assert_eq!(output["unseals_on"], serde_json::json!("seat"));

    // And the one receipt a mass reveal owes.
    let columns: String = world.one(
        "SELECT json_extract(detail_json, '$.context.derivation') FROM access_receipt
          WHERE action = 'reveal locker.export' ORDER BY seq DESC LIMIT 1",
        &[],
    );
    assert_eq!(columns, "export");
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
    assert_eq!(output["derived_on"], serde_json::json!("seat"));
    // The digits are NOT here: the gateway cannot compute them.
    assert!(output.get("code").is_none());
}
