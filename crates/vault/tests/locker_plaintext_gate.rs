//! THE LOCKER PLAINTEXT GATE — *nothing the vault serves, backs up or keeps on
//! disk carries the plaintext of an `lk1:` cell* (#1020, D-1020-L5; #1047,
//! D-6).
//!
//! `K` is the 24 words' own leaf, derived by the core at open and held only in
//! its memory; this crate never holds it, and the laptop's gateway stores only
//! sealed backup objects. So the claim that the gateway cannot produce Locker
//! plaintext rests on two legs: `K` is nowhere on disk (asserted in
//! `crates/core/src/app_query/locker_tests.rs` and
//! `crates/identity/src/derive.rs`), and **the artefacts that leave the vault
//! carry only ciphertext even once their own sealing is opened** — which is
//! this file.
//!
//! ## What "cannot produce plaintext" is asserted over
//!
//! A real founded vault with real sealed cells, sealed here with a key that is
//! never written anywhere, and then: `keyset_page` over every sealed table,
//! the `locker.*` command surface including `export` and the two derivations,
//! the pre-migration snapshot, the backup snapshot's parts (sealed **and**
//! opened), and the vault file with its WAL and SHM. Every answer is searched for every planted
//! plaintext as a raw byte run, because a structured payload could carry one
//! without spelling it.
//!
//! #1020's structural and binary halves — a source scan for member-key-file
//! readers and an `nm` over the operator binary — are deleted with the
//! multi-seat file custody they policed (#1047 slice D1): there is no key file
//! for a reader to open.
//!
//! ## The search index
//!
//! A Locker item is indexed by its plain fields (its title, username, address,
//! aliases, notes ...), so the gate is not "the index holds nothing of Locker"
//! but "the index holds nothing SEALED": no word of a planted sealed cell is in
//! `search_vocab`, `search_word`, the FTS5 shadow tables' bytes or `text_of`,
//! while the planted plain fields are (a positive control, so the scan cannot be
//! passing by looking nowhere).
//!
//! ## The falsification
//!
//! A search that finds nothing is the same output as a search that looks
//! nowhere, so [`the_search_fires_when_the_key_is_present`] opens the same
//! cells with `K` and asserts the searcher fires on them.

mod common;

use centraid_vault::access::Principal;
use centraid_vault::commands::{Command, CommandStatus, Registry};
use centraid_vault::custody::locker_key::{
    LOCKER_ENCRYPTED_COLUMNS, decrypt_under_locker_key, encrypt_under_locker_key,
    is_locker_ciphertext,
};
use centraid_vault::model::Kind;

/// The plaintexts planted, and the strings the gate hunts for.
///
/// Chosen to be **findable**: long, unique, and not a substring of anything a
/// payload would legitimately carry. A short plaintext that happened to appear
/// in a base64 blob would make this test pass for the wrong reason.
const PLANTED: [(&str, &str, &str, &str); 5] = [
    (
        "locker_item",
        "item-1",
        "password",
        "PLANTED-PASSWORD-zq7xk4-not-in-any-payload",
    ),
    (
        "locker_item",
        "item-1",
        "otp_seed",
        "PLANTED-OTPSEED-mv9wr2-not-in-any-payload",
    ),
    (
        "locker_item",
        "item-2",
        "card_number",
        "PLANTED-CARDNUMBER-td3hb8-not-in-any-payload",
    ),
    (
        "locker_item_field",
        "field-1",
        "value_sealed",
        "PLANTED-CUSTOMFIELD-kp5ny1-not-in-any-payload",
    ),
    (
        "locker_item_passkey",
        "item-1",
        "private_key",
        "PLANTED-PRIVATEKEY-fw2js6-not-in-any-payload",
    ),
];

/// A `K` that is written NOWHERE. It exists only inside this test process, so
/// that the cells are real ciphertext and there is something for the gate to
/// fail to produce.
fn locker_key() -> Vec<u8> {
    vec![0x5a_u8; 32]
}

struct Sealed {
    scratch: common::Scratch,
    registry: Registry,
}

impl Sealed {
    /// A founded vault with real `lk1:` cells and **no key anywhere on disk**.
    ///
    /// The cells are sealed here, in the test, with a key that is never
    /// written — which is the phone's state of affairs: the core sealed them
    /// with the `K` it derived, and the vault stores what it was given.
    fn founded() -> Self {
        let scratch =
            common::Scratch::founded("locker-plaintext-gate").expect("a vault is founded");
        let registry = Registry::with_system_commands().expect("the registry builds");
        let key = locker_key();
        scratch
            .vault
            .commit(|tx| {
                tx.set_producer("test.fixture");
                let connection = tx.connection();
                connection.execute(
                    "INSERT INTO locker_key (key_id, created_at)
                     VALUES ('key-1', '2026-01-01T00:00:00.000Z')",
                    [],
                )?;
                for (item_id, title, username, brand) in [
                    ("item-1", "The bank", "plainuser-xylophone9", None),
                    (
                        "item-2",
                        "The card",
                        "plainname-quokka7",
                        Some("plainbrand-zeppelin3"),
                    ),
                ] {
                    // A Locker item is an entity first; its kind row joins it.
                    tx.insert_entity(item_id, Kind::LockerItem, title, "2026-01-01T00:00:00.000Z")?;
                    connection.execute(
                        "INSERT INTO locker_item (id, type, username, brand, key_id)
                         VALUES (?1, 'login', ?2, ?3, 'key-1')",
                        rusqlite::params![item_id, username, brand],
                    )?;
                }
                connection.execute(
                    "INSERT INTO locker_item_alias (alias, item_id, created_at)
                     VALUES ('plainalias-narwhal5', 'item-1', '2026-01-01T00:00:00.000Z')",
                    [],
                )?;
                connection.execute(
                    "INSERT INTO locker_item_field
                       (field_id, item_id, section, label, kind, created_at, updated_at, key_id)
                     VALUES ('field-1', 'item-1', '', 'Recovery code', 'sealed',
                             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'key-1')",
                    [],
                )?;
                connection.execute(
                    "INSERT INTO locker_item_passkey
                       (item_id, rp_id, created_at, updated_at, key_id)
                     VALUES ('item-1', 'bank.example', '2026-01-01T00:00:00.000Z',
                             '2026-01-01T00:00:00.000Z', 'key-1')",
                    [],
                )?;
                for (table, row_id, column, plaintext) in PLANTED {
                    let sealed = encrypt_under_locker_key(&key, "key-1", row_id, plaintext)
                        .expect("the core seals");
                    assert!(is_locker_ciphertext(&sealed));
                    let pk = LOCKER_ENCRYPTED_COLUMNS
                        .iter()
                        .find(|(known, _, _)| *known == table)
                        .map(|(_, pk, _)| *pk)
                        .expect("the registry names the table");
                    connection.execute(
                        &format!("UPDATE {table} SET {column} = ?1 WHERE {pk} = ?2"),
                        rusqlite::params![sealed, row_id],
                    )?;
                }
                Ok(())
            })
            .expect("the sealed corpus lands");
        Self { scratch, registry }
    }

    fn run(&self, name: &str, input: serde_json::Value) -> String {
        let outcome = self
            .scratch
            .vault
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .map_or_else(
                |error| serde_json::json!({ "error": error.to_string() }),
                |outcome| {
                    serde_json::json!({
                        "status": format!("{:?}", outcome.status),
                        "output": outcome.output,
                        "reason": outcome.reason,
                    })
                },
            );
        serde_json::to_string(&outcome).expect("the answer serialises")
    }
}

/// Every planted plaintext, as a needle.
fn needles() -> Vec<&'static str> {
    PLANTED
        .iter()
        .map(|(_, _, _, plaintext)| *plaintext)
        .collect()
}

/// The digit-bearing words of each planted secret (`zq7xk4`, `mv9wr2`, ...): the
/// tokenizer splits `PLANTED-PASSWORD-zq7xk4-...` at its hyphens, so a scan for
/// the whole string cannot see a secret indexed as words. These are what the
/// index would actually hold.
fn secret_tokens() -> Vec<String> {
    needles()
        .iter()
        .flat_map(|needle| needle.split('-'))
        .filter(|token| token.chars().any(|letter| letter.is_ascii_digit()))
        .map(str::to_lowercase)
        .collect()
}

/// Assert no word of any planted secret appears in the bytes.
fn carries_no_secret_token(what: &str, answer: &[u8]) {
    let lower = answer.to_ascii_lowercase();
    for token in secret_tokens() {
        assert!(
            !contains(&lower, token.as_bytes()),
            "{what} holds `{token}`, a word of a sealed cell's plaintext"
        );
    }
}

/// Assert a door's answer carries no planted secret, as text AND as bytes.
fn carries_no_secret(what: &str, answer: &[u8]) {
    for needle in needles() {
        assert!(
            !contains(answer, needle.as_bytes()),
            "{what} produced the plaintext of a sealed cell"
        );
    }
    // And the ciphertext's own base64 is fine to carry — the vault serves and
    // backs up ciphertext **by design**, which is the other half of the premise
    // and is worth saying so this test is not read as "no Locker data leaves".
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// THE GATE.
#[test]
fn nothing_the_vault_serves_or_backs_up_carries_locker_plaintext() {
    let sealed_vault = Sealed::founded();

    // ---- 1. THE PAGED DOOR, over every sealed table -----------------------
    for (table, pk, columns) in LOCKER_ENCRYPTED_COLUMNS {
        let select: Vec<String> = std::iter::once((*pk).to_owned())
            .chain(columns.iter().map(|column| (*column).to_owned()))
            .collect();
        let page = sealed_vault
            .scratch
            .vault
            .keyset_page(&centraid_vault::page::KeysetPage {
                name: "locker.gate".to_owned(),
                select: select.clone(),
                from: (*table).to_owned(),
                predicate: None,
                binds: Vec::new(),
                sort_column: (*pk).to_owned(),
                pk_column: (*pk).to_owned(),
                descending: false,
                limit: 100,
                after: None,
                held_thumbnail: false,
                document_size: false,
            })
            .expect("the door answers");
        let rendered = format!("{:?}", page.rows);
        carries_no_secret(&format!("the paged door over {table}"), rendered.as_bytes());
        // …and it DID serve the ciphertext, so this is not passing because the
        // read returned nothing.
        assert!(
            rendered.contains("lk1:"),
            "the paged door over {table} served no ciphertext, so the assertion above is vacuous"
        );
    }

    // ---- 2. EVERY `locker.*` COMMAND THAT RETURNS BYTES -------------------
    let answers = [
        ("locker.export", serde_json::json!({ "confirm": true })),
        (
            "locker.export",
            serde_json::json!({ "confirm": true, "include_trashed": true, "include_history": true }),
        ),
        ("locker.counts", serde_json::json!({})),
        (
            "locker.totp_code",
            serde_json::json!({ "item_id": "item-1" }),
        ),
        (
            "locker.reveal_receipt",
            serde_json::json!({
                "object_type": "locker.item",
                "item_id": "item-1",
                "columns": ["password"]
            }),
        ),
        (
            "locker.duplicate_item",
            serde_json::json!({ "item_id": "item-1", "new_item_id": "item-copy" }),
        ),
        (
            "locker.edit_item",
            serde_json::json!({ "item_id": "item-1", "title": "Renamed" }),
        ),
    ];
    for (name, input) in answers {
        let answer = sealed_vault.run(name, input);
        carries_no_secret(&format!("{name}'s answer"), answer.as_bytes());
    }

    // ---- 2b. THE READERS OF EVERY ENTITY (a Locker item is one) -----------
    //
    // A Locker item is an entity, so every reader that serves "entities" is a
    // reader that could serve it. None may carry a cell, and none may carry the
    // item at all unless it is one of Locker's.
    {
        let vault = &sealed_vault.scratch.vault;
        let page_of = |name: &str, from: &str, select: &[&str], sort: &str, pk: &str| {
            vault.keyset_page(&centraid_vault::page::KeysetPage {
                name: name.to_owned(),
                select: select.iter().map(|column| (*column).to_owned()).collect(),
                from: from.to_owned(),
                predicate: None,
                binds: Vec::new(),
                sort_column: sort.to_owned(),
                pk_column: pk.to_owned(),
                descending: false,
                limit: 100,
                after: None,
                held_thumbnail: false,
                document_size: false,
            })
        };
        // keyset_page over `entity`: the vault's own owner and the seeded words,
        // and not a Locker row.
        let entities = page_of(
            "generic.entities",
            "entity",
            &["id", "kind", "title"],
            "id",
            "id",
        )
        .expect("the door answers");
        assert!(!entities.rows.is_empty(), "the entity page served nothing");
        let rendered = format!("{:?}", entities.rows);
        carries_no_secret("a generic page over entity", rendered.as_bytes());
        assert!(
            !rendered.contains("locker_item") && !rendered.contains("The bank"),
            "a generic page over entity served a Locker item: {rendered}"
        );
        // …while Locker's own read of the same table does see its items.
        let own = page_of(
            "locker.phone.shelves",
            "entity",
            &["id", "kind", "title"],
            "id",
            "id",
        )
        .expect("the door answers");
        assert!(format!("{:?}", own.rows).contains("The bank"));
        // keyset_page over `edge`: no edge that touches an item.
        sealed_vault
            .scratch
            .vault
            .commit(|tx| {
                tx.set_producer("test.fixture");
                tx.connection().execute(
                    "INSERT INTO edge (from_id, rel, to_id, created_at)
                     VALUES ('item-1', 'tagged', 'flag:starred', '2026-01-01T00:00:00.000Z')",
                    [],
                )?;
                Ok(())
            })
            .expect("a star lands");
        let edges = page_of(
            "generic.edges",
            "edge",
            &["from_id", "to_id"],
            "from_id",
            "to_id",
        )
        .expect("the door answers");
        assert!(
            edges.rows.is_empty(),
            "a generic page over edge served a Locker edge"
        );
        let own_edges = page_of(
            "locker.phone.tags",
            "edge",
            &["from_id", "to_id"],
            "from_id",
            "to_id",
        )
        .expect("the door answers");
        assert_eq!(own_edges.rows.len(), 1, "Locker's own read lost its star");
        // And a Locker TABLE is Locker's alone: a generic read is refused.
        for table in ["locker_item", "locker_item_field", "locker_item_passkey"] {
            let pk = if table == "locker_item" {
                "id"
            } else {
                "item_id"
            };
            let refused = page_of("generic.peek", table, &[pk], pk, pk);
            assert!(refused.is_err(), "a generic read of {table} was served");
        }
        // THE SEARCH INDEX holds a Locker item by its PLAIN text and by nothing
        // sealed. The scan is of the index's vocabulary, its word list (every
        // realm), `text_of`, and the raw bytes of the FTS5 shadow tables.
        vault
            .read(|connection| {
                let words: Vec<String> = connection
                    .prepare(
                        "SELECT term FROM search_vocab UNION ALL SELECT word FROM search_word",
                    )?
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                let index_text = words.join(" ");
                carries_no_secret("the search index's words", index_text.as_bytes());
                carries_no_secret_token("the search index's words", index_text.as_bytes());
                // The shadow tables, as bytes: leaf blocks, the segment index,
                // the doc sizes and the config.
                let mut shadow = Vec::new();
                for (table, column) in [
                    ("search_data", "block"),
                    ("search_docsize", "sz"),
                    ("search_idx", "term"),
                    ("search_config", "v"),
                ] {
                    for cell in connection
                        .prepare(&format!("SELECT {column} FROM {table}"))?
                        .query_map([], |row| row.get::<_, rusqlite::types::Value>(0))?
                    {
                        match cell? {
                            rusqlite::types::Value::Blob(bytes) => shadow.extend(bytes),
                            rusqlite::types::Value::Text(text) => shadow.extend(text.into_bytes()),
                            other => shadow.extend(format!("{other:?}").into_bytes()),
                        }
                    }
                }
                carries_no_secret("the search shadow tables", &shadow);
                carries_no_secret_token("the search shadow tables", &shadow);
                // POSITIVE CONTROLS: the planted PLAIN fields are findable, and
                // the scan above can see a word in these very bytes — so its
                // silence about the secrets is not a scan that looks nowhere.
                for plain in ["bank", "card", "quokka7", "zeppelin3", "narwhal5"] {
                    assert!(
                        words.iter().any(|word| word == plain),
                        "the plain word `{plain}` of a Locker item is not in the index"
                    );
                }
                assert!(
                    contains(&shadow, b"zeppelin3"),
                    "the byte scan cannot see a plain word in the shadow tables, so it proves nothing"
                );
                // text_of answers with the plain fields and nothing sealed.
                for item in ["item-1", "item-2"] {
                    let text = centraid_vault::index::text_of(connection, item, Kind::LockerItem)?
                        .expect("text_of answered for a Locker item");
                    carries_no_secret("text_of", text.as_bytes());
                    carries_no_secret_token("text_of", text.as_bytes());
                }
                // (`locker.edit_item` above REPLACED item-1's cells, so the plain
                // cells that are still there are item-1's alias and item-2's two.)
                for (item, plain) in [
                    ("item-1", "narwhal5"),
                    ("item-2", "quokka7"),
                    ("item-2", "zeppelin3"),
                ] {
                    let text = centraid_vault::index::text_of(connection, item, Kind::LockerItem)?
                        .unwrap_or_default();
                    assert!(text.contains(plain), "text_of lost `{plain}`: {text}");
                }
                // Every Locker word is filed under the locker realm, and a word
                // only Locker holds is not in the vault's.
                let in_vault: i64 = connection.query_row(
                    "SELECT COUNT(*) FROM search_word WHERE realm = 'vault'
                       AND word IN ('quokka7', 'zeppelin3', 'narwhal5')",
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(in_vault, 0, "a Locker word was filed under the vault realm");
                // The journal carried no cell (every command above ran), and a
                // Locker item has no revision to carry one.
                let journal: String = connection
                    .prepare("SELECT input || ' ' || COALESCE(detail, '') FROM journal")?
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?
                    .join("\n");
                carries_no_secret("the journal", journal.as_bytes());
                let revisions: i64 =
                    connection.query_row("SELECT COUNT(*) FROM revision", [], |row| row.get(0))?;
                assert_eq!(revisions, 0, "a Locker item left a revision");
                Ok(())
            })
            .expect("the readers answer");
    }

    // ---- 3. THE SNAPSHOT ---------------------------------------------------
    let snapshot_dir = sealed_vault.scratch.dir().join("snapshot");
    let snapshot = centraid_vault::build_snapshot(&sealed_vault.scratch.vault, &snapshot_dir)
        .expect("a snapshot is built");
    // The artefact is gzipped, so the raw file is searched AND the inflated
    // bytes are: a compressed plaintext is still a plaintext, and a scan that
    // only read the gzip would pass on a vault that shipped one.
    let bytes = std::fs::read(snapshot_dir.join(&snapshot.name)).expect("the snapshot reads");
    carries_no_secret("the snapshot (compressed)", &bytes);
    carries_no_secret("the snapshot (inflated)", &inflate(&bytes));

    // ---- 4. THE BACKUP SNAPSHOT, SEALED AND OPENED (#1080) ---------------
    //
    // A backup is the file copied page for page, cut into 64 KiB ranges, each
    // sealed as a `centraid-sealed/2` part, plus one sealed manifest. The scan
    // reads every sealed part — which would pass vacuously if the sealing were
    // ever removed — AND every opened one: a range that leaked a Locker secret
    // into the plaintext it seals is a leak the moment its key is lost.
    {
        use centraid_vault::backup::ledger::Ledger;
        use centraid_vault::backup::naming::keys_from_root;
        use centraid_vault::backup::snapshot::{self, APP};
        use centraid_vault::backup::spool::{SPOOL_CEILING_BYTES, Spool};
        use centraid_vault::backup::store::MemoryStore;

        let vault = &sealed_vault.scratch.vault;
        let keys = keys_from_root(&[0x5a; 32]);
        let ledger = Ledger::open(Ledger::path_for(vault.path())).expect("a ledger");
        let spool = Spool::open(Spool::dir_for(vault.path())).expect("a spool");
        let taken = snapshot::take(
            vault,
            &keys,
            &sealed_vault.scratch.dir().join("backup-scratch"),
            &"5a".repeat(32),
            APP,
        )
        .expect("a snapshot is taken");
        let plan = snapshot::plan(&taken, &MemoryStore::new("laptop")).expect("plans");
        let spooled = snapshot::spool(
            &taken,
            &plan,
            &spool,
            &ledger,
            &keys,
            SPOOL_CEILING_BYTES,
            1,
        )
        .expect("spools");
        assert!(
            spooled.spooled.len() > 1,
            "the ranges and the manifest are sealed"
        );
        for name in &spooled.spooled {
            let sealed = std::fs::read(spool.path(name)).expect("the part reads");
            carries_no_secret("a sealed snapshot part", &sealed);
            let plain =
                centraid_media::sealed::open_whole(&keys, name, &sealed).expect("the part opens");
            carries_no_secret("an opened snapshot part", &plain);
        }
        taken.discard().expect("the scratch copy goes");
    }

    // ---- 5. THE VAULT FILE ITSELF ----------------------------------------
    // Not a door, and the reason it is here anyway: a gate that only checked
    // the doors would pass over a vault that had a plaintext column somebody
    // forgot to seal, or a journal that kept the value an intent carried.
    let file = std::fs::read(sealed_vault.scratch.dir().join("vault.db")).expect("the file reads");
    carries_no_secret("the vault file", &file);
    for sidecar in ["vault.db-wal", "vault.db-shm"] {
        if let Ok(bytes) = std::fs::read(sealed_vault.scratch.dir().join(sidecar)) {
            carries_no_secret(sidecar, &bytes);
        }
    }
}

/// Inflate a gzipped artefact, so a compressed plaintext cannot hide from the
/// byte scan.
fn inflate(bytes: &[u8]) -> Vec<u8> {
    use std::io::Read as _;
    let mut out = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .read_to_end(&mut out)
        .expect("the artefact inflates");
    out
}

/// A LOCKER WRITE THAT CARRIES PLAINTEXT IS REFUSED, NEVER STORED PLAIN.
///
/// The other direction of the same property: the gate above says no secret
/// gets out, and this says the command plane cannot be talked into taking one
/// in. Both matter, because a vault that accepted plaintext would hold the
/// secret in its journal, its WAL and every backup of them regardless of what
/// its read doors answer.
#[test]
fn the_command_plane_cannot_be_talked_into_storing_a_plaintext_secret() {
    let sealed_vault = Sealed::founded();
    for (command, input) in [
        (
            "locker.add_item",
            serde_json::json!({
                "item_id": "item-3",
                "type": "login",
                "title": "A third",
                "password": "PLANTED-PASSWORD-zq7xk4-not-in-any-payload",
                "password_rotated": true,
                "key_id": "key-1"
            }),
        ),
        (
            "locker.edit_item",
            serde_json::json!({
                "item_id": "item-1",
                "password": "PLANTED-PASSWORD-zq7xk4-not-in-any-payload",
                "password_rotated": true,
                "key_id": "key-1"
            }),
        ),
        (
            "locker.set_field",
            serde_json::json!({
                "item_id": "item-1",
                "field_id": "field-2",
                "label": "A code",
                "kind": "sealed",
                "value": "PLANTED-CUSTOMFIELD-kp5ny1-not-in-any-payload",
                "key_id": "key-1"
            }),
        ),
    ] {
        let outcome = sealed_vault
            .scratch
            .vault
            .execute(
                &sealed_vault.registry,
                &Principal::owner("phone"),
                &Command::new(command, input),
            )
            .expect("the command plane answers");
        assert_eq!(
            outcome.status,
            CommandStatus::Failed,
            "{command} accepted a plaintext secret"
        );
    }

    // AND THE FILE HOLDS NONE OF IT — not in a row, not in the journal, not in
    // the WAL.
    let file = std::fs::read(sealed_vault.scratch.dir().join("vault.db")).expect("the file reads");
    carries_no_secret("the vault file after three refused writes", &file);
    for sidecar in ["vault.db-wal", "vault.db-shm"] {
        if let Ok(bytes) = std::fs::read(sealed_vault.scratch.dir().join(sidecar)) {
            carries_no_secret(sidecar, &bytes);
        }
    }
}

/// THE FALSIFICATION.
///
/// The gate above is a **search for plaintext**, and a search that finds
/// nothing is the same output as a search that looks nowhere. So: take the
/// same vault's own ciphertext, open it with `K`, and assert the searcher
/// **would** have failed on that output. If this test ever stops finding the
/// plaintext, `carries_no_secret` has stopped looking and every assertion
/// above it is vacuous.
#[test]
fn the_search_fires_when_the_key_is_present() {
    let sealed_vault = Sealed::founded();
    let key = locker_key();

    // The ciphertext the vault serves, read back through its own door.
    let mut opened = 0usize;
    for (table, row_id, column, plaintext) in PLANTED {
        let cell: String = sealed_vault
            .scratch
            .vault
            .read(|connection| {
                Ok(connection.query_row(
                    &format!("SELECT {column} FROM {table} WHERE rowid IN (SELECT rowid FROM {table}) AND {column} IS NOT NULL LIMIT 1"),
                    [],
                    |row| row.get(0),
                )?)
            })
            .expect("the cell reads");
        if !is_locker_ciphertext(&cell) {
            continue;
        }
        // What only the holder of `K` can do: open it.
        let Ok(revealed) = decrypt_under_locker_key(&key, "key-1", row_id, &cell) else {
            continue;
        };
        if revealed != plaintext {
            // The planted rows share columns; only the matching pair proves
            // anything, and one is enough.
            continue;
        }
        // THE SEARCHER FIRES. Asserted by catching the panic, because
        // `carries_no_secret` is an assertion and its failing IS the claim.
        let caught = std::panic::catch_unwind(|| {
            carries_no_secret("a holder of K", revealed.as_bytes());
        });
        assert!(
            caught.is_err(),
            "the searcher did not fire on {table}.{column}'s own plaintext — \
             `carries_no_secret` has stopped looking and every assertion in \
             the gate above it is vacuous"
        );
        opened += 1;
    }
    assert!(
        opened > 0,
        "no planted cell could be opened even WITH the key: the falsification \
         itself is vacuous"
    );
}
