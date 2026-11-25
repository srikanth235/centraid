//! The follow engine, proved with maps of the tests' own: the product's `SYSTEMS` is empty until
//! each app lane re-plugs its map (`crates/vault/UNPLUGGED.md`), and a map says only which fields
//! of a kind a system states. What a system fills, retires, names or yields is the file's
//! (`origin_system`, `source_shape`), which is what these tests read it through.
//!
//! Three maps, one per shape the engine has to serve, each over a table a test can fill by raw SQL
//! (no app module): the phone's **contacts** (a person with no home, with a list field the
//! member edits item by item), a picked folder's **files** (a document in a home it fills, bytes it
//! claims) and the **camera roll** (a photo, which the vault keeps whatever the phone deletes).

use rusqlite::types::Value as Sql;
use serde_json::{Value as Json, json};

use centraid_vault::commands::follow::{
    Child, Gone, Maps, Match, OriginRow, SystemMap, definitions_for,
};
use centraid_vault::commands::{CommandCtx, Registry, entity};
use centraid_vault::model::Kind;
use centraid_vault::{Command, CommandOutcome, CommandStatus, Principal, Vault};

use super::Scratch;

fn no_defaults(
    _: &rusqlite::Connection,
    _: &OriginRow,
) -> centraid_vault::Result<Vec<(&'static str, Sql)>> {
    Ok(Vec::new())
}

fn as_stated(_: &CommandCtx<'_, '_>, _: &mut serde_json::Map<String, Json>) -> Result<(), String> {
    Ok(())
}

fn nothing_to_settle(_: &CommandCtx<'_, '_>, _: &str) -> centraid_vault::Result<()> {
    Ok(())
}

fn a_file_defaults(
    _: &rusqlite::Connection,
    _: &OriginRow,
) -> centraid_vault::Result<Vec<(&'static str, Sql)>> {
    Ok(vec![("media_type", Sql::Text("text/plain".to_owned()))])
}

fn a_line_defaults(
    _: &rusqlite::Connection,
    origin: &OriginRow,
) -> centraid_vault::Result<Vec<(&'static str, Sql)>> {
    Ok(vec![(
        "account_id",
        Sql::Text(
            origin
                .fills
                .clone()
                .expect("a statement is imported into an account"),
        ),
    )])
}

fn a_photo_defaults(
    _: &rusqlite::Connection,
    _: &OriginRow,
) -> centraid_vault::Result<Vec<(&'static str, Sql)>> {
    Ok(vec![
        ("media_type", Sql::Text("image/jpeg".to_owned())),
        ("form", Sql::Text("photo".to_owned())),
    ])
}

// ---------------------------------------------------------------------------------------------
// A list field: a person's labels, kept in `person.nickname` as `a|b|c`
// ---------------------------------------------------------------------------------------------

fn labels_of(text: Option<&str>) -> Vec<String> {
    text.unwrap_or_default()
        .split('|')
        .filter(|label| !label.is_empty())
        .map(str::to_owned)
        .collect()
}

fn read_labels(connection: &rusqlite::Connection, id: &str) -> centraid_vault::Result<Json> {
    let text: Option<String> =
        connection.query_row("SELECT nickname FROM person WHERE id = ?1", [id], |row| {
            row.get(0)
        })?;
    Ok(json!(labels_of(text.as_deref())))
}

fn canon_labels(value: &Json) -> Json {
    let mut labels: Vec<String> = value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|label| label.as_str().map(str::to_owned))
        .collect();
    labels.sort();
    labels.dedup();
    json!(labels)
}

fn label_items(value: &Json) -> std::collections::BTreeMap<String, Json> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|label| Some((label.as_str()?.to_owned(), label.clone())))
        .collect()
}

fn write_labels(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    labels: &[String],
) -> centraid_vault::Result<()> {
    ctx.connection().execute(
        "UPDATE person SET nickname = ?2 WHERE id = ?1",
        rusqlite::params![id, labels.join("|")],
    )?;
    Ok(())
}

/// Per item: a label the member did not change takes the source's word, including its removal;
/// one the member added stays, one the member removed stays removed.
fn merge_labels(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    before: Option<&Json>,
    now: &Json,
) -> centraid_vault::Result<bool> {
    let held = labels_of(
        ctx.connection()
            .query_row("SELECT nickname FROM person WHERE id = ?1", [id], |row| {
                row.get::<_, Option<String>>(0)
            })?
            .as_deref(),
    );
    let (before, now) = (
        label_items(&canon_labels(before.unwrap_or(&json!([])))),
        label_items(&canon_labels(now)),
    );
    let mut next = held.clone();
    for label in before.keys().filter(|label| !now.contains_key(*label)) {
        next.retain(|held| held != label);
    }
    for label in now.keys().filter(|label| !before.contains_key(*label)) {
        if !next.contains(label) {
            next.push(label.clone());
        }
    }
    let changed = next != held;
    if changed {
        write_labels(ctx, id, &next)?;
    }
    Ok(changed)
}

fn take_labels(
    ctx: &CommandCtx<'_, '_>,
    id: &str,
    item: Option<&str>,
    stated: &Json,
) -> centraid_vault::Result<bool> {
    let stated = label_items(&canon_labels(stated));
    let held = labels_of(
        ctx.connection()
            .query_row("SELECT nickname FROM person WHERE id = ?1", [id], |row| {
                row.get::<_, Option<String>>(0)
            })?
            .as_deref(),
    );
    let next: Vec<String> = match item {
        None => stated.keys().cloned().collect(),
        Some(item) => {
            let mut next = held.clone();
            next.retain(|label| label != item);
            if stated.contains_key(item) {
                next.push(item.to_owned());
            }
            next
        }
    };
    let changed = next != held;
    if changed {
        write_labels(ctx, id, &next)?;
    }
    Ok(changed)
}

// ---------------------------------------------------------------------------------------------
// The maps
// ---------------------------------------------------------------------------------------------

pub const CONTACTS: &str = "follow.test_contacts";
pub const FILES: &str = "follow.test_files";
pub const ROLL: &str = "follow.test_roll";
/// A map for a system the file does not know.
pub const STATEMENT: &str = "follow.test_statement";
pub const TELEPATHY: &str = "follow.test_telepathy";
/// A map for a kind its system does not yield (`files` yields a document, not a person).
pub const FILES_AS_PEOPLE: &str = "follow.test_files_as_people";

pub struct TestMaps;

impl Maps for TestMaps {
    const MAPS: &'static [SystemMap] = &[
        SystemMap {
            system: "contacts",
            command: CONTACTS,
            kind: Kind::Person,
            claims: None,
            fields: &["given", "family", "org"],
            fixed: &[],
            children: &[Child {
                name: "labels",
                read: read_labels,
                canon: canon_labels,
                merge: merge_labels,
                items: Some(label_items),
                take: take_labels,
                stamp: None,
            }],
            match_on: &[Match::Title],
            gone: Gone::Trash,
            window: None,
            defaults: no_defaults,
            founds: None,
            shape: as_stated,
            settle: nothing_to_settle,
            named: nothing_to_settle,
        },
        SystemMap {
            system: "files",
            command: FILES,
            kind: Kind::Document,
            claims: Some("blob"),
            fields: &["blob", "media_type"],
            fixed: &[],
            children: &[],
            match_on: &[Match::Title],
            gone: Gone::Trash,
            window: None,
            defaults: a_file_defaults,
            founds: None,
            shape: as_stated,
            settle: nothing_to_settle,
            named: nothing_to_settle,
        },
        SystemMap {
            system: "camera_roll",
            command: ROLL,
            kind: Kind::Photo,
            claims: Some("blob"),
            fields: &["blob"],
            fixed: &["blob"],
            children: &[],
            match_on: &[],
            gone: Gone::Forget,
            window: None,
            defaults: a_photo_defaults,
            founds: None,
            shape: as_stated,
            settle: nothing_to_settle,
            named: nothing_to_settle,
        },
        SystemMap {
            system: "statement",
            command: STATEMENT,
            kind: Kind::Txn,
            claims: None,
            fields: &["posted_on", "amount_minor"],
            fixed: &["title", "posted_on", "amount_minor"],
            children: &[],
            match_on: &[],
            gone: Gone::Keep,
            window: None,
            defaults: a_line_defaults,
            founds: None,
            shape: as_stated,
            settle: nothing_to_settle,
            named: nothing_to_settle,
        },
        SystemMap {
            system: "telepathy",
            command: TELEPATHY,
            kind: Kind::Person,
            claims: None,
            fields: &[],
            fixed: &[],
            children: &[],
            match_on: &[],
            gone: Gone::Keep,
            window: None,
            defaults: no_defaults,
            founds: None,
            shape: as_stated,
            settle: nothing_to_settle,
            named: nothing_to_settle,
        },
        SystemMap {
            system: "files",
            command: FILES_AS_PEOPLE,
            kind: Kind::Person,
            claims: None,
            fields: &[],
            fixed: &[],
            children: &[],
            match_on: &[],
            gone: Gone::Keep,
            window: None,
            defaults: no_defaults,
            founds: None,
            shape: as_stated,
            settle: nothing_to_settle,
            named: nothing_to_settle,
        },
    ];
}

/// A hash for a file's bytes: 64 lowercase hex characters, by one letter.
#[must_use]
pub fn hash(letter: char) -> String {
    std::iter::repeat_n(letter, 64).collect()
}

/// A founded vault with the follow commands of [`TestMaps`] and the shared entity verbs.
pub struct Follow {
    pub scratch: Scratch,
    pub registry: Registry,
}

impl Follow {
    #[must_use]
    pub fn new(seed: &str) -> Self {
        let mut registry = Registry::new();
        for definition in entity::definitions()
            .into_iter()
            .chain(definitions_for::<TestMaps>())
        {
            registry.register(definition).expect("a definition");
        }
        Self {
            scratch: Scratch::founded(seed).expect("a vault"),
            registry,
        }
    }

    #[must_use]
    pub const fn vault(&self) -> &Vault {
        &self.scratch.vault
    }

    /// Run a command; the clock moves a second first, so every pass has its own instant.
    pub fn run(&self, name: &str, input: Json) -> CommandOutcome {
        self.scratch.clock.advance_ms(1_000);
        self.vault()
            .execute(
                &self.registry,
                &Principal::owner("phone"),
                &Command::new(name, input),
            )
            .unwrap_or_else(|error| panic!("`{name}`: {error}"))
    }

    /// The same, answering whatever the vault answered, a refused write included.
    pub fn try_run(&self, name: &str, input: Json) -> centraid_vault::Result<CommandOutcome> {
        self.scratch.clock.advance_ms(1_000);
        self.vault().execute(
            &self.registry,
            &Principal::owner("phone"),
            &Command::new(name, input),
        )
    }

    pub fn ok(&self, name: &str, input: Json) -> Json {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Executed,
            "{name}: {:?}",
            outcome.reason
        );
        outcome.output
    }

    pub fn refused(&self, name: &str, input: Json) -> String {
        let outcome = self.run(name, input);
        assert_eq!(
            outcome.status,
            CommandStatus::Failed,
            "{name} was not refused"
        );
        outcome.reason.expect("a sentence")
    }

    /// One pass of `command`: the origin, the records `(external id, fields)`, and whether the
    /// read was complete.
    pub fn pass(
        &self,
        command: &str,
        origin: Json,
        records: &[(&str, Json)],
        complete: bool,
    ) -> Json {
        self.ok(command, self.pass_input(origin, records, complete))
    }

    #[must_use]
    pub fn pass_input(&self, origin: Json, records: &[(&str, Json)], complete: bool) -> Json {
        // A record is read on the install the origin names, and says so; bytes it names are
        // counted by the phone (three of them here).
        let device = origin.get("device_id").cloned().unwrap_or(Json::Null);
        json!({
            "origin": origin,
            "records": records.iter().map(|(id, fields)| json!({
                "external_id": id,
                "device_id": device,
                "size": fields.get("blob").map(|_| 3),
                "fields": fields,
            })).collect::<Vec<_>>(),
            "complete": complete,
        })
    }

    pub fn one<T: rusqlite::types::FromSql>(&self, sql: &str, params: &[&str]) -> T {
        self.vault()
            .read(|connection| {
                Ok(connection
                    .query_row(sql, rusqlite::params_from_iter(params), |row| row.get(0))?)
            })
            .unwrap_or_else(|error| panic!("{sql}: {error}"))
    }

    pub fn maybe<T: rusqlite::types::FromSql>(&self, sql: &str, params: &[&str]) -> Option<T> {
        self.vault()
            .read(|connection| {
                Ok(connection
                    .query_row(sql, rusqlite::params_from_iter(params), |row| {
                        row.get::<_, Option<T>>(0)
                    })
                    .ok()
                    .flatten())
            })
            .unwrap_or_else(|error| panic!("{sql}: {error}"))
    }

    pub fn count(&self, sql: &str, params: &[&str]) -> i64 {
        self.one::<i64>(sql, params)
    }

    /// Raw SQL in one commit, as the member's own hand.
    pub fn raw(&self, sql: &str) {
        self.vault()
            .commit(|tx| {
                tx.connection().execute_batch(sql)?;
                Ok(())
            })
            .unwrap_or_else(|error| panic!("{sql}: {error}"));
    }

    /// Raw SQL the database may refuse.
    pub fn raw_result(&self, sql: &str) -> Result<(), String> {
        self.vault()
            .commit(|tx| {
                tx.connection().execute_batch(sql)?;
                Ok(())
            })
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    /// An account to import a statement into.
    pub fn account(&self) -> String {
        let id = self.vault().ids().next();
        let now = self.vault().clock().now_text();
        self.vault()
            .commit(|tx| {
                tx.insert_entity(&id, Kind::Account, "Everyday", &now)?;
                tx.connection().execute(
                    "INSERT INTO account (id, type, currency) VALUES (?1, 'checking', 'USD')",
                    [&id],
                )?;
                Ok(())
            })
            .expect("an account");
        id
    }

    /// A container of `kind` (a notebook, a folder, an album...), made the way the member's own
    /// commands make one.
    pub fn container(&self, kind: Kind, title: &str) -> String {
        let id = self.vault().ids().next();
        let now = self.vault().clock().now_text();
        self.vault()
            .commit(|tx| {
                tx.insert_entity(&id, kind, title, &now)?;
                tx.connection().execute(
                    "INSERT INTO container (id, kind) VALUES (?1, ?2)",
                    [id.as_str(), kind.as_str()],
                )?;
                Ok(())
            })
            .expect("a container");
        id
    }

    /// The id of the one entity of `kind` titled `title`.
    pub fn by_title(&self, kind: &str, title: &str) -> String {
        self.one(
            "SELECT id FROM entity WHERE kind = ?1 AND title = ?2",
            &[kind, title],
        )
    }

    /// Whether the entity is in the trash.
    pub fn trashed(&self, id: &str) -> bool {
        self.one::<bool>(
            "SELECT deleted_at IS NOT NULL FROM entity WHERE id = ?1",
            &[id],
        )
    }
}

/// A contacts read: the origin of phone `device` named `ref`.
#[must_use]
pub fn contacts_origin(reference: &str, device: &str) -> Json {
    json!({ "ref": reference, "label": reference, "device_id": device })
}
