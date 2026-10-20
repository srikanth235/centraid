//! THE FOUR `phone.*` COMMANDS (#1127, lane A), over all four sources (`health` since #1129).
//!
//! What each test holds, and the claim a port would get wrong:
//!
//! 1. **Link, re-link, and idempotency by state.** A second `phone.link` with the same input
//!    writes nothing (`row_version` stands still); a new fingerprint refreshes the one link and
//!    never makes a second.
//! 2. **A detached link is never re-attached** (R-1127-2): `phone.link` is REFUSED, not ignored,
//!    and the refusal writes nothing. `phone.detach` keeps the first `detached_at`.
//! 3. **A refusal is a value**: the predicate a shell switches on, and no half-write.
//! 4. **A purge leaves a tombstone, `phone.forget` ends it** (gap 3 of #1127): the purged record
//!    is not linked to another row, and forgetting a link twice is not an error.
//! 5. **`phone.touch` moves `last_seen_at` for a batch and nothing else.**
//! 6. **The origin (R-1127-9)**: `phone.origin` registers an account, calendar or folder once and
//!    relabels it in place; a link names it and a re-link may move it; its label survives the
//!    origin leaving the phone (nothing clears it); an origin a link names cannot be retired,
//!    and one nobody names can.

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

    /// The origin a source's links come from in most tests: one account per source.
    fn origin(&self, source: &str) -> String {
        self.run(
            "phone.origin",
            json!({
                "source": source, "phone_origin": format!("acct:{source}"), "label": "Main",
            }),
        )["origin_id"]
            .as_str()
            .expect("an origin id")
            .to_owned()
    }

    fn link(&self, source: &str, phone_id: &str, entity: &str, fingerprint: &str) -> Value {
        self.run(
            "phone.link",
            json!({
                "source": source, "phone_id": phone_id, "origin_id": self.origin(source),
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
    // A workout is an activity (#1129, R-1129-2), followed like any other row.
    let run = bench.run(
        "health.follow_workout",
        json!({
            "activity_id": "wk-1", "kind": "run", "phone_kind": "running",
            "started_at": "2026-10-19T07:00:00Z", "ended_at": "2026-10-19T07:40:00Z",
        }),
    )["activity_id"]
        .as_str()
        .expect("an activity id")
        .to_owned();
    bench.link("health", "HKWorkout:1", &run, "fp-4");
    assert_eq!(bench.count("SELECT COUNT(*) FROM phone_link"), 4);

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
            "source": "contacts", "phone_id": "c1", "origin_id": bench.origin("contacts"),
            "entity_id": ada, "fingerprint": "fp-2",
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
    for (source, entity) in [
        ("contacts", &lunch),
        ("calendar", &ada),
        ("files", &ada),
        ("health", &lunch),
    ] {
        assert_eq!(
            bench.refused(
                "phone.link",
                json!({
                    "source": source, "phone_id": "x", "origin_id": bench.origin(source),
                    "entity_id": entity, "fingerprint": "f",
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
                "source": "contacts", "phone_id": "x", "origin_id": bench.origin("contacts"),
                "entity_id": "nobody", "fingerprint": "f",
            }),
        ),
        "link_entity_is_live_and_of_the_sources_kind"
    );
    // A row already following another phone record is not stolen.
    assert_eq!(
        bench.refused(
            "phone.link",
            json!({
                "source": "contacts", "phone_id": "c2", "origin_id": bench.origin("contacts"),
                "entity_id": ada, "fingerprint": "f",
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
                "source": "contacts", "phone_id": "c3", "origin_id": bench.origin("contacts"),
                "entity_id": ada, "fingerprint": "f",
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
                "source": "contacts", "phone_id": "c2", "origin_id": bench.origin("contacts"),
                "entity_id": grace, "fingerprint": "f",
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
fn a_purge_leaves_a_tombstone_for_a_person_and_a_document_and_phone_forget_ends_it() {
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
        bench.count(
            "SELECT COUNT(*) FROM phone_link
              WHERE source IN ('contacts', 'files') AND entity_id IS NULL"
        ),
        2,
        "both links stayed, as tombstones of rows purged"
    );
    assert_eq!(
        bench.count(
            "SELECT COUNT(*) FROM phone_link WHERE source = 'calendar' AND entity_id IS NOT NULL"
        ),
        1,
        "the event's link is untouched"
    );
    // THE PURGED RECORD DOES NOT COME BACK: a fresh row cannot take over the tombstone's phone id.
    let grace = bench.person("Grace");
    assert_eq!(
        bench.refused(
            "phone.link",
            json!({
                "source": "contacts", "phone_id": "c1", "origin_id": bench.origin("contacts"),
                "entity_id": grace, "fingerprint": "fp-9",
            }),
        ),
        "link_row_was_not_purged"
    );
    // The origin stays named while a tombstone does.
    assert_eq!(
        bench.refused(
            "phone.retire_origin",
            json!({ "origin_id": bench.origin("contacts") }),
        ),
        "origin_has_no_links"
    );
    // The engine ends a tombstone with `phone.forget`; a second forget is a quiet no-op.
    let link_id = person_link["link_id"].as_str().expect("an id");
    assert_eq!(
        bench.run("phone.forget", json!({ "link_id": link_id }))["forgotten"],
        json!(true)
    );
    assert_eq!(
        bench.run("phone.forget", json!({ "link_id": link_id }))["forgotten"],
        json!(false)
    );
    // Once forgotten, the phone id is free again (the phone record itself is gone).
    bench.link("contacts", "c1", &grace, "fp-9");
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

#[test]
fn an_origin_is_registered_once_and_relabelled_in_place() {
    let bench = Bench::open("origin");
    let first = bench.run(
        "phone.origin",
        json!({ "source": "calendar", "phone_origin": "cal:work", "label": "Work" }),
    );
    assert_eq!(first["created"], json!(true));
    let before = bench.count("SELECT row_version FROM phone_origin");

    // IDEMPOTENT BY STATE: the same input writes nothing, `row_version` included.
    let again = bench.run(
        "phone.origin",
        json!({ "source": "calendar", "phone_origin": "cal:work", "label": "Work" }),
    );
    assert_eq!(again["origin_id"], first["origin_id"]);
    assert_eq!(again["changed"], json!(false));
    assert_eq!(bench.count("SELECT row_version FROM phone_origin"), before);

    // A rename is one write on the one row.
    let renamed = bench.run(
        "phone.origin",
        json!({ "source": "calendar", "phone_origin": "cal:work", "label": "  Work (Google) " }),
    );
    assert_eq!(renamed["origin_id"], first["origin_id"]);
    assert_eq!(renamed["changed"], json!(true));
    assert_eq!(
        bench.text("SELECT label FROM phone_origin").as_deref(),
        Some("Work (Google)"),
        "stored trimmed"
    );
    assert_eq!(bench.count("SELECT COUNT(*) FROM phone_origin"), 1);

    // The same phone id in another source is another origin.
    bench.run(
        "phone.origin",
        json!({ "source": "contacts", "phone_origin": "cal:work", "label": "Work" }),
    );
    assert_eq!(bench.count("SELECT COUNT(*) FROM phone_origin"), 2);
}

#[test]
fn a_link_names_its_origin_may_move_and_the_label_outlives_the_origin_leaving_the_phone() {
    let bench = Bench::open("origin-link");
    let lunch = bench.event("evt-1");
    let work = bench.run(
        "phone.origin",
        json!({ "source": "calendar", "phone_origin": "cal:work", "label": "Work" }),
    )["origin_id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let home = bench.run(
        "phone.origin",
        json!({ "source": "calendar", "phone_origin": "cal:home", "label": "Home" }),
    )["origin_id"]
        .as_str()
        .expect("an id")
        .to_owned();
    let input = |origin: &str, fingerprint: &str| {
        json!({
            "source": "calendar", "phone_id": "uid:k1", "origin_id": origin,
            "entity_id": lunch, "fingerprint": fingerprint,
        })
    };
    bench.run("phone.link", input(&work, "fp-1"));
    assert_eq!(
        bench.text("SELECT origin_id FROM phone_link").as_deref(),
        Some(work.as_str())
    );

    // Idempotent on the origin too.
    let before = bench.links();
    let same = bench.run("phone.link", input(&work, "fp-1"));
    assert_eq!(same["changed"], json!(false));
    assert_eq!(before, bench.links());

    // The record moved calendar on the phone: the one link is re-homed.
    let moved = bench.run("phone.link", input(&home, "fp-1"));
    assert_eq!(moved["created"], json!(false));
    assert_eq!(moved["changed"], json!(true));
    assert_eq!(
        bench.text("SELECT origin_id FROM phone_link").as_deref(),
        Some(home.as_str())
    );

    // THE LABEL SURVIVES: nothing in a pass that no longer sees the origin writes it, and the
    // origin cannot be retired out from under a link.
    assert_eq!(
        bench
            .text(&format!(
                "SELECT label FROM phone_origin WHERE origin_id = '{home}'"
            ))
            .as_deref(),
        Some("Home")
    );
    let refused = bench.try_run("phone.retire_origin", json!({ "origin_id": home }));
    assert_eq!(refused.status, CommandStatus::Failed);
    assert_eq!(refused.predicate.as_deref(), Some("origin_has_no_links"));
    // A DETACHED link still names its origin (it is the tombstone), so the origin stays.
    let link_id = bench
        .text("SELECT link_id FROM phone_link")
        .expect("a link");
    bench.run("phone.detach", json!({ "link_id": link_id }));
    let still = bench.try_run("phone.retire_origin", json!({ "origin_id": home }));
    assert_eq!(still.predicate.as_deref(), Some("origin_has_no_links"));
    // The emptied origin (no link names Work any more) retires, and retiring it twice is quiet.
    let retired = bench.run("phone.retire_origin", json!({ "origin_id": work }));
    assert_eq!(retired["retired"], json!(true));
    let twice = bench.run("phone.retire_origin", json!({ "origin_id": work }));
    assert_eq!(twice["retired"], json!(false));
    assert_eq!(bench.count("SELECT COUNT(*) FROM phone_origin"), 1);
    // Forgetting the link frees its origin.
    bench.run("phone.forget", json!({ "link_id": link_id }));
    bench.run("phone.retire_origin", json!({ "origin_id": home }));
    assert_eq!(bench.count("SELECT COUNT(*) FROM phone_origin"), 0);
}

#[test]
fn a_link_with_an_unknown_origin_or_one_of_another_source_is_refused() {
    let bench = Bench::open("origin-refuse");
    let ada = bench.person("Ada");
    let calendar_origin = bench.origin("calendar");
    for origin in ["nobody", calendar_origin.as_str()] {
        assert_eq!(
            bench.refused(
                "phone.link",
                json!({
                    "source": "contacts", "phone_id": "c1", "origin_id": origin,
                    "entity_id": ada, "fingerprint": "f",
                }),
            ),
            "link_origin_is_of_the_source",
            "{origin}"
        );
    }
    // An empty label or origin id is refused by the schema, not stored.
    for input in [
        json!({ "source": "contacts", "phone_origin": "a", "label": " " }),
        json!({ "source": "contacts", "phone_origin": " ", "label": "A" }),
        json!({ "source": "mail", "phone_origin": "a", "label": "A" }),
    ] {
        let outcome = bench.try_run("phone.origin", input);
        assert_eq!(outcome.status, CommandStatus::Failed);
    }
    assert_eq!(bench.count("SELECT COUNT(*) FROM phone_origin"), 1);
}
