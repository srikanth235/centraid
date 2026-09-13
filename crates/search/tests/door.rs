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
//!    by `crates/vault::custody` — the vault's own `sealed:v1:` envelope and its
//!    own `lk1:` member-key cell, not a hand-typed prefix — so the run is
//!    neither vacuous nor a claim about a string;
//! 2. no `Target` from any of the seven domains carries the PLAINTEXT or the
//!    CIPHERTEXT, for a query that asks for each by name;
//! 3. the entities that HAVE sealed columns are not domains at all, and asking
//!    for one is a typed refusal rather than an empty page — the empty page is
//!    what a filter would produce, and it reads as "no matches".

use centraid_apps_kit::contract_vault::open_contract_vault;
use centraid_apps_kit::page::PageRequest;
use centraid_search::{
    Answer, DOMAINS, Principal, Search, SearchError, SearchRequest, SqliteDoor, Target,
};
use centraid_vault::custody::locker_key::{
    LOCKER_CIPHERTEXT_PREFIX, encrypt_under_locker_key, is_locker_ciphertext, locker_aad,
};
use centraid_vault::custody::seal::{SEALED_PREFIX, is_sealed_value, seal_aad, seal_value};
use rusqlite::Connection;

/// THE SECRETS THIS FIXTURE PLANTS, AS THE PRODUCT WRITES THEM.
///
/// Not a hand-made prefix: `crates/vault::custody` is what seals a cell, and a
/// test that typed `"sealed:v1:…"` itself would be proving something about a
/// string rather than about the vault. `seal_value` is the `sealed:v1:`
/// envelope every sealed column takes; `encrypt_under_locker_key` is the `lk1:`
/// form the Locker member key writes (wave 4 lane Locker) — and the two are
/// different classes, so both are planted (census §D2).
///
/// The PLAINTEXT is what a member would search for and the CIPHERTEXT is what
/// the column holds; the test asserts neither reaches a target.
const PLAINTEXT: &str = "zqmarker recovery phrase seventeen";

/// A key by value. There is no ambient seal key in the search crate, and there
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
    reason = "one fixture, one reading order: seven domains and four sealed tables"
)]
fn seed(connection: &Connection) {
    let body = |id: &str, text: &str, sha: &str| {
        connection
            .execute(
                "INSERT INTO core_content_item
                   (content_id, content_uri, sha256, byte_size, created_at)
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
            "INSERT INTO core_content_item (content_id, content_uri, sha256, byte_size, created_at)
             VALUES ('content-6', 'blob:sha256/f', ?1, 1024, ?2)",
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
    // their row and key id; the connector's take the `sealed:v1:` envelope whose
    // AAD binds table, column and row. Neither is typed here: both come out of
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
    let credential = |column: &str| {
        seal_value(
            &KEY,
            &seal_aad("sync_connection_credential", column, "connection-1"),
            PLAINTEXT,
        )
        .unwrap_or_else(|error| panic!("{column} seals: {error}"))
    };
    connection
        .execute(
            "INSERT INTO sync_connection_credential
               (connection_id, cred_kind, allowed_hosts, client_secret, access_token,
                refresh_token, api_key, refresh_capability)
             VALUES ('connection-1', 'oauth2', '[]', ?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![
                credential("client_secret"),
                credential("access_token"),
                credential("refresh_token"),
                credential("api_key"),
                credential("refresh_capability")
            ],
        )
        .expect("a connector credential is inserted");
}

/// The key id every planted locker cell is bound to. The AAD carries it, so a
/// cell cannot be replayed under another key.
const LOCKER_KEY_ID: &str = "key-000001";

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
        (
            "sync_connection_credential",
            "client_secret",
            "connection-1",
        ),
        ("sync_connection_credential", "access_token", "connection-1"),
        (
            "sync_connection_credential",
            "refresh_token",
            "connection-1",
        ),
        ("sync_connection_credential", "api_key", "connection-1"),
        (
            "sync_connection_credential",
            "refresh_capability",
            "connection-1",
        ),
    ]
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
    let mut registry: Vec<(String, String)> =
        centraid_ontology::registries::sealed_physical_columns();
    registry.sort_unstable();
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
            _ => "connection_id",
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
        if table == "sync_connection_credential" {
            assert!(
                is_sealed_value(&held),
                "{table}.{column} is not a `{SEALED_PREFIX}` envelope"
            );
        } else {
            assert!(
                is_locker_ciphertext(&held),
                "{table}.{column} is not a `{LOCKER_CIPHERTEXT_PREFIX}` cell"
            );
        }
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
    for marker in [PLAINTEXT, ciphertext.as_str()] {
        for domain in DOMAINS {
            let answer = door
                .query(
                    &Principal::Owner,
                    &SearchRequest::new(domain.entity, marker, 50),
                )
                .unwrap_or_else(|error| panic!("{} answered {error}", domain.entity));
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
                        "{} answered a target carrying {marker}: {target:?}",
                        domain.entity
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
