//! THE CORE'S DOOR FOR THE NATIVE RUNTIME (#1088): it reads what the harness's
//! door reads, and a write is refused until parking lands.
//!
//! The harness opens a vault FILE; the core's door reaches the vault the core
//! already holds. Over the same scenario they must answer the same rows, or
//! the phone and the fine-tuning loop run one runtime over two worlds.

use centraid_assist::native::world::World;
use centraid_assist::native::{Door, meta::Kind};
use centraid_core::api_proto as wire;
use centraid_core::assist::door::WRITES_OFF_PREDICATE;
use centraid_core::{Core, CoreConfig};
use centraid_nativetools::vaultio::{Handle as Harness, SetClock};

/// A vault holding the scenario, closed to its file, copied, and the original reopened by a
/// fresh core. The copy is what the harness opens.
struct Pair {
    dir: std::path::PathBuf,
    core: centraid_core::Handle,
    copy: std::path::PathBuf,
}

impl Drop for Pair {
    fn drop(&mut self) {
        self.core.close();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn pair() -> Pair {
    let dir = centraid_ontology::scratch::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a directory");
    let path = dir.join("vault.db");
    let copy = dir.join("harness.db");
    // Found a vault into `dir` and seed the scenario the way the shared helper
    // does, then end the file so the log is in it
    // (`docs/traps/wal-checkpoint.md`) and copy it.
    let core = Core::open(CoreConfig::new(&path)).expect("a core opens");
    core.open_own_bytes(path.with_extension("bytes"))
        .expect("the byte store opens");
    let answer = core
        .call(&wire::Request {
            kind: Some(wire::request::Kind::Found(wire::FoundRequest {
                display_name: "Sample".to_owned(),
                owner_name: "Me".to_owned(),
                content: wire::FoundContent::Unspecified as i32,
            })),
        })
        .expect("the vault founds");
    let Some(wire::response::Kind::Found(_)) = answer.kind else {
        panic!("a found answered {:?}", answer.kind);
    };
    let report = core
        .with_vault(|vault| {
            centraid_core::example::seed(
                vault,
                core.registry(),
                &core.owner(),
                &|_| true,
                centraid_core::example::now_ms(),
            )
        })
        .expect("the scenario seeds");
    assert!(report.is_whole(), "the scenario seeds whole: {report:?}");
    core.close_file().expect("the file ends");
    std::fs::copy(&path, &copy).expect("the copy is made");
    drop(core);
    let core = Core::open(CoreConfig::new(&path)).expect("the core reopens");
    Pair { dir, core, copy }
}

/// The world each door loads, rendered whole: rows, edges, ledger, everything.
fn world_of(door: &dyn Door) -> String {
    format!(
        "{:?}",
        World::load_with(door, false).expect("a world loads")
    )
}

#[test]
fn a_read_through_the_core_door_returns_the_rows_the_harness_door_returns() {
    let pair = pair();
    let core = pair.core.assist_door();
    // On the core's clock: Money's lines are held for the months around "now" (R-1099-81), so
    // two doors on two clocks would hold two windows of the demo ledger.
    let harness = Harness::open(&pair.copy, SetClock::at(core.now_ms()), "door-test")
        .expect("the harness opens");

    // THE WHOLE WORLD, secrets off as on the phone: the table reads the runtime makes at open.
    let from_core = world_of(&core);
    let from_harness = world_of(&harness);
    assert!(
        from_core.len() > 2_000,
        "the scenario is not empty: {} bytes",
        from_core.len()
    );
    assert_eq!(from_core, from_harness);

    // A table straight, in the kit's paged shape.
    for (table, columns, sort, pk) in [
        ("entity", "id, title, kind, created_at", "created_at", "id"),
        ("container", "id, kind, parent_id", "id", "id"),
    ] {
        let a = core.table(table, columns, sort, pk).expect("core reads");
        let b = harness
            .table(table, columns, sort, pk)
            .expect("harness reads");
        assert!(!a.is_empty(), "{table} holds rows in the scenario");
        assert_eq!(a, b, "{table}");
    }

    // A search: a person's own name, over the entities the runtime searches.
    let world = World::load_with(&core, false).unwrap();
    let person = world
        .rows
        .values()
        .find(|row| row.kind == Kind::Person && row.name != world.me)
        .expect("the scenario holds a person");
    let word = person
        .name
        .split_whitespace()
        .next()
        .expect("a name has a word")
        .to_owned();
    for entity in ["person", "note", "task"] {
        assert_eq!(
            core.search(entity, &word, 50).expect("core searches"),
            harness.search(entity, &word, 50).expect("harness searches"),
            "{entity}"
        );
    }
    // A text with no searchable word is an answer, not an error, on both.
    assert!(core.search("person", "!!", 5).unwrap().is_empty());
}

/// `YYYY-MM-DD` of a day count since 1970-01-01 (Hinnant's civil-from-days).
fn ymd(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

fn project_names(door: &dyn Door) -> Vec<String> {
    door.table_where(
        "entity",
        "id, title, created_at",
        "created_at",
        "id",
        "kind = ?",
        &["project".to_owned()],
    )
    .unwrap()
    .iter()
    .filter_map(|row| centraid_assist::native::door::text(row, "title"))
    .collect()
}

fn change_tables(pair: &Pair) -> Vec<String> {
    let mut tables = Vec::new();
    while let Ok(Some(event)) = pair.core.next_event(std::time::Duration::from_millis(1)) {
        if let Some(wire::event::Kind::Change(change)) = event.kind {
            tables.push(change.table);
        }
    }
    tables
}

#[test]
fn a_bare_run_is_refused_and_a_keyed_run_writes_once_through_the_change_feed() {
    let pair = pair();
    let door = pair.core.assist_door();
    let before = project_names(&door).len();
    let input = serde_json::json!({"kind": "project", "title": "Door test"});
    let _ = change_tables(&pair);

    // A BARE RUN IS REFUSED, as a value, and the vault is untouched: a card's confirm is the only
    // way the phone's chat writes.
    let ran = door.run("container.create", input.clone()).unwrap();
    assert!(!ran.ok);
    assert_eq!(ran.predicate.as_deref(), Some(WRITES_OFF_PREDICATE));
    assert_eq!(project_names(&door).len(), before);
    assert!(change_tables(&pair).is_empty());

    // A KEYED RUN goes through `api::invoke`: the row lands and the feed names its table.
    let ran = door
        .run_keyed("pending-1:0", "container.create", input.clone())
        .unwrap();
    assert!(ran.ok, "{:?}", ran.reason);
    assert_eq!(project_names(&door).len(), before + 1);
    assert!(
        change_tables(&pair)
            .iter()
            .any(|table| table == "container")
    );

    // THE SAME KEY AGAIN writes nothing and answers what it answered; a new key writes.
    let again = door
        .run_keyed("pending-1:0", "container.create", input.clone())
        .unwrap();
    assert!(again.ok);
    assert_eq!(again.output, ran.output);
    assert_eq!(project_names(&door).len(), before + 1);
    assert!(
        change_tables(&pair).is_empty(),
        "a replay announces nothing"
    );
    door.run_keyed("pending-1:1", "container.create", input)
        .unwrap();
    assert_eq!(project_names(&door).len(), before + 2);

    // A command the vault refuses is a value with its predicate, never an Err, and is not
    // remembered: the same key may be asked again.
    let bad = serde_json::json!({"nope": 1});
    let ran = door
        .run_keyed("pending-2:0", "container.create", bad.clone())
        .unwrap();
    assert!(!ran.ok);
    assert_eq!(ran.predicate.as_deref(), Some("schema"));
    assert!(
        !door
            .run_keyed("pending-2:0", "container.create", bad)
            .unwrap()
            .ok
    );
}

#[test]
fn events_on_the_core_door_are_the_ones_the_harness_door_reads_in_every_zone() {
    let pair = pair();
    let core = pair.core.assist_door();
    let now = core.now_ms();
    let harness = Harness::open(&pair.copy, SetClock::at(now), "door-test").unwrap();
    let today = now.div_euclid(86_400_000);
    // the window the runtime reads: 31 days back, 120 ahead
    let (from, to) = (ymd(today - 31), ymd(today + 120));
    for tz in ["Etc/UTC", "America/Los_Angeles", "Pacific/Auckland"] {
        let a = core
            .events(&from, &to, tz)
            .unwrap_or_else(|e| panic!("{tz}: {e}"));
        let b = harness.events(&from, &to, tz).unwrap();
        assert!(
            !a.is_empty(),
            "{tz}: the scenario holds events in the window"
        );
        assert_eq!(format!("{a:?}"), format!("{b:?}"), "{tz}");
    }
    assert!(
        core.events("2026-10-01", "2026-10-02", "Not/AZone")
            .is_err()
    );
}

#[test]
fn ids_and_the_clock_are_the_vaults_and_the_chat_holds_no_locker_key() {
    let pair = pair();
    let door = pair.core.assist_door();
    let (a, b) = (door.mint_id(), door.mint_id());
    assert!(!a.is_empty() && a != b);
    assert!(door.now_ms() > 1_700_000_000_000);
    assert!(door.seal("item", "secret").is_err());
    assert!(door.unseal("key", "item", "sealed").is_err());
}

#[test]
fn money_reaches_the_world_through_the_core_door_as_signed_rows_inside_the_window() {
    // #1099, R-1099-8: the phone's door answers `table_where` through the same paged read a
    // screen uses, and the runtime's world holds the recent months of an account's lines.
    let pair = pair();
    let door = pair.core.assist_door();
    let today = door.now_ms().div_euclid(86_400_000);
    let day = |back: i64| ymd(today - back);
    let account = door.mint_id();
    let run = |key: &str, command: &str, input: serde_json::Value| {
        let ran = door.run_keyed(key, command, input).unwrap();
        assert!(ran.ok, "{command}: {:?}", ran.reason);
    };
    run(
        "money-1:0",
        "account.add",
        // The demo ledger (`example::seed_money`) already holds an "Everyday"; this account's
        // lines are told apart from its by the account's own name.
        serde_json::json!({"id": account, "title": "Door test", "type": "checking"}),
    );
    // a followed line, signed (money out is negative); `follow.statement` names each by the id
    // its source gave it
    let line = |external: &str, back: i64, minor: i64, name: &str| {
        serde_json::json!({
            "external_id": external,
            "fields": {
                "title": name, "posted_on": day(back), "amount_minor": minor,
                "category_id": "category:food.groceries",
                "line": {"description": name.to_uppercase()},
            },
        })
    };
    let externals: Vec<String> = (1..=3).map(|n| format!("csv:{n:064x}")).collect();
    run(
        "money-1:1",
        "follow.statement",
        serde_json::json!({
            "origin": {"ref": account, "label": "Door test", "fills": account},
            "records": [
                line(&externals[0], 2, -4_250, "Corner Market"),
                line(&externals[1], 3, 100_000, "Payroll"),
                // two years back: outside the three months the world holds
                line(&externals[2], 730, -999, "Ancient"),
            ],
        }),
    );
    let followed = |external: &String| -> String {
        door.table_where(
            "source",
            "external_id, entity_id",
            "external_id",
            "external_id",
            "external_id = ?",
            std::slice::from_ref(external),
        )
        .unwrap()
        .first()
        .and_then(|row| centraid_assist::native::door::text(row, "entity_id"))
        .expect("a followed line")
    };
    let (recent, income, old) = (
        followed(&externals[0]),
        followed(&externals[1]),
        followed(&externals[2]),
    );

    let world = World::load_in(&door, false, true, None).expect("a world loads");
    let held: Vec<(&str, String)> = world
        .of_kind(Kind::Transaction)
        .filter(|row| {
            row.field("account")
                == Some(&centraid_assist::native::world::Val::Text(
                    "Door test".to_owned(),
                ))
        })
        .map(|row| {
            (
                row.name.as_str(),
                format!("{:?}", row.field("amount").unwrap()),
            )
        })
        .collect();
    assert_eq!(held.len(), 2, "{held:?}");
    assert!(
        world
            .rows
            .contains_key(&(Kind::Transaction, recent.clone()))
    );
    assert!(!world.rows.contains_key(&(Kind::Transaction, old)));
    let amount = |id: &String| {
        world
            .row(&(Kind::Transaction, id.clone()))
            .unwrap()
            .field("amount")
            .cloned()
    };
    assert_eq!(
        amount(&recent),
        Some(centraid_assist::native::world::Val::Money(
            -4_250,
            "USD".to_owned()
        ))
    );
    assert_eq!(
        amount(&income),
        Some(centraid_assist::native::world::Val::Money(
            100_000,
            "USD".to_owned()
        ))
    );
    let row = world.row(&(Kind::Transaction, recent)).unwrap();
    assert_eq!(row.name, "Corner Market");
    assert_eq!(
        row.field("category"),
        Some(&centraid_assist::native::world::Val::Text(
            "Groceries".to_owned()
        ))
    );

    // Money off reads none of it
    let without = World::load_in(&door, false, false, None).expect("a world loads");
    assert_eq!(without.of_kind(Kind::Transaction).count(), 0);
}

// ---------------------------------------------------------------------------
// THE ASSISTANT HAS THE OWNER'S ACCESS TO LOCKER, EXCEPT TO A SEALED VALUE
// (the owner's ruling of 2026-10-22, R-1088-3, #1135).
//
// A Locker item is an entity, so the rows the door reads and the verbs it runs are the ones that
// serve every other kind: its title, its edges and its tags are the assistant's to read, and the
// shared verbs run on it. These hold both halves at the door the phone actually uses: the parity,
// and the boundary at the sealed values (planted here as real ciphertext, sealed under a key the
// vault never holds, and searched for in every byte the door serves).
// ---------------------------------------------------------------------------

/// The plaintexts planted in the item's sealed cells.
const PLANTED: [&str; 4] = [
    "PLANTED-PASSWORD-zq7xk4-not-in-any-payload",
    "PLANTED-OTPSEED-mv9wr2-not-in-any-payload",
    "PLANTED-CUSTOMFIELD-kp5ny1-not-in-any-payload",
    "PLANTED-PRIVATEKEY-fw2js6-not-in-any-payload",
];

/// A sealed cell as the core would have sealed it, under a key written nowhere.
fn sealed(row_id: &str, plaintext: &str) -> String {
    centraid_vault::custody::locker_key::encrypt_under_locker_key(
        &[0x5a_u8; 32],
        "key-1",
        row_id,
        plaintext,
    )
    .expect("the cell seals")
}

/// A Locker item with every kind of sealed value, tagged, starred and linked by a note, through
/// the owner's own door.
fn with_a_locker_item(pair: &Pair) -> (String, String) {
    pair.core
        .with_vault(|vault| {
            vault
                .commit(|tx| {
                    tx.set_producer("test.fixture");
                    tx.connection().execute(
                        "INSERT INTO locker_key (key_id, created_at)
                         VALUES ('key-1', '2026-01-01T00:00:00.000Z')",
                        [],
                    )?;
                    Ok(())
                })
                .map_err(centraid_core::CoreError::from)
        })
        .expect("the key plane lands");
    let owner = pair.core.owner();
    let run = |name: &str, input: serde_json::Value| {
        pair.core
            .with_vault(|vault| {
                vault
                    .execute(
                        pair.core.registry(),
                        &owner,
                        &centraid_vault::commands::Command::new(name, input),
                    )
                    .map_err(centraid_core::CoreError::from)
            })
            .expect("the owner's command answers")
    };
    let executed = |ran: &centraid_vault::CommandOutcome, what: &str| {
        assert_eq!(
            ran.status,
            centraid_vault::CommandStatus::Executed,
            "{what}: {:?}",
            ran.reason
        );
    };
    let added = run(
        "locker.add_item",
        serde_json::json!({
            "item_id": "lk-bank", "type": "login", "title": "Hidden Vaultbank login",
            "username": "plainname", "url": "https://vaultbank.example",
            "password": sealed("lk-bank", PLANTED[0]),
            "otp_seed": sealed("lk-bank", PLANTED[1]),
            "password_rotated": true, "key_id": "key-1"
        }),
    );
    executed(&added, "add_item");
    executed(
        &run(
            "locker.set_field",
            serde_json::json!({
                "item_id": "lk-bank", "field_id": "field-1", "label": "Recovery", "kind": "sealed",
                "value": sealed("field-1", PLANTED[2]), "key_id": "key-1"
            }),
        ),
        "set_field",
    );
    executed(
        &run(
            "locker.set_passkey",
            serde_json::json!({
                "item_id": "lk-bank", "rp_id": "vaultbank.example", "user_handle": "ada",
                "display_name": "Ada", "credential_id": "cred-1", "algorithm": "ES256",
                "private_key": sealed("lk-bank", PLANTED[3]), "key_id": "key-1"
            }),
        ),
        "set_passkey",
    );
    for (name, input) in [
        (
            "tag.add",
            serde_json::json!({"id": "lk-bank", "label": "vaultonly"}),
        ),
        (
            "flag.set",
            serde_json::json!({"id": "lk-bank", "flag": "starred"}),
        ),
    ] {
        executed(&run(name, input), name);
    }
    let note = run(
        "note.create",
        serde_json::json!({"title": "Links the bank", "body": "see the login"}),
    );
    let note_id = note.output["id"].as_str().expect("a note id").to_owned();
    executed(
        &run(
            "edge.add",
            serde_json::json!({"from": note_id, "rel": "links", "to": "lk-bank"}),
        ),
        "edge.add",
    );
    ("lk-bank".to_owned(), note_id)
}

/// Every planted plaintext, and the `lk1:` ciphertext it is stored as, is absent from `bytes`.
fn assert_no_secret(what: &str, bytes: &str) {
    for planted in PLANTED {
        assert!(!bytes.contains(planted), "{what} carried `{planted}`");
    }
    assert!(!bytes.contains("lk1:"), "{what} carried a ciphertext");
}

#[test]
fn the_core_door_serves_a_locker_items_plain_rows_edges_and_tags_and_no_sealed_cell() {
    let pair = pair();
    let (item, note) = with_a_locker_item(&pair);
    let door = pair.core.assist_door();

    // Its entity row: the title, the kind.
    let entities = door
        .table("entity", "id, title, kind", "id", "id")
        .expect("the door reads entity");
    let seen = format!("{entities:?}");
    assert!(seen.contains(&note), "the door reads the other kinds");
    assert!(
        seen.contains(&item)
            && seen.contains("Hidden Vaultbank login")
            && seen.contains("locker_item"),
        "the door serves a Locker item's entity row: {seen}"
    );
    let by_kind = door
        .table_where(
            "entity",
            "id, title",
            "id",
            "id",
            "kind = ?",
            &["locker_item".to_owned()],
        )
        .expect("the door answers");
    assert_eq!(by_kind.len(), 1, "{by_kind:?}");

    // Its edges and tags: the note's link, the star, the tag.
    let edges = door
        .table("edge", "from_id, rel, to_id", "from_id", "to_id")
        .expect("the door reads edge");
    let seen = format!("{edges:?}");
    assert!(
        seen.contains(&item),
        "the door serves the item's edges: {seen}"
    );
    let tagged = door
        .table_where(
            "edge",
            "from_id, to_id",
            "from_id",
            "to_id",
            "rel = ?",
            &["tagged".to_owned()],
        )
        .expect("the door answers");
    assert!(format!("{tagged:?}").contains(&item), "{tagged:?}");

    // Its kind row, plain: the username and the url, with each sealed cell as a presence bit.
    let rows = door
        .table(
            "locker_item",
            "id, type, username, url, password IS NOT NULL AS has_password, \
             otp_seed IS NOT NULL AS has_otp_seed, card_number IS NOT NULL AS has_card_number",
            "id",
            "id",
        )
        .expect("the door reads the kind row");
    let seen = format!("{rows:?}");
    assert!(
        seen.contains("plainname") && seen.contains("https://vaultbank.example"),
        "{seen}"
    );
    assert_no_secret("the kind row", &seen);
    assert!(
        seen.contains("has_password") && seen.contains("has_otp_seed"),
        "the sealed cells are presence bits: {seen}"
    );

    // …and a sealed column is served in no form: not projected, not ordered by, not filtered on.
    for (table, pk, column) in [
        ("locker_item", "id", "password"),
        ("locker_item", "id", "otp_seed"),
        ("locker_item", "id", "card_number"),
        ("locker_item", "id", "cvv"),
        ("locker_item", "id", "content"),
        ("locker_item_field", "item_id", "value_sealed"),
        ("locker_item_passkey", "item_id", "private_key"),
    ] {
        assert!(
            door.table(table, &format!("{pk}, {column}"), pk, pk)
                .is_err(),
            "the door projected {table}.{column}"
        );
        assert!(
            door.table(table, pk, column, pk).is_err(),
            "the door ordered by {table}.{column}"
        );
        assert!(
            door.table_where(table, pk, pk, pk, &format!("{column} IS NOT NULL"), &[])
                .is_err(),
            "the door filtered on {table}.{column}"
        );
    }

    // The world the runtime builds holds the item by its plain fields and no sealed value.
    let world = world_of(&door);
    assert!(
        world.contains("Hidden Vaultbank login") && world.contains("plainname"),
        "the world holds the Locker item"
    );
    assert_no_secret("the world", &world);

    // The search index finds it by its title and its username, and by no sealed word.
    assert_eq!(
        door.search("locker_item", "Vaultbank", 20)
            .expect("a search")
            .len(),
        1
    );
    assert_eq!(
        door.search("locker_item", "plainname", 20)
            .expect("a search")
            .len(),
        1
    );
    for planted in PLANTED {
        assert!(
            door.search("locker_item", planted, 20)
                .expect("a search")
                .is_empty(),
            "`{planted}` is a word of the index"
        );
    }
}

#[test]
fn a_shared_verb_on_a_locker_item_runs_under_the_assistants_principal() {
    let pair = pair();
    let (item, note) = with_a_locker_item(&pair);
    let door = pair.core.assist_door();
    for (key, command, input) in [
        (
            "l1:0",
            "entity.retitle",
            serde_json::json!({"id": item, "title": "The savings bank"}),
        ),
        (
            "l2:0",
            "tag.add",
            serde_json::json!({"id": item, "label": "spy"}),
        ),
        (
            "l3:0",
            "tag.remove",
            serde_json::json!({"id": item, "label": "vaultonly"}),
        ),
        (
            "l4:0",
            "flag.clear",
            serde_json::json!({"id": item, "flag": "starred"}),
        ),
        (
            "l5:0",
            "flag.set",
            serde_json::json!({"id": item, "flag": "archived"}),
        ),
        (
            "l6:0",
            "edge.add",
            serde_json::json!({"from": note, "rel": "about", "to": item}),
        ),
        (
            "l7:0",
            "edge.remove",
            serde_json::json!({"from": note, "rel": "links", "to": item}),
        ),
        ("l8:0", "locker.counts", serde_json::json!({})),
        ("l9:0", "entity.trash", serde_json::json!({"id": item})),
        ("l10:0", "entity.restore", serde_json::json!({"id": item})),
    ] {
        let ran = door
            .run_keyed(key, command, input)
            .expect("the door answers");
        assert!(ran.ok, "{command}: {:?}", ran.reason);
    }
    // An edit that keeps every sealed cell (the placeholder) is the plain edit the model makes.
    let ran = door
        .run_keyed(
            "l11:0",
            "locker.edit_item",
            serde_json::json!({
                "item_id": item, "title": "Bank", "username": "ada@new.example",
                "url": "https://vaultbank.example", "password": "«sealed»",
                "otp_seed": "«sealed»"
            }),
        )
        .expect("the door answers");
    assert!(ran.ok, "{:?}", ran.reason);

    // The owner sees the edit, and the sealed cell exactly as it was.
    let owner = |select: &[&str], from: &str, predicate: &str, binds: usize| {
        pair.core
            .with_vault(|vault| {
                vault
                    .keyset_page(&centraid_vault::page::KeysetPage {
                        name: "locker.check".to_owned(),
                        select: select.iter().map(|column| (*column).to_owned()).collect(),
                        from: from.to_owned(),
                        predicate: Some(predicate.to_owned()),
                        binds: vec![centraid_vault::value::Value::Text(item.clone()); binds],
                        sort_column: select[0].to_owned(),
                        pk_column: select[0].to_owned(),
                        descending: false,
                        limit: 50,
                        after: None,
                        held_thumbnail: false,
                        document_size: false,
                    })
                    .map_err(centraid_core::CoreError::from)
            })
            .expect("the owner reads")
            .rows
    };
    let rows = owner(
        &["id", "username", "password", "otp_seed"],
        "locker_item",
        "id = ?",
        1,
    );
    let [row] = rows.as_slice() else {
        panic!("the item is gone: {rows:?}");
    };
    assert_eq!(
        format!("{:?}", row.get("username")),
        format!(
            "{:?}",
            Some(centraid_vault::value::Value::Text(
                "ada@new.example".to_owned()
            ))
        )
    );
    let cells = format!("{:?}{:?}", row.get("password"), row.get("otp_seed"));
    assert_eq!(
        cells.matches("lk1:").count(),
        2,
        "both cells are still sealed: {cells}"
    );
    let rows = owner(&["id", "title"], "entity", "id = ?", 1);
    assert!(format!("{rows:?}").contains("Bank"), "{rows:?}");
}

/// The shared verbs that carry a confirmation for the member carry it for the assistant: the same
/// refusal, on a Locker item as on a note.
#[test]
fn a_purge_asks_the_assistant_the_confirmation_it_asks_the_member() {
    let pair = pair();
    let (item, note) = with_a_locker_item(&pair);
    let door = pair.core.assist_door();
    let ask = |key: &str, id: &str| {
        door.run_keyed(key, "entity.purge", serde_json::json!({"id": id}))
            .expect("the door answers")
    };
    let (on_item, on_note) = (ask("p1:0", &item), ask("p2:0", &note));
    assert_eq!(on_item.ok, on_note.ok, "{on_item:?} / {on_note:?}");
    assert_eq!(on_item.predicate, on_note.predicate);
}

#[test]
fn every_secret_touching_command_is_refused_through_the_core_door() {
    let pair = pair();
    let (item, _note) = with_a_locker_item(&pair);
    let door = pair.core.assist_door();
    let new_cipher = sealed("lk-bank", "a new password");
    for (key, command, input) in [
        (
            "s1:0",
            "locker.export",
            serde_json::json!({"confirm": true}),
        ),
        (
            "s2:0",
            "locker.totp_code",
            serde_json::json!({"item_id": item}),
        ),
        (
            "s3:0",
            "locker.reveal_receipt",
            serde_json::json!({
                "object_type": "locker.item", "item_id": item, "columns": ["password"]
            }),
        ),
        (
            "s4:0",
            "locker.edit_item",
            serde_json::json!({"item_id": item, "password": new_cipher, "key_id": "key-1"}),
        ),
        // An edit that leaves a held secret out clears it.
        (
            "s5:0",
            "locker.edit_item",
            serde_json::json!({"item_id": item, "title": "x", "username": "u"}),
        ),
        (
            "s6:0",
            "locker.add_item",
            serde_json::json!({
                "item_id": "lk-new", "type": "login", "title": "New", "password": new_cipher,
                "key_id": "key-1"
            }),
        ),
        (
            "s7:0",
            "locker.set_field",
            serde_json::json!({
                "item_id": item, "field_id": "field-1", "label": "Recovery", "kind": "sealed",
                "value": new_cipher, "key_id": "key-1"
            }),
        ),
        (
            "s8:0",
            "locker.set_passkey",
            serde_json::json!({
                "item_id": item, "rp_id": "vaultbank.example", "user_handle": "ada",
                "display_name": "Ada", "credential_id": "cred-1", "algorithm": "ES256",
                "private_key": new_cipher, "key_id": "key-1"
            }),
        ),
        (
            "s9:0",
            "locker.duplicate_item",
            serde_json::json!({"item_id": item, "new_item_id": "lk-copy"}),
        ),
        (
            "s10:0",
            "locker.remove_field",
            serde_json::json!({"item_id": item, "field_id": "field-1"}),
        ),
        (
            "s11:0",
            "locker.clear_passkey",
            serde_json::json!({"item_id": item}),
        ),
    ] {
        let ran = door
            .run_keyed(key, command, input)
            .expect("the door answers");
        assert!(!ran.ok, "{command} reached a secret: {:?}", ran.output);
        assert_eq!(
            ran.predicate.as_deref(),
            Some(centraid_vault::commands::ASSISTANT_CLOSED_OUT),
            "{command}: {:?}",
            ran.reason
        );
        let said = ran.reason.unwrap_or_default();
        assert!(
            said.contains("secret") && said.contains("Locker"),
            "the sentence says it is a secret and where the member opens it: {said}"
        );
        assert_no_secret(command, &said);
        assert!(
            !said.contains("Hidden Vaultbank") && !said.contains("lk-bank"),
            "{said}"
        );
    }
    // Nothing moved: the item's four sealed values, the new item and the copy.
    let rows = pair
        .core
        .with_vault(|vault| {
            vault
                .keyset_page(&centraid_vault::page::KeysetPage {
                    name: "locker.check".to_owned(),
                    select: vec![
                        "id".to_owned(),
                        "password".to_owned(),
                        "otp_seed".to_owned(),
                    ],
                    from: "locker_item".to_owned(),
                    predicate: None,
                    binds: Vec::new(),
                    sort_column: "id".to_owned(),
                    pk_column: "id".to_owned(),
                    descending: false,
                    limit: 50,
                    after: None,
                    held_thumbnail: false,
                    document_size: false,
                })
                .map_err(centraid_core::CoreError::from)
        })
        .expect("the owner reads")
        .rows;
    assert_eq!(rows.len(), 1, "no item was added or copied: {rows:?}");
    assert_eq!(
        format!("{rows:?}").matches("lk1:").count(),
        2,
        "the sealed cells are as they were"
    );
}
