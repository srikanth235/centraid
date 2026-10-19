//! THE FOUR `phone.*` COMMANDS (#1127, lane A).
//!
//! What each test holds, and the claim a port would get wrong:
//!
//! 1. **Link, re-link, and idempotency by state.** A second `phone.link` with the same input
//!    writes nothing (`row_version` stands still); a new fingerprint refreshes the one link and
//!    never makes a second.
//! 2. **A detached link is never re-attached** (R-1127-2): `phone.link` is REFUSED, not ignored,
//!    and the refusal writes nothing. `phone.detach` keeps the first `detached_at`.
//! 3. **A refusal is a value**: the predicate a shell switches on, and no half-write.
//! 4. **`phone.forget` and a purge both end a link**, and neither touches the row it followed;
//!    forgetting a link a purge already took is not an error.
//! 5. **`phone.touch` moves `last_seen_at` for a batch and nothing else.**

mod common;

use centraid_vault::access::Principal;
use centraid_vault::commands::Registry;
use centraid_vault::{Command, CommandOutcome, CommandStatus, Vault};
use serde_json::{Value, json};

struct Bench {
    scratch: common::Scratch,
    registry: Registry,
    principal: Principal,
}

impl Bench {
    fn open(seed: &str) -> Self {
        let scratch = common::Scratch::founded(seed).expect("a vault is founded");
        let registry = Registry::with_system_commands().expect("the registry builds");
        registry
            .install(&scratch.vault)
            .expect("the record installs");
        Self {
            scratch,
            registry,
            principal: Principal::owner("phone"),
        }
    }

    fn vault(&self) -> &Vault {
        &self.scratch.vault
    }

    fn try_run(&self, command: &str, input: Value) -> CommandOutcome {
        self.vault()
            .execute(
                &self.registry,
                &self.principal,
                &Command::new(command, input),
            )
            .unwrap_or_else(|error| panic!("`{command}` errored rather than answering: {error}"))
    }

    fn run(&self, command: &str, input: Value) -> Value {
        let outcome = self.try_run(command, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "`{command}` refused: {:?} / {:?}",
            outcome.predicate,
            outcome.reason
        );
        outcome.output
    }

    /// The predicate a refused command named; fails if it ran or wrote anything.
    fn refused(&self, command: &str, input: Value) -> String {
        let before = self.links();
        let outcome = self.try_run(command, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Failed,
            "`{command}` should have been refused"
        );
        assert!(outcome.reason.is_some(), "a refusal says why");
        assert_eq!(before, self.links(), "a refused `{command}` wrote a link");
        outcome.predicate.expect("a refusal names its predicate")
    }

    /// Every link, every column, as text: a no-op that still wrote shows in `row_version`.
    fn links(&self) -> String {
        self.vault()
            .read(|connection| {
                let mut statement =
                    connection.prepare("SELECT * FROM phone_link ORDER BY link_id")?;
                let columns = statement.column_count();
                let rows = statement.query_map([], |row| {
                    let mut line = String::new();
                    for column in 0..columns {
                        line.push_str(&format!("{:?}|", row.get_ref(column)?));
                    }
                    Ok(line)
                })?;
                Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?.join("\n"))
            })
            .expect("the links read")
    }

    fn count(&self, sql: &str) -> i64 {
        self.vault()
            .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
            .expect("the count reads")
    }

    fn text(&self, sql: &str) -> Option<String> {
        self.vault()
            .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
            .expect("the text reads")
    }

    fn person(&self, name: &str) -> String {
        self.run(
            "people.add_person",
            json!({ "display_name": name, "cadence_days": 30 }),
        )["party_id"]
            .as_str()
            .expect("a party id")
            .to_owned()
    }

    fn document(&self, id: &str) -> String {
        self.run(
            "core.create_text_document",
            json!({ "document_id": id, "title": "From the phone" }),
        );
        id.to_owned()
    }

    fn event(&self, id: &str) -> String {
        let now = self.vault().clock().now_text();
        let owned = id.to_owned();
        self.vault()
            .commit(|tx| {
                tx.set_producer("test.phone_commands");
                tx.connection().execute(
                    "INSERT INTO core_event
                       (event_id, summary, dtstart, start_tz, status, sequence, created_at)
                     VALUES (?1, 'Lunch', '2026-10-20T12:00:00Z', 'UTC', 'confirmed', 0, ?2)",
                    rusqlite::params![owned, now],
                )?;
                Ok(())
            })
            .expect("an event is written");
        id.to_owned()
    }

    fn link(&self, source: &str, phone_id: &str, entity: &str, fingerprint: &str) -> Value {
        self.run(
            "phone.link",
            json!({
                "source": source, "phone_id": phone_id,
                "entity_id": entity, "fingerprint": fingerprint,
            }),
        )
    }
}

#[test]
fn a_link_per_source_is_written_and_a_second_run_writes_nothing() {
    let bench = Bench::open("link");
    let ada = bench.person("Ada");
    let lunch = bench.event("evt-1");
    let spec = bench.document("01920000-0000-7000-8000-0000000000d1");

    let first = bench.link("contacts", "ABPerson:7", &ada, "fp-1");
    assert_eq!(first["created"], json!(true));
    bench.link("calendar", "EKEvent:9", &lunch, "fp-2");
    bench.link("files", "bookmark/a.md", &spec, "fp-3");
    assert_eq!(bench.count("SELECT COUNT(*) FROM phone_link"), 3);

    // IDEMPOTENT BY STATE: the same input again changes no column, `row_version` included.
    let before = bench.links();
    let again = bench.link("contacts", "ABPerson:7", &ada, "fp-1");
    assert_eq!(again["created"], json!(false));
    assert_eq!(again["changed"], json!(false));
    assert_eq!(again["link_id"], first["link_id"]);
    assert_eq!(
        before,
        bench.links(),
        "a second run must land the same state"
    );
}

#[test]
fn a_new_fingerprint_refreshes_the_one_link_and_never_makes_a_second() {
    let bench = Bench::open("relink");
    let ada = bench.person("Ada");
    let first = bench.link("contacts", "c1", &ada, "fp-1");
    bench.scratch.clock.advance_ms(60_000);
    let second = bench.link("contacts", "c1", &ada, "fp-2");
    assert_eq!(second["link_id"], first["link_id"]);
    assert_eq!(second["changed"], json!(true));
    assert_eq!(bench.count("SELECT COUNT(*) FROM phone_link"), 1);
    assert_eq!(
        bench.text("SELECT fingerprint FROM phone_link").as_deref(),
        Some("fp-2")
    );
    assert_eq!(
        bench.count("SELECT row_version FROM phone_link"),
        2,
        "one refresh, one version"
    );
    assert_ne!(
        bench.text("SELECT last_seen_at FROM phone_link"),
        bench.text("SELECT created_at FROM phone_link"),
        "the sighting moved and the creation did not"
    );
}

#[test]
fn a_link_may_be_re_pointed_to_another_row_of_the_same_kind() {
    let bench = Bench::open("repoint");
    let ada = bench.person("Ada");
    let grace = bench.person("Grace");
    bench.link("contacts", "c1", &ada, "fp-1");
    bench.link("contacts", "c1", &grace, "fp-1");
    assert_eq!(
        bench
            .text("SELECT entity_id FROM phone_link WHERE phone_id = 'c1'")
            .as_deref(),
        Some(grace.as_str())
    );
    assert_eq!(bench.count("SELECT COUNT(*) FROM phone_link"), 1);
}

#[test]
fn a_detached_link_is_never_reattached_and_the_refusal_writes_nothing() {
    let bench = Bench::open("detach");
    let ada = bench.person("Ada");
    let link = bench.link("contacts", "c1", &ada, "fp-1");
    let link_id = link["link_id"].as_str().expect("a link id").to_owned();

    let detached = bench.run("phone.detach", json!({ "link_id": link_id }));
    assert_eq!(detached["detached"], json!(true));
    let stamp = bench.text("SELECT detached_at FROM phone_link");
    assert!(stamp.is_some(), "detached_at is set");

    // The same command again: a no-op that keeps the FIRST time.
    bench.scratch.clock.advance_ms(3_600_000);
    let twice = bench.run("phone.detach", json!({ "link_id": link_id }));
    assert_eq!(twice["detached"], json!(false));
    assert_eq!(bench.text("SELECT detached_at FROM phone_link"), stamp);

    // THE ENGINE MAY NOT WRITE THE PHONE'S VERSION OVER THE MEMBER'S EDIT.
    let predicate = bench.refused(
        "phone.link",
        json!({
            "source": "contacts", "phone_id": "c1", "entity_id": ada, "fingerprint": "fp-2",
        }),
    );
    assert_eq!(predicate, "link_is_attached");
    assert_eq!(
        bench.text("SELECT fingerprint FROM phone_link").as_deref(),
        Some("fp-1")
    );
}

#[test]
fn a_refusal_names_its_predicate_and_writes_nothing() {
    let bench = Bench::open("refuse");
    let ada = bench.person("Ada");
    let grace = bench.person("Grace");
    let lunch = bench.event("evt-1");
    bench.link("contacts", "c1", &ada, "fp-1");

    // Not the kind the source implies (the engine's other guard is the schema's trigger).
    for (source, entity) in [("contacts", &lunch), ("calendar", &ada), ("files", &ada)] {
        assert_eq!(
            bench.refused(
                "phone.link",
                json!({
                    "source": source, "phone_id": "x", "entity_id": entity, "fingerprint": "f",
                }),
            ),
            "link_entity_is_live_and_of_the_sources_kind",
            "{source} -> {entity}"
        );
    }
    // Not a row at all.
    assert_eq!(
        bench.refused(
            "phone.link",
            json!({
                "source": "contacts", "phone_id": "x", "entity_id": "nobody", "fingerprint": "f",
            }),
        ),
        "link_entity_is_live_and_of_the_sources_kind"
    );
    // A row already following another phone record is not stolen.
    assert_eq!(
        bench.refused(
            "phone.link",
            json!({
                "source": "contacts", "phone_id": "c2", "entity_id": ada, "fingerprint": "f",
            }),
        ),
        "link_entity_is_followed_once"
    );
    // A phone record already linked cannot be pointed at a row another record follows.
    bench.link("contacts", "c3", &grace, "fp-3");
    assert_eq!(
        bench.refused(
            "phone.link",
            json!({
                "source": "contacts", "phone_id": "c3", "entity_id": ada, "fingerprint": "f",
            }),
        ),
        "link_entity_is_followed_once"
    );
    // Detaching what is not there.
    assert_eq!(
        bench.refused("phone.detach", json!({ "link_id": "nope" })),
        "link_exists"
    );
}

#[test]
fn a_trashed_row_cannot_take_a_new_link_but_keeps_the_one_it_has() {
    let bench = Bench::open("trash");
    let ada = bench.person("Ada");
    let grace = bench.person("Grace");
    bench.link("contacts", "c1", &ada, "fp-1");

    // R-1127-3: the engine trashes the row, then forgets or KEEPS the link — both are allowed.
    bench.run("people.trash_person", json!({ "party_id": ada }));
    assert_eq!(
        bench.count("SELECT COUNT(*) FROM phone_link"),
        1,
        "the link is kept"
    );
    bench.run("people.trash_person", json!({ "party_id": grace }));
    assert_eq!(
        bench.refused(
            "phone.link",
            json!({
                "source": "contacts", "phone_id": "c2", "entity_id": grace, "fingerprint": "f",
            }),
        ),
        "link_entity_is_live_and_of_the_sources_kind",
        "a fresh link to a trashed row is refused"
    );
    // Restored, it follows again: the kept link is refreshed in place.
    bench.run("people.restore_person", json!({ "party_id": ada }));
    let again = bench.link("contacts", "c1", &ada, "fp-2");
    assert_eq!(again["created"], json!(false));
}

#[test]
fn forgetting_a_link_leaves_its_row_and_forgetting_it_twice_is_not_an_error() {
    let bench = Bench::open("forget");
    let ada = bench.person("Ada");
    let link = bench.link("contacts", "c1", &ada, "fp-1");
    let link_id = link["link_id"].as_str().expect("a link id").to_owned();

    let first = bench.run("phone.forget", json!({ "link_id": link_id }));
    assert_eq!(first["forgotten"], json!(true));
    assert_eq!(bench.count("SELECT COUNT(*) FROM phone_link"), 0);
    assert_eq!(
        bench.count(&format!(
            "SELECT COUNT(*) FROM core_party WHERE party_id = '{ada}' AND deleted_at IS NULL"
        )),
        1,
        "the person is untouched"
    );
    let second = bench.run("phone.forget", json!({ "link_id": link_id }));
    assert_eq!(second["forgotten"], json!(false));

    // A forgotten phone record may be followed again, even one that had detached.
    let relinked = bench.link("contacts", "c1", &ada, "fp-9");
    assert_eq!(relinked["created"], json!(true));
    bench.run(
        "phone.detach",
        json!({ "link_id": relinked["link_id"].as_str().expect("an id") }),
    );
    bench.run(
        "phone.forget",
        json!({ "link_id": relinked["link_id"].as_str().expect("an id") }),
    );
    bench.link("contacts", "c1", &ada, "fp-10");
}

#[test]
fn a_purge_takes_the_link_with_the_row_for_a_person_and_a_document() {
    let bench = Bench::open("purge");
    let ada = bench.person("Ada");
    let spec = bench.document("01920000-0000-7000-8000-0000000000d2");
    let lunch = bench.event("evt-keep");
    let person_link = bench.link("contacts", "c1", &ada, "fp-1");
    bench.link("files", "f1", &spec, "fp-2");
    bench.link("calendar", "k1", &lunch, "fp-3");

    bench.run("people.trash_person", json!({ "party_id": ada }));
    bench
        .vault()
        .commit(|tx| {
            tx.set_producer("test.lapse");
            tx.connection().execute(
                "UPDATE people_profile SET purge_at = '1999-01-01T00:00:00.000Z'
                  WHERE party_id = ?1",
                [&ada],
            )?;
            Ok(())
        })
        .expect("the lapse lands");
    bench.run("people.purge_person", json!({ "party_id": ada }));
    bench.run("core.trash_document", json!({ "document_id": spec }));
    bench.run("core.purge_document", json!({ "document_id": spec }));

    assert_eq!(
        bench.count("SELECT COUNT(*) FROM phone_link WHERE source IN ('contacts', 'files')"),
        0,
        "both links went with their rows"
    );
    assert_eq!(
        bench.count("SELECT COUNT(*) FROM phone_link WHERE source = 'calendar'"),
        1,
        "the event's link is untouched"
    );
    // The engine's `phone.forget` of a link a purge already took is a quiet no-op.
    let gone = bench.run(
        "phone.forget",
        json!({ "link_id": person_link["link_id"].as_str().expect("an id") }),
    );
    assert_eq!(gone["forgotten"], json!(false));
}

#[test]
fn touching_a_batch_moves_last_seen_at_and_nothing_else() {
    let bench = Bench::open("touch");
    let ada = bench.person("Ada");
    let grace = bench.person("Grace");
    let lunch = bench.event("evt-1");
    bench.link("contacts", "c1", &ada, "fp-1");
    bench.link("contacts", "c2", &grace, "fp-2");
    bench.link("calendar", "c1", &lunch, "fp-3");
    let seen = |phone_id: &str, source: &str, bench: &Bench| {
        bench
            .text(&format!(
                "SELECT last_seen_at FROM phone_link WHERE source = '{source}' AND phone_id = '{phone_id}'"
            ))
            .expect("a sighting")
    };
    let (c1, c2, k1) = (
        seen("c1", "contacts", &bench),
        seen("c2", "contacts", &bench),
        seen("c1", "calendar", &bench),
    );

    bench.scratch.clock.advance_ms(600_000);
    let out = bench.run(
        "phone.touch",
        // `unknown` has no link and is not an error; `c1` of the calendar is not named.
        json!({ "source": "contacts", "phone_ids": ["c1", "c2", "unknown"] }),
    );
    assert_eq!(out["touched"], json!(2));
    assert_ne!(seen("c1", "contacts", &bench), c1);
    assert_ne!(seen("c2", "contacts", &bench), c2);
    assert_eq!(
        seen("c1", "calendar", &bench),
        k1,
        "the same phone id in another source is another record"
    );
    assert_eq!(
        bench
            .text(
                "SELECT fingerprint FROM phone_link WHERE phone_id = 'c1' AND source = 'contacts'"
            )
            .as_deref(),
        Some("fp-1"),
        "a touch never changes the fingerprint"
    );
    // Idempotent: the same touch at the same instant changes nothing.
    let before = bench.links();
    let again = bench.run(
        "phone.touch",
        json!({ "source": "contacts", "phone_ids": ["c1", "c2"] }),
    );
    assert_eq!(again["touched"], json!(0));
    assert_eq!(before, bench.links());
}

#[test]
fn input_that_the_schema_refuses_never_reaches_a_handler() {
    let bench = Bench::open("schema");
    let ada = bench.person("Ada");
    for input in [
        // `photos` is not a source (R-1127-4).
        json!({ "source": "photos", "phone_id": "p", "entity_id": ada, "fingerprint": "f" }),
        json!({ "source": "contacts", "phone_id": "  ", "entity_id": ada, "fingerprint": "f" }),
        json!({ "source": "contacts", "phone_id": "p", "entity_id": ada, "fingerprint": "" }),
        json!({ "source": "contacts", "phone_id": "p", "entity_id": ada }),
        json!({ "source": "contacts", "phone_id": "p", "entity_id": ada, "fingerprint": "f",
                "detached_at": "2026-10-19T00:00:00Z" }),
    ] {
        let outcome = bench.try_run("phone.link", input.clone());
        assert_eq!(outcome.status, CommandStatus::Failed, "{input}");
    }
    assert_eq!(bench.count("SELECT COUNT(*) FROM phone_link"), 0);
}
