//! THE LOCKER PLAINTEXT GATE: nothing the vault serves, backs up, indexes, notifies or keeps on
//! disk carries the plaintext of a sealed value (#1020, #1047, #1214 K4).
//!
//! `K` is a test constant written nowhere; the vault holds ciphertext only. A real vault is built
//! THROUGH THE COMMANDS with a planted plaintext in EVERY built-in secret key of all fifteen
//! types ([`locker::secret_keys`], so a key added to the table is planted the moment it exists), a
//! custom sealed field, a custom one-time-code field, a passkey's private key, and a sealed file
//! (its name, its media type and its bytes). Then every door that returns bytes, the index and
//! its word lists, the history, a notification, the backup's parts (sealed and opened), the vault
//! file with its WAL and the content store are searched for every planted plaintext as a raw byte
//! run (and, for the index, as the words a tokenizer would make of it). Positive controls and a
//! falsification (the cells DO open under `K`) show the scan is not looking nowhere.

mod common;

use std::collections::BTreeSet;

use centraid_vault::commands::locker::{self, reads};
use centraid_vault::custody::decrypt_under_locker_key;
use centraid_vault::custody::sealed_file::SealReader;
use common::locker::{K, add, id_of, item_id, key_id, plain, seal, secret, world};
use serde_json::{Value, json};

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

struct Planted {
    /// `(table, row id, plaintext)` of every ciphertext cell planted.
    cells: Vec<(&'static str, String, String)>,
    /// The words a tokenizer makes of each plaintext (the digit-bearing ones).
    tokens: Vec<String>,
    /// What the file held, as bytes.
    file_plain: Vec<u8>,
    items: Vec<String>,
}

impl Planted {
    fn needles(&self) -> Vec<&str> {
        self.cells
            .iter()
            .map(|(_, _, plaintext)| plaintext.as_str())
            .collect()
    }

    fn silent(&self, what: &str, bytes: &[u8]) {
        for needle in self.needles() {
            assert!(
                !contains(bytes, needle.as_bytes()),
                "{what} produced the plaintext `{needle}`"
            );
        }
        assert!(
            !contains(bytes, &self.file_plain[..64]),
            "{what} produced the plaintext of a sealed file"
        );
        let lower = bytes.to_ascii_lowercase();
        for token in &self.tokens {
            assert!(
                !contains(&lower, token.as_bytes()),
                "{what} holds the word `{token}` of a secret"
            );
        }
    }
}

fn plant(w: &common::world::World) -> Planted {
    let live = key_id(w);
    let mut planted = Planted {
        cells: Vec::new(),
        tokens: Vec::new(),
        file_plain: (0..4096_u32)
            .flat_map(|n| format!("PLANTED-FILE-{n:05}-qz9;").into_bytes())
            .collect(),
        items: Vec::new(),
    };
    let mut keys_seen = BTreeSet::new();
    for item_type in locker::ITEM_TYPES {
        let item = item_id(w);
        let mut fields = vec![plain("notes", &format!("plainmemo-{item_type}"))];
        for key in locker::secret_keys_of(item_type) {
            let plaintext = format!(
                "PLANTED-{}-{}-zq7xk4w{}",
                item_type.to_uppercase(),
                key.to_uppercase(),
                planted.cells.len()
            );
            fields.push(secret(w, &item, key, &plaintext));
            planted
                .tokens
                .push(format!("zq7xk4w{}", planted.cells.len()));
            planted
                .cells
                .push(("locker_item_field", id_of(&item, key), plaintext));
            keys_seen.insert(key);
        }
        add(w, &item, item_type, &format!("The {item_type}"), fields);
        planted.items.push(item);
    }
    assert_eq!(
        keys_seen,
        locker::secret_keys().into_iter().collect::<BTreeSet<_>>(),
        "every built-in secret key is planted"
    );
    // A custom sealed field, a custom one-time-code field, a passkey and a sealed file, on item 0.
    let item = planted.items[0].clone();
    let (sealed_id, otp_id, passkey_id, file_id) = (
        "custom-sealed-1".to_owned(),
        "custom-otp-1".to_owned(),
        w.mint(),
        "sealed-file-1".to_owned(),
    );
    let sealed_plain = "PLANTED-CUSTOMFIELD-kp5ny1v1".to_owned();
    let otp_plain = "PLANTED-OTPFIELD-bn8qc3v2".to_owned();
    let key_plain = "PLANTED-PRIVATEKEY-fw2js6v3".to_owned();
    let name_plain = "PLANTED-FILENAME-hd4mt8v4.pdf".to_owned();
    for (id, kind, label, plaintext) in [
        (&sealed_id, "sealed", "Recovery code", &sealed_plain),
        (&otp_id, "otp", "Backup code", &otp_plain),
    ] {
        w.ok(
            "locker.set_field",
            json!({ "item_id": item, "field_id": id, "label": label, "kind": kind,
                    "value": seal(w, id, plaintext), "key_id": live }),
        );
        planted
            .cells
            .push(("locker_item_field", id.clone(), plaintext.clone()));
    }
    w.ok(
        "locker.set_passkey",
        json!({ "item_id": item, "passkey_id": passkey_id, "rp_id": "bank.example",
                "private_key": seal(w, &passkey_id, &key_plain), "key_id": live }),
    );
    planted
        .cells
        .push(("locker_item_passkey", passkey_id, key_plain));
    let sealed_bytes = {
        let mut sealer = SealReader::new(&planted.file_plain[..], &K, &live, &file_id).unwrap();
        let mut out = Vec::new();
        std::io::Read::read_to_end(&mut sealer, &mut out).unwrap();
        out
    };
    let hash = w.vault().blobs().unwrap().put(&sealed_bytes).unwrap();
    let meta = format!("{{\"name\":\"{name_plain}\",\"media_type\":\"application/pdf\"}}");
    w.ok(
        "locker.set_field",
        json!({ "item_id": item, "field_id": file_id, "label": "Scan", "kind": "file",
                "value": seal(w, &file_id, &meta), "blob": hash, "key_id": live }),
    );
    planted.cells.push(("locker_item_field", file_id, meta));
    planted.cells.push(("name", String::new(), name_plain));
    for token in ["kp5ny1v1", "bn8qc3v2", "fw2js6v3", "hd4mt8v4"] {
        planted.tokens.push(token.to_owned());
    }
    // A reminder on a dated field, for the notification.
    w.ok(
        "locker.edit_item",
        json!({ "item_id": planted.items[8], "fields": [plain("expires", "2031-05-04")] }),
    );
    planted
}

#[test]
fn nothing_the_vault_serves_indexes_notifies_or_backs_up_carries_locker_plaintext() {
    let w = world("locker-plaintext-gate");
    let planted = plant(&w);
    let vault = w.vault();

    // 1. The paged door over every sealed table: it serves ciphertext, never the plaintext.
    for (table, pk, columns) in centraid_vault::custody::locker_key::LOCKER_ENCRYPTED_COLUMNS {
        let page = vault
            .keyset_page(&centraid_vault::page::KeysetPage {
                name: "locker.gate".to_owned(),
                select: std::iter::once((*pk).to_owned())
                    .chain(columns.iter().map(|c| (*c).to_owned()))
                    .collect(),
                from: (*table).to_owned(),
                predicate: None,
                binds: Vec::new(),
                sort_column: (*pk).to_owned(),
                pk_column: (*pk).to_owned(),
                descending: false,
                limit: 200,
                after: None,
                held_thumbnail: false,
                document_size: false,
            })
            .expect("the door answers");
        let rendered = format!("{:?}", page.rows);
        planted.silent(&format!("the paged door over {table}"), rendered.as_bytes());
        assert!(
            rendered.contains("lk1:"),
            "{table}: no ciphertext served, so the scan is vacuous"
        );
        // A read that is not Locker's cannot name a sealed column at all.
        let refused = vault.keyset_page(&centraid_vault::page::KeysetPage {
            name: "generic.peek".to_owned(),
            select: vec![(*pk).to_owned(), columns[0].to_owned()],
            from: (*table).to_owned(),
            predicate: None,
            binds: Vec::new(),
            sort_column: (*pk).to_owned(),
            pk_column: (*pk).to_owned(),
            descending: false,
            limit: 10,
            after: None,
            held_thumbnail: false,
            document_size: false,
        });
        assert!(
            refused.is_err(),
            "a generic read of {table}.{} was served",
            columns[0]
        );
    }

    // 2. Every Locker command that returns bytes, and the reads.
    let item = planted.items[0].clone();
    let reminder = w.ok(
        "reminder.add",
        json!({ "entity_id": planted.items[8], "field_id": id_of(&planted.items[8], "expires"), "offset_min": 0 }),
    )["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let answers: Vec<Value> = vec![
        w.ok(
            "locker.export",
            json!({ "confirm": true, "device_passcode": true, "include_trashed": true }),
        ),
        w.ok("locker.counts", json!({})),
        w.ok("locker.mark_used", json!({ "item_id": item })),
        w.ok("locker.totp_code", json!({ "item_id": item })),
        w.ok(
            "locker.edit_item",
            json!({ "item_id": item, "title": "Renamed" }),
        ),
        w.ok(
            "locker.duplicate_item",
            json!({ "item_id": item, "new_item_id": w.mint() }),
        ),
    ];
    for answer in &answers {
        planted.silent("a locker command's answer", answer.to_string().as_bytes());
    }
    // The refusals of plaintext say nothing of it either.
    let refusal = w.refused(
        "locker.set_field",
        json!({ "item_id": item, "field_key": "password", "value": "PLANTED-REFUSED-ab1cd2", "key_id": key_id(&w) }),
    );
    assert!(!refusal.contains("ab1cd2"), "{refusal}");
    let views: String = planted
        .items
        .iter()
        .map(|id| format!("{:?}", vault.read(|c| reads::fields_of(c, id)).unwrap()))
        .collect();
    planted.silent("the field reads", views.as_bytes());
    // The notification names the title and the label and nothing else.
    let notice = vault
        .read(|c| centraid_vault::alerts::notice(c, &reminder))
        .unwrap()
        .unwrap();
    planted.silent("a notification", format!("{notice:?}").as_bytes());
    assert_eq!(notice.what.as_deref(), Some("Expires"));

    // 3. The index: its words, its postings, its bytes; the derivative table; the history.
    common::index::drain(vault);
    let words: Vec<String> = common::index::words_file(&common::index::index_path(w.scratch.dir()))
        .into_iter()
        .collect();
    planted.silent("the word list", words.join(" ").as_bytes());
    let postings = common::index::dump(w.scratch.dir())
        .into_iter()
        .collect::<Vec<_>>()
        .join("\n");
    planted.silent("the index's postings", postings.as_bytes());
    let index_bytes = std::fs::read(common::index::index_path(w.scratch.dir())).unwrap();
    planted.silent("the index file", &index_bytes);
    if let Ok(wal) = std::fs::read(w.scratch.dir().join("vault.index.db-wal")) {
        planted.silent("the index file's WAL", &wal);
    }
    // Positive controls: plain words are there, and the byte scan can see one.
    assert!(
        words.iter().any(|word| word == "plainmemo"),
        "the plain memo is indexed"
    );
    assert!(contains(&index_bytes, b"plainmemo") || postings.contains("plainmemo"));
    assert_eq!(
        w.one::<i64>("SELECT COUNT(*) FROM derivative", &[]),
        0,
        "nothing is derived"
    );
    let revisions: String = w
        .strings(
            "SELECT state || ' ' || COALESCE(body, '') FROM revision",
            &[],
        )
        .join("\n");
    planted.silent("the history", revisions.as_bytes());
    assert!(
        revisions.contains("lk1:"),
        "history keeps the ciphertext, which is the control"
    );
    let keys = w
        .strings("SELECT key || ' ' || asked FROM action_key", &[])
        .join("\n");
    planted.silent("the action keys", keys.as_bytes());

    // 4. The backup snapshot, sealed and opened.
    {
        use centraid_media::sealed::{self, BackupKeys, Class, Digest};
        use centraid_vault::backup::directory::Directory;
        use centraid_vault::backup::snapshot::{self, Options};
        use centraid_vault::backup::staging::Staging;
        use centraid_vault::backup::state::DeviceState;

        let keys = BackupKeys::from_root(&[0x5a; 32]);
        let state = DeviceState::open_beside(vault.path()).expect("a device state");
        let staging =
            Staging::open(w.scratch.join("vault.staging"), 512 * 1024 * 1024).expect("staging");
        let directory = Directory::new(Vec::new()).expect("a directory");
        snapshot::take(vault, &keys, &state, &staging, &directory, Options::at(1))
            .expect("a snapshot");
        let staged = state.staged_all().expect("the staged ranges");
        assert!(staged.len() > 1);
        for row in &staged {
            let object = std::fs::read(&row.path).expect("the object reads");
            planted.silent("a sealed snapshot range", &object);
            let plain = sealed::open_checked(
                &keys,
                &row.name,
                Class::Records,
                Some(&Digest::of(&object)),
                None,
                &object,
            )
            .expect("the range opens");
            planted.silent("an opened snapshot range", &plain);
        }
    }

    // 5. Every file on disk: the vault, its WAL, and the content store (the file is sealed there).
    let mut stored = 0;
    for path in walk(w.scratch.dir()) {
        let bytes = std::fs::read(&path).unwrap();
        planted.silent(&format!("{}", path.display()), &bytes);
        stored += 1;
    }
    assert!(stored >= 3, "the scan walked the vault file and the store");

    // 6. THE FALSIFICATION: the same cells DO open under K, so the scans above have something to
    // fail to find, and the search finds a plaintext when one is present.
    for (table, row_id, plaintext) in &planted.cells {
        if row_id.is_empty() {
            continue;
        }
        let pk = "id";
        let (cipher, key): (String, String) = w
            .vault()
            .read(|c| {
                let column = if *table == "locker_item_field" {
                    "value_sealed"
                } else {
                    "private_key"
                };
                Ok(c.query_row(
                    &format!("SELECT {column}, key_id FROM {table} WHERE {pk} = ?1"),
                    [row_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?)
            })
            .expect("a planted cell");
        assert_eq!(
            &decrypt_under_locker_key(&K, &key, row_id, &cipher).unwrap(),
            plaintext
        );
        assert!(contains(plaintext.as_bytes(), plaintext.as_bytes()));
    }
    let opened_file = {
        let hash: String = w.one(
            "SELECT value_blob FROM locker_item_field WHERE id = 'sealed-file-1'",
            &[],
        );
        let bytes = vault.blobs().unwrap().get(&hash).unwrap();
        centraid_vault::custody::sealed_file::open_bytes(&bytes, &K, &key_id(&w), "sealed-file-1")
            .unwrap()
    };
    assert_eq!(opened_file, planted.file_plain);
    assert!(contains(&opened_file, &planted.file_plain[..64]));
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut found = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        if path.is_dir() {
            found.extend(walk(&path));
        } else {
            found.push(path);
        }
    }
    found
}

#[test]
fn the_command_plane_cannot_be_talked_into_storing_a_plaintext_secret() {
    let w = world("locker-gate-refuse");
    let live = key_id(&w);
    for item_type in locker::ITEM_TYPES {
        for key in locker::secret_keys_of(item_type) {
            let item = item_id(&w);
            let sentence = w.refused(
                "locker.add_item",
                json!({ "item_id": item, "type": item_type, "title": "x", "fields": [
                    { "field_key": key, "value": "PLANTED-PLAINTEXT-mq3rv9", "key_id": live }] }),
            );
            assert!(!sentence.contains("mq3rv9"), "{sentence}");
        }
    }
    assert_eq!(w.one::<i64>("SELECT COUNT(*) FROM locker_item", &[]), 0);
    let file = std::fs::read(w.scratch.dir().join("vault.db")).unwrap();
    assert!(!contains(&file, b"mq3rv9"));
    // Nor a passkey's key.
    let item = item_id(&w);
    add(&w, &item, "login", "x", vec![]);
    assert!(
        w.refused(
            "locker.set_passkey",
            json!({ "item_id": item, "passkey_id": w.mint(), "rp_id": "x.example", "private_key": "mq3rv9", "key_id": live }),
        )
        .contains("sealed")
    );
}
