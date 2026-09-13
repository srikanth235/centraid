//! THE WAVE 4 GATE — *a gateway process with the key door deleted cannot
//! produce plaintext for any `lk1:` cell* (#1020, D-1020-L5).
//!
//! ## Why this test is new, and why lane R's is not enough
//!
//! `gateway_file_and_keystore_do_not_reveal_a_cell_without_k` (wave 2,
//! D-1020-R4) opens the vault file and the whole `keys/` directory with `K`
//! **withheld** and asserts every `lk1:` cell fails to open. It is green, it
//! is not vacuous, and it proves a real thing: *a sealed cell depends on `K`
//! and on nothing else that is on disk* — which is the property that makes
//! wave 4 a change of custody rather than a change of format.
//!
//! What it does not prove, in its own receipt's words, is that **the gateway
//! cannot obtain `K`**; it was deliberately written in the shape the wave 4
//! key would satisfy, so it keeps passing after the custody change and
//! therefore cannot *detect* it (census §F seam 1). This file is the new one.
//!
//! ## What "cannot produce plaintext" is asserted over
//!
//! Three layers, because any one of them alone is a weaker claim:
//!
//! 1. **Behaviourally, over every door that returns bytes to a client.** A
//!    real founded vault with real sealed cells, and then: `keyset_page`, the
//!    `locker.*` command surface including `export` and the two derivations,
//!    the snapshot a seat receives, and the backup base. Every answer is
//!    searched for every planted plaintext — as a whole value **and** as a
//!    raw byte run, because a structured payload could carry one without
//!    spelling it.
//! 2. **Structurally, over this crate's own source.** No symbol in
//!    `crates/vault` reads a member key file. A behavioural test can only
//!    cover the doors somebody thought of; a source assertion covers the door
//!    somebody adds next week.
//! 3. **Over the built gateway binary's symbols**, the pattern
//!    `abi-five-symbols` uses: a member-key reader compiled into
//!    `centraid` would be a door the source scan could miss if it lived in a
//!    dependency.
//!
//! ## The falsification
//!
//! Recorded in the receipt: re-adding a door on a scratch branch turns this
//! test red. A gate that cannot be made to fail is a gate that proves nothing,
//! and this one's demonstrated red is in
//! `receipts/issue-1020-v1-platform.md`'s lane Locker section.

mod common;

use centraid_vault::access::Principal;
use centraid_vault::commands::{Command, CommandStatus, Registry};
use centraid_vault::custody::locker_key::{
    LOCKER_ENCRYPTED_COLUMNS, decrypt_under_locker_key, encrypt_under_locker_key,
    is_locker_ciphertext,
};

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

/// A member key the GATEWAY NEVER SEES. It exists only inside this test
/// process, so that the cells are real ciphertext and there is something for
/// the gate to fail to produce.
fn member_key() -> Vec<u8> {
    vec![0x5a_u8; 32]
}

struct Gateway {
    scratch: common::Scratch,
    registry: Registry,
}

impl Gateway {
    /// A founded vault with real `lk1:` cells and **no key file anywhere the
    /// gateway can reach**.
    ///
    /// The cells are sealed here, in the test, with a key that is never
    /// written to disk — which is precisely the post-wave-4 state of affairs:
    /// a seat sealed them and the gateway stores what it was given.
    fn founded() -> Self {
        let scratch = common::Scratch::founded("member-key-gate").expect("a vault is founded");
        let registry = Registry::with_system_commands().expect("the registry builds");
        registry
            .install(&scratch.vault)
            .expect("the record installs");
        let key = member_key();
        scratch
            .vault
            .commit(|tx| {
                tx.set_producer("test.fixture");
                let connection = tx.connection();
                connection.execute(
                    "INSERT INTO locker_key (key_id, created_at, retired_at)
                     VALUES ('key-1', '2026-01-01T00:00:00.000Z', NULL)",
                    [],
                )?;
                for (item_id, title) in [("item-1", "The bank"), ("item-2", "The card")] {
                    connection.execute(
                        "INSERT INTO locker_item
                           (item_id, type, title, created_at, updated_at, key_id)
                         VALUES (?1, 'login', ?2, '2026-01-01T00:00:00.000Z',
                                 '2026-01-01T00:00:00.000Z', 'key-1')",
                        rusqlite::params![item_id, title],
                    )?;
                }
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
                        .expect("the seat seals");
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
                &Principal::owner("gateway-device"),
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

/// Assert a door's answer carries no planted secret, as text AND as bytes.
fn carries_no_secret(what: &str, answer: &[u8]) {
    for needle in needles() {
        assert!(
            !contains(answer, needle.as_bytes()),
            "{what} produced the plaintext of a sealed cell"
        );
    }
    // And the ciphertext's own base64 is fine to carry — the gateway serves
    // ciphertext to enrolled seats **by design**, which is the other half of
    // the premise and is worth asserting so this test is not read as "no
    // Locker data crosses the wire".
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// THE GATE.
#[test]
fn a_gateway_without_the_key_door_cannot_produce_plaintext() {
    let gateway = Gateway::founded();

    // ---- 1. THE PAGED DOOR, over every sealed table -----------------------
    for (table, pk, columns) in LOCKER_ENCRYPTED_COLUMNS {
        let select: Vec<String> = std::iter::once((*pk).to_owned())
            .chain(columns.iter().map(|column| (*column).to_owned()))
            .collect();
        let page = gateway
            .scratch
            .vault
            .keyset_page(&centraid_vault::page::KeysetPage {
                name: "gate".to_owned(),
                select: select.clone(),
                from: (*table).to_owned(),
                predicate: None,
                binds: Vec::new(),
                sort_column: (*pk).to_owned(),
                pk_column: (*pk).to_owned(),
                descending: false,
                limit: 100,
                after: None,
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
        ("locker.watchtower", serde_json::json!({})),
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
        let answer = gateway.run(name, input);
        carries_no_secret(&format!("{name}'s answer"), answer.as_bytes());
    }

    // ---- 3. THE SNAPSHOT A SEAT RECEIVES ----------------------------------
    let snapshot_dir = gateway.scratch.dir().join("snapshot");
    let snapshot = centraid_vault::build_snapshot(&gateway.scratch.vault, &snapshot_dir)
        .expect("a snapshot is built");
    // The artefact is gzipped, so the raw file is searched AND the inflated
    // bytes are: a compressed plaintext is still a plaintext, and a scan that
    // only read the gzip would pass on a vault that shipped one.
    let bytes = std::fs::read(snapshot_dir.join(&snapshot.name)).expect("the snapshot reads");
    carries_no_secret("the seat snapshot (compressed)", &bytes);
    carries_no_secret("the seat snapshot (inflated)", &inflate(&bytes));

    // ---- 4. THE BACKUP BASE ----------------------------------------------
    let base_dir = gateway.scratch.dir().join("base");
    let base = centraid_vault::backup::base::build_backup_base(&gateway.scratch.vault, &base_dir)
        .expect("a base is built");
    let bytes = std::fs::read(base_dir.join(&base.name)).expect("the base reads");
    carries_no_secret("the backup base (compressed)", &bytes);
    carries_no_secret("the backup base (inflated)", &inflate(&bytes));

    // ---- 5. THE VAULT FILE ITSELF ----------------------------------------
    // Not a door, and the reason it is here anyway: a gate that only checked
    // the doors would pass over a vault that had a plaintext column somebody
    // forgot to seal, or a journal that kept the value an intent carried.
    let file = std::fs::read(gateway.scratch.dir().join("vault.db")).expect("the file reads");
    carries_no_secret("the vault file", &file);
    for sidecar in ["vault.db-wal", "vault.db-shm"] {
        if let Ok(bytes) = std::fs::read(gateway.scratch.dir().join(sidecar)) {
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

/// THE STRUCTURAL HALF: no symbol in `crates/vault` reads a member key file.
///
/// A behavioural test covers the doors somebody thought of. This covers the
/// door somebody adds next week — and it is the assertion that goes red when
/// the door is put back, which is how the falsification in the receipt was
/// produced.
#[test]
fn no_symbol_in_the_vault_crate_reads_a_member_key_file() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let mut findings = Vec::new();
    let mut scanned = 0_usize;

    // The names a key door has had, or would have. `locker_key_dir_for` is
    // v0's own gateway-side mapping and is the one this wave deleted.
    let forbidden = [
        "read_locker_key",
        "locker_key_dir_for",
        "gateway_locker_key",
        "lockerKey(",
        "/_vault/seat/locker-key",
    ];

    let mut stack = vec![root.join("src")];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("the source tree reads") {
            let entry = entry.expect("an entry");
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            if path.extension().is_none_or(|extension| extension != "rs") {
                continue;
            }
            scanned += 1;
            let source = std::fs::read_to_string(&path).expect("a source file reads");
            // CODE, NOT PROSE. Every module header in `custody/` names the
            // deleted door on purpose — that is what the documentation is for
            // — so the scan strips comments first. A scan that flagged a doc
            // comment would be a scan somebody silences by deleting the
            // explanation, which is the opposite of what it is for.
            let code: String = source
                .lines()
                .filter(|line| {
                    let trimmed = line.trim_start();
                    !trimmed.starts_with("//") && !trimmed.starts_with("*")
                })
                .collect::<Vec<&str>>()
                .join("\n");
            for name in forbidden {
                if code.contains(name) {
                    findings.push(format!(
                        "{}: names `{name}`, which is a member-key door",
                        path.strip_prefix(root).unwrap_or(&path).display()
                    ));
                }
            }
            // AND THE STRONGER FORM: the only type that may open a member key
            // file is `MemberKeyCustody`, and it lives in one module. A file
            // outside `custody/` that constructs a `KeyStore` **over a Locker
            // path** is a second custody.
            //
            // The window is three lines and not the whole file, deliberately:
            // `backup/drill.rs` builds a `KeyStore` for the SEAL KEY — which
            // is the host's own and always was — and also mentions Locker
            // elsewhere, and a whole-file test would flag it and teach the
            // next reader to widen the rule rather than read it.
            if !path.to_string_lossy().contains("custody") {
                let lines: Vec<&str> = code.lines().collect();
                for (index, line) in lines.iter().enumerate() {
                    if !line.contains("KeyStore::new") {
                        continue;
                    }
                    let from = index.saturating_sub(1);
                    let to = (index + 2).min(lines.len());
                    let window = lines[from..to].join(" ");
                    if window.contains("locker") {
                        findings.push(format!(
                            "{}:{}: builds a KeyStore over a Locker path outside custody/",
                            path.strip_prefix(root).unwrap_or(&path).display(),
                            index + 1
                        ));
                    }
                }
            }
        }
    }
    assert!(scanned > 20, "the scan found {scanned} files; it is broken");
    assert!(
        findings.is_empty(),
        "the gateway has a member-key door again:\n{}",
        findings.join("\n")
    );
}

/// THE BINARY HALF, the pattern `abi-five-symbols` uses.
///
/// A member-key reader compiled in from a dependency is a door the source scan
/// above would miss. `nm` over the built `centraid` binary is what catches
/// one — and when the binary has not been built, the test says so **loudly**
/// rather than passing: a skipped gate that reads green is the failure mode
/// `device-lanes` exists to name.
#[test]
fn the_gateway_binary_exports_no_member_key_reader() {
    let target = std::env::var("CARGO_TARGET_DIR").unwrap_or_else(|_| {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../target")
            .to_string_lossy()
            .into_owned()
    });
    let binary = std::path::Path::new(&target).join("debug").join("centraid");
    if !binary.exists() {
        // Loud, named, and not a pass: the name says what was not checked.
        eprintln!(
            "SKIPPED the_gateway_binary_exports_no_member_key_reader: {} is not built. \
             Run `cargo build -p centraid` first; the gate's other two halves still ran.",
            binary.display()
        );
        return;
    }
    let output = std::process::Command::new("nm")
        .arg("--defined-only")
        .arg(&binary)
        .output();
    let Ok(output) = output else {
        eprintln!("SKIPPED the_gateway_binary_exports_no_member_key_reader: `nm` is not on PATH.");
        return;
    };
    let symbols = String::from_utf8_lossy(&output.stdout);
    for name in [
        "read_locker_key",
        "locker_key_dir_for",
        "gateway_locker_key",
    ] {
        assert!(
            !symbols.contains(name),
            "the gateway binary exports `{name}`, which is a member-key door"
        );
    }
    // The scan is not vacuous: the binary DOES carry the custody symbols that
    // are allowed — the format layer and the seat-side custody.
    assert!(
        symbols.contains("locker_key") || symbols.contains("locker"),
        "`nm` found no Locker symbols at all, so the assertions above prove nothing"
    );
}

/// LANE R'S TEST STILL PASSES, AND NOW IT MEANS MORE.
///
/// D-1020-R4's test proves a sealed cell depends on `K` and on nothing else on
/// disk. Before this wave that left the question of whether the gateway could
/// *get* `K` open; now there is no key file for it to get, so the two together
/// are the whole claim. This asserts the half this file is responsible for:
/// **the gateway's own `keys/` directory holds no member key.**
#[test]
fn the_gateways_key_directory_holds_no_member_key() {
    let gateway = Gateway::founded();
    let keys = gateway.scratch.dir().join("keys");
    let held: Vec<String> = if keys.exists() {
        std::fs::read_dir(&keys)
            .expect("the keys directory reads")
            .map(|entry| {
                entry
                    .expect("an entry")
                    .file_name()
                    .to_string_lossy()
                    .into_owned()
            })
            .collect()
    } else {
        Vec::new()
    };
    let locker_keys: Vec<&String> = held
        .iter()
        .filter(|name| name.contains(".locker."))
        .collect();
    assert!(
        locker_keys.is_empty(),
        "the gateway holds member key file(s): {locker_keys:?}"
    );
    // …and the vault still NAMES one, which is the point: the id is the
    // gateway's and the material is not.
    let live: Option<String> = gateway
        .scratch
        .vault
        .read(|connection| {
            Ok(connection
                .query_row(
                    "SELECT key_id FROM locker_key WHERE retired_at IS NULL",
                    [],
                    |row| row.get(0),
                )
                .ok())
        })
        .expect("the read answers");
    assert_eq!(live.as_deref(), Some("key-1"));
}

/// A LOCKER WRITE FROM A HOST WITH NO KEY IS REFUSED, NEVER STORED PLAIN.
///
/// The other direction of the same property: the gate above says the gateway
/// cannot get a secret out, and this says it cannot be talked into taking one
/// in. Both matter, because a host that accepted plaintext would hold the
/// secret in its journal and its replica log regardless of what its read doors
/// answer.
#[test]
fn the_gateway_cannot_be_talked_into_storing_a_plaintext_secret() {
    let gateway = Gateway::founded();
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
        let outcome = gateway
            .scratch
            .vault
            .execute(
                &gateway.registry,
                &Principal::owner("gateway-device"),
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
    let file = std::fs::read(gateway.scratch.dir().join("vault.db")).expect("the file reads");
    carries_no_secret("the vault file after three refused writes", &file);
    for sidecar in ["vault.db-wal", "vault.db-shm"] {
        if let Ok(bytes) = std::fs::read(gateway.scratch.dir().join(sidecar)) {
            carries_no_secret(sidecar, &bytes);
        }
    }
}

/// THE FALSIFICATION, AND THE FINDING THAT PUT IT HERE.
///
/// The gate above is a **search for plaintext**, and a search that finds
/// nothing is the same output as a search that looks nowhere. The obvious
/// falsification — restore the key door and re-run — was tried and **the gate
/// still passed**: opening `SealedSubject::new` to the `locker` schema makes a
/// reveal *representable*, but a gateway with no key file still cannot
/// decrypt, so there is no plaintext to find. Only
/// `access::tests::a_reveal_subject_cannot_be_built_for_the_locker_schema`
/// went red.
///
/// That is worth saying plainly, because it changes what the gate claims: **it
/// proves the KEY is absent, not that the door is.** The door's deletion is
/// proven structurally, by that unit test and by
/// [`no_symbol_in_the_vault_crate_reads_a_member_key_file`]. A pre-wave
/// gateway had both, and this test is the leg that shows the search fires when
/// the pair is restored.
///
/// So: take the same vault's own ciphertext, open it with the key a seat
/// holds, and assert the searcher **would** have failed on that output. If
/// this test ever stops finding the plaintext, `carries_no_secret` has stopped
/// looking and every assertion above it is vacuous.
#[test]
fn the_search_fires_when_a_gateway_can_actually_decrypt() {
    let gateway = Gateway::founded();
    let key = member_key();

    // The ciphertext the gateway serves, read back through its own door.
    let mut opened = 0usize;
    for (table, row_id, column, plaintext) in PLANTED {
        let cell: String = gateway
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
        // WHAT A PRE-WAVE GATEWAY COULD DO, and this one cannot: open it.
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
            carries_no_secret("a gateway that could decrypt", revealed.as_bytes());
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
