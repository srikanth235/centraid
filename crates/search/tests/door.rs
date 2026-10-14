//! THE FTS DOOR, END TO END — and the proof that a secret cannot come out of it.
//!
//! The vault here is the committed model (`contracts/schema/vault-ddl.sql`, the
//! #929 golden corpus's schema) with the FTS5 triggers the baseline installs, so
//! an `INSERT` populates the index the way the product does. Nothing is stubbed:
//! the rows go in, the triggers fire, the door runs a real `MATCH`.
//!
//! ## What `secrets_planted_in_every_sealed_column_never_reach_a_target` proves
//!
//! Not "the door filters secrets out" — a filter is a thing someone edits. Three
//! independent properties, each with its own mechanism (#1020, D-1020-N1):
//!
//! 1. every sealed column the registry names really does hold a secret sealed
//!    by `crates/vault::custody` — the vault's own `lk1:` member-key cell, not
//!    a hand-typed prefix — so the run is neither vacuous nor a claim about a
//!    string;
//! 2. no `Target` from any of the seven domains carries the PLAINTEXT or the
//!    CIPHERTEXT, for a query that asks for each by name;
//! 3. the entities that HAVE sealed columns are not domains at all, and asking
//!    for one is a typed refusal rather than an empty page — the empty page is
//!    what a filter would produce, and it reads as "no matches".

use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::page::PageRequest;
use centraid_search::{
    Answer, CONTAINERS, DOMAINS, MAX_VOCAB_SCAN, Principal, Search, SearchError, SearchRequest,
    SqliteDoor, Target,
};
use centraid_vault::custody::locker_key::{
    LOCKER_CIPHERTEXT_PREFIX, encrypt_under_locker_key, is_locker_ciphertext, locker_aad,
};
use rusqlite::Connection;

/// THE SECRETS THIS FIXTURE PLANTS, AS THE PRODUCT WRITES THEM.
///
/// Not a hand-made prefix: `crates/vault::custody` is what seals a cell, and a
/// test that typed `"lk1:…"` itself would be proving something about a string
/// rather than about the vault. `encrypt_under_locker_key` is the `lk1:` form
/// the Locker member key writes, and it is the only cell encryption the vault
/// has: the `sealed:v1:` envelope sealed only the connector credentials rung
/// five dropped, and is deleted (R-1047-D2).
///
/// The PLAINTEXT is what a member would search for and the CIPHERTEXT is what
/// the column holds; the test asserts neither reaches a target.
const PLAINTEXT: &str = "zqmarker recovery phrase seventeen";

/// A key by value. There is no ambient Locker key in the search crate, and there
/// is none here either: the bytes are the fixture's.
const KEY: [u8; 32] = [7u8; 32];

const NOW: &str = "2099-06-01T09:00:00.000Z";

fn vault() -> Connection {
    let ddl = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../contracts/schema/vault-ddl.sql"),
    )
    .expect("the committed DDL is readable");
    let connection = open_contract_vault(&ddl, "[]").expect("the fixture vault is built");
    seed(&connection);
    connection
}

/// One row in every domain, plus a planted secret in every sealed column.
#[expect(
    clippy::too_many_lines,
    reason = "one fixture, one reading order: seven domains and three sealed tables"
)]
fn seed(connection: &Connection) {
    let body = |id: &str, text: &str, sha: &str| {
        connection
            .execute(
                "INSERT INTO core_content_item
                   (content_id, content_uri, content_hash, byte_size, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![
                    id,
                    format!("data:text/markdown,{text}"),
                    sha,
                    i64::try_from(text.len()).unwrap_or_default(),
                    NOW
                ],
            )
            .expect("a content item is inserted");
        connection
            .execute(
                "INSERT INTO core_content_text
                   (content_id, body_text, decoder, byte_size, created_at, updated_at)
                 VALUES (?1, ?2, 'data-uri/v1', ?3, ?4, ?4)",
                rusqlite::params![id, text, i64::try_from(text.len()).unwrap_or_default(), NOW],
            )
            .expect("the decoded text is inserted");
    };

    connection
        .execute(
            "INSERT INTO core_party (party_id, kind, display_name, sort_name, created_at)
             VALUES ('party-1', 'person', 'Priya Raman', 'Raman, Priya', ?1)",
            [NOW],
        )
        .expect("a party is inserted");

    // NOTES — two, so rank order and the keyset have something to order.
    body(
        "content-1",
        "Book the cabin. Rent is due on the first.",
        &"a".repeat(64),
    );
    body("content-2", "Second cabin note, shorter.", &"b".repeat(64));
    for (id, title, content) in [
        ("note-1", "Tahoe cabin shortlist", "content-1"),
        ("note-2", "Cabin follow-up", "content-2"),
    ] {
        connection
            .execute(
                "INSERT INTO knowledge_note
                   (note_id, author_party_id, title, body_content_id, format, pinned, created_at, updated_at)
                 VALUES (?1, 'party-1', ?2, ?3, 'markdown', 0, ?4, ?4)",
                rusqlite::params![id, title, content, NOW],
            )
            .expect("a note is inserted");
    }
    // A TRASHED note carrying the same word: the index drops it and the door's
    // own predicate drops it again.
    body("content-3", "Trashed cabin note.", &"c".repeat(64));
    connection
        .execute(
            "INSERT INTO knowledge_note
               (note_id, author_party_id, title, body_content_id, format, pinned,
                created_at, updated_at, deleted_at, purge_at)
             VALUES ('note-trashed', 'party-1', 'Cabin, cancelled', 'content-3', 'plain', 0,
                     ?1, ?1, ?1, '2099-07-01T09:00:00.000Z')",
            [NOW],
        )
        .expect("a trashed note is inserted");
    // A note with NO title: not a target, because an unlabelled link is one a
    // member cannot recognise.
    body("content-4", "cabin cabin cabin", &"d".repeat(64));
    connection
        .execute(
            "INSERT INTO knowledge_note
               (note_id, author_party_id, title, body_content_id, format, pinned, created_at, updated_at)
             VALUES ('note-untitled', 'party-1', '', 'content-4', 'plain', 0, ?1, ?1)",
            [NOW],
        )
        .expect("an untitled note is inserted");

    connection
        .execute(
            "INSERT INTO core_event
               (event_id, summary, description, dtstart, start_tz, status, sequence, created_at)
             VALUES ('event-1', 'Cabin walkthrough', 'meet at the cabin',
                     '2099-06-10T17:00:00.000Z', 'America/Los_Angeles', 'confirmed', 0, ?1)",
            [NOW],
        )
        .expect("an event is inserted");

    connection
        .execute(
            "INSERT INTO schedule_task
               (task_id, owner_party_id, title, description, status, priority, due_at, created_at, updated_at)
             VALUES ('task-1', 'party-1', 'Book the cabin', 'call them', 'needs-action', 0,
                     '2099-06-05', ?1, ?1)",
            [NOW],
        )
        .expect("a task is inserted");

    connection
        .execute(
            "INSERT INTO tally_expense
               (expense_id, description, amount_minor, currency, paid_by, spent_on, category, created_at)
             VALUES ('expense-1', 'Cabin deposit', 18000, 'USD', 'party-1', '2099-05-30', 'travel', ?1)",
            [NOW],
        )
        .expect("an expense is inserted");

    body("content-5", "the lease", &"e".repeat(64));
    connection
        .execute(
            "INSERT INTO core_document (document_id, title, current_content_id, created_at)
             VALUES ('document-1', 'Cabin lease 2099', 'content-5', ?1)",
            [NOW],
        )
        .expect("a document is inserted");

    // PHOTOS: the byte row has no title of its own (#996 R20(b)); the index
    // carries the owning asset's, so the asset has to exist for the label.
    connection
        .execute(
            "INSERT INTO core_content_item (content_id, content_uri, content_hash, byte_size, created_at)
             VALUES ('content-6', 'blob:blake3/f', ?1, 1024, ?2)",
            rusqlite::params!["f".repeat(64), NOW],
        )
        .expect("a photo's bytes are inserted");
    connection
        .execute(
            "INSERT INTO media_asset (asset_id, content_id, kind, title, created_at, updated_at)
             VALUES ('asset-1', 'content-6', 'photo', 'Cabin porch', ?1, ?1)",
            [NOW],
        )
        .expect("an asset is inserted");

    // THE PLANTED SECRETS, sealed the way the product seals them.
    //
    // Locker's cells take the member key's `lk1:` form and the AAD binds them to
    // their row and key id. Nothing is typed here: the cells come out of
    // `crates/vault::custody`, so what the columns hold is what a real vault
    // holds.
    let locker = |column: &str| {
        encrypt_under_locker_key(&KEY, LOCKER_KEY_ID, "item-1", PLAINTEXT)
            .unwrap_or_else(|error| panic!("{column} seals: {error}"))
    };
    connection
        .execute(
            "INSERT INTO locker_item
               (item_id, type, title, username, password, url, otp_seed, notes,
                card_number, cvv, content, created_at, key_id)
             VALUES ('item-1', 'login', 'Cabin booking site', 'priya', ?1, 'https://cabins.example',
                     ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                locker("password"),
                locker("otp_seed"),
                // `notes` is NOT a sealed column and is deliberately not indexed
                // either: it routinely carries recovery codes (`schema/fts.ts`).
                "the kennel is booked",
                locker("card_number"),
                locker("cvv"),
                locker("content"),
                NOW,
                LOCKER_KEY_ID
            ],
        )
        .expect("a locker item is inserted");
    connection
        .execute(
            "INSERT INTO locker_item_field
               (field_id, item_id, label, kind, value_sealed, created_at, key_id)
             VALUES ('field-1', 'item-1', 'Recovery code', 'sealed', ?1, ?2, ?3)",
            rusqlite::params![
                encrypt_under_locker_key(&KEY, LOCKER_KEY_ID, "field-1", PLAINTEXT)
                    .expect("a field seals"),
                NOW,
                LOCKER_KEY_ID
            ],
        )
        .expect("a sealed field is inserted");
    connection
        .execute(
            "INSERT INTO locker_item_passkey (item_id, rp_id, private_key, created_at, key_id)
             VALUES ('item-1', 'cabins.example', ?1, ?2, ?3)",
            rusqlite::params![
                encrypt_under_locker_key(&KEY, LOCKER_KEY_ID, "item-1", PLAINTEXT)
                    .expect("a passkey seals"),
                NOW,
                LOCKER_KEY_ID
            ],
        )
        .expect("a passkey is inserted");
}

/// The key id every planted locker cell is bound to. The AAD carries it, so a
/// cell cannot be replayed under another key.
const LOCKER_KEY_ID: &str = "key-000001";

/// Does this fixture's schema carry that table?
fn table_exists(connection: &rusqlite::Connection, table: &str) -> bool {
    connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0
}

/// Every sealed cell this fixture holds, as `(table, column, row_id)`.
///
/// Derived from `centraid_ontology::registries::sealed_physical_columns` in
/// `every_sealed_column_in_this_fixture_really_holds_a_secret`, so a column
/// added to the registry and not planted here fails rather than being skipped.
fn planted_rows() -> Vec<(&'static str, &'static str, &'static str)> {
    vec![
        ("locker_item", "password", "item-1"),
        ("locker_item", "otp_seed", "item-1"),
        ("locker_item", "card_number", "item-1"),
        ("locker_item", "cvv", "item-1"),
        ("locker_item", "content", "item-1"),
        ("locker_item_field", "value_sealed", "field-1"),
        ("locker_item_passkey", "private_key", "item-1"),
    ]
}

/// A LOCKER INDEX THIS TEST PLANTS ITSELF.
///
/// Rung thirteen retired the vault's own `fts_locker_item` (Q-1097-1 (c)): no
/// feature read it, and Locker has a walker of its own. The refusal below is
/// structural, "the entity is not a domain", and a test of that has to be run
/// against a vault where the entity COULD be answered, or it proves only that
/// there was nothing to answer from. So the fixture makes the index the vault
/// used to carry (the baseline's own shape, filled with the planted item's
/// cleartext label columns) in the one place a test needs it. A door that
/// listed `locker.item` as a domain would find the row and answer, and the
/// refusals fail.
fn with_a_locker_index(connection: &Connection) {
    connection
        .execute_batch(
            "CREATE VIRTUAL TABLE fts_locker_item USING fts5(
               item_id UNINDEXED, title, username, url,
               tokenize = \"unicode61 remove_diacritics 2\");
             INSERT INTO fts_locker_item(item_id, title, username, url)
               SELECT item_id, title, username, url FROM locker_item;",
        )
        .expect("the planted locker index is made");
}

fn door(connection: &Connection) -> SqliteDoor<'_> {
    SqliteDoor::open(connection).expect("the door opens over the committed model")
}

fn targets(answer: &Answer) -> Vec<Target> {
    answer
        .targets()
        .expect("the owner is not denied here")
        .to_vec()
}

// ---------------------------------------------------------------------------
// The security property
// ---------------------------------------------------------------------------

/// THE PLANT IS REAL, AND IT IS EVERY COLUMN THE REGISTRY NAMES.
///
/// A green run of the test below would prove nothing over an empty set — and it
/// would prove nothing over a HAND-TYPED string either, which is why every cell
/// is read back and checked to be real ciphertext of the vault's own two forms.
/// The set of planted cells is compared against
/// `centraid_ontology::registries::sealed_physical_columns`, so a sealed column
/// added to the model and not planted here fails rather than being skipped.
#[test]
fn every_sealed_column_in_this_fixture_really_holds_a_secret() {
    let connection = vault();
    // THE MAPPING, STATED. `contracts/schema/v0-registries.json` is the v0
    // record and is checked against the FROZEN v0 corpus
    // (`crates/ontology/tests/commitments.rs`), so it still names
    // `sync_connection_credential`'s five sealed columns. Rung five drops that
    // table with the connector plane (#1029), and this fixture is built from
    // the schema a NEW vault gets — there is no column here to plant. The
    // registry is filtered by what the fixture's own schema has, which is a
    // stronger read than a hard-coded skip: a sealed column that arrives in a
    // table this vault DOES have is still unplanted and still fails.
    let mut registry: Vec<(String, String)> =
        centraid_ontology::registries::sealed_physical_columns()
            .into_iter()
            .filter(|(table, _)| table_exists(&connection, table))
            .collect();
    registry.sort_unstable();
    assert!(
        registry.len() < centraid_ontology::registries::sealed_physical_columns().len(),
        "nothing was filtered: the mapping above no longer describes anything"
    );
    let mut planted: Vec<(String, String)> = planted_rows()
        .into_iter()
        .map(|(table, column, _)| (table.to_owned(), column.to_owned()))
        .collect();
    planted.sort_unstable();
    assert_eq!(
        planted, registry,
        "the planted cells and the sealed registry disagree"
    );

    for (table, column, row_id) in planted_rows() {
        let pk = match table {
            "locker_item" | "locker_item_passkey" => "item_id",
            "locker_item_field" => "field_id",
            other => panic!("`{other}` has no primary key named here"),
        };
        let held: String = connection
            .query_row(
                &format!("SELECT {column} FROM {table} WHERE {pk} = ?1"),
                [row_id],
                |row| row.get(0),
            )
            .unwrap_or_else(|error| panic!("{table}.{column}: {error}"));
        // REAL CIPHERTEXT, not a string that begins with the prefix: both
        // checks decode the envelope and measure it.
        assert!(
            is_locker_ciphertext(&held),
            "{table}.{column} is not a `{LOCKER_CIPHERTEXT_PREFIX}` cell"
        );
        assert!(
            !held.contains(PLAINTEXT),
            "{table}.{column} holds the plaintext"
        );
    }
    // AND THE AAD BINDS THE CELL TO ITS ROW. A ciphertext that opened anywhere
    // would make "the column is sealed" a weaker claim than it reads as.
    assert!(
        !locker_aad("item-1", LOCKER_KEY_ID).is_empty()
            && locker_aad("item-1", LOCKER_KEY_ID) != locker_aad("field-1", LOCKER_KEY_ID)
    );
}

/// The one that matters: a marker in a sealed column is unreachable through
/// every domain, for a query that asks for the marker by name.
#[test]
fn secrets_planted_in_every_sealed_column_never_reach_a_target() {
    let connection = vault();
    let door = door(&connection);
    // BOTH HALVES: the words a member would type, and the bytes the column
    // holds. A door that leaked either would be leaking the secret.
    let ciphertext: String = connection
        .query_row(
            "SELECT password FROM locker_item WHERE item_id = 'item-1'",
            [],
            |row| row.get(0),
        )
        .expect("the cell reads");
    // THE CONTAINERS TOO (R-1097-20): a second registry is held to the same
    // property, and its entities are asked for the marker by name as well.
    let entities: Vec<&str> = DOMAINS
        .iter()
        .map(|domain| domain.entity)
        .chain(CONTAINERS.iter().map(|container| container.entity))
        .collect();
    for marker in [PLAINTEXT, ciphertext.as_str()] {
        for entity in &entities {
            let answer = door
                .query(&Principal::Owner, &SearchRequest::new(*entity, marker, 50))
                .unwrap_or_else(|error| panic!("{entity} answered {error}"));
            for target in targets(&answer) {
                for field in [
                    &target.entity,
                    &target.id,
                    &target.title,
                    &target.subtitle,
                    &target.app_id,
                    &target.snippet,
                ] {
                    assert!(
                        !field.contains(marker),
                        "{entity} answered a target carrying {marker}: {target:?}"
                    );
                }
            }
        }
    }
}

/// The absence is STRUCTURAL. Asking for a sealed-column entity is a refusal, so
/// nobody can read "no matches" as "there is nothing there".
#[test]
fn an_entity_with_sealed_columns_is_not_a_domain_and_asking_is_a_refusal() {
    let connection = vault();
    with_a_locker_index(&connection);
    let door = door(&connection);
    for entity in [
        "locker.item",
        "locker.item_field",
        "locker.item_passkey",
        "sync.connection_credential",
    ] {
        let refused = door.query(&Principal::Owner, &SearchRequest::new(entity, "cabin", 8));
        assert!(
            matches!(refused, Err(SearchError::NotADomain { count: 7, .. })),
            "{entity} answered {refused:?} rather than refusing"
        );
    }
}

/// The locker's own index EXISTS and matches the same word — which is exactly
/// why the refusal above has to be structural rather than "there is no index".
#[test]
fn the_locker_index_is_populated_and_still_unreachable() {
    let connection = vault();
    with_a_locker_index(&connection);
    let indexed: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM fts_locker_item WHERE fts_locker_item MATCH '\"cabin\"*'",
            [],
            |row| row.get(0),
        )
        .expect("the locker index answers");
    assert_eq!(
        indexed, 1,
        "the locker index is empty — the refusal proves nothing"
    );
    assert!(centraid_search::domain_of("locker.item").is_none());
}

// ---------------------------------------------------------------------------
// The door's own behaviour
// ---------------------------------------------------------------------------

#[test]
fn every_domain_answers_its_own_row_for_one_word() {
    let connection = vault();
    let door = door(&connection);
    let mut seen: Vec<(&str, usize)> = Vec::new();
    for domain in DOMAINS {
        let answer = door
            .query(
                &Principal::Owner,
                &SearchRequest::new(domain.entity, "cabin", 8),
            )
            .unwrap_or_else(|error| panic!("{} answered {error}", domain.entity));
        seen.push((domain.entity, targets(&answer).len()));
    }
    assert_eq!(
        seen,
        vec![
            // note-1 and note-2; the trashed one and the untitled one are out.
            ("knowledge.note", 2),
            ("core.party", 0),
            ("core.event", 1),
            ("schedule.task", 1),
            ("tally.expense", 1),
            ("core.content_item", 1),
            ("core.document", 1),
        ]
    );
}

#[test]
fn a_target_carries_its_app_its_title_and_a_subtitle_that_is_never_empty() {
    let connection = vault();
    let door = door(&connection);
    let answer = door
        .query(
            &Principal::Owner,
            &SearchRequest::new("knowledge.note", "tahoe", 8),
        )
        .expect("notes answer");
    let rows = targets(&answer);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].entity, "knowledge.note");
    assert_eq!(rows[0].id, "note-1");
    assert_eq!(rows[0].title, "Tahoe cabin shortlist");
    assert_eq!(rows[0].app_id, "notes");
    assert!(rows[0].subtitle.starts_with("Book the cabin"));
    assert!(rows[0].snippet.contains('⟦'), "{:?}", rows[0].snippet);

    // A domain with no subtitle column falls back to the app, never "".
    let people = door
        .query(
            &Principal::Owner,
            &SearchRequest::new("core.party", "priya", 8),
        )
        .expect("people answer");
    assert_eq!(targets(&people)[0].subtitle, "people");
}

/// A row with no label is NOT a target — and the row is in the index, so this
/// is the door dropping it rather than the index never having it.
#[test]
fn an_unlabelled_row_is_not_a_target_even_though_it_matched() {
    let connection = vault();
    let indexed: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM fts_knowledge_note
              WHERE fts_knowledge_note MATCH '\"cabin\"*' AND note_id = 'note-untitled'",
            [],
            |row| row.get(0),
        )
        .expect("the note index answers");
    assert_eq!(indexed, 1);
    let door = door(&connection);
    let answer = door
        .query(
            &Principal::Owner,
            &SearchRequest::new("knowledge.note", "cabin", 8),
        )
        .expect("notes answer");
    assert!(targets(&answer).iter().all(|row| row.id != "note-untitled"));
}

/// The caller's exclusion set runs INSIDE the door, over the ranked hits — which
/// is what makes an all-excluded search an empty list rather than a filtered one
/// (#834 R-journal).
#[test]
fn an_excluded_id_is_dropped_before_the_page_is_cut() {
    let connection = vault();
    let door = door(&connection);
    let answer = door
        .query(
            &Principal::Owner,
            &SearchRequest::new("knowledge.note", "cabin", 8)
                .excluding(vec!["note-1".to_owned(), "note-2".to_owned()]),
        )
        .expect("notes answer");
    assert_eq!(targets(&answer), Vec::<Target>::new());
    assert_eq!(answer.window(), Some(8));
}

/// The page is a keyset over `(rank, id)`, and a continuation reaches the rows
/// the first page did not.
#[test]
fn a_window_continues_by_keyset_and_ends_without_a_cursor() {
    let connection = vault();
    let door = door(&connection);
    let first = door
        .query(
            &Principal::Owner,
            &SearchRequest::new("knowledge.note", "cabin", 1),
        )
        .expect("notes answer");
    let Answer::Data { page, window } = first else {
        panic!("the owner is not denied")
    };
    assert_eq!(window, 1);
    assert_eq!(page.rows.len(), 1);
    let cursor = page.next.clone().expect("a second note is still owed");

    let second = door
        .query(
            &Principal::Owner,
            &SearchRequest {
                entity: "knowledge.note".to_owned(),
                query: "cabin".to_owned(),
                page: PageRequest::after(1, cursor),
                excluded_ids: Vec::new(),
                app: None,
            },
        )
        .expect("notes answer");
    let Answer::Data { page: rest, .. } = second else {
        panic!("the owner is not denied")
    };
    assert_eq!(rest.rows.len(), 1);
    assert_ne!(rest.rows[0].id, page.rows[0].id);
    assert!(
        rest.next.is_none(),
        "the rows ended, so there is no continuation"
    );
}

/// Both clamps, and the answer reports the one that applied (D-1020-D3-12).
#[test]
fn the_window_reports_the_size_it_can_reach() {
    let connection = vault();
    let door = door(&connection);
    let answer = door
        .query(
            &Principal::Owner,
            &SearchRequest::new("knowledge.note", "cabin", 9_000),
        )
        .expect("notes answer");
    assert_eq!(
        answer.window(),
        Some(centraid_search::MAX_MATCH_ROWS),
        "a bound must not name a number it cannot reach"
    );
}

#[test]
fn a_query_with_no_searchable_word_is_a_refusal_not_an_empty_page() {
    let connection = vault();
    let door = door(&connection);
    assert!(matches!(
        door.query(
            &Principal::Owner,
            &SearchRequest::new("knowledge.note", "   ", 8)
        ),
        Err(SearchError::NoSearchableWords { .. })
    ));
}

/// FTS5 operators a member typed are words. Without the quoting in
/// `match_expression` this query would run `cabin OR password` as syntax.
#[test]
fn an_operator_a_member_typed_matches_nothing_rather_than_running() {
    let connection = vault();
    let door = door(&connection);
    let answer = door
        .query(
            &Principal::Owner,
            &SearchRequest::new("knowledge.note", "cabin OR sealedv1zqmarker", 8),
        )
        .expect("notes answer");
    assert_eq!(
        targets(&answer),
        Vec::<Target>::new(),
        "the three words are ANDed as literals, and no note carries all three"
    );
}

// ---------------------------------------------------------------------------
// Folded columns (#1097): text from another table, found through the parent
// ---------------------------------------------------------------------------

/// The ids one search finds in one domain.
fn found(door: &SqliteDoor<'_>, entity: &str, query: &str) -> Vec<String> {
    let answer = door
        .query(&Principal::Owner, &SearchRequest::new(entity, query, 50))
        .unwrap_or_else(|error| panic!("{entity} answered {error}"));
    targets(&answer)
        .into_iter()
        .map(|target| target.id)
        .collect()
}

fn ids<const N: usize>(ids: [&str; N]) -> Vec<String> {
    ids.into_iter().map(str::to_owned).collect()
}

/// One person with the profile and reach a member typed, and a memo. The
/// fixture's triggers fire as the product's do, so each row below re-indexes
/// the party it belongs to.
fn seed_person(connection: &Connection) {
    connection
        .execute(
            "INSERT INTO core_party (party_id, kind, display_name, sort_name, created_at)
             VALUES ('party-2', 'person', 'Ravi Menon', 'Menon, Ravi', ?1)",
            [NOW],
        )
        .expect("a person is inserted");
    connection
        .execute(
            "INSERT INTO people_profile
               (profile_id, party_id, role, nickname, cadence_days, met, created_at)
             VALUES ('profile-2', 'party-2', 'Cousin', 'Chotu', 30, 'at the Goa wedding', ?1)",
            [NOW],
        )
        .expect("a profile is inserted");
    connection
        .execute(
            "INSERT INTO social_contact_channel
               (channel_id, party_id, kind, value, normalized_value, created_at)
             VALUES ('channel-2', 'party-2', 'email', 'Ravi.Menon@Example.org',
                     'ravi.menon@example.org', ?1),
                    ('channel-3', 'party-2', 'phone', '+44 20 7946 0958', '+442079460958', ?1)",
            [NOW],
        )
        .expect("channels are inserted");
    connection
        .execute(
            "INSERT INTO knowledge_annotation
               (annotation_id, author_party_id, target_type, target_id, body_text, created_at)
             VALUES ('annotation-2', 'party-1', 'core.party', 'party-2', 'loves kayaking', ?1),
                    ('annotation-3', 'party-1', 'locker.item', 'item-1', 'zebrafish memo', ?1)",
            [NOW],
        )
        .expect("memos are inserted");
}

#[test]
fn a_person_is_found_by_nickname_role_where_they_met_email_phone_and_memo() {
    let connection = vault();
    seed_person(&connection);
    let door = door(&connection);
    for query in [
        "chotu",
        "cousin",
        "goa",
        "ravi.menon@example.org",
        "442079460958",
        "7946",
        "kayaking",
    ] {
        assert_eq!(
            found(&door, "core.party", query),
            ids(["party-2"]),
            "`{query}` finds the person"
        );
    }
    // The snippet is the index's own highlight, so it shows the folded word.
    let answer = door
        .query(
            &Principal::Owner,
            &SearchRequest::new("core.party", "chotu", 8),
        )
        .expect("people answer");
    assert!(targets(&answer)[0].snippet.contains("⟦"));
    // A Locker memo is an annotation too, and it is in no domain's index.
    for entity in DOMAINS.iter().map(|domain| domain.entity) {
        assert_eq!(found(&door, entity, "zebrafish"), Vec::<String>::new());
    }
}

/// An interaction with a note, linked to a person by the live edge
/// `people.log_interaction` writes (Q-1097-5). The activity's kind concept is a
/// row of its own because `core_activity.kind_concept_id` is a real reference.
fn seed_interaction(connection: &Connection, owner: &str, with: &[&str]) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO core_concept_scheme (scheme_id, uri, title, publisher, version, created_at)
         VALUES ('scheme-act', 'urn:duaility:activity-kinds', 'Activity kinds', 'centraid', '1', ?1),
                ('scheme-rel', 'urn:duaility:relations', 'Link relation types', 'centraid', '1', ?1)",
        [NOW],
    )?;
    connection.execute(
        "INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label, created_at, updated_at)
         VALUES ('concept-lunch', 'scheme-act', 'lunch', 'lunch', ?1, ?1),
                ('concept-about', 'scheme-rel', 'about', 'About', ?1, ?1)",
        [NOW],
    )?;
    connection.execute(
        "INSERT INTO core_activity (activity_id, actor_party_id, kind_concept_id, started_at, created_at)
         VALUES ('activity-1', ?1, 'concept-lunch', ?2, ?2)",
        rusqlite::params![owner, NOW],
    )?;
    for (index, party) in with.iter().enumerate() {
        connection.execute(
            "INSERT INTO core_link
               (link_id, from_type, from_id, to_type, to_id, relation_concept_id,
                valid_from, valid_to, asserted_by, provenance_id, updated_at)
             VALUES (?1, 'core.activity', 'activity-1', 'core.party', ?2, 'concept-about',
                     ?3, NULL, 'owner', NULL, ?3)",
            rusqlite::params![format!("link-{index}"), party, NOW],
        )?;
    }
    connection.execute(
        "INSERT INTO knowledge_annotation
           (annotation_id, author_party_id, target_type, target_id, body_text, created_at)
         VALUES ('annotation-act', ?1, 'core.activity', 'activity-1', 'lunch at Rao''s', ?2)",
        rusqlite::params![owner, NOW],
    )?;
    Ok(())
}

/// THE NOTE LOGGED ON AN INTERACTION FINDS THE PERSON, through the door, and a
/// slipped letter in it is corrected to the word the vault holds.
#[test]
fn an_interaction_note_finds_the_person_and_a_typo_in_it_is_corrected() {
    let connection = vault();
    seed_person(&connection);
    connection
        .execute(
            "INSERT INTO core_party (party_id, kind, display_name, sort_name, created_at)
             VALUES ('party-3', 'person', 'Asha Rao', 'Rao, Asha', ?1),
                    ('party-4', 'person', 'Jake Bennett', 'Bennett, Jake', ?1)",
            [NOW],
        )
        .expect("two more people are inserted");
    seed_interaction(&connection, "party-1", &["party-2", "party-3"])
        .expect("the interaction is inserted");
    let door = door(&connection);
    for query in ["lunch", "lunch at rao", "rao's"] {
        let mut people = found(&door, "core.party", query);
        people.sort();
        assert_eq!(
            people,
            ids(["party-2", "party-3"]),
            "`{query}` finds both participants and no one else"
        );
    }
    // The vocabulary holds the folded word, so a slip in it is corrected.
    assert_eq!(found(&door, "core.party", "lnuch"), Vec::<String>::new());
    assert_eq!(
        corrected(&door, &["core.party"], "lnuch").as_deref(),
        Some("lunch")
    );
    // The note is the person's, so no other domain finds it.
    for entity in DOMAINS.iter().map(|domain| domain.entity) {
        if entity != "core.party" {
            assert_eq!(found(&door, entity, "lunch"), Vec::<String>::new());
        }
    }
}

#[test]
fn an_event_is_found_by_its_place() {
    let connection = vault();
    connection
        .execute(
            "INSERT INTO core_place (place_id, name, created_at) VALUES ('place-1', 'Lisbon Docks', ?1)",
            [NOW],
        )
        .expect("a place is inserted");
    connection
        .execute(
            "INSERT INTO core_event
               (event_id, summary, dtstart, start_tz, status, sequence, location_place_id, created_at)
             VALUES ('event-2', 'Team offsite', '2099-06-12T09:00:00.000Z', 'Europe/London',
                     'confirmed', 0, 'place-1', ?1)",
            [NOW],
        )
        .expect("an event is inserted");
    let door = door(&connection);
    assert_eq!(found(&door, "core.event", "lisbon"), ids(["event-2"]));
    // The place's own rename reaches the event's row.
    connection
        .execute(
            "UPDATE core_place SET name = 'Porto Riverside' WHERE place_id = 'place-1'",
            [],
        )
        .expect("the place is renamed");
    assert_eq!(found(&door, "core.event", "lisbon"), Vec::<String>::new());
    assert_eq!(found(&door, "core.event", "porto"), ids(["event-2"]));
}

#[test]
fn a_task_is_found_by_its_project() {
    let connection = vault();
    connection
        .execute(
            "INSERT INTO schedule_project (project_id, owner_party_id, name, created_at)
             VALUES ('project-1', 'party-1', 'Kitchen refit', ?1)",
            [NOW],
        )
        .expect("a project is inserted");
    connection
        .execute(
            "INSERT INTO schedule_task
               (task_id, owner_party_id, title, status, priority, created_at, updated_at, project_id)
             VALUES ('task-2', 'party-1', 'Order tiles', 'needs-action', 0, ?1, ?1, 'project-1')",
            [NOW],
        )
        .expect("a task is inserted");
    let door = door(&connection);
    assert_eq!(found(&door, "schedule.task", "kitchen"), ids(["task-2"]));
}

#[test]
fn an_expense_is_found_by_category_group_line_item_and_memo() {
    let connection = vault();
    connection
        .execute(
            "INSERT INTO social_circle (circle_id, owner_party_id, name, kind)
             VALUES ('circle-1', 'party-1', 'Sitwell Road', 'custom')",
            [],
        )
        .expect("a circle is inserted");
    connection
        .execute(
            "INSERT INTO tally_group (group_id, circle_id, icon, color, currency, created_at)
             VALUES ('group-1', 'circle-1', 'x', 'blue', 'GBP', ?1)",
            [NOW],
        )
        .expect("a group is inserted");
    connection
        .execute(
            "INSERT INTO tally_expense
               (expense_id, group_id, description, amount_minor, currency, paid_by, spent_on,
                category, created_at)
             VALUES ('expense-2', 'group-1', 'Hardware shop', 3000, 'GBP', 'party-1',
                     '2099-05-04', 'utilities', ?1)",
            [NOW],
        )
        .expect("an expense is inserted");
    connection
        .execute(
            "INSERT INTO tally_expense_line_item
               (line_item_id, expense_id, kind, description, amount_minor, sort_order, created_at)
             VALUES ('line-1', 'expense-2', 'item', 'Paint', 2000, 0, ?1),
                    ('line-2', 'expense-2', 'item', 'Brushes', 1000, 1, ?1)",
            [NOW],
        )
        .expect("line items are inserted");
    connection
        .execute(
            "INSERT INTO knowledge_annotation
               (annotation_id, author_party_id, target_type, target_id, body_text, created_at)
             VALUES ('annotation-4', 'party-1', 'tally.expense', 'expense-2', 'the red folder', ?1)",
            [NOW],
        )
        .expect("a memo is inserted");
    let door = door(&connection);
    for query in ["utilities", "sitwell", "paint", "brushes", "folder"] {
        assert_eq!(
            found(&door, "tally.expense", query),
            ids(["expense-2"]),
            "`{query}` finds the expense"
        );
    }
    // The seeded expense's own category is a column of its index too.
    assert_eq!(found(&door, "tally.expense", "travel"), ids(["expense-1"]));
}

// ---------------------------------------------------------------------------
// The weight of a folded column, in a replayed vault and in a founded one
// ---------------------------------------------------------------------------

/// A project and five tasks: the word `gutters` is the title of one task and
/// the project of another.
///
/// The title hit sits in a longer row than the project hit, so equal weights
/// rank the shorter row first — which is what makes the order below the
/// WEIGHTS' doing. Three rows without the word keep its idf positive.
fn plant_gutters(connection: &Connection, owner: &str) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO schedule_project (project_id, owner_party_id, name, created_at)
         VALUES ('project-gutters', ?1, 'Gutters', ?2)",
        rusqlite::params![owner, NOW],
    )?;
    for (id, title, description, project) in [
        ("task-title", "Gutters", Some("clean before"), None),
        ("task-project", "Errands", None, Some("project-gutters")),
        ("task-a", "Milk", None, None),
        ("task-b", "Eggs", None, None),
        ("task-c", "Bread", None, None),
    ] {
        connection.execute(
            "INSERT INTO schedule_task
               (task_id, owner_party_id, title, description, status, priority,
                created_at, updated_at, project_id)
             VALUES (?1, ?2, ?3, ?4, 'needs-action', 0, ?5, ?5, ?6)",
            rusqlite::params![id, owner, title, description, NOW, project],
        )?;
    }
    Ok(())
}

/// The door's order for `gutters`, and the order the same index gives with equal
/// weights.
fn gutters_ranked(connection: &Connection) -> (Vec<String>, Vec<String>) {
    let door = door(connection);
    let by_door = found(&door, "schedule.task", "gutters");
    let mut statement = connection
        .prepare(
            "SELECT task_id FROM fts_schedule_task
              WHERE fts_schedule_task MATCH 'gutters'
              ORDER BY bm25(fts_schedule_task, 1.0, 1.0, 1.0, 1.0)",
        )
        .expect("the control prepares");
    let equal = statement
        .query_map([], |row| row.get::<_, String>(0))
        .expect("the control runs")
        .collect::<rusqlite::Result<Vec<String>>>()
        .expect("the control reads");
    (by_door, equal)
}

fn assert_a_title_outranks_a_project(by_door: &[String], by_equal_weights: &[String]) {
    let rows = |all: &[String]| -> Vec<String> {
        all.iter()
            .filter(|id| id.starts_with("task-title") || id.starts_with("task-project"))
            .cloned()
            .collect()
    };
    assert_eq!(
        rows(by_equal_weights),
        ids(["task-project", "task-title"]),
        "with equal weights the shorter row wins, so this test discriminates"
    );
    assert_eq!(
        rows(by_door),
        ids(["task-title", "task-project"]),
        "the folded project weighs less than the title"
    );
}

/// THE WEIGHTS ARE THE DOOR'S, so a vault built by replaying the DDL ranks as a
/// founded one does (#1097, R1d). This is the replayed one.
#[test]
fn a_title_hit_ranks_above_a_project_hit_in_a_replayed_vault() {
    let connection = vault();
    plant_gutters(&connection, "party-1").expect("the tasks are written");
    let (by_door, equal) = gutters_ranked(&connection);
    assert_a_title_outranks_a_project(&by_door, &equal);
}

/// And the founded one: `Vault::create`, every rung run, no weights stored.
#[test]
fn a_title_hit_ranks_above_a_project_hit_in_a_founded_vault() {
    let founded = founded_vault("door-rank");
    let owner = owner_of(&founded);
    founded
        .commit(|tx| {
            tx.set_producer("test.fixture");
            plant_gutters(tx.connection(), &owner)?;
            Ok(())
        })
        .expect("the tasks are written");
    let (by_door, equal) = founded
        .read(|connection| Ok(gutters_ranked(connection)))
        .expect("the ranking reads");
    assert_a_title_outranks_a_project(&by_door, &equal);
}

fn founded_vault(seed: &str) -> centraid_vault::Vault {
    use centraid_vault::clock::{FixedClock, SeededIds};

    let dir = centraid_ontology::golden::scratch_dir();
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    let vault = centraid_vault::Vault::create_with(
        dir.join("vault.db"),
        Box::new(FixedClock::frozen()),
        Box::new(SeededIds::new(seed)),
    )
    .expect("a vault is created");
    vault
        .found("Test", "Test Owner")
        .expect("a vault is founded");
    vault
}

fn owner_of(vault: &centraid_vault::Vault) -> String {
    vault
        .read(|connection| {
            Ok(
                connection.query_row(
                    "SELECT self_party_id FROM core_vault LIMIT 1",
                    [],
                    |row| row.get(0),
                )?,
            )
        })
        .expect("an owner")
}

/// The index columns rung thirteen folded in, which are the ones that weigh half.
/// Written out here, apart from the list in `domains.rs`, so a weight that sits
/// on the wrong column is a difference between two statements of one fact.
const HALF_WEIGHT: [(&str, &str); 11] = [
    ("core.party", "nickname"),
    ("core.party", "role"),
    ("core.party", "met"),
    ("core.party", "channels"),
    ("core.party", "memo"),
    ("core.event", "location"),
    ("schedule.task", "project"),
    ("tally.expense", "category"),
    ("tally.expense", "group_name"),
    ("tally.expense", "items"),
    ("tally.expense", "memo"),
];

fn assert_weights_sit_on_their_columns(connection: &Connection) {
    for domain in DOMAINS {
        let live: Vec<String> = connection
            .prepare("SELECT name FROM pragma_table_info(?1) ORDER BY cid")
            .expect("the columns prepare")
            .query_map([domain.fts], |row| row.get::<_, String>(0))
            .expect("the columns read")
            .collect::<rusqlite::Result<_>>()
            .expect("the columns read");
        assert_eq!(
            live.len(),
            domain.weights.len(),
            "{} has {} columns and {} weights",
            domain.fts,
            live.len(),
            domain.weights.len()
        );
        for (column, weight) in live.iter().zip(domain.weights) {
            let expected = if HALF_WEIGHT.contains(&(domain.entity, column.as_str())) {
                0.5
            } else {
                1.0
            };
            assert!(
                (weight - expected).abs() < f64::EPSILON,
                "{}.{column} weighs {weight}, not {expected}",
                domain.fts
            );
        }
    }
}

#[test]
fn every_weight_sits_on_the_column_it_names_in_both_kinds_of_vault() {
    assert_weights_sit_on_their_columns(&vault());
    let founded = founded_vault("door-weights");
    founded
        .read(|connection| {
            assert_weights_sit_on_their_columns(connection);
            Ok(())
        })
        .expect("the founded schema reads");
}

/// No index stores a rank: a stored override would make the two kinds of vault
/// disagree again.
#[test]
fn no_index_stores_a_rank_override() {
    let founded = founded_vault("door-no-rank");
    founded
        .read(|connection| {
            for domain in DOMAINS {
                let stored: i64 = connection.query_row(
                    &format!(
                        "SELECT COUNT(*) FROM {}_config WHERE k = 'rank'",
                        domain.fts
                    ),
                    [],
                    |row| row.get(0),
                )?;
                assert_eq!(stored, 0, "{} stores a rank", domain.fts);
            }
            Ok(())
        })
        .expect("the config reads");
}

// ---------------------------------------------------------------------------
// The open-time check over a real model
// ---------------------------------------------------------------------------

/// A DEMONSTRATED RED over the committed model: an index that grew a column
/// nobody listed does not open, whatever the column is called.
#[test]
fn an_index_that_grew_an_unlisted_column_fails_to_open_over_the_committed_model() {
    let connection = vault();
    assert!(SqliteDoor::open(&connection).is_ok());
    connection
        .execute_batch(
            "DROP TABLE fts_core_party;
             CREATE VIRTUAL TABLE fts_core_party USING fts5(
               party_id UNINDEXED, display_name, sort_name, nickname, role, met, channels, memo,
               scratchpad, tokenize = \"unicode61 remove_diacritics 2\");",
        )
        .expect("the index is rebuilt with one more column");
    match SqliteDoor::open(&connection) {
        Err(SearchError::IndexUnusable { entity, detail }) => {
            assert_eq!(entity, "core.party");
            assert!(detail.contains("scratchpad"), "{detail}");
        }
        other => panic!(
            "the door opened over an unlisted fold: {:?}",
            other.map(|_| ())
        ),
    }
}

// ---------------------------------------------------------------------------
// The correction (#1097, R4, R4a): a word the vault does not hold, replaced by
// one it does
// ---------------------------------------------------------------------------

/// A task of this owner. The trigger fires as the product's do, so the title is in
/// the vocabulary of `schedule.task` the moment it is written.
fn add_task(connection: &Connection, owner: &str, id: &str, title: &str) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO schedule_task
           (task_id, owner_party_id, title, status, priority, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'needs-action', 0, ?4, ?4)",
        rusqlite::params![id, owner, title, NOW],
    )?;
    Ok(())
}

fn add_event(connection: &Connection, id: &str, summary: &str) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO core_event
           (event_id, summary, dtstart, start_tz, status, sequence, created_at)
         VALUES (?1, ?2, '2099-06-10T17:00:00.000Z', 'UTC', 'confirmed', 0, ?3)",
        rusqlite::params![id, summary, NOW],
    )?;
    Ok(())
}

/// Seeds a vault, then runs `check` over it: once on the contract fixture (the
/// committed DDL replayed, owner `party-1`) and once on a founded vault
/// (`Vault::create`, every rung run). The vocabularies are the same tables, but
/// only the second is the file the product writes, so a correction is proved on
/// both.
fn on_both_vaults(
    seed: impl Fn(&Connection, &str) -> rusqlite::Result<()>,
    check: impl Fn(&Connection),
) {
    let fixture = vault();
    seed(&fixture, "party-1").expect("the fixture is seeded");
    check(&fixture);

    let founded = founded_vault("door-correct");
    let owner = owner_of(&founded);
    founded
        .commit(|tx| {
            tx.set_producer("test.fixture");
            seed(tx.connection(), &owner)?;
            Ok(())
        })
        .expect("the founded vault is seeded");
    founded
        .read(|connection| {
            check(connection);
            Ok(())
        })
        .expect("the founded vault is read");
}

/// What `correct` says for one query over the named entities.
fn corrected(door: &SqliteDoor<'_>, entities: &[&str], query: &str) -> Option<String> {
    door.correct(&Principal::Owner, entities, query)
        .unwrap_or_else(|error| panic!("`{query}` over {entities:?} answered {error}"))
}

const TASKS: [&str; 1] = ["schedule.task"];

fn seed_budget(connection: &Connection, owner: &str) -> rusqlite::Result<()> {
    add_task(connection, owner, "task-budget", "Quarterly budget review")?;
    add_task(
        connection,
        owner,
        "task-parcel",
        "Package received at the office",
    )?;
    add_task(connection, owner, "task-roof", "Replace the roof tiles")?;
    Ok(())
}

/// THE HEADLINE, on both kinds of vault: one slipped letter, each way a letter
/// slips, lands on the word the vault holds.
#[test]
fn a_slipped_word_is_corrected_to_the_word_the_vault_holds() {
    on_both_vaults(seed_budget, |connection| {
        let door = door(connection);
        // Two neighbours swapped, in the middle of the word.
        assert_eq!(
            corrected(&door, &TASKS, "budegt").as_deref(),
            Some("budget")
        );
        // A letter different.
        assert_eq!(
            corrected(&door, &TASKS, "budhet").as_deref(),
            Some("budget")
        );
        // A letter too many.
        assert_eq!(
            corrected(&door, &TASKS, "budgget").as_deref(),
            Some("budget")
        );
        // A letter dropped: the answer is the whole word the vault holds (R4b),
        // `received`, not the prefix `receive` the index would also match.
        assert_eq!(
            corrected(&door, &TASKS, "recive").as_deref(),
            Some("received")
        );
        // The classic: `ie` and `ei`.
        assert_eq!(
            corrected(&door, &TASKS, "recieve").as_deref(),
            Some("received")
        );
        // Mid-word as you type: the slip is in the letters typed so far, and the
        // word is the whole term (R4b), not the five letters the slip was read in.
        assert_eq!(corrected(&door, &TASKS, "budeg").as_deref(), Some("budget"));
        // The case and the accent a member typed are the index's to forgive.
        assert_eq!(
            corrected(&door, &TASKS, "BUDEGT").as_deref(),
            Some("budget")
        );
        // A swap of the first two letters is the one first-letter slip (R4a).
        assert_eq!(
            corrected(&door, &TASKS, "ubdget").as_deref(),
            Some("budget")
        );
    });
}

/// R4B: the correction is the WHOLE term the vault holds, and the member is told
/// that word. `sunscren` is one edit from the prefix `sunscree`; the answer is
/// `sunscreen`, and the re-search finds the row with it.
#[test]
fn a_correction_is_the_whole_word_the_vault_holds() {
    on_both_vaults(
        |connection, owner| {
            seed_budget(connection, owner)?;
            add_task(connection, owner, "task-sun", "Buy sunscreen for the trip")
        },
        |connection| {
            let door = door(connection);
            assert_eq!(
                corrected(&door, &TASKS, "sunscren").as_deref(),
                Some("sunscreen")
            );
            let answer = door
                .query(
                    &Principal::Owner,
                    &SearchRequest::new("schedule.task", "sunscreen", 8),
                )
                .expect("the search answers");
            assert_eq!(
                targets(&answer)
                    .into_iter()
                    .map(|target| target.id)
                    .collect::<Vec<String>>(),
                ids(["task-sun"])
            );
        },
    );
}

/// THE POINT OF IT: the typed query finds nothing, and the corrected one finds the
/// row. A demonstrated red for the correction is this test without it.
#[test]
fn the_corrected_query_finds_the_row_the_typed_one_could_not() {
    on_both_vaults(seed_budget, |connection| {
        let door = door(connection);
        let ask = |query: &str| {
            let answer = door
                .query(
                    &Principal::Owner,
                    &SearchRequest::new("schedule.task", query, 8),
                )
                .expect("the search answers");
            targets(&answer)
                .into_iter()
                .map(|target| target.id)
                .collect::<Vec<String>>()
        };
        assert!(ask("budegt").is_empty(), "the slip finds nothing");
        let query = corrected(&door, &TASKS, "budegt").expect("the slip is corrected");
        assert_eq!(ask(&query), ids(["task-budget"]));
        // And `recieve` finds `received` through the word it was corrected to.
        assert!(ask("recieve").is_empty());
        let query = corrected(&door, &TASKS, "recieve").expect("the slip is corrected");
        assert_eq!(ask(&query), ids(["task-parcel"]));
    });
}

/// Only the unknown word changes: a known word keeps the case it was typed in.
#[test]
fn in_a_query_of_several_words_only_the_unknown_one_changes() {
    on_both_vaults(seed_budget, |connection| {
        let door = door(connection);
        assert_eq!(
            corrected(&door, &TASKS, "Quarterly budegt").as_deref(),
            Some("Quarterly budget")
        );
        assert_eq!(
            corrected(&door, &TASKS, "roof budegt recieve").as_deref(),
            Some("roof budget received")
        );
        // Nothing unknown, nothing to say.
        assert_eq!(corrected(&door, &TASKS, "Quarterly budget"), None);
    });
}

/// Documents are summed across the entities named, and only across those.
#[test]
fn the_documents_of_a_term_add_across_the_entities_named() {
    let seed = |connection: &Connection, owner: &str| -> rusqlite::Result<()> {
        // `budgat` is one edit from `budget` and from `budgit`. In the tasks
        // `budgit` is in more documents; in the events `budget` is.
        add_task(connection, owner, "task-a", "budget")?;
        add_task(connection, owner, "task-b", "budgit")?;
        add_task(connection, owner, "task-c", "budgit")?;
        add_event(connection, "event-a", "budget")?;
        add_event(connection, "event-b", "budget")?;
        Ok(())
    };
    on_both_vaults(seed, |connection| {
        let door = door(connection);
        let events = ["core.event"];
        assert_eq!(
            corrected(&door, &TASKS, "budgat").as_deref(),
            Some("budgit")
        );
        assert_eq!(
            corrected(&door, &events, "budgat").as_deref(),
            Some("budget")
        );
        // 1 + 2 documents of `budget` beat 2 of `budgit`: they add.
        assert_eq!(
            corrected(&door, &["schedule.task", "core.event"], "budgat").as_deref(),
            Some("budget")
        );
        // The same entity named twice is one entity, not double the documents.
        assert_eq!(
            corrected(&door, &["schedule.task", "schedule.task"], "budgat").as_deref(),
            Some("budgit")
        );
    });
}

/// EVERYTHING THAT IS LEFT ALONE, and why each one is.
#[test]
fn a_word_that_is_not_a_slip_is_left_alone() {
    on_both_vaults(seed_budget, |connection| {
        let door = door(connection);
        // A word the vault holds, whole or as the start of one.
        assert_eq!(corrected(&door, &TASKS, "budget"), None);
        assert_eq!(corrected(&door, &TASKS, "budg"), None);
        assert_eq!(corrected(&door, &TASKS, "Quarterly"), None);
        // Under four letters: `roc` is one edit from `roof`, and is not a typo.
        assert_eq!(corrected(&door, &TASKS, "roc"), None);
        assert_eq!(corrected(&door, &TASKS, "rof"), None);
        // A digit: a number is not a misspelling of another number.
        assert_eq!(corrected(&door, &TASKS, "budg3t"), None);
        assert_eq!(corrected(&door, &TASKS, "2026"), None);
        // A slip in the FIRST letter (R4a): the scan reads the terms that start
        // like the word, and `gudget` does not start like `budget`.
        assert_eq!(corrected(&door, &TASKS, "gudget"), None);
        assert_eq!(corrected(&door, &TASKS, "pecieve"), None);
        // A word two edits away.
        assert_eq!(corrected(&door, &TASKS, "bugdte"), None);
        // Nothing near it at all.
        assert_eq!(corrected(&door, &TASKS, "zzyzx"), None);
        // No searchable word is nothing to correct, not an error.
        assert_eq!(corrected(&door, &TASKS, "   --- "), None);
        assert_eq!(corrected(&door, &TASKS, ""), None);
    });
}

/// The word's near term lives in a domain the caller did not name: the caller is
/// about to search the ones it named, so a term only another holds is no help.
#[test]
fn a_term_in_a_domain_that_is_not_named_is_not_offered() {
    on_both_vaults(seed_budget, |connection| {
        let door = door(connection);
        assert_eq!(corrected(&door, &["core.event"], "budegt"), None);
        assert_eq!(
            corrected(&door, &["core.party", "core.event"], "budegt"),
            None
        );
        assert_eq!(corrected(&door, &[], "budegt"), None);
        assert_eq!(
            corrected(&door, &["core.event", "schedule.task"], "budegt").as_deref(),
            Some("budget")
        );
    });
}

/// A slip in a word that no longer fits the exact answer of ONE domain but is the
/// word of another is the caller's call: `correct` says `known` as soon as any
/// named domain holds the word, so a Home search is not rewritten by a domain that
/// has no such word.
#[test]
fn a_word_any_named_domain_holds_is_known() {
    on_both_vaults(
        |connection, owner| {
            add_task(connection, owner, "task-a", "budgat")?;
            add_event(connection, "event-a", "budget")?;
            Ok(())
        },
        |connection| {
            let door = door(connection);
            // `budgat` is a term of the tasks, so over both it is held...
            assert_eq!(
                corrected(&door, &["core.event", "schedule.task"], "budgat"),
                None
            );
            // ...and over the events alone it is a slip of `budget`.
            assert_eq!(
                corrected(&door, &["core.event"], "budgat").as_deref(),
                Some("budget")
            );
        },
    );
}

/// LOCKER IS NOT A DOMAIN, FOR A CORRECTION AS FOR A SEARCH. Asking is a refusal,
/// even beside entities that are domains, and nothing answers before it.
#[test]
fn an_entity_that_is_not_a_domain_is_a_refusal_for_a_correction_too() {
    let connection = vault();
    with_a_locker_index(&connection);
    let door = door(&connection);
    for entity in [
        "locker.item",
        "locker.item_field",
        "locker.item_passkey",
        "sync.connection_credential",
    ] {
        for entities in [vec![entity], vec!["schedule.task", entity]] {
            let refused = door.correct(&Principal::Owner, &entities, "budegt");
            assert!(
                matches!(refused, Err(SearchError::NotADomain { count: 7, .. })),
                "{entities:?} answered {refused:?} rather than refusing"
            );
        }
    }
}

/// A word that lives only in Locker's index is not offered to any search: the
/// index is populated, the vocabulary of a domain is not Locker's, and the typo of
/// the title of a login is corrected to nothing.
#[test]
fn a_word_only_the_locker_index_holds_is_never_offered() {
    let connection = vault();
    with_a_locker_index(&connection);
    let in_locker: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM fts_locker_item WHERE fts_locker_item MATCH '\"booking\"*'",
            [],
            |row| row.get(0),
        )
        .expect("the locker index answers");
    assert_eq!(in_locker, 1, "the control: Locker holds `booking`");
    let no_vocabulary: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name = 'fts_locker_item_vocab'",
            [],
            |row| row.get(0),
        )
        .expect("the schema answers");
    assert_eq!(no_vocabulary, 0, "Locker has no vocabulary");
    let door = door(&connection);
    let every_domain: Vec<&str> = DOMAINS.iter().map(|domain| domain.entity).collect();
    assert_eq!(corrected(&door, &every_domain, "bookign"), None);
}

/// A vault from before the vocabulary says so, as the unusable index it is,
/// rather than answering that nothing needed correcting.
#[test]
fn a_vault_without_the_vocabulary_is_an_unusable_index() {
    let connection = vault();
    connection
        .execute_batch("DROP TABLE fts_schedule_task_vocab;")
        .expect("the vocabulary is dropped");
    let door = door(&connection);
    match door.correct(&Principal::Owner, &TASKS, "budegt") {
        Err(SearchError::IndexUnusable { entity, detail }) => {
            assert_eq!(entity, "schedule.task");
            assert!(detail.contains("fts_schedule_task_vocab"), "{detail}");
        }
        other => panic!("a missing vocabulary answered {other:?}"),
    }
}

/// `n` distinct terms, each `q` and five letters, in term order: `qaaaaa`,
/// `qaaaab`, ...
fn filler_term(n: usize) -> String {
    let mut letters = [b'a'; 5];
    let mut rest = n;
    for slot in letters.iter_mut().rev() {
        *slot = b'a' + u8::try_from(rest % 26).expect("a base-26 digit");
        rest /= 26;
    }
    format!("q{}", String::from_utf8_lossy(&letters))
}

/// THE SCAN HAS A HARD BOUND, AND IT IS DETERMINISTIC (doctrine: nothing whose
/// cost scales with the vault runs unbounded on the request path).
///
/// More terms than the bound under one first letter, in term order. A typo of the
/// last term the scan reads is corrected; a typo of the first it does not read is
/// not, though its target is right there in the vocabulary. The plan check is the
/// other half: the vocabulary honours the range on `term` and hands the rows over
/// in term order, so the limit stops the walk and does not sort a bucket.
#[test]
fn the_vocabulary_scan_stops_at_its_bound() {
    let terms: Vec<String> = (0..MAX_VOCAB_SCAN + 10).map(filler_term).collect();
    let seed = |connection: &Connection, owner: &str| -> rusqlite::Result<()> {
        for (index, chunk) in terms.chunks(200).enumerate() {
            add_task(
                connection,
                owner,
                &format!("bound-{index}"),
                &chunk.join(" "),
            )?;
        }
        Ok(())
    };
    on_both_vaults(seed, |connection| {
        let door = door(connection);
        let slip = |term: &str| format!("q{term}"); // one letter too many
        let last_read = &terms[MAX_VOCAB_SCAN - 1];
        let first_unread = &terms[MAX_VOCAB_SCAN];
        // The control: inside the bound the typo is corrected...
        assert_eq!(
            corrected(&door, &TASKS, &slip(last_read)).as_deref(),
            Some(last_read.as_str())
        );
        assert_eq!(
            corrected(&door, &TASKS, &slip(&terms[0])).as_deref(),
            Some(terms[0].as_str())
        );
        // ...and past it, it is not: the bound, not the vocabulary, decides.
        assert_eq!(corrected(&door, &TASKS, &slip(first_unread)), None);
        assert_eq!(
            corrected(&door, &TASKS, &slip(terms.last().expect("terms"))),
            None
        );

        // The plan: a range scan on `term` that returns its rows in order.
        let plan: Vec<String> = connection
            .prepare(
                "EXPLAIN QUERY PLAN SELECT term, doc FROM fts_schedule_task_vocab
                  WHERE term >= ?1 AND term < ?2 ORDER BY term LIMIT ?3",
            )
            .expect("the plan prepares")
            .query_map(rusqlite::params!["q", "r", 10], |row| {
                row.get::<_, String>(3)
            })
            .expect("the plan reads")
            .collect::<rusqlite::Result<_>>()
            .expect("the plan rows read");
        let plan = plan.join("; ");
        assert!(plan.contains("VIRTUAL TABLE INDEX"), "{plan}");
        assert!(
            !plan.contains("TEMP B-TREE"),
            "the bucket is sorted: {plan}"
        );

        // And the walk is the limit's: a bucket of ten thousand terms costs the
        // virtual machine steps for the rows it returned, not for the bucket.
        let steps = |limit: i64| -> i32 {
            let mut statement = connection
                .prepare(
                    "SELECT term, doc FROM fts_schedule_task_vocab
                      WHERE term >= 'q' AND term < 'r' ORDER BY term LIMIT ?1",
                )
                .expect("the scan prepares");
            let rows = statement
                .query_map([limit], |row| row.get::<_, String>(0))
                .expect("the scan reads")
                .count();
            assert_eq!(i64::try_from(rows).expect("a count"), limit.min(10_000));
            statement.get_status(rusqlite::StatementStatus::VmStep)
        };
        let (small, large) = (steps(100), steps(2_000));
        assert!(
            small < 100 * 20 && large < 2_000 * 20,
            "the scan costs more than its rows: {small} steps for 100, {large} for 2000"
        );
    });
}

// ---------------------------------------------------------------------------
// The cost of a correction, measured
// ---------------------------------------------------------------------------

/// A small deterministic generator (xorshift64*): the same vault on every machine.
struct Random(u64);

impl Random {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, bound: usize) -> usize {
        usize::try_from(self.next() % u64::try_from(bound).expect("a bound")).expect("an index")
    }
}

/// English initial letters by weight (per mille), so the busiest buckets are as
/// busy as a real vocabulary's: `s` is a ninth of it.
const INITIALS: [(char, usize); 26] = [
    ('a', 60),
    ('b', 55),
    ('c', 90),
    ('d', 50),
    ('e', 30),
    ('f', 40),
    ('g', 25),
    ('h', 35),
    ('i', 30),
    ('j', 8),
    ('k', 8),
    ('l', 30),
    ('m', 55),
    ('n', 20),
    ('o', 25),
    ('p', 75),
    ('q', 5),
    ('r', 50),
    ('s', 110),
    ('t', 50),
    ('u', 15),
    ('v', 15),
    ('w', 25),
    ('x', 1),
    ('y', 4),
    ('z', 3),
];

/// A pronounceable word of four to eleven letters.
fn pseudo_word(random: &mut Random) -> String {
    let total: usize = INITIALS.iter().map(|(_, weight)| weight).sum();
    let mut pick = random.below(total);
    let mut word = String::new();
    for (letter, weight) in INITIALS {
        if pick < weight {
            word.push(letter);
            break;
        }
        pick -= weight;
    }
    let length = 4 + random.below(8);
    let (vowels, consonants) = ("aeiou", "bcdfghjklmnprstvwy");
    while word.chars().count() < length {
        let pool = if word.ends_with(|c| vowels.contains(c)) {
            consonants
        } else {
            vowels
        };
        let at = random.below(pool.len());
        word.push(pool.as_bytes()[at] as char);
    }
    word
}

/// One slip in a word, never in its first letter.
fn slipped(random: &mut Random, word: &str) -> String {
    let mut letters: Vec<char> = word.chars().collect();
    let at = 1 + random.below(letters.len() - 1);
    match random.below(4) {
        0 if at + 1 < letters.len() && letters[at] != letters[at + 1] => letters.swap(at, at + 1),
        1 => {
            letters.remove(at);
        }
        2 => letters.insert(at, 'z'),
        _ => letters[at] = if letters[at] == 'x' { 'y' } else { 'x' },
    }
    letters.into_iter().collect()
}

/// THE LATENCY OF A CORRECTION, on a vault of about 50,000 distinct terms. Not run
/// by the suite — wall time is a machine's, not a build's — and the receipt holds
/// the figures:
///
/// ```sh
/// cargo test -p centraid-search --test door correction_latency_on_fifty_thousand_terms \
///     -- --ignored --nocapture
/// ```
///
/// The terms are spread over four domains (tasks, events, people, expenses) as a
/// Home search would read them, with English initial letters so the busiest bucket
/// is the busiest a real vocabulary has. Each of 100 calls is one word with one
/// slip in it (never in the first letter), asked over the four domains and over
/// the tasks alone; then 100 calls of a three-word query with two slips.
#[test]
#[ignore = "a measurement, run by hand: the command is in the doc comment"]
fn correction_latency_on_fifty_thousand_terms() {
    const TERMS: usize = 50_000;
    let connection = vault();
    let mut random = Random(0x9E37_79B9_7F4A_7C15);
    let mut seen = std::collections::HashSet::new();
    let mut terms: Vec<String> = Vec::with_capacity(TERMS);
    while terms.len() < TERMS {
        let word = pseudo_word(&mut random);
        if seen.insert(word.clone()) {
            terms.push(word);
        }
    }
    connection.execute_batch("BEGIN").expect("a transaction");
    for (index, chunk) in terms.chunks(8).enumerate() {
        let text = chunk.join(" ");
        // Half the terms in tasks, a fifth in events, the rest in people and expenses.
        match index % 20 {
            0..=9 => add_task(&connection, "party-1", &format!("synthetic-task-{index}"), &text),
            10..=13 => add_event(&connection, &format!("synthetic-event-{index}"), &text),
            14..=16 => connection
                .execute(
                    "INSERT INTO core_party (party_id, kind, display_name, sort_name, created_at)
                     VALUES (?1, 'person', ?2, ?2, ?3)",
                    rusqlite::params![format!("synthetic-party-{index}"), text, NOW],
                )
                .map(|_| ()),
            _ => connection
                .execute(
                    "INSERT INTO tally_expense
                       (expense_id, description, amount_minor, currency, paid_by, spent_on, category, created_at)
                     VALUES (?1, ?2, 100, 'USD', 'party-1', '2099-05-30', 'general', ?3)",
                    rusqlite::params![format!("synthetic-expense-{index}"), text, NOW],
                )
                .map(|_| ()),
        }
        .expect("a synthetic row is inserted");
    }
    // The bound itself: a bucket of the tasks' vocabulary past `MAX_VOCAB_SCAN`, so
    // a word that starts with `q` makes the scan read every row it may.
    let fillers: Vec<String> = (0..MAX_VOCAB_SCAN + 10).map(filler_term).collect();
    for (index, chunk) in fillers.chunks(200).enumerate() {
        add_task(
            &connection,
            "party-1",
            &format!("synthetic-filler-{index}"),
            &chunk.join(" "),
        )
        .expect("a filler row is inserted");
    }
    connection.execute_batch("COMMIT").expect("the rows commit");

    for domain in ["schedule_task", "core_event", "core_party", "tally_expense"] {
        let (distinct, busiest, letter): (i64, i64, String) = connection
            .query_row(
                &format!(
                    "SELECT (SELECT COUNT(*) FROM fts_{domain}_vocab),
                            MAX(n), c FROM (SELECT substr(term, 1, 1) c, COUNT(*) n
                                              FROM fts_{domain}_vocab GROUP BY c)"
                ),
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .expect("the vocabulary counts");
        eprintln!("{domain}: {distinct} terms, the busiest first letter `{letter}` has {busiest}");
    }

    let door = door(&connection);
    let home = ["schedule.task", "core.event", "core.party", "tally.expense"];
    let measure = |label: &str, entities: &[&str], words: usize| {
        let mut random = Random(0xD1B5_4A32_D192_ED03);
        let mut micros: Vec<u128> = Vec::new();
        let mut corrected = 0;
        for call in 0..100 {
            // One word with a slip; the others as the vault holds them, so the
            // call costs what a correction costs and not a refusal.
            let query: Vec<String> = (0..words)
                .map(|n| {
                    let term = &terms[random.below(terms.len())];
                    if n + 1 == words || n == call % words {
                        slipped(&mut random, term)
                    } else {
                        term.clone()
                    }
                })
                .collect();
            let started = std::time::Instant::now();
            let answer = door
                .correct(&Principal::Owner, entities, &query.join(" "))
                .expect("the correction answers");
            micros.push(started.elapsed().as_micros());
            corrected += usize::from(answer.is_some());
        }
        micros.sort_unstable();
        eprintln!(
            "{label}: p50 {:.2} ms, p95 {:.2} ms, max {:.2} ms; {corrected} of 100 corrected",
            micros[50] as f64 / 1000.0,
            micros[95] as f64 / 1000.0,
            micros[99] as f64 / 1000.0,
        );
    };
    measure("one word, four domains ", &home, 1);
    measure("one word, tasks only   ", &TASKS, 1);
    measure("three words, four domains", &home, 3);

    // THE BOUND ITSELF: a typo of the first term the scan does not read, so it
    // reads all `MAX_VOCAB_SCAN` rows of the bucket and corrects nothing.
    let mut micros: Vec<u128> = Vec::new();
    let query = format!("q{}", fillers[MAX_VOCAB_SCAN]);
    for _ in 0..100 {
        let started = std::time::Instant::now();
        let answer = door
            .correct(&Principal::Owner, &TASKS, &query)
            .expect("the correction answers");
        micros.push(started.elapsed().as_micros());
        assert_eq!(answer, None, "the bound did not hold");
    }
    micros.sort_unstable();
    eprintln!(
        "the bound ({MAX_VOCAB_SCAN} rows), tasks only: p50 {:.2} ms, max {:.2} ms",
        micros[50] as f64 / 1000.0,
        micros[99] as f64 / 1000.0,
    );
}

// ---------------------------------------------------------------------------
// The containers (#1097, R-1097-19..21): a second registry beside the domains
// ---------------------------------------------------------------------------

const FOLDERS_URI: &str = "https://centraid.dev/schemes/folders";

/// One of each container, as the product writes them, plus the rows that must
/// NOT be found: an archived project, a circle with an archived group, a circle
/// no group stands on, the folders scheme's root and a tag.
fn seed_containers(connection: &Connection, owner: &str) -> rusqlite::Result<()> {
    for (id, kind, name) in [
        ("nb-1", "notebook", "Reading list"),
        ("al-1", "album", "Reading trip"),
    ] {
        connection.execute(
            "INSERT INTO core_collection
               (collection_id, owner_party_id, kind, name, sort_order, created_at)
             VALUES (?1, ?2, ?3, ?4, 0, ?5)",
            rusqlite::params![id, owner, kind, name, NOW],
        )?;
    }
    for (id, name, archived) in [
        ("pr-1", "Kitchen refit", None),
        ("pr-2", "Kitchen archive", Some(NOW)),
    ] {
        connection.execute(
            "INSERT INTO schedule_project (project_id, owner_party_id, name, archived_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![id, owner, name, archived, NOW],
        )?;
    }
    for (circle, group, name, archived) in [
        ("ci-1", Some("gr-1"), "Kitchen flat", None),
        ("ci-2", Some("gr-2"), "Kitchen old flat", Some(NOW)),
        ("ci-3", None, "Kitchen cousins", None),
    ] {
        connection.execute(
            "INSERT INTO social_circle (circle_id, owner_party_id, name, kind)
             VALUES (?1, ?2, ?3, 'custom')",
            rusqlite::params![circle, owner, name],
        )?;
        if let Some(group) = group {
            connection.execute(
                "INSERT INTO tally_group
                   (group_id, circle_id, icon, color, currency, archived_at, created_at)
                 VALUES (?1, ?2, 'x', 'blue', 'GBP', ?3, ?4)",
                rusqlite::params![group, circle, archived, NOW],
            )?;
        }
    }
    connection.execute(
        "INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
         VALUES ('sch-f', ?1, 'Folders', '1'), ('sch-t', 'https://centraid.dev/schemes/tags', 'Tags', '1')",
        [FOLDERS_URI],
    )?;
    for (id, scheme, notation, label) in [
        ("cn-root", "sch-f", "root", "Kitchen root"),
        ("cn-1", "sch-f", "kitchen-docs", "Kitchen documents"),
        ("cn-tag", "sch-t", "kitchen", "Kitchen tag"),
    ] {
        connection.execute(
            "INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![id, scheme, notation, label],
        )?;
    }
    Ok(())
}

fn app_of_each(door: &SqliteDoor<'_>, entity: &str, query: &str) -> Vec<(String, String)> {
    let answer = door
        .query(&Principal::Owner, &SearchRequest::new(entity, query, 50))
        .unwrap_or_else(|error| panic!("{entity} answered {error}"));
    targets(&answer)
        .into_iter()
        .map(|target| (target.id, target.app_id))
        .collect()
}

fn pairs<const N: usize>(rows: [(&str, &str); N]) -> Vec<(String, String)> {
    rows.into_iter()
        .map(|(id, app)| (id.to_owned(), app.to_owned()))
        .collect()
}

/// EACH CONTAINER IS FOUND BY ITS NAME, on the replayed DDL and on a founded
/// vault, with the app it opens in, and only while it is live.
#[test]
fn each_container_is_found_by_name_with_the_app_it_opens_in_and_only_while_live() {
    on_both_vaults(seed_containers, |connection| {
        let door = door(connection);
        // One index, two apps: the kind decides, in id order within one rank.
        let mut both = app_of_each(&door, "core.collection", "reading");
        both.sort();
        assert_eq!(both, pairs([("al-1", "photos"), ("nb-1", "notes")]));
        assert_eq!(
            app_of_each(&door, "schedule.project", "kitchen"),
            pairs([("pr-1", "tasks")]),
            "an archived project is not found"
        );
        assert_eq!(
            app_of_each(&door, "social.circle", "kitchen"),
            pairs([("ci-1", "tally")]),
            "a circle with an archived group, and a circle no group stands on, are not found"
        );
        assert_eq!(
            app_of_each(&door, "core.concept", "kitchen"),
            pairs([("cn-1", "docs")]),
            "the root and a tag are not folders"
        );
        // A title is the name; the subtitle is never empty (the app).
        let answer = door
            .query(
                &Principal::Owner,
                &SearchRequest::new("schedule.project", "kitchen", 50),
            )
            .expect("projects answer");
        let project = &targets(&answer)[0];
        assert_eq!(
            (
                project.entity.as_str(),
                project.title.as_str(),
                project.subtitle.as_str()
            ),
            ("schedule.project", "Kitchen refit", "tasks")
        );
        assert!(project.snippet.contains('⟦'), "{}", project.snippet);
    });
}

/// A QUERY MAY BE NARROWED TO ONE APP: the kinds of the shared index that open
/// there, and nothing for an entity that opens elsewhere.
#[test]
fn a_query_narrowed_to_an_app_answers_that_apps_containers_only() {
    on_both_vaults(seed_containers, |connection| {
        let door = door(connection);
        let narrowed = |entity: &str, query: &str, app: &str| -> Vec<(String, String)> {
            let answer = door
                .query(
                    &Principal::Owner,
                    &SearchRequest::new(entity, query, 50).in_app(app),
                )
                .unwrap_or_else(|error| panic!("{entity} in {app} answered {error}"));
            targets(&answer)
                .into_iter()
                .map(|target| (target.id, target.app_id))
                .collect()
        };
        assert_eq!(
            narrowed("core.collection", "reading", "notes"),
            pairs([("nb-1", "notes")])
        );
        assert_eq!(
            narrowed("core.collection", "reading", "photos"),
            pairs([("al-1", "photos")])
        );
        assert_eq!(narrowed("core.collection", "reading", "tally"), Vec::new());
        assert_eq!(
            narrowed("schedule.project", "kitchen", "tasks"),
            pairs([("pr-1", "tasks")])
        );
        assert_eq!(narrowed("schedule.project", "kitchen", "notes"), Vec::new());
        // A domain narrowed to another app answers nothing either.
        assert_eq!(narrowed("schedule.task", "budget", "notes"), Vec::new());
    });
}

/// A TYPO IN A CONTAINER'S NAME IS CORRECTED from the container's own
/// vocabulary, and a container's words are not offered to a search that named
/// only domains.
#[test]
fn a_typo_in_a_container_name_is_corrected_from_its_vocabulary() {
    on_both_vaults(seed_containers, |connection| {
        let door = door(connection);
        for (entity, typo, word) in [
            ("core.collection", "raeding", "reading"),
            ("schedule.project", "kithcen", "kitchen"),
            ("social.circle", "kithcen", "kitchen"),
            ("core.concept", "documnets", "documents"),
        ] {
            assert_eq!(
                corrected(&door, &[entity], typo).as_deref(),
                Some(word),
                "{entity}"
            );
        }
        // Not named, not offered.
        assert_eq!(corrected(&door, &TASKS, "raeding"), None);
        assert_eq!(corrected(&door, &["schedule.task"], "kithcen"), None);
        // Mixed with a domain, either's words are known.
        assert_eq!(
            corrected(&door, &["schedule.task", "core.collection"], "raeding").as_deref(),
            Some("reading")
        );
        // The archived project's words are not in the vocabulary.
        assert_eq!(corrected(&door, &["schedule.project"], "archvie"), None);
    });
}

/// LOCKER IS NEVER A CONTAINER, for a query or a correction, alone or beside a
/// container; and the domains stay seven.
#[test]
fn locker_is_refused_beside_the_containers_and_the_domains_stay_seven() {
    let connection = vault();
    with_a_locker_index(&connection);
    let door = door(&connection);
    assert_eq!(DOMAINS.len(), 7);
    assert_eq!(CONTAINERS.len(), 4);
    for entity in [
        "locker.item",
        "locker.item_field",
        "locker.item_passkey",
        "sync.connection_credential",
    ] {
        let refused = door.query(&Principal::Owner, &SearchRequest::new(entity, "cabin", 8));
        assert!(
            matches!(refused, Err(SearchError::NotADomain { count: 7, .. })),
            "{entity} answered {refused:?}"
        );
        for entities in [vec![entity], vec!["core.collection", entity]] {
            let refused = door.correct(&Principal::Owner, &entities, "raeding");
            assert!(
                matches!(refused, Err(SearchError::NotADomain { count: 7, .. })),
                "{entities:?} answered {refused:?}"
            );
        }
    }
}

/// THE REGISTRIES ARE DISJOINT, and a domain's entity does not become a
/// container's by being asked for narrowed.
#[test]
fn the_two_registries_share_no_entity_index_or_table() {
    for container in CONTAINERS {
        assert!(
            centraid_search::domain_of(container.entity).is_none(),
            "{} is a domain",
            container.entity
        );
        assert!(DOMAINS.iter().all(|domain| domain.fts != container.fts));
    }
    for domain in DOMAINS {
        assert!(
            centraid_search::container_of(domain.entity).is_none(),
            "{} is a container",
            domain.entity
        );
    }
}

/// THE FOLDER SCHEME THE DOOR TESTS IS THE ONE THE COMMANDS WRITE.
#[test]
fn the_folders_scheme_is_the_one_the_vault_writes() {
    assert_eq!(
        centraid_search::containers::FOLDERS_SCHEME_URI,
        centraid_vault::commands::core::FOLDER_SCHEME_URI
    );
}

/// A DEMONSTRATED RED for the open checks over the committed model: a container
/// index with a column the table lacks does not open, and neither does a file
/// without a container's vocabulary correct.
#[test]
fn a_container_index_that_grew_a_column_fails_to_open_and_a_missing_vocabulary_is_unusable() {
    let connection = vault();
    assert!(SqliteDoor::open(&connection).is_ok());
    connection
        .execute_batch(
            "DROP TABLE fts_core_collection_vocab;
             DROP TABLE fts_core_collection;
             CREATE VIRTUAL TABLE fts_core_collection USING fts5(
               collection_id UNINDEXED, name, scratchpad,
               tokenize = \"unicode61 remove_diacritics 2\");",
        )
        .expect("the index is rebuilt with one more column");
    match SqliteDoor::open(&connection) {
        Err(SearchError::IndexUnusable { entity, detail }) => {
            assert_eq!(entity, "core.collection");
            assert!(detail.contains("scratchpad"), "{detail}");
        }
        other => panic!(
            "the door opened over a stray column: {:?}",
            other.map(|_| ())
        ),
    }

    let connection = vault();
    connection
        .execute_batch("DROP TABLE fts_schedule_project_vocab;")
        .expect("the vocabulary is dropped");
    let door = door(&connection);
    match door.correct(&Principal::Owner, &["schedule.project"], "kithcen") {
        Err(SearchError::IndexUnusable { entity, detail }) => {
            assert_eq!(entity, "schedule.project");
            assert!(detail.contains("fts_schedule_project_vocab"), "{detail}");
        }
        other => panic!("a missing vocabulary answered {other:?}"),
    }
}

/// THE DOOR'S OWN BELT, apart from the triggers' braces: the three rows the rung
/// keeps out of the indexes are written into them by hand, and the door still
/// does not find them. A guard that lived only in a trigger would answer them.
#[test]
fn the_door_does_not_find_a_dead_container_that_got_into_an_index() {
    let connection = vault();
    seed_containers(&connection, "party-1").expect("containers are seeded");
    connection
        .execute_batch(
            "INSERT INTO fts_schedule_project(rowid, project_id, name)
               SELECT rowid, project_id, name FROM schedule_project WHERE project_id = 'pr-2';
             INSERT INTO fts_social_circle(rowid, circle_id, name)
               SELECT rowid, circle_id, name FROM social_circle WHERE circle_id IN ('ci-2', 'ci-3');
             INSERT INTO fts_core_concept(rowid, concept_id, pref_label)
               SELECT rowid, concept_id, pref_label FROM core_concept
                WHERE concept_id IN ('cn-root', 'cn-tag');",
        )
        .expect("the dead rows are written into the indexes");
    // The control: the index really does hold them now.
    for (fts, expected) in [
        ("fts_schedule_project", 2_i64),
        ("fts_social_circle", 3),
        ("fts_core_concept", 3),
    ] {
        let held: i64 = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM {fts} WHERE {fts} MATCH 'kitchen'"),
                [],
                |row| row.get(0),
            )
            .expect("the index answers");
        assert_eq!(held, expected, "{fts} holds the poison");
    }
    let door = door(&connection);
    assert_eq!(
        app_of_each(&door, "schedule.project", "kitchen"),
        pairs([("pr-1", "tasks")])
    );
    assert_eq!(
        app_of_each(&door, "social.circle", "kitchen"),
        pairs([("ci-1", "tally")])
    );
    assert_eq!(
        app_of_each(&door, "core.concept", "kitchen"),
        pairs([("cn-1", "docs")])
    );
}
