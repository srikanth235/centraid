//! RUNG THIRTEEN, END TO END: SEARCH FINDS WHAT A MEMBER TYPED (#1097).
//!
//! A member who typed a nickname, an email, a place, a project, a category, a
//! line item or a memo searched for it and found nothing, because the text lived
//! in a table whose index nothing read. Rung thirteen folds that text into the
//! index each domain's probe reads (R1), leaves out what the member can no longer
//! see (R1b), keeps a Locker memo out of every index (R1c), stores no rank weights
//! (R1d: the door owns them) and adds a vocabulary table per domain (R3). It also
//! keeps four indexes for the containers a member files things in (R5): a
//! notebook and an album, a project, a Tally group, a Docs folder.
//!
//! ## How the claims are made
//!
//! **Through the commands that write the text**, as the neighbouring
//! `*_commands.rs` suites do: a person is added and edited with `people.*`, an
//! expense with `tally.*`. SQL writes only what has no command: a calendar, a
//! place, a project's delete and a photograph's byte row.
//!
//! **Against an oracle that is not the triggers.** [`assert_indexes_match`]
//! rebuilds what each of the four widened indexes SHOULD hold from the base
//! tables with plain joins and compares it, row by row and column by column,
//! with what the index holds. The triggers and the rung's backfill are the two
//! writers of that index; the oracle is a third answer, so a trigger that
//! forgot a path, or a backfill that disagreed with the triggers, is a
//! difference rather than a quiet gap. It runs after every scenario below.
//!
//! **A column filter proves WHERE the word sits.** `nickname : "chotu"` finds a
//! party only if the word is in the folded column; a bare word would match the
//! display name and prove nothing about the fold.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use centraid_vault::access::Principal;
use centraid_vault::commands::Registry;
use centraid_vault::migrations::BASELINE_SQL;
use centraid_vault::{Command, CommandOutcome, CommandStatus, Vault};
use rusqlite::{Connection, OptionalExtension as _};
use serde_json::{Value, json};

// ---------------------------------------------------------------------------
// The bench.
// ---------------------------------------------------------------------------

struct World {
    scratch: common::Scratch,
    registry: Registry,
    owner: String,
}

impl World {
    fn new(seed: &str) -> Self {
        let scratch = common::Scratch::founded(seed).expect("a vault is founded");
        let registry = Registry::with_system_commands().expect("the registry builds");
        registry
            .install(&scratch.vault)
            .expect("the registry's record installs");
        let owner = common::owner_party(&scratch.vault).expect("a founded vault has an owner");
        Self {
            scratch,
            registry,
            owner,
        }
    }

    fn vault(&self) -> &Vault {
        &self.scratch.vault
    }

    fn try_run(&self, command: &str, input: Value) -> CommandOutcome {
        self.vault()
            .execute(
                &self.registry,
                &Principal::owner("phone"),
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

    fn id(&self, command: &str, input: Value, key: &str) -> String {
        self.run(command, input)[key]
            .as_str()
            .unwrap_or_else(|| panic!("`{command}` returned no `{key}`"))
            .to_owned()
    }

    /// Ids a MATCH finds in one index.
    fn hits(&self, fts: &str, query: &str) -> BTreeSet<String> {
        hits(self.vault(), fts, query)
    }

    fn count(&self, sql: &str) -> i64 {
        self.vault()
            .read(|connection| Ok(connection.query_row(sql, [], |row| row.get(0))?))
            .expect("the count reads")
    }

    fn execute_sql(&self, sql: &str, params: &[&dyn rusqlite::ToSql]) {
        self.vault()
            .commit(|tx| {
                tx.set_producer("test.fixture");
                tx.connection().execute(sql, params)?;
                Ok(())
            })
            .expect("the fixture row is written");
    }

    // --- people ---

    fn person(&self, name: &str, nickname: Option<&str>, role: Option<&str>) -> String {
        let mut input = json!({ "display_name": name, "cadence_days": 30 });
        if let Some(nickname) = nickname {
            input["nickname"] = json!(nickname);
        }
        if let Some(role) = role {
            input["role"] = json!(role);
        }
        self.id("people.add_person", input, "party_id")
    }

    fn channel(&self, party: &str, kind: &str, value: &str) -> String {
        self.id(
            "people.save_contact_channel",
            json!({ "party_id": party, "kind": kind, "value": value }),
            "channel_id",
        )
    }

    // --- interactions (Q-1097-5) ---

    /// An interaction logged with the real command, which writes the
    /// `core_activity`, its live `about` link onto the party and, because there
    /// is text, a `knowledge_annotation` on the activity. Returns the activity.
    fn interaction(&self, party: &str, text: &str) -> String {
        self.id(
            "people.log_interaction",
            json!({ "party_id": party, "kind": "lunch", "text": text }),
            "interaction_id",
        )
    }

    /// The live `about` link of an activity onto a party.
    fn link_of(&self, activity: &str, party: &str) -> String {
        self.vault()
            .read(|connection| {
                Ok(connection.query_row(
                    "SELECT link_id FROM core_link
                      WHERE from_type = 'core.activity' AND from_id = ?1
                        AND to_type = 'core.party' AND to_id = ?2",
                    [activity, party],
                    |row| row.get::<_, String>(0),
                )?)
            })
            .expect("the activity is linked to the party")
    }

    /// A second participant: the same `about` edge onto another party, as an
    /// import or a group meeting would write it. No command in this crate links
    /// an activity (`core.link_entities` allow-lists no activity), so the fixture
    /// writes the row the way `people.log_interaction` does.
    fn also_about(&self, activity: &str, party: &str) -> String {
        let first: String = self
            .vault()
            .read(|connection| {
                Ok(connection.query_row(
                    "SELECT relation_concept_id FROM core_link
                      WHERE from_type = 'core.activity' AND from_id = ?1",
                    [activity],
                    |row| row.get(0),
                )?)
            })
            .expect("the activity has an edge to copy the relation from");
        let id = self.vault().ids().next();
        let now = self.vault().clock().now_text();
        self.execute_sql(
            "INSERT INTO core_link
               (link_id, from_type, from_id, to_type, to_id, relation_concept_id,
                valid_from, valid_to, asserted_by, provenance_id, updated_at)
             VALUES (?1, 'core.activity', ?2, 'core.party', ?3, ?4, ?5, NULL, 'owner', NULL, ?5)",
            &[&id, &activity, &party, &first, &now],
        );
        id
    }

    // --- agenda ---

    /// A calendar and a place have no command in this crate that makes one
    /// alone (an import or a photograph's location does), so the fixture
    /// writes them.
    fn calendar(&self) -> String {
        let id = self.vault().ids().next();
        let owner = self.owner.clone();
        let now = self.vault().clock().now_text();
        self.execute_sql(
            "INSERT INTO schedule_calendar
               (calendar_id, owner_party_id, name, color, default_tz, visibility,
                external_uri, created_at)
             VALUES (?1, ?2, 'Home', NULL, 'Europe/London', 'private', NULL, ?3)",
            &[&id, &owner, &now],
        );
        id
    }

    fn place(&self, name: &str) -> String {
        let id = self.vault().ids().next();
        let now = self.vault().clock().now_text();
        self.execute_sql(
            "INSERT INTO core_place (place_id, name, kind, created_at)
             VALUES (?1, ?2, 'venue', ?3)",
            &[&id, &name, &now],
        );
        id
    }

    fn event(&self, calendar: &str, summary: &str, place: Option<&str>) -> String {
        let mut input = json!({
            "summary": summary,
            "dtstart": "2099-06-10T17:00:00.000Z",
            "dtend": "2099-06-10T18:00:00.000Z",
            "start_tz": "Europe/London",
            "calendar_id": calendar,
            // Free, so two events at the same hour do not refuse each other.
            "busy": "free",
        });
        if let Some(place) = place {
            input["location_place_id"] = json!(place);
        }
        self.id("schedule.propose_event", input, "event_id")
    }

    // --- tasks ---

    fn task_in(&self, title: &str, project: Option<&str>) -> String {
        let task = self.id("schedule.add_task", json!({ "title": title }), "task_id");
        if let Some(project) = project {
            self.run(
                "schedule.organize_task",
                json!({ "task_id": task, "project_id": project, "sort_order": 0 }),
            );
        }
        task
    }

    // --- containers (R5) ---

    fn notebook(&self, name: &str) -> String {
        self.id(
            "knowledge.create_notebook",
            json!({ "name": name }),
            "notebook_id",
        )
    }

    fn album(&self, title: &str) -> String {
        self.id("media.create_album", json!({ "title": title }), "album_id")
    }

    fn project(&self, name: &str) -> String {
        self.id(
            "schedule.save_project",
            json!({ "name": name }),
            "project_id",
        )
    }

    fn folder(&self, name: &str) -> String {
        self.id("core.create_folder", json!({ "name": name }), "folder_id")
    }

    /// The circle a Tally group stands on: the id the circle index holds.
    fn circle_of(&self, group: &str) -> String {
        self.vault()
            .read(|connection| {
                Ok(connection.query_row(
                    "SELECT circle_id FROM tally_group WHERE group_id = ?1",
                    [group],
                    |row| row.get::<_, String>(0),
                )?)
            })
            .expect("a group stands on a circle")
    }

    // --- tally ---

    fn friend(&self, name: &str) -> String {
        self.id("tally.add_friend", json!({ "name": name }), "party_id")
    }

    fn group(&self, name: &str, members: &[&str]) -> String {
        self.id(
            "tally.create_group",
            json!({ "name": name, "icon": "x", "currency": "GBP", "member_ids": members }),
            "group_id",
        )
    }

    /// An expense of 3,000 minor units split between the owner and one friend,
    /// optionally in a group and optionally with two itemised lines.
    fn expense(
        &self,
        description: &str,
        category: &str,
        group: Option<&str>,
        friend: &str,
        items: Option<(&str, &str)>,
    ) -> String {
        let mut input = json!({
            "description": description,
            "amount_minor": 3000,
            "paid_by": self.owner,
            "category": category,
            "spent_on": "2099-05-04",
            "splits": [
                { "party_id": self.owner, "share_minor": 2000 },
                { "party_id": friend, "share_minor": 1000 }
            ],
        });
        if let Some(group) = group {
            input["group_id"] = json!(group);
        }
        if let Some((first, second)) = items {
            input["split_method"] = json!("by_line");
            input["line_items"] = json!([
                { "kind": "item", "description": first, "amount_minor": 2000,
                  "allocations": [{ "party_id": self.owner, "share_minor": 2000 }] },
                { "kind": "item", "description": second, "amount_minor": 1000,
                  "allocations": [{ "party_id": friend, "share_minor": 1000 }] }
            ]);
        }
        self.id("tally.add_expense", input, "expense_id")
    }
}

fn set<const N: usize>(ids: [&String; N]) -> BTreeSet<String> {
    ids.into_iter().cloned().collect()
}

fn none() -> BTreeSet<String> {
    BTreeSet::new()
}

/// `column : "word"`, the FTS5 column filter over one phrase.
fn col(column: &str, phrase: &str) -> String {
    format!("{column} : \"{phrase}\"")
}

/// Ids a MATCH finds in one index. The id is the index's first column.
fn hits(vault: &Vault, fts: &str, query: &str) -> BTreeSet<String> {
    vault
        .read(|connection| {
            let id: String = connection.query_row(
                "SELECT name FROM pragma_table_info(?1) WHERE cid = 0",
                [fts],
                |row| row.get(0),
            )?;
            let mut statement =
                connection.prepare(&format!("SELECT {id} FROM {fts} WHERE {fts} MATCH ?1"))?;
            let found = statement
                .query_map([query], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<BTreeSet<String>>>()?;
            Ok(found)
        })
        .unwrap_or_else(|error| panic!("`{query}` against {fts}: {error}"))
}

// ---------------------------------------------------------------------------
// The oracle.
// ---------------------------------------------------------------------------

/// One column's text as a sorted bag of words: the index tokenises, so order
/// and spacing are not what is being compared.
fn bag(text: Option<String>) -> Vec<String> {
    let mut words: Vec<String> = text
        .unwrap_or_default()
        .split_whitespace()
        .map(str::to_owned)
        .collect();
    words.sort();
    words
}

fn bags<I: IntoIterator<Item = Option<String>>>(columns: I) -> Vec<Vec<String>> {
    columns.into_iter().map(bag).collect()
}

fn joined(parts: &[String]) -> Option<String> {
    (!parts.is_empty()).then(|| parts.join(" "))
}

type Indexed = BTreeMap<String, Vec<Vec<String>>>;

/// What an index holds: its id and then the text of each named column.
fn held(connection: &Connection, fts: &str, columns: &[&str]) -> Indexed {
    let mut statement = connection
        .prepare(&format!("SELECT {} FROM {fts}", columns.join(", ")))
        .expect("the index reads");
    statement
        .query_map([], |row| {
            let id: String = row.get(0)?;
            let mut texts = Vec::new();
            for position in 1..columns.len() {
                texts.push(row.get::<_, Option<String>>(position)?);
            }
            Ok((id, bags(texts)))
        })
        .expect("the index reads")
        .collect::<rusqlite::Result<Indexed>>()
        .expect("the rows read")
}

fn strings(connection: &Connection, sql: &str, key: &str) -> Vec<String> {
    let mut statement = connection.prepare(sql).expect("the query prepares");
    statement
        .query_map([key], |row| row.get::<_, String>(0))
        .expect("the query runs")
        .collect::<rusqlite::Result<_>>()
        .expect("the rows read")
}

type Profile = (Option<String>, Option<String>, Option<String>);

fn expected_parties(connection: &Connection) -> Indexed {
    let mut statement = connection
        .prepare("SELECT party_id, display_name, sort_name FROM core_party")
        .expect("the parties read");
    let parties: Vec<(String, String, Option<String>)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .expect("the parties read")
        .collect::<rusqlite::Result<_>>()
        .expect("the parties read");
    let mut out = Indexed::new();
    for (party, display_name, sort_name) in parties {
        let profile: Option<Profile> = connection
            .query_row(
                "SELECT nickname, role, met FROM people_profile
                  WHERE party_id = ?1 AND deleted_at IS NULL",
                [&party],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .expect("the profile reads");
        let (nickname, role, met) = profile.unwrap_or((None, None, None));
        let reach = strings(
            connection,
            "SELECT value || ' ' || normalized_value FROM social_contact_channel
              WHERE party_id = ?1",
            &party,
        );
        // The party's own memos, and the notes of every interaction with a
        // live `about` edge onto it (Q-1097-5): an activity counted once per
        // party however many edges it has.
        let memo = strings(
            connection,
            "SELECT body_text FROM knowledge_annotation
              WHERE target_type = 'core.party' AND target_id = ?1
             UNION ALL
             SELECT an.body_text
               FROM knowledge_annotation an
               JOIN (SELECT DISTINCT from_id FROM core_link
                      WHERE from_type = 'core.activity' AND to_type = 'core.party'
                        AND to_id = ?1 AND valid_to IS NULL) edge
                 ON edge.from_id = an.target_id
              WHERE an.target_type = 'core.activity'",
            &party,
        );
        out.insert(
            party,
            bags([
                Some(display_name),
                sort_name,
                nickname,
                role,
                met,
                joined(&reach),
                joined(&memo),
            ]),
        );
    }
    out
}

fn expected_with_one_join(connection: &Connection, sql: &str) -> Indexed {
    let mut statement = connection.prepare(sql).expect("the rows read");
    statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                bags([Some(row.get::<_, String>(1)?), row.get(2)?, row.get(3)?]),
            ))
        })
        .expect("the rows read")
        .collect::<rusqlite::Result<Indexed>>()
        .expect("the rows read")
}

fn expected_events(connection: &Connection) -> Indexed {
    expected_with_one_join(
        connection,
        "SELECT e.event_id, e.summary, e.description, p.name
           FROM core_event e LEFT JOIN core_place p ON p.place_id = e.location_place_id
          WHERE e.deleted_at IS NULL",
    )
}

fn expected_tasks(connection: &Connection) -> Indexed {
    expected_with_one_join(
        connection,
        "SELECT t.task_id, t.title, t.description, p.name
           FROM schedule_task t LEFT JOIN schedule_project p ON p.project_id = t.project_id
          WHERE t.deleted_at IS NULL",
    )
}

fn expected_expenses(connection: &Connection) -> Indexed {
    let mut statement = connection
        .prepare(
            "SELECT x.expense_id, x.description,
                    CASE WHEN x.category = 'general' THEN NULL ELSE x.category END, c.name
               FROM tally_expense x
               LEFT JOIN tally_group g ON g.group_id = x.group_id
               LEFT JOIN social_circle c ON c.circle_id = g.circle_id
              WHERE x.deleted_at IS NULL",
        )
        .expect("the expenses read");
    let expenses: Vec<(String, String, Option<String>, Option<String>)> = statement
        .query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .expect("the expenses read")
        .collect::<rusqlite::Result<_>>()
        .expect("the expenses read");
    let mut out = Indexed::new();
    for (expense, description, category, group) in expenses {
        let items = strings(
            connection,
            "SELECT description FROM tally_expense_line_item WHERE expense_id = ?1",
            &expense,
        );
        let memo = strings(
            connection,
            "SELECT body_text FROM knowledge_annotation
              WHERE target_type = 'tally.expense' AND target_id = ?1",
            &expense,
        );
        out.insert(
            expense,
            bags([
                Some(description),
                category,
                group,
                joined(&items),
                joined(&memo),
            ]),
        );
    }
    out
}

/// The four widened indexes hold exactly what their base tables say they
/// should: the same rows, and in each folded column the same words.
fn assert_indexes_match(vault: &Vault) {
    vault
        .read(|connection| {
            let checks: [(&str, &[&str], Indexed); 4] = [
                (
                    "fts_core_party",
                    &[
                        "party_id",
                        "display_name",
                        "sort_name",
                        "nickname",
                        "role",
                        "met",
                        "channels",
                        "memo",
                    ],
                    expected_parties(connection),
                ),
                (
                    "fts_core_event",
                    &["event_id", "summary", "description", "location"],
                    expected_events(connection),
                ),
                (
                    "fts_schedule_task",
                    &["task_id", "title", "description", "project"],
                    expected_tasks(connection),
                ),
                (
                    "fts_tally_expense",
                    &[
                        "expense_id",
                        "description",
                        "category",
                        "group_name",
                        "items",
                        "memo",
                    ],
                    expected_expenses(connection),
                ),
            ];
            for (fts, columns, expected) in checks {
                let actual = held(connection, fts, columns);
                assert_eq!(
                    actual, expected,
                    "{fts} does not hold what its base tables say (columns {columns:?})"
                );
            }
            Ok(())
        })
        .expect("the indexes read");
}

/// The four container indexes hold exactly the live containers (R5), judged by
/// plain joins that are not the triggers: a notebook or an album as it stands, a
/// project while it is not archived, a circle a live group stands on, and a
/// concept of the folders scheme that is not the root.
fn assert_containers_match(vault: &Vault) {
    vault
        .read(|connection| {
            let one = |sql: &str| -> Indexed {
                let mut statement = connection.prepare(sql).expect("the rows read");
                statement
                    .query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, bags([Some(row.get::<_, String>(1)?)])))
                    })
                    .expect("the rows read")
                    .collect::<rusqlite::Result<Indexed>>()
                    .expect("the rows read")
            };
            let checks: [(&str, &[&str], Indexed); 4] = [
                (
                    "fts_core_collection",
                    &["collection_id", "name"],
                    one("SELECT collection_id, name FROM core_collection"),
                ),
                (
                    "fts_schedule_project",
                    &["project_id", "name"],
                    one("SELECT project_id, name FROM schedule_project WHERE archived_at IS NULL"),
                ),
                (
                    "fts_social_circle",
                    &["circle_id", "name"],
                    one(
                        "SELECT c.circle_id, c.name FROM social_circle c
                          WHERE EXISTS (SELECT 1 FROM tally_group g
                                         WHERE g.circle_id = c.circle_id AND g.archived_at IS NULL)",
                    ),
                ),
                (
                    "fts_core_concept",
                    &["concept_id", "pref_label"],
                    one(
                        "SELECT c.concept_id, c.pref_label FROM core_concept c
                           JOIN core_concept_scheme s ON s.scheme_id = c.scheme_id
                          WHERE s.uri = 'https://centraid.dev/schemes/folders'
                            AND c.notation <> 'root'",
                    ),
                ),
            ];
            for (fts, columns, expected) in checks {
                let actual = held(connection, fts, columns);
                assert_eq!(
                    actual, expected,
                    "{fts} does not hold the live containers its base tables say"
                );
            }
            Ok(())
        })
        .expect("the indexes read");
}

// ---------------------------------------------------------------------------
// 1. A MATCH on each folded column finds its parent.
// ---------------------------------------------------------------------------

#[test]
fn a_nickname_a_role_and_where_they_met_find_the_person() {
    let world = World::new("cov-profile");
    let ravi = world.person("Ravi Menon", Some("Chotu"), Some("Cousin"));
    world.run(
        "people.edit_person",
        json!({ "party_id": ravi, "met": "at the Goa wedding" }),
    );

    for (column, word) in [("nickname", "chotu"), ("role", "cousin"), ("met", "goa")] {
        assert_eq!(
            world.hits("fts_core_party", &col(column, word)),
            set([&ravi]),
            "`{word}` is in `{column}`"
        );
    }
    // A prefix, as the door types it.
    assert_eq!(
        world.hits("fts_core_party", "nickname : \"cho\"*"),
        set([&ravi])
    );
    // The fold is the only way in: the name column does not hold the nickname.
    assert_eq!(
        world.hits("fts_core_party", &col("display_name", "chotu")),
        none()
    );
    assert_indexes_match(world.vault());
}

#[test]
fn an_email_a_phone_digits_run_and_a_handle_find_the_person() {
    let world = World::new("cov-reach");
    let ravi = world.person("Ravi Menon", None, None);
    let other = world.person("Asha Rao", None, None);
    world.channel(&ravi, "email", "Ravi.Menon@Example.org");
    world.channel(&ravi, "phone", "+44 20 7946 0958");
    world.channel(&ravi, "handle", "@ravi_menon");
    world.channel(&other, "phone", "+1 (415) 555-0100");

    // The whole address, as one phrase of its tokens.
    assert_eq!(
        world.hits("fts_core_party", &col("channels", "ravi.menon@example.org")),
        set([&ravi])
    );
    // The digits run the vault normalised to (`+442079460958`), and a group of
    // digits as the member wrote it.
    assert_eq!(
        world.hits("fts_core_party", &col("channels", "442079460958")),
        set([&ravi])
    );
    assert_eq!(
        world.hits("fts_core_party", &col("channels", "7946")),
        set([&ravi])
    );
    assert_eq!(
        world.hits("fts_core_party", &col("channels", "ravi_menon")),
        set([&ravi])
    );
    assert_eq!(
        world.hits("fts_core_party", &col("channels", "14155550100")),
        set([&other])
    );
    assert_indexes_match(world.vault());
}

#[test]
fn a_memo_on_a_person_finds_the_person() {
    let world = World::new("cov-memo");
    let ravi = world.person("Ravi Menon", None, None);
    world.run(
        "people.add_note",
        json!({ "party_id": ravi, "text": "Allergic to peanuts, loves kayaking" }),
    );
    world.run(
        "people.add_note",
        json!({ "party_id": ravi, "text": "Owes me a book" }),
    );
    for word in ["peanuts", "kayaking", "book"] {
        assert_eq!(
            world.hits("fts_core_party", &col("memo", word)),
            set([&ravi]),
            "`{word}` is in a memo"
        );
    }
    assert_indexes_match(world.vault());
}

// ---------------------------------------------------------------------------
// 1b. An interaction's note is found under the person (Q-1097-5).
// ---------------------------------------------------------------------------

#[test]
fn a_logged_interaction_note_finds_its_person_and_every_participant() {
    let world = World::new("cov-interaction");
    let ravi = world.person("Ravi Menon", None, None);
    let asha = world.person("Asha Rao", None, None);
    let unrelated = world.person("Jake Bennett", None, None);
    let lunch = world.interaction(&ravi, "lunch at Rao's, talked about the move");
    // A note on the party itself stays in the same column beside it.
    world.run(
        "people.add_note",
        json!({ "party_id": ravi, "text": "Allergic to peanuts" }),
    );

    for word in ["lunch", "rao", "move", "peanuts"] {
        assert_eq!(
            world.hits("fts_core_party", &col("memo", word)),
            set([&ravi]),
            "`{word}` is in Ravi's memo"
        );
    }
    // The words are Ravi's alone until someone else is on the interaction.
    assert_eq!(
        world.hits("fts_core_party", "\"lunch at rao\""),
        set([&ravi])
    );
    assert_indexes_match(world.vault());

    // A SECOND PARTICIPANT finds it too, and an unrelated party never does.
    world.also_about(&lunch, &asha);
    assert_eq!(
        world.hits("fts_core_party", &col("memo", "lunch")),
        set([&ravi, &asha])
    );
    assert!(
        !world
            .hits("fts_core_party", &col("memo", "lunch"))
            .contains(&unrelated)
    );
    assert_eq!(world.hits("fts_core_party", "lunch"), set([&ravi, &asha]));
    assert_indexes_match(world.vault());
}

#[test]
fn removing_the_link_or_the_note_or_the_activity_drops_the_hit() {
    let world = World::new("cov-interaction-drop");
    let ravi = world.person("Ravi Menon", None, None);
    let asha = world.person("Asha Rao", None, None);

    // ENDING the link (the command that ends a relationship): only that
    // participant loses the words.
    let lunch = world.interaction(&ravi, "lunch at Rao's");
    let asha_link = world.also_about(&lunch, &asha);
    assert_eq!(
        world.hits("fts_core_party", &col("memo", "lunch")),
        set([&ravi, &asha])
    );
    world.run("core.unlink_entities", json!({ "link_id": asha_link }));
    assert_eq!(
        world.hits("fts_core_party", &col("memo", "lunch")),
        set([&ravi]),
        "an ended link stops contributing"
    );
    assert_indexes_match(world.vault());

    // DELETING the link.
    let ravi_link = world.link_of(&lunch, &ravi);
    world.execute_sql("DELETE FROM core_link WHERE link_id = ?1", &[&ravi_link]);
    assert_eq!(world.hits("fts_core_party", &col("memo", "lunch")), none());
    assert_indexes_match(world.vault());

    // DELETING the annotation (an annotation has no trash column; its removal
    // is the delete).
    let dinner = world.interaction(&ravi, "dinner with the Menon cousins");
    assert_eq!(
        world.hits("fts_core_party", &col("memo", "cousins")),
        set([&ravi])
    );
    world.execute_sql(
        "DELETE FROM knowledge_annotation
          WHERE target_type = 'core.activity' AND target_id = ?1",
        &[&dinner],
    );
    assert_eq!(
        world.hits("fts_core_party", &col("memo", "cousins")),
        none()
    );
    assert_indexes_match(world.vault());

    // EDITING the annotation moves the words.
    let brunch = world.interaction(&asha, "brunch at the Lisbon docks");
    world.execute_sql(
        "UPDATE knowledge_annotation SET body_text = 'swim at the beach'
          WHERE target_type = 'core.activity' AND target_id = ?1",
        &[&brunch],
    );
    assert_eq!(world.hits("fts_core_party", &col("memo", "brunch")), none());
    assert_eq!(
        world.hits("fts_core_party", &col("memo", "beach")),
        set([&asha])
    );
    assert_indexes_match(world.vault());

    // REMOVING THE ACTIVITY (an activity cannot be trashed; the entity's delete
    // cascades its link and its note, each firing its own trigger).
    let walk = world.interaction(&ravi, "walk along the canal");
    assert_eq!(
        world.hits("fts_core_party", &col("memo", "canal")),
        set([&ravi])
    );
    world.execute_sql("DELETE FROM core_entity WHERE entity_id = ?1", &[&walk]);
    assert_eq!(world.hits("fts_core_party", &col("memo", "canal")), none());
    assert_indexes_match(world.vault());
}

#[test]
fn a_merged_persons_interactions_move_to_the_survivor_and_a_purge_clears_them() {
    let world = World::new("cov-interaction-merge");
    let survivor = world.person("Ray", None, None);
    let merged = world.person("Grandpa Ray", None, None);
    world.interaction(&merged, "fishing at the reservoir");
    assert_eq!(
        world.hits("fts_core_party", &col("memo", "fishing")),
        set([&merged])
    );
    world.run(
        "core.merge_party",
        json!({ "survivor_party_id": survivor, "merged_party_id": merged }),
    );
    assert_eq!(
        world.hits("fts_core_party", &col("memo", "fishing")),
        set([&survivor])
    );
    assert_indexes_match(world.vault());

    world.run("people.trash_person", json!({ "party_id": survivor }));
    world.run("people.purge_person", json!({ "party_id": survivor }));
    assert_eq!(
        world.hits("fts_core_party", &col("memo", "fishing")),
        none()
    );
    assert_eq!(
        tables_holding(world.vault(), "fishing"),
        Vec::<String>::new(),
        "no index, vocabulary or shadow table keeps a purged person's interaction note"
    );
    assert_indexes_match(world.vault());
}

#[test]
fn an_interaction_notes_words_are_terms_of_the_party_vocabulary() {
    // `Search::correct` reads this vocabulary; `crates/search/tests/door.rs`
    // runs the correction through the door. Here the claim is that the folded
    // word is a TERM with the document count a correction chooses by.
    let world = World::new("cov-interaction-vocab");
    let ravi = world.person("Ravi Menon", None, None);
    world.interaction(&ravi, "lunch at Rao's");
    let docs: i64 = world.count("SELECT doc FROM fts_core_party_vocab WHERE term = 'lunch'");
    assert_eq!(docs, 1);
    assert_eq!(
        world.count("SELECT COUNT(*) FROM fts_core_party_vocab WHERE term = 'lnuch'"),
        0
    );
}

#[test]
fn an_events_place_finds_the_event_and_a_rename_moves_the_hit() {
    let world = World::new("cov-event");
    let calendar = world.calendar();
    let place = world.place("Lisbon Docks");
    let event = world.event(&calendar, "Team offsite", Some(&place));
    let elsewhere = world.event(&calendar, "Dentist", None);

    assert_eq!(
        world.hits("fts_core_event", &col("location", "lisbon")),
        set([&event])
    );
    assert_eq!(
        world.hits("fts_core_event", &col("summary", "lisbon")),
        none()
    );

    // THE RENAME MOVES THE HIT: the place's own name is the source, so the
    // event's row has to be written again when it changes.
    world.run(
        "media.name_place",
        json!({ "place_id": place, "name": "Porto Riverside" }),
    );
    assert_eq!(
        world.hits("fts_core_event", &col("location", "lisbon")),
        none()
    );
    assert_eq!(
        world.hits("fts_core_event", &col("location", "porto")),
        set([&event])
    );
    assert_indexes_match(world.vault());

    // A trashed event is out of the index and a restored one is back.
    world.run("schedule.delete_event", json!({ "event_id": event }));
    assert_eq!(
        world.hits("fts_core_event", &col("location", "porto")),
        none()
    );
    assert_indexes_match(world.vault());
    world.run("schedule.restore_event", json!({ "event_id": event }));
    assert_eq!(
        world.hits("fts_core_event", &col("location", "porto")),
        set([&event])
    );
    assert!(world.hits("fts_core_event", "dentist").contains(&elsewhere));
    assert_indexes_match(world.vault());
}

#[test]
fn a_tasks_project_finds_the_task_and_a_rename_moves_the_hit() {
    let world = World::new("cov-task");
    let project = world.id(
        "schedule.save_project",
        json!({ "name": "Kitchen refit" }),
        "project_id",
    );
    let task = world.task_in("Order tiles", Some(&project));
    let loose = world.task_in("Call the plumber", None);

    assert_eq!(
        world.hits("fts_schedule_task", &col("project", "kitchen")),
        set([&task])
    );
    assert_eq!(
        world.hits("fts_schedule_task", &col("title", "kitchen")),
        none()
    );

    // The same command, given the id again, renames the project.
    world.run(
        "schedule.save_project",
        json!({ "project_id": project, "name": "Bathroom refit" }),
    );
    assert_eq!(
        world.hits("fts_schedule_task", &col("project", "kitchen")),
        none()
    );
    assert_eq!(
        world.hits("fts_schedule_task", &col("project", "bathroom")),
        set([&task])
    );
    assert_indexes_match(world.vault());

    // A trashed task is out and a restored one is back.
    world.run("schedule.delete_task", json!({ "task_id": task }));
    assert_eq!(
        world.hits("fts_schedule_task", &col("project", "bathroom")),
        none()
    );
    world.run("schedule.restore_task", json!({ "task_id": task }));
    assert_eq!(
        world.hits("fts_schedule_task", &col("project", "bathroom")),
        set([&task])
    );
    assert!(world.hits("fts_schedule_task", "plumber").contains(&loose));
    assert_indexes_match(world.vault());

    // Deleting the project sets the task's `project_id` to NULL, which is an
    // UPDATE of the task: the project's words leave the task's row. No command
    // deletes a project, so the fixture does.
    world.execute_sql(
        "DELETE FROM schedule_project WHERE project_id = ?1",
        &[&project],
    );
    assert_eq!(
        world.hits("fts_schedule_task", &col("project", "bathroom")),
        none()
    );
    assert_indexes_match(world.vault());
}

#[test]
fn an_expense_is_found_by_category_group_line_item_and_memo() {
    let world = World::new("cov-expense");
    let ana = world.friend("Ana");
    let group = world.group("Sitwell Road", &[&ana]);
    let expense = world.expense(
        "Hardware shop",
        "utilities",
        Some(&group),
        &ana,
        Some(("Paint", "Brushes")),
    );
    world.run(
        "tally.set_expense_memo",
        json!({ "expense_id": expense, "note": "receipt is in the red folder" }),
    );
    let plain = world.expense("Cinema", "fun", None, &ana, None);

    for (column, word) in [
        ("category", "utilities"),
        ("group_name", "sitwell"),
        ("items", "paint"),
        ("items", "brushes"),
        ("memo", "folder"),
    ] {
        assert_eq!(
            world.hits("fts_tally_expense", &col(column, word)),
            set([&expense]),
            "`{word}` is in `{column}`"
        );
    }
    assert_eq!(
        world.hits("fts_tally_expense", &col("category", "fun")),
        set([&plain])
    );
    assert_indexes_match(world.vault());

    // A RENAME OF THE GROUP moves the hit: the name lives on the circle.
    world.run(
        "tally.rename_group",
        json!({ "group_id": group, "name": "Kensington Flat" }),
    );
    assert_eq!(
        world.hits("fts_tally_expense", &col("group_name", "sitwell")),
        none()
    );
    assert_eq!(
        world.hits("fts_tally_expense", &col("group_name", "kensington")),
        set([&expense])
    );
    assert_indexes_match(world.vault());

    // A trashed expense is out and a restored one is back.
    world.run("tally.delete_expense", json!({ "expense_id": expense }));
    assert_eq!(
        world.hits("fts_tally_expense", &col("items", "paint")),
        none()
    );
    assert_indexes_match(world.vault());
    world.run("tally.restore_expense", json!({ "expense_id": expense }));
    assert_eq!(
        world.hits("fts_tally_expense", &col("items", "paint")),
        set([&expense])
    );
    assert_indexes_match(world.vault());
}

#[test]
fn the_default_category_is_not_folded() {
    let world = World::new("cov-general");
    let ana = world.friend("Ana");
    let generic = world.expense("Dinner", "general", None, &ana, None);
    let chosen = world.expense("Lunch", "food", None, &ana, None);

    assert_eq!(
        world.hits("fts_tally_expense", &col("category", "general")),
        none(),
        "`general` is what every expense that chose nothing carries"
    );
    assert_eq!(world.hits("fts_tally_expense", "general"), none());
    assert_eq!(
        world.hits("fts_tally_expense", &col("category", "food")),
        set([&chosen])
    );
    // And the expense itself is still in the index, by its description.
    assert_eq!(
        world.hits("fts_tally_expense", &col("description", "dinner")),
        set([&generic])
    );
    assert_indexes_match(world.vault());
}

// ---------------------------------------------------------------------------
// 2. What is removed, edited or cleared leaves with its words.
// ---------------------------------------------------------------------------

#[test]
fn deleting_a_line_item_a_channel_or_a_memo_removes_its_words() {
    let world = World::new("cov-removal");
    let ana = world.friend("Ana");
    let expense = world.expense(
        "Hardware shop",
        "utilities",
        None,
        &ana,
        Some(("Paint", "Brushes")),
    );
    world.run(
        "tally.set_expense_memo",
        json!({ "expense_id": expense, "note": "the red folder" }),
    );
    assert_eq!(
        world.hits("fts_tally_expense", &col("items", "brushes")),
        set([&expense])
    );

    // A LINE ITEM: the edit writes the lines again with one fewer.
    world.run(
        "tally.edit_expense",
        json!({
            "expense_id": expense,
            "description": "Hardware shop",
            "amount_minor": 3000,
            "paid_by": world.owner,
            "category": "utilities",
            "spent_on": "2099-05-04",
            "split_method": "by_line",
            "splits": [{ "party_id": world.owner, "share_minor": 3000 }],
            "line_items": [{
                "kind": "item", "description": "Paint", "amount_minor": 3000,
                "allocations": [{ "party_id": world.owner, "share_minor": 3000 }]
            }],
        }),
    );
    assert_eq!(
        world.hits("fts_tally_expense", &col("items", "brushes")),
        none()
    );
    assert_eq!(
        world.hits("fts_tally_expense", &col("items", "paint")),
        set([&expense])
    );
    assert_indexes_match(world.vault());

    // A MEMO: an empty note clears it.
    world.run(
        "tally.set_expense_memo",
        json!({ "expense_id": expense, "note": "" }),
    );
    assert_eq!(
        world.hits("fts_tally_expense", &col("memo", "folder")),
        none()
    );
    assert_indexes_match(world.vault());

    // A CHANNEL: the delete takes the address with it, and the undo puts it back.
    let ravi = world.person("Ravi Menon", None, None);
    let channel = world.channel(&ravi, "email", "ravi@example.org");
    assert_eq!(
        world.hits("fts_core_party", &col("channels", "ravi@example.org")),
        set([&ravi])
    );
    let deleted = world.run(
        "people.delete_contact_channel",
        json!({ "channel_id": channel }),
    );
    assert_eq!(
        world.hits("fts_core_party", &col("channels", "ravi@example.org")),
        none()
    );
    assert_indexes_match(world.vault());
    world.run(
        "people.undo_contact_channel",
        json!({ "channel_id": channel, "revision_id": deleted["revision_id"] }),
    );
    assert_eq!(
        world.hits("fts_core_party", &col("channels", "ravi@example.org")),
        set([&ravi])
    );
    assert_indexes_match(world.vault());
}

#[test]
fn a_trashed_profiles_nickname_is_not_found_and_a_restored_one_is() {
    let world = World::new("cov-trash");
    let ravi = world.person("Ravi Menon", Some("Chotu"), Some("Cousin"));
    world.run(
        "people.edit_person",
        json!({ "party_id": ravi, "met": "at the Goa wedding" }),
    );
    world.run("people.trash_person", json!({ "party_id": ravi }));

    for (column, word) in [("nickname", "chotu"), ("role", "cousin"), ("met", "goa")] {
        assert_eq!(
            world.hits("fts_core_party", &col(column, word)),
            none(),
            "a trashed profile's `{column}` is not found"
        );
    }
    // The party stays, as it always did: only the profile's text left.
    assert_eq!(
        world.hits("fts_core_party", &col("display_name", "ravi")),
        set([&ravi])
    );
    assert_indexes_match(world.vault());

    world.run("people.restore_person", json!({ "party_id": ravi }));
    assert_eq!(
        world.hits("fts_core_party", &col("nickname", "chotu")),
        set([&ravi])
    );
    assert_indexes_match(world.vault());
}

#[test]
fn folding_a_merged_person_in_moves_their_words_to_the_survivor() {
    let world = World::new("cov-merge");
    let survivor = world.person("Ray", None, None);
    let merged = world.person("Grandpa Ray", Some("Pops"), None);
    world.channel(&merged, "email", "pops@example.org");
    world.run(
        "people.add_note",
        json!({ "party_id": merged, "text": "Tells the story about the boat" }),
    );
    assert_eq!(
        world.hits("fts_core_party", &col("nickname", "pops")),
        set([&merged])
    );

    world.run(
        "core.merge_party",
        json!({ "survivor_party_id": survivor, "merged_party_id": merged }),
    );
    // The folded-in person's row is gone and everything they carried is the
    // survivor's: the merge re-points the profile, the channel and the memo.
    for (column, word) in [
        ("nickname", "pops"),
        ("channels", "pops@example.org"),
        ("memo", "boat"),
    ] {
        assert_eq!(
            world.hits("fts_core_party", &col(column, word)),
            set([&survivor]),
            "`{word}` is the survivor's now"
        );
    }
    assert_eq!(
        world.count(&format!(
            "SELECT COUNT(*) FROM fts_core_party WHERE party_id = '{merged}'"
        )),
        0
    );
    assert_indexes_match(world.vault());
}

#[test]
fn purging_a_person_leaves_nothing_of_them_in_the_index() {
    let world = World::new("cov-purge");
    let maya = world.person("Maya Alvarez", Some("Mayita"), Some("Neighbour"));
    world.channel(&maya, "email", "maya@example.org");
    world.run(
        "people.add_note",
        json!({ "party_id": maya, "text": "Likes figs" }),
    );
    let kept = world.person("Jake Bennett", Some("Jakey"), None);
    world.run("people.trash_person", json!({ "party_id": maya }));
    world.run("people.purge_person", json!({ "party_id": maya }));

    assert_eq!(
        world.count(&format!(
            "SELECT COUNT(*) FROM fts_core_party WHERE party_id = '{maya}'"
        )),
        0,
        "the purged party's row left the index"
    );
    for (column, word) in [
        ("display_name", "maya"),
        ("nickname", "mayita"),
        ("channels", "maya@example.org"),
        ("memo", "figs"),
    ] {
        assert_eq!(
            world.hits("fts_core_party", &col(column, word)),
            none(),
            "`{word}` is still in `{column}` after the purge"
        );
    }
    assert_eq!(
        world.hits("fts_core_party", &col("nickname", "jakey")),
        set([&kept])
    );
    assert_indexes_match(world.vault());
}

// ---------------------------------------------------------------------------
// 3. Rank weights and the vocabulary.
// ---------------------------------------------------------------------------

/// THE WEIGHTS ARE NOT IN THE INDEX (R1d). A `rank` row in an index's `_config`
/// is data, `contracts/schema/vault-ddl.sql` carries none, and a vault built by
/// replaying it would rank differently from one that ran the rung. The door
/// passes the weights with each query (`crates/search`, which tests the order
/// against a replayed vault and a founded one).
#[test]
fn no_widened_index_stores_a_rank_override() {
    let world = World::new("cov-no-rank");
    for fts in [
        "fts_core_party",
        "fts_core_event",
        "fts_schedule_task",
        "fts_tally_expense",
    ] {
        assert_eq!(
            world.count(&format!(
                "SELECT COUNT(*) FROM {fts}_config WHERE k = 'rank'"
            )),
            0,
            "{fts} stores a rank, so a replayed vault would order differently"
        );
    }
}

#[test]
fn every_domain_vocabulary_answers_term_and_doc_for_a_planted_word() {
    let world = World::new("cov-vocab");
    let word = "quokka";
    let ana = world.friend("Ana");
    let calendar = world.calendar();

    world.run(
        "knowledge.create_note",
        json!({ "title": "Quokka expedition", "body_text": "packing list" }),
    );
    world.person("Quokka Rao", None, None);
    world.event(&calendar, "Quokka picnic", None);
    world.task_in("Quokka rescue", None);
    world.expense("Quokka tickets", "fun", None, &ana, None);
    world.run(
        "core.create_text_document",
        json!({ "title": "Quokka lease", "body_text": "the terms" }),
    );
    // A photograph's byte row and its asset: no command makes one without bytes.
    common::insert_photograph(world.vault(), "asset-photo", "Quokka selfie")
        .expect("the photograph is written");

    for domain in [
        "fts_knowledge_note",
        "fts_core_party",
        "fts_core_event",
        "fts_schedule_task",
        "fts_tally_expense",
        "fts_core_content_item",
        "fts_core_document",
    ] {
        let vocab = format!("{domain}_vocab");
        let (docs, total): (i64, i64) = world
            .vault()
            .read(|connection| {
                Ok(connection.query_row(
                    &format!("SELECT doc, cnt FROM {vocab} WHERE term = ?1"),
                    [word],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?)
            })
            .unwrap_or_else(|error| panic!("{vocab} does not answer `{word}`: {error}"));
        assert_eq!(
            (docs, total),
            (1, 1),
            "{vocab}: one row holds `{word}` once"
        );
        let absent: i64 = world.count(&format!(
            "SELECT COUNT(*) FROM {vocab} WHERE term = 'nosuchword'"
        ));
        assert_eq!(absent, 0, "{vocab} invents no terms");
    }

    // `doc` counts rows, not occurrences: a second task with the word twice.
    world.task_in("Quokka quokka", None);
    let (docs, total): (i64, i64) = world
        .vault()
        .read(|connection| {
            Ok(connection.query_row(
                "SELECT doc, cnt FROM fts_schedule_task_vocab WHERE term = 'quokka'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?)
        })
        .expect("the vocabulary answers");
    assert_eq!((docs, total), (2, 3));
}

// ---------------------------------------------------------------------------
// 4. What must never be indexed.
// ---------------------------------------------------------------------------

/// Every table whose name starts with `fts_`: the indexes, their vocabularies
/// and FTS5's own shadow tables, each with its DDL.
fn fts_tables(connection: &Connection) -> Vec<(String, String)> {
    let mut statement = connection
        .prepare(
            r"SELECT name, sql FROM sqlite_master
               WHERE type = 'table' AND name LIKE 'fts\_%' ESCAPE '\'
               ORDER BY name",
        )
        .expect("the schema reads");
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .expect("the schema reads")
        .collect::<rusqlite::Result<_>>()
        .expect("the schema reads")
}

/// Which `fts_*` tables hold this word anywhere: matched in an index, a term of
/// a vocabulary, or text in a shadow table's cells.
fn tables_holding(vault: &Vault, word: &str) -> Vec<String> {
    vault
        .read(|connection| {
            let mut holding = Vec::new();
            for (table, sql) in fts_tables(connection) {
                let count: i64 = if sql.contains("USING fts5vocab") {
                    connection.query_row(
                        &format!("SELECT COUNT(*) FROM {table} WHERE term = ?1"),
                        [word],
                        |row| row.get(0),
                    )?
                } else if sql.contains("USING fts5(") {
                    connection.query_row(
                        &format!("SELECT COUNT(*) FROM {table} WHERE {table} MATCH ?1"),
                        [format!("\"{word}\"")],
                        |row| row.get(0),
                    )?
                } else {
                    let columns: Vec<String> = connection
                        .prepare("SELECT name FROM pragma_table_info(?1)")?
                        .query_map([&table], |row| row.get(0))?
                        .collect::<rusqlite::Result<_>>()?;
                    let predicate = columns
                        .iter()
                        .map(|column| format!("CAST({column} AS TEXT) LIKE ?1"))
                        .collect::<Vec<_>>()
                        .join(" OR ");
                    connection.query_row(
                        &format!("SELECT COUNT(*) FROM {table} WHERE {predicate}"),
                        [format!("%{word}%")],
                        |row| row.get(0),
                    )?
                };
                if count > 0 {
                    holding.push(table);
                }
            }
            Ok(holding)
        })
        .expect("the scan runs")
}

#[test]
fn a_locker_memo_is_in_no_index_and_no_vocabulary() {
    let world = World::new("cov-locker");
    world.execute_sql(
        "INSERT INTO locker_key (key_id, created_at) VALUES ('key-1', '2026-01-01T00:00:00.000Z')",
        &[],
    );
    world.run(
        "locker.add_item",
        json!({ "item_id": "item-1", "type": "note", "title": "Spare keys" }),
    );
    world.run(
        "locker.set_memo",
        json!({ "item_id": "item-1", "note": "zebrafish quokkaberry under the mat" }),
    );
    // THE MEMO IS THERE, as an annotation on the Locker item: the scan below is
    // not over an empty set.
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM knowledge_annotation
              WHERE target_type = 'locker.item' AND body_text LIKE '%zebrafish%'"
        ),
        1
    );

    // A person's memo with another word is the positive control: the same scan
    // finds it, in the party's index, its vocabulary and the index's own cells.
    let ravi = world.person("Ravi Menon", None, None);
    world.run(
        "people.add_note",
        json!({ "party_id": ravi, "text": "narwhalberry on the shelf" }),
    );
    let control = tables_holding(world.vault(), "narwhalberry");
    for expected in [
        "fts_core_party",
        "fts_core_party_vocab",
        "fts_core_party_content",
    ] {
        assert!(
            control.iter().any(|table| table == expected),
            "the scan does not see a party memo in {expected}: {control:?}"
        );
    }

    for word in ["zebrafish", "quokkaberry"] {
        assert_eq!(
            tables_holding(world.vault(), word),
            Vec::<String>::new(),
            "a Locker memo's `{word}` is in an index, a vocabulary or a shadow table"
        );
    }
    // And Locker has no index at all, so no vocabulary either: its index was
    // retired with rung thirteen (Q-1097-1 (c)).
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'fts\\_locker%' ESCAPE '\\'"
        ),
        0
    );
    assert_indexes_match(world.vault());
}

/// A whole-word search, so `content` does not find `content_id`.
fn mentions_word(sql: &str, word: &str) -> bool {
    let is_word = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_';
    let bytes = sql.as_bytes();
    let mut from = 0;
    while let Some(found) = sql[from..].find(word) {
        let start = from + found;
        let end = start + word.len();
        let before = start == 0 || !is_word(bytes[start - 1]);
        let after = end >= bytes.len() || !is_word(bytes[end]);
        if before && after {
            return true;
        }
        from = start + 1;
    }
    false
}

/// `commitments.rs`' `no_sealed_column_appears_in_any_fts_ddl`, over the LADDER
/// HEAD: that test reads the frozen v0 corpus, which has none of rung
/// thirteen's objects. Every `fts_*` object and every trigger that names an
/// index is checked against the sealed registry.
#[test]
fn no_sealed_column_appears_in_any_fts_object_at_the_ladder_head() {
    let world = World::new("cov-sealed");
    let sealed = centraid_ontology::registries::sealed_physical_columns();
    assert!(!sealed.is_empty(), "the sealed register is empty");
    let objects = world
        .vault()
        .read(|connection| Ok(centraid_ontology::schema_objects_of(connection)?))
        .expect("the schema reads");
    let fts_objects: Vec<_> = objects
        .iter()
        .filter(|object| object.name.starts_with("fts_") || object.sql.contains("fts_"))
        .collect();

    // NOT VACUOUS: rung thirteen's objects are in the set being checked.
    for named in [
        "fts_core_party_vocab",
        "fts_core_party_from_knowledge_annotation_ai",
        "fts_tally_expense_from_tally_expense_line_item_au",
        "fts_core_party_from_core_link_au",
        "fts_core_collection",
    ] {
        assert!(
            fts_objects.iter().any(|object| object.name == named),
            "{named} is not among the objects checked"
        );
    }

    let findings: Vec<String> = fts_objects
        .iter()
        .flat_map(|object| {
            sealed.iter().filter_map(move |(table, column)| {
                let touches_table = mentions_word(&object.sql, &format!("fts_{table}"))
                    || mentions_word(&object.sql, table);
                (touches_table && mentions_word(&object.sql, column)).then(|| {
                    format!(
                        "{} {} mentions sealed column {table}.{column}",
                        object.kind, object.name
                    )
                })
            })
        })
        .collect();
    assert_eq!(findings.join("\n"), "");

    // THE CHECK CAN FAIL: a trigger that folded a sealed column would be named.
    let planted = "CREATE TRIGGER fts_locker_item_from_x AFTER INSERT ON locker_item BEGIN \
                   INSERT INTO fts_locker_item(rowid, title) SELECT new.rowid, new.password; END";
    assert!(
        mentions_word(planted, "fts_locker_item") && mentions_word(planted, "password"),
        "the matcher would not flag a trigger that folded locker_item.password"
    );
}

// ---------------------------------------------------------------------------
// 5. The rung over a vault written before it.
// ---------------------------------------------------------------------------

/// One object's DDL out of the baseline, which is the text rung twelve's file
/// still carries for every index rung thirteen did not rewrite.
fn baseline_block(kind: &str, name: &str) -> String {
    let marker = format!("-- {kind} {name}");
    let lines: Vec<&str> = BASELINE_SQL.lines().collect();
    let start = lines
        .iter()
        .position(|line| *line == marker)
        .unwrap_or_else(|| panic!("`{marker}` is not in the baseline"));
    let mut block = String::new();
    for line in &lines[start + 1..] {
        if ["-- table ", "-- trigger ", "-- index ", "-- view ", "---- "]
            .iter()
            .any(|head| line.starts_with(head))
        {
            break;
        }
        block.push_str(line);
        block.push('\n');
    }
    block
}

/// WIND A FOUNDED FILE BACK TO RUNG TWELVE: rung thirteen's objects leave, and
/// the thirteen indexes it rebuilt or retired come back in the baseline's own text,
/// empty — a file at rung twelve held them in that shape.
fn wind_back_to_rung_twelve(path: &Path) {
    let raw = Connection::open(path).expect("the file opens");
    let rung_thirteen: Vec<(String, String)> = {
        let mut statement = raw
            .prepare(
                r"SELECT type, name FROM sqlite_master
                   WHERE name LIKE 'fts\_%' ESCAPE '\'
                     AND (name LIKE '%\_vocab' ESCAPE '\' OR name LIKE '%\_from\_%' ESCAPE '\')",
            )
            .expect("the schema reads");
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .expect("the schema reads")
            .collect::<rusqlite::Result<_>>()
            .expect("the schema reads")
    };
    // Eleven vocabularies (seven domains, four containers), twenty-two
    // re-indexing triggers of the domains, the circle's three from the Tally
    // group and the folder index's one from its scheme.
    assert_eq!(
        rung_thirteen.len(),
        11 + 22 + 3 + 1,
        "rung thirteen's own objects"
    );
    let mut statements = String::from("BEGIN;\n");
    for (kind, name) in &rung_thirteen {
        statements.push_str(&format!("DROP {} {name};\n", kind.to_uppercase()));
    }
    // The folder index is born in rung thirteen: it leaves and nothing replaces it.
    for suffix in ["ai", "au", "ad"] {
        statements.push_str(&format!(
            "DROP TRIGGER IF EXISTS fts_core_concept_{suffix};\n"
        ));
    }
    statements.push_str("DROP TABLE IF EXISTS fts_core_concept;\n");
    let rebuilt = [
        "fts_core_party",
        "fts_core_event",
        "fts_schedule_task",
        "fts_tally_expense",
        "fts_people_profile",
        "fts_core_place",
        "fts_schedule_project",
        "fts_social_circle",
        "fts_knowledge_annotation",
        "fts_core_transaction",
        "fts_locker_item",
        "fts_social_thread",
        "fts_social_message",
    ];
    for fts in rebuilt {
        for suffix in ["ai", "au", "ad"] {
            statements.push_str(&format!("DROP TRIGGER IF EXISTS {fts}_{suffix};\n"));
        }
        statements.push_str(&format!("DROP TABLE IF EXISTS {fts};\n"));
    }
    for fts in rebuilt {
        statements.push_str(&baseline_block("table", fts));
        for suffix in ["ai", "au", "ad"] {
            statements.push_str(&baseline_block("trigger", &format!("{fts}_{suffix}")));
        }
    }
    // The four triggers of other indexes that also wrote `fts_social_message`,
    // in the baseline's own text.
    for writer in SOCIAL_WRITERS {
        statements.push_str(&format!("DROP TRIGGER IF EXISTS {writer};\n"));
        statements.push_str(&baseline_block("trigger", writer));
    }
    statements.push_str("PRAGMA user_version = 12;\nCOMMIT;\n");
    raw.execute_batch(&statements)
        .expect("the file is wound back to rung twelve");
}

/// The seven indexes rung thirteen retires (R2a). `fts_schedule_project` and
/// `fts_social_circle` are not among them: they serve containers (R5).
const RETIRED: [&str; 7] = [
    "fts_people_profile",
    "fts_core_place",
    "fts_knowledge_annotation",
    "fts_core_transaction",
    "fts_locker_item",
    "fts_social_thread",
    "fts_social_message",
];

/// The four indexes kept for containers as results of their own (Q-1097-2,
/// R5), each with a vocabulary of its own. Chat history is `chat_thread` and
/// `chat_message`, not the People messaging model `fts_social_*` indexed, so
/// the messaging pair is retired.
const CONTAINER_INDEXES: [&str; 4] = [
    "fts_core_collection",
    "fts_schedule_project",
    "fts_social_circle",
    "fts_core_concept",
];

/// The triggers of OTHER indexes that also wrote `fts_social_message`: a body's
/// text or a representation arriving re-indexes every note, document and
/// message that owns it. Rung thirteen creates them again without the message.
const SOCIAL_WRITERS: [&str; 4] = [
    "trg_fts_content_text_ai",
    "trg_fts_content_text_au",
    "trg_fts_representation_ai",
    "trg_fts_representation_au",
];

/// Every schema object an index leaves behind if it is not fully gone: its
/// table, the FTS5 shadow tables (`_data`, `_idx`, `_content`, `_docsize`,
/// `_config`) and its triggers, which are all named `<index>` or `<index>_…`.
fn remaining_objects(vault: &Vault, fts: &str) -> Vec<String> {
    vault
        .read(|connection| {
            let mut statement = connection.prepare(
                r"SELECT name FROM sqlite_master
                   WHERE name = ?1 OR name LIKE ?2 ESCAPE '\'
                   ORDER BY name",
            )?;
            let like = format!("{}\\_%", fts.replace('_', "\\_"));
            let names = statement
                .query_map([fts, &like], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(names)
        })
        .expect("the schema reads")
}

#[test]
fn a_vault_at_rung_twelve_climbs_to_thirteen_with_its_rows_backfilled() {
    let world = World::new("cov-rung");
    let calendar = world.calendar();
    let place = world.place("Lisbon Docks");
    let ravi = world.person("Ravi Menon", Some("Chotu"), Some("Cousin"));
    world.run(
        "people.edit_person",
        json!({ "party_id": ravi, "met": "at the Goa wedding" }),
    );
    world.channel(&ravi, "email", "ravi@example.org");
    world.run(
        "people.add_note",
        json!({ "party_id": ravi, "text": "loves kayaking" }),
    );
    world.interaction(&ravi, "lunch at Rao's");
    let trashed = world.person("Old Friend", Some("Zed"), None);
    world.run("people.trash_person", json!({ "party_id": trashed }));
    let event = world.event(&calendar, "Team offsite", Some(&place));
    let gone_event = world.event(&calendar, "Cancelled offsite", Some(&place));
    world.run("schedule.delete_event", json!({ "event_id": gone_event }));
    let project = world.id(
        "schedule.save_project",
        json!({ "name": "Kitchen refit" }),
        "project_id",
    );
    let task = world.task_in("Order tiles", Some(&project));
    let ana = world.friend("Ana");
    let group = world.group("Sitwell Road", &[&ana]);
    let expense = world.expense(
        "Hardware shop",
        "utilities",
        Some(&group),
        &ana,
        Some(("Paint", "Brushes")),
    );
    world.run(
        "tally.set_expense_memo",
        json!({ "expense_id": expense, "note": "the red folder" }),
    );
    let generic = world.expense("Dinner", "general", None, &ana, None);
    // Containers (R5): one of each, and an archived project and group that the
    // baseline indexed and the rebuilt index must not.
    let notebook = world.notebook("Reading list");
    let album = world.album("Goa trip");
    let folder = world.folder("Leases");
    let archived_project = world.project("Archived chores");
    world.execute_sql(
        "UPDATE schedule_project SET archived_at = '2099-01-01T00:00:00.000Z' WHERE project_id = ?1",
        &[&archived_project],
    );
    let mothballed = world.group("Mothballed flat", &[&ana]);
    world.run("tally.archive_group", json!({ "group_id": mothballed }));
    let circle = world.circle_of(&group);

    let path = world.vault().path().to_path_buf();
    wind_back_to_rung_twelve(&path);

    // THE REAL PATH: `Vault::open` sees rung twelve, snapshots, and climbs.
    let migrated = Vault::open(&path).expect("the file climbs rung thirteen");
    assert_eq!(migrated.schema_version(), centraid_vault::head_version());
    assert!(centraid_vault::head_version() >= 13);

    // Rows written before the rung are in the widened indexes.
    for (fts, column, word, found) in [
        ("fts_core_party", "nickname", "chotu", &ravi),
        ("fts_core_party", "role", "cousin", &ravi),
        ("fts_core_party", "met", "goa", &ravi),
        ("fts_core_party", "channels", "ravi@example.org", &ravi),
        ("fts_core_party", "memo", "kayaking", &ravi),
        // An interaction's note, logged before the rung, is backfilled too.
        ("fts_core_party", "memo", "lunch", &ravi),
        ("fts_core_event", "location", "lisbon", &event),
        ("fts_schedule_task", "project", "kitchen", &task),
        ("fts_tally_expense", "category", "utilities", &expense),
        ("fts_tally_expense", "group_name", "sitwell", &expense),
        ("fts_tally_expense", "items", "brushes", &expense),
        ("fts_tally_expense", "memo", "folder", &expense),
    ] {
        assert_eq!(
            hits(&migrated, fts, &col(column, word)),
            set([found]),
            "{fts}.{column} after the climb"
        );
    }
    // A trashed profile's text, a trashed event and a `general` category are
    // not backfilled either.
    assert_eq!(
        hits(&migrated, "fts_core_party", &col("nickname", "zed")),
        none()
    );
    assert_eq!(
        hits(&migrated, "fts_core_event", &col("location", "lisbon")),
        set([&event]),
        "the trashed event is not the one found"
    );
    assert_eq!(
        hits(&migrated, "fts_tally_expense", &col("category", "general")),
        none()
    );
    // And what the indexes already held by their base columns is still there.
    assert_eq!(
        hits(
            &migrated,
            "fts_tally_expense",
            &col("description", "dinner")
        ),
        set([&generic])
    );
    // The backfill equals what the base tables say, which is what the triggers
    // are held to as well.
    assert_indexes_match(&migrated);

    // The retired indexes are gone: the table, its FTS5 shadow tables and its
    // triggers. Seven were retired (R2a): five whose text is folded, and two
    // (Q-1097-1 (c)) that nothing read.
    for retired in RETIRED {
        assert_eq!(
            remaining_objects(&migrated, retired),
            Vec::<String>::new(),
            "{retired} is still in the file"
        );
    }
    // NO OBJECT AT ALL STILL NAMES A RETIRED INDEX: a trigger of another index
    // that inserted into one would fail the statement that fired it. The four
    // that did (`SOCIAL_WRITERS`) were created again without it.
    for retired in RETIRED {
        let naming: Vec<String> = migrated
            .read(|connection| {
                let mut statement = connection.prepare(
                    "SELECT name FROM sqlite_master WHERE instr(sql, ?1) > 0 ORDER BY name",
                )?;
                let names = statement
                    .query_map([retired], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(names)
            })
            .expect("the schema reads");
        assert_eq!(
            naming,
            Vec::<String>::new(),
            "an object still names {retired}"
        );
    }
    for writer in SOCIAL_WRITERS {
        assert_eq!(
            remaining_objects(&migrated, writer)
                .first()
                .map(String::as_str),
            Some(writer),
            "{writer} is gone"
        );
    }
    // Each container index is whole: the table, its five shadow tables, its
    // three triggers and its vocabulary (R5), and the circle's index and the
    // folder index have the triggers of the table they hang on besides.
    for kept in CONTAINER_INDEXES {
        let objects = remaining_objects(&migrated, kept);
        let from_children = match kept {
            "fts_social_circle" => 3,
            "fts_core_concept" => 1,
            _ => 0,
        };
        assert_eq!(
            objects.len(),
            1 + 5 + 3 + 1 + from_children,
            "{kept} lost objects at the climb: {objects:?}"
        );
    }
    // What the containers held before the rung is in them after it.
    for (fts, word, found) in [
        ("fts_core_collection", "reading", &notebook),
        ("fts_core_collection", "goa", &album),
        ("fts_schedule_project", "kitchen", &project),
        ("fts_social_circle", "sitwell", &circle),
        ("fts_core_concept", "leases", &folder),
    ] {
        assert_eq!(
            hits(&migrated, fts, &format!("\"{word}\"")),
            set([found]),
            "{fts} after the climb"
        );
    }
    // A project and a group archived before the rung are not backfilled.
    for (fts, word) in [
        ("fts_schedule_project", "archived"),
        ("fts_social_circle", "mothballed"),
    ] {
        assert_eq!(
            hits(&migrated, fts, &format!("\"{word}\"")),
            none(),
            "{fts}: `{word}` is archived"
        );
    }
    assert_containers_match(&migrated);
    // The triggers work on the migrated file as they do on a founded one.
    let registry = Registry::with_system_commands().expect("the registry builds");
    registry.install(&migrated).expect("the record installs");
    let outcome = migrated
        .execute(
            &registry,
            &Principal::owner("phone"),
            &Command::new(
                "people.edit_person",
                json!({ "party_id": ravi, "nickname": "Guddu" }),
            ),
        )
        .expect("the command answers");
    assert_eq!(
        outcome.status,
        CommandStatus::Executed,
        "{:?}",
        outcome.reason
    );
    assert_eq!(
        hits(&migrated, "fts_core_party", &col("nickname", "guddu")),
        set([&ravi])
    );
    assert_eq!(
        hits(&migrated, "fts_core_party", &col("nickname", "chotu")),
        none()
    );
}

#[test]
fn the_rung_climbs_over_a_file_that_already_has_its_objects() {
    // The suites wind a founded file back by pragma and climb again, so the
    // rung must run over its own objects: every DROP is IF EXISTS and every
    // CREATE follows its DROP.
    let world = World::new("cov-twice");
    let ravi = world.person("Ravi Menon", Some("Chotu"), None);
    world.channel(&ravi, "email", "ravi@example.org");
    let path = world.vault().path().to_path_buf();
    {
        let raw = Connection::open(&path).expect("the file opens");
        raw.execute_batch("PRAGMA user_version = 12;")
            .expect("the pragma is set");
    }
    let migrated = Vault::open(&path).expect("the file climbs rung thirteen again");
    assert_eq!(migrated.schema_version(), centraid_vault::head_version());
    assert_eq!(
        hits(&migrated, "fts_core_party", &col("nickname", "chotu")),
        set([&ravi])
    );
    assert_eq!(
        hits(
            &migrated,
            "fts_core_party",
            &col("channels", "ravi@example.org")
        ),
        set([&ravi])
    );
    assert_indexes_match(&migrated);
}

// ---------------------------------------------------------------------------
// 6. Containers (R5): a notebook, an album, a project, a group, a folder.
// ---------------------------------------------------------------------------

/// A phrase, so a word is looked up whole.
fn word(word: &str) -> String {
    format!("\"{word}\"")
}

#[test]
fn a_notebook_and_an_album_are_indexed_renamed_and_removed() {
    let world = World::new("cov-collections");
    let notebook = world.notebook("Reading list");
    let album = world.album("Goa trip");
    // A notebook inside a notebook is a notebook.
    let nested = world.id(
        "knowledge.create_notebook",
        json!({ "name": "Cookery", "parent_notebook_id": notebook }),
        "notebook_id",
    );
    for (query, found) in [
        ("reading", set([&notebook])),
        ("goa", set([&album])),
        ("cookery", set([&nested])),
    ] {
        assert_eq!(world.hits("fts_core_collection", &word(query)), found);
    }
    assert_containers_match(world.vault());

    // A RENAME MOVES THE HIT, for each kind.
    world.run(
        "knowledge.rename_notebook",
        json!({ "notebook_id": notebook, "name": "Novels" }),
    );
    world.run(
        "media.rename_album",
        json!({ "album_id": album, "title": "Lisbon trip" }),
    );
    assert_eq!(world.hits("fts_core_collection", &word("reading")), none());
    assert_eq!(world.hits("fts_core_collection", &word("goa")), none());
    assert_eq!(
        world.hits("fts_core_collection", &word("novels")),
        set([&notebook])
    );
    assert_eq!(
        world.hits("fts_core_collection", &word("lisbon")),
        set([&album])
    );
    assert_containers_match(world.vault());

    // A DELETE IS A HARD DELETE and the hit goes with the row.
    world.run(
        "knowledge.delete_notebook",
        json!({ "notebook_id": nested }),
    );
    world.run(
        "knowledge.delete_notebook",
        json!({ "notebook_id": notebook }),
    );
    world.run("media.delete_album", json!({ "album_id": album }));
    for query in ["novels", "lisbon", "cookery"] {
        assert_eq!(world.hits("fts_core_collection", &word(query)), none());
    }
    assert_containers_match(world.vault());
}

#[test]
fn a_project_is_indexed_while_it_is_not_archived_and_a_rename_moves_the_hit() {
    let world = World::new("cov-projects");
    let project = world.project("Kitchen refit");
    assert_eq!(
        world.hits("fts_schedule_project", &word("kitchen")),
        set([&project])
    );

    // A RENAME is an upsert on the same id.
    world.run(
        "schedule.save_project",
        json!({ "project_id": project, "name": "Bathroom refit" }),
    );
    assert_eq!(world.hits("fts_schedule_project", &word("kitchen")), none());
    assert_eq!(
        world.hits("fts_schedule_project", &word("bathroom")),
        set([&project])
    );
    assert_containers_match(world.vault());

    // ARCHIVED IS NOT FOUND, and restoring it is found again. No command writes
    // `archived_at` yet, so the fixture does (the column and the read filter
    // exist; the door must already honour it).
    world.execute_sql(
        "UPDATE schedule_project SET archived_at = '2099-01-01T00:00:00.000Z' WHERE project_id = ?1",
        &[&project],
    );
    assert_eq!(
        world.hits("fts_schedule_project", &word("bathroom")),
        none()
    );
    assert_containers_match(world.vault());
    world.execute_sql(
        "UPDATE schedule_project SET archived_at = NULL WHERE project_id = ?1",
        &[&project],
    );
    assert_eq!(
        world.hits("fts_schedule_project", &word("bathroom")),
        set([&project])
    );

    // A project made already archived is never in; a delete takes it out.
    let born_archived = world.id(
        "schedule.save_project",
        json!({ "name": "Shelved chores" }),
        "project_id",
    );
    world.execute_sql(
        "UPDATE schedule_project SET archived_at = '2099-01-01T00:00:00.000Z' WHERE project_id = ?1",
        &[&born_archived],
    );
    assert_eq!(world.hits("fts_schedule_project", &word("shelved")), none());
    world.execute_sql(
        "DELETE FROM schedule_project WHERE project_id = ?1",
        &[&project],
    );
    assert_eq!(
        world.hits("fts_schedule_project", &word("bathroom")),
        none()
    );
    assert_containers_match(world.vault());
}

#[test]
fn a_circle_is_indexed_only_while_a_live_tally_group_stands_on_it() {
    let world = World::new("cov-circles");
    let ana = world.friend("Ana");
    let group = world.group("Sitwell Road", &[&ana]);
    let circle = world.circle_of(&group);
    assert_eq!(
        world.hits("fts_social_circle", &word("sitwell")),
        set([&circle])
    );

    // A RENAME is on the circle.
    world.run(
        "tally.rename_group",
        json!({ "group_id": group, "name": "Elm Street" }),
    );
    assert_eq!(world.hits("fts_social_circle", &word("sitwell")), none());
    assert_eq!(
        world.hits("fts_social_circle", &word("elm")),
        set([&circle])
    );
    assert_containers_match(world.vault());

    // ARCHIVED IS NOT FOUND, and un-archiving finds it again.
    world.run("tally.archive_group", json!({ "group_id": group }));
    assert_eq!(world.hits("fts_social_circle", &word("elm")), none());
    assert_containers_match(world.vault());
    world.run(
        "tally.archive_group",
        json!({ "group_id": group, "archived": false }),
    );
    assert_eq!(
        world.hits("fts_social_circle", &word("elm")),
        set([&circle])
    );

    // A CIRCLE NO GROUP STANDS ON is no result, whoever made it: People has no
    // circles screen. Giving it a group later makes it one, and a group moved
    // onto another circle takes the hit with it.
    let owner = world.owner.clone();
    world.execute_sql(
        "INSERT INTO social_circle (circle_id, owner_party_id, name, kind)
         VALUES ('circle-bare', ?1, 'Bare circle', 'friends'),
                ('circle-spare', ?1, 'Spare circle', 'custom')",
        &[&owner],
    );
    assert_eq!(world.hits("fts_social_circle", &word("bare")), none());
    world.execute_sql(
        "INSERT INTO tally_group (group_id, circle_id, icon, color, currency, created_at)
         VALUES ('group-bare', 'circle-bare', 'x', 'blue', 'GBP', '2099-01-01T00:00:00.000Z')",
        &[],
    );
    assert_eq!(
        world.hits("fts_social_circle", &word("bare")),
        set([&"circle-bare".to_owned()])
    );
    world.execute_sql(
        "UPDATE tally_group SET circle_id = 'circle-spare' WHERE group_id = 'group-bare'",
        &[],
    );
    assert_eq!(world.hits("fts_social_circle", &word("bare")), none());
    assert_eq!(
        world.hits("fts_social_circle", &word("spare")),
        set([&"circle-spare".to_owned()])
    );
    assert_containers_match(world.vault());

    // A DELETE takes the group and then the circle; the hit is gone.
    world.run("tally.delete_group", json!({ "group_id": group }));
    assert_eq!(world.hits("fts_social_circle", &word("elm")), none());
    assert_containers_match(world.vault());
}

#[test]
fn a_folder_is_indexed_and_the_root_a_tag_and_another_scheme_never_are() {
    let world = World::new("cov-folders");
    let leases = world.folder("Leases");
    assert_eq!(
        world.hits("fts_core_concept", &word("leases")),
        set([&leases])
    );
    // THE ROOT is a concept of the folders scheme and is not a result: its label
    // is `Documents`, and it exists now that a folder was made.
    assert_eq!(
        world.count(
            "SELECT COUNT(*) FROM core_concept WHERE notation = 'root' AND pref_label = 'Documents'"
        ),
        1
    );
    assert_eq!(world.hits("fts_core_concept", &word("documents")), none());

    // A TAG is a concept too, of another scheme, with a label of its own.
    world.execute_sql(
        "INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
         VALUES ('scheme-tags', 'https://centraid.dev/schemes/tags', 'Tags', '1')",
        &[],
    );
    world.execute_sql(
        "INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label)
         VALUES ('tag-urgent', 'scheme-tags', 'urgent', 'Urgent leases')",
        &[],
    );
    assert_eq!(
        world.hits("fts_core_concept", &word("urgent")),
        none(),
        "a tag is no folder"
    );
    assert_eq!(
        world.hits("fts_core_concept", &word("leases")),
        set([&leases]),
        "only the folder holds the word"
    );

    // A RENAME moves the hit; a nested folder is a folder.
    world.run(
        "core.rename_folder",
        json!({ "folder_id": leases, "name": "Contracts" }),
    );
    assert_eq!(world.hits("fts_core_concept", &word("leases")), none());
    assert_eq!(
        world.hits("fts_core_concept", &word("contracts")),
        set([&leases])
    );
    let nested = world.id(
        "core.create_folder",
        json!({ "name": "Signed", "parent_folder_id": leases }),
        "folder_id",
    );
    assert_eq!(
        world.hits("fts_core_concept", &word("signed")),
        set([&nested])
    );
    assert_containers_match(world.vault());

    // MOVING A CONCEPT OUT OF THE SCHEME, or the scheme off its URI, takes the
    // folder out of the index, and back in puts it back.
    world.execute_sql(
        "UPDATE core_concept SET scheme_id = 'scheme-tags', notation = 'moved'
          WHERE concept_id = ?1",
        &[&nested],
    );
    assert_eq!(world.hits("fts_core_concept", &word("signed")), none());
    assert_containers_match(world.vault());
    world.execute_sql(
        "UPDATE core_concept_scheme SET uri = 'https://centraid.dev/schemes/folders-moved'
          WHERE uri = 'https://centraid.dev/schemes/folders'",
        &[],
    );
    assert_eq!(world.hits("fts_core_concept", &word("contracts")), none());
    assert_containers_match(world.vault());
    world.execute_sql(
        "UPDATE core_concept_scheme SET uri = 'https://centraid.dev/schemes/folders'
          WHERE uri = 'https://centraid.dev/schemes/folders-moved'",
        &[],
    );
    assert_eq!(
        world.hits("fts_core_concept", &word("contracts")),
        set([&leases])
    );
    assert_eq!(world.hits("fts_core_concept", &word("documents")), none());

    // A DELETE takes the hit (the subfolder that was moved out leaves first, or
    // the folder is not empty).
    world.execute_sql("DELETE FROM core_concept WHERE concept_id = ?1", &[&nested]);
    world.run("core.delete_folder", json!({ "folder_id": leases }));
    assert_eq!(world.hits("fts_core_concept", &word("contracts")), none());
    assert_containers_match(world.vault());
}

#[test]
fn every_container_vocabulary_answers_term_and_doc_for_a_planted_word() {
    let world = World::new("cov-container-vocab");
    let ana = world.friend("Ana");
    world.notebook("Quokka notebook");
    world.project("Quokka project");
    world.group("Quokka group", &[&ana]);
    world.folder("Quokka folder");
    for container in CONTAINER_INDEXES {
        let vocab = format!("{container}_vocab");
        let (docs, total): (i64, i64) = world
            .vault()
            .read(|connection| {
                Ok(connection.query_row(
                    &format!("SELECT doc, cnt FROM {vocab} WHERE term = 'quokka'"),
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?)
            })
            .unwrap_or_else(|error| panic!("{vocab} does not answer `quokka`: {error}"));
        assert_eq!(
            (docs, total),
            (1, 1),
            "{vocab}: one container holds it once"
        );
        assert_eq!(
            world.count(&format!(
                "SELECT COUNT(*) FROM {vocab} WHERE term = 'nosuchword'"
            )),
            0
        );
    }
    // A DELETED container leaves its words: a vocabulary offers nothing the
    // member can no longer find.
    world.run(
        "core.delete_folder",
        json!({ "folder_id": world.id(
        "core.create_folder",
        json!({ "name": "Wombat" }),
        "folder_id",
    ) }),
    );
    assert_eq!(
        world.count("SELECT COUNT(*) FROM fts_core_concept_vocab WHERE term = 'wombat'"),
        0
    );
    assert_containers_match(world.vault());
}

/// THE WEIGHTS ARE NOT IN A CONTAINER INDEX EITHER (R1d, R5), and the sealed-column
/// scan above (`no_sealed_column_appears_in_any_fts_object_at_the_ladder_head`)
/// reads every `fts_*` object, the four containers' included.
#[test]
fn no_container_index_stores_a_rank_override() {
    let world = World::new("cov-container-rank");
    for fts in CONTAINER_INDEXES {
        assert_eq!(
            world.count(&format!(
                "SELECT COUNT(*) FROM {fts}_config WHERE k = 'rank'"
            )),
            0,
            "{fts} stores a rank, so a replayed vault would order differently"
        );
    }
}
