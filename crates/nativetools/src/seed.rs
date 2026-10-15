//! WORLD SEEDING: a JSON world description written into a fresh vault through
//! the real typed commands, deterministically. The Eval and Data steps seed
//! with this and never write SQL.
//!
//! ```json
//! {
//!   "me": "Sam Park", "epoch": "2026-01-05T09:00", "seed": "w1", "currency": "EUR",
//!   "people":    [{"key":"neha","name":"Neha Rao","role":"…","nickname":"…","met":"…",
//!                  "cadence":30,"starred":true,"last_contacted":"2026-09-01T10:00",
//!                  "last_contacted_kind":"call"}],
//!   "lists":     [{"key":"home","name":"Home","area":"…"}],
//!   "events":    [{"key":"dentist","name":"Dentist","start":"2026-10-02T09:00",
//!                  "end":"2026-10-02T10:00","description":"…","attendees":["neha"],
//!                  "cancelled":true}],
//!   "tasks":     [{"key":"cabin","name":"Book the cabin","due":"2026-06-19T09:00",
//!                  "status":"open","effort":30,"priority":2,"description":"…",
//!                  "parent":"key","list":"home","completed":"2026-06-01T10:00"}],
//!   "notebooks": [{"key":"recipes","name":"Recipes"}],
//!   "notes":     [{"key":"dal","name":"Dal","body":"…","notebook":"recipes","pinned":true}],
//!   "folders":   [{"key":"taxes","name":"Taxes"}],
//!   "documents": [{"key":"w2","name":"W2 2025","text":"…","folder":"taxes","starred":true}],
//!   "albums":    [{"key":"summer","name":"Summer"}],
//!   "photos":    [{"key":"beach","name":"Beach","taken":"2026-07-01T10:00",
//!                  "albums":["summer"],"people":["neha"],"starred":true}],
//!   "locker":    [{"key":"bank","name":"Bank","type":"login","username":"…",
//!                  "url":"…","notes":"…","password":"…","starred":true}],
//!   "accounts":  [{"key":"checking","name":"Everyday","kind":"checking","currency":"USD"}],
//!   "transactions": [{"key":"coffee","account":"checking","date":"2026-09-30","amount":-4.5,
//!                  "name":"Blue Bottle","description":"BLUE BOTTLE #12","category":"food.dining",
//!                  "void":true}],
//!   "links":     [{"from":"cabin","to":"neha"}]
//! }
//! ```
//!
//! `currency` is the vault's default (base) currency, set at founding; USD
//! when absent. A transaction's `amount` is signed in currency units (money out is negative), its
//! `category` is a Money category notation and `void` is a member's void (#1099); they go in through
//! `money.import_transactions`. Every row may carry `created` (the clock at its create command),
//! `modified` (a later same-value edit that stamps `updated_at`) and `trashed`
//! (`true` or a time). Keys are unique across the world; `me` is the owner.
//! Times are `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`, floating (no zone).
//! A top-level key that is none of the above is an error (`groups`, `expenses` and `debts` were Tally's: #1115).

use std::collections::BTreeMap;
use std::path::Path;

use base64::Engine as _;
use serde_json::{Map, Value, json};

use crate::dates::Stamp;
use crate::meta::Kind;
use crate::vaultio::{Handle, SetClock, millis_of};

struct Seeder {
    handle: Handle,
    keys: BTreeMap<String, (Kind, String)>,
    cursor: i64,
    locker: Option<(String, Vec<u8>)>,
    /// `key.field` of every world value the vault cannot hold.
    dropped: Vec<String>,
}

fn at(text: &str) -> Result<i64, String> {
    let stamp =
        Stamp::parse(text).ok_or_else(|| format!("\"{text}\" is not YYYY-MM-DD[THH:MM]"))?;
    Ok(millis_of(stamp.at()))
}

fn str_of<'a>(row: &'a Value, key: &str) -> Option<&'a str> {
    row.get(key)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty())
}

fn rows<'a>(world: &'a Value, key: &str) -> &'a [Value] {
    world
        .get(key)
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn vault_time(text: &str) -> Result<String, String> {
    Stamp::parse(text)
        .map(Stamp::vault)
        .ok_or_else(|| format!("\"{text}\" is not YYYY-MM-DD[THH:MM]"))
}

impl Seeder {
    /// Set the clock to a row's `created`, or step it a minute.
    fn clock_for(&mut self, row: &Value, field: &str) -> Result<(), String> {
        match str_of(row, field) {
            Some(text) => self.handle.clock.set(at(text)?),
            None => {
                self.cursor += 60_000;
                self.handle.clock.set(self.cursor);
            }
        }
        Ok(())
    }

    fn mint(&self) -> String {
        centraid_vault::Ids::next(self.handle.vault.ids())
    }

    fn key(&mut self, row: &Value, kind: Kind, id: String) -> Result<(), String> {
        let key = str_of(row, "key")
            .ok_or_else(|| format!("every {} needs a key: {row}", kind.name()))?
            .to_owned();
        if self.keys.insert(key.clone(), (kind, id)).is_some() {
            return Err(format!("the key \"{key}\" is used twice"));
        }
        Ok(())
    }

    fn id(&self, key: &str, kind: Kind) -> Result<String, String> {
        match self.keys.get(key) {
            Some((found, id)) if *found == kind => Ok(id.clone()),
            Some((found, _)) => Err(format!(
                "\"{key}\" is a {}, not a {}",
                found.name(),
                kind.name()
            )),
            None => Err(format!("no {} has the key \"{key}\"", kind.name())),
        }
    }

    fn run(&self, command: &str, input: Value) -> Result<Value, String> {
        self.handle.must(command, input)
    }

    /// At `field`'s time (or the next minute), run a command.
    fn at_then(
        &mut self,
        row: &Value,
        field: &str,
        command: &str,
        input: Value,
    ) -> Result<Value, String> {
        if let Some(text) = str_of(row, field) {
            self.handle.clock.set(at(text)?);
        } else {
            self.cursor += 60_000;
            self.handle
                .clock
                .set(self.cursor.max(self.handle.clock.get()));
        }
        self.run(command, input)
    }
}

/// The top-level keys a world may carry: the scalars and the sections [`seed_report`] reads. `today` is the
/// day the sessions on the world run; the Python tools read it and the seeder does not.
const SECTIONS: &[&str] = &[
    "me",
    "epoch",
    "seed",
    "currency",
    "today",
    "people",
    "lists",
    "events",
    "tasks",
    "notebooks",
    "notes",
    "folders",
    "documents",
    "albums",
    "photos",
    "locker",
    "accounts",
    "transactions",
    "links",
];

/// A section the seeder does not read is an error, never a silent drop: a world that still names a kind
/// the runtime no longer has (`groups`, `expenses`, `debts` after Tally, #1099) would otherwise seed
/// without it and pass for a household that never held it (#1115).
fn reject_unknown_sections(world: &Value) -> Result<(), String> {
    let Some(object) = world.as_object() else {
        return Err("a world is a JSON object".to_owned());
    };
    let unknown: Vec<&str> = object
        .keys()
        .map(String::as_str)
        .filter(|key| !SECTIONS.contains(key))
        .collect();
    if unknown.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "the world has sections the seeder does not read: {} (known: {})",
            unknown.join(", "),
            SECTIONS.join(", ")
        ))
    }
}

/// Seed `world` into a fresh vault at `path`. Returns every key's kind and id.
pub fn seed(world: &Value, path: &Path) -> Result<Value, String> {
    seed_report(world, path).map(|(keys, _)| keys)
}

/// [`seed`], plus the `key.field` values the vault could not hold (a locker
/// field its type does not keep).
pub fn seed_report(world: &Value, path: &Path) -> Result<(Value, Vec<String>), String> {
    reject_unknown_sections(world)?;
    let me = str_of(world, "me").unwrap_or("Me");
    let epoch = at(str_of(world, "epoch").unwrap_or("2026-01-01T09:00"))?;
    let clock = SetClock::at(epoch);
    let seed = format!("nativetools:seed:{}", str_of(world, "seed").unwrap_or("0"));
    // THE VAULT'S DEFAULT CURRENCY, set once at founding.
    let currency = str_of(world, "currency").unwrap_or("USD").to_uppercase();
    if currency.len() != 3 || !currency.chars().all(|c| c.is_ascii_alphabetic()) {
        return Err(format!(
            "currency is a three-letter ISO code, not \"{currency}\""
        ));
    }
    let handle = Handle::create_in(path, clock, &seed, me, &currency)?;
    let founded = crate::world::World::load(&handle)?;
    let mut seeder = Seeder {
        handle,
        keys: BTreeMap::new(),
        cursor: epoch,
        locker: None,
        dropped: Vec::new(),
    };
    seeder
        .keys
        .insert("me".to_owned(), (Kind::Person, founded.me.clone()));
    let calendar = founded.calendar.clone();

    for row in rows(world, "people") {
        seeder.clock_for(row, "created")?;
        let mut input = json!({
            "display_name": str_of(row, "name").ok_or("a person needs a name")?,
            "cadence_days": row.get("cadence").and_then(Value::as_i64).unwrap_or(0),
        });
        for field in ["role", "nickname"] {
            if let Some(value) = str_of(row, field) {
                input[field] = json!(value);
            }
        }
        let out = seeder.run("people.add_person", input)?;
        let id = out["party_id"].as_str().unwrap_or_default().to_owned();
        seeder.key(row, Kind::Person, id.clone())?;
        if let Some(met) = str_of(row, "met") {
            seeder.run("people.edit_person", json!({"party_id": id, "met": met}))?;
        }
    }
    for row in rows(world, "lists") {
        seeder.clock_for(row, "created")?;
        let id = seeder.mint();
        let mut input =
            json!({"project_id": id, "name": str_of(row, "name").ok_or("a list needs a name")?});
        if let Some(area) = str_of(row, "area") {
            input["area"] = json!(area);
        }
        seeder.run("schedule.save_project", input)?;
        seeder.key(row, Kind::List, id)?;
    }
    for row in rows(world, "notebooks") {
        seeder.clock_for(row, "created")?;
        let id = seeder.mint();
        seeder.run(
            "knowledge.create_notebook",
            json!({"notebook_id": id, "name": str_of(row, "name").ok_or("a notebook needs a name")?}),
        )?;
        seeder.key(row, Kind::Notebook, id)?;
    }
    for row in rows(world, "folders") {
        seeder.clock_for(row, "created")?;
        let id = seeder.mint();
        seeder.run(
            "core.create_folder",
            json!({"folder_id": id, "name": str_of(row, "name").ok_or("a folder needs a name")?}),
        )?;
        seeder.key(row, Kind::Folder, id)?;
    }
    for row in rows(world, "albums") {
        seeder.clock_for(row, "created")?;
        let id = seeder.mint();
        seeder.run(
            "media.create_album",
            json!({"album_id": id, "title": str_of(row, "name").ok_or("an album needs a name")?}),
        )?;
        seeder.key(row, Kind::Album, id)?;
    }
    for row in rows(world, "events") {
        seeder.clock_for(row, "created")?;
        let id = seeder.mint();
        let start = Stamp::parse(str_of(row, "start").ok_or("an event needs a start")?)
            .ok_or("an event start is YYYY-MM-DD[THH:MM]")?;
        let (dtstart, dtend) = match (start.time, str_of(row, "end")) {
            (_, Some(end)) => (start.vault(), vault_time(end)?),
            (Some(_), None) => {
                let end = start
                    .at()
                    .checked_add(jiff::Span::new().hours(1))
                    .map_err(|e| e.to_string())?;
                (
                    start.vault(),
                    format!("{}T{}:00", end.date(), crate::dates::clock(end.time())),
                )
            }
            (None, None) => (
                format!("{}T00:00:00", start.date),
                format!(
                    "{}T00:00:00",
                    start.date.tomorrow().map_err(|e| e.to_string())?
                ),
            ),
        };
        let dtstart = if dtstart.len() == 10 {
            format!("{dtstart}T00:00:00")
        } else {
            dtstart
        };
        let dtend = if dtend.len() == 10 {
            format!("{dtend}T00:00:00")
        } else {
            dtend
        };
        let mut attendees = Vec::new();
        for person in row
            .get("attendees")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            attendees.push(seeder.id(person.as_str().unwrap_or_default(), Kind::Person)?);
        }
        let mut input = json!({
            "event_id": id,
            "summary": str_of(row, "name").ok_or("an event needs a name")?,
            "dtstart": dtstart,
            "dtend": dtend,
            "calendar_id": calendar,
        });
        if !attendees.is_empty() {
            input["attendee_party_ids"] = json!(attendees);
        }
        if let Some(description) = str_of(row, "description") {
            input["description"] = json!(description);
        }
        seeder.run("schedule.propose_event", input)?;
        seeder.key(row, Kind::Event, id)?;
    }
    for row in rows(world, "tasks") {
        seeder.clock_for(row, "created")?;
        let id = seeder.mint();
        let mut input =
            json!({"task_id": id, "title": str_of(row, "name").ok_or("a task needs a name")?});
        if let Some(due) = str_of(row, "due") {
            input["due_at"] = json!(vault_time(due)?);
        }
        if let Some(effort) = row.get("effort").and_then(Value::as_i64) {
            input["effort_min"] = json!(effort);
        }
        if let Some(priority) = row.get("priority").and_then(Value::as_i64) {
            input["priority"] = json!(priority);
        }
        if let Some(description) = str_of(row, "description") {
            input["description"] = json!(description);
        }
        if let Some(parent) = str_of(row, "parent") {
            input["parent_task_id"] = json!(seeder.id(parent, Kind::Task)?);
        }
        seeder.run("schedule.add_task", input)?;
        seeder.key(row, Kind::Task, id.clone())?;
        if let Some(list) = str_of(row, "list") {
            let project = seeder.id(list, Kind::List)?;
            seeder.run(
                "schedule.organize_task",
                json!({"task_id": id, "project_id": project, "sort_order": 0}),
            )?;
        }
    }
    for row in rows(world, "notes") {
        seeder.clock_for(row, "created")?;
        let id = seeder.mint();
        let name = str_of(row, "name").ok_or("a note needs a name")?;
        let mut input =
            json!({"note_id": id, "title": name, "body_text": str_of(row, "body").unwrap_or(name)});
        if let Some(notebook) = str_of(row, "notebook") {
            input["notebook_id"] = json!(seeder.id(notebook, Kind::Notebook)?);
        }
        seeder.run("knowledge.create_note", input)?;
        seeder.key(row, Kind::Note, id.clone())?;
        if row.get("pinned").and_then(Value::as_bool) == Some(true) {
            seeder.run("knowledge.edit_note", json!({"note_id": id, "pinned": 1}))?;
        }
    }
    for row in rows(world, "documents") {
        seeder.clock_for(row, "created")?;
        let id = seeder.mint();
        let name = str_of(row, "name").ok_or("a document needs a name")?;
        let body = str_of(row, "text").unwrap_or(name);
        let mut input = json!({
            "document_id": id,
            "title": name,
            "data_uri": format!("data:text/plain;base64,{}", base64::engine::general_purpose::STANDARD.encode(format!("{body}\n[{}]", str_of(row, "key").unwrap_or_default()))),
        });
        if let Some(folder) = str_of(row, "folder") {
            input["folder_id"] = json!(seeder.id(folder, Kind::Folder)?);
        }
        seeder.run("core.add_document", input)?;
        seeder.key(row, Kind::Document, id)?;
    }
    for row in rows(world, "photos") {
        seeder.clock_for(row, "created")?;
        let key = str_of(row, "key").unwrap_or_default();
        let bytes = format!(
            "nativetools-photo:{}:{key}",
            str_of(world, "seed").unwrap_or("0")
        );
        let mut input = json!({
            "data_uri": format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)),
            "kind": "photo",
        });
        if let Some(name) = str_of(row, "name") {
            input["title"] = json!(name);
        }
        if let Some(taken) = str_of(row, "taken") {
            input["captured_at"] = json!(vault_time(taken)?);
        }
        let out = seeder.run("media.add_asset", input)?;
        let id = out["asset_id"].as_str().unwrap_or_default().to_owned();
        seeder.key(row, Kind::Photo, id.clone())?;
        for album in row
            .get("albums")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let album = seeder.id(album.as_str().unwrap_or_default(), Kind::Album)?;
            seeder.run(
                "media.add_to_album",
                json!({"album_id": album, "asset_id": id}),
            )?;
        }
    }
    for row in rows(world, "locker") {
        seeder.clock_for(row, "created")?;
        let id = seeder.mint();
        let mut input = json!({
            "item_id": id,
            "type": str_of(row, "type").unwrap_or("login"),
            "title": str_of(row, "name").ok_or("a locker item needs a name")?,
        });
        let item_type = str_of(row, "type").unwrap_or("login");
        let mut secrets: Vec<(&str, &str)> = crate::meta::REVEAL_FIELDS
            .iter()
            .filter_map(|(name, column)| str_of(row, name).map(|value| (*column, value)))
            .collect();
        // Each field goes where the type keeps it (a note's notes are its
        // sealed content); a field the type cannot keep is reported, since
        // the vault would null it without a word.
        for field in ["username", "url", "notes"] {
            let Some(value) = str_of(row, field) else {
                continue;
            };
            match crate::meta::locker_column(item_type, field) {
                Some("content") => secrets.push(("content", value)),
                Some(column) => input[column] = json!(value),
                None => seeder.dropped.push(format!(
                    "{}.{field} (a {item_type} item keeps no {field})",
                    str_of(row, "key").unwrap_or_default()
                )),
            }
        }
        if !secrets.is_empty() {
            if seeder.locker.is_none() {
                seeder.locker = Some(seeder.handle.locker_key()?);
            }
            let (key_id, key) = seeder.locker.clone().unwrap_or_default();
            input["key_id"] = json!(key_id);
            for (column, value) in secrets {
                let sealed = centraid_vault::custody::locker_key::encrypt_under_locker_key(
                    &key, &key_id, &id, value,
                )
                .map_err(|error| error.to_string())?;
                input[column] = json!(sealed);
                if column == "password" {
                    input["password_rotated"] = json!(true);
                }
            }
        }
        seeder.run("locker.add_item", input)?;
        seeder.key(row, Kind::LockerItem, id)?;
    }
    // MONEY (#1099): accounts, then each transaction through the import command, one row at a time
    // so a row has the instant of its own.
    let mut accounts: BTreeMap<String, (String, String)> = BTreeMap::new();
    for row in rows(world, "accounts") {
        seeder.clock_for(row, "created")?;
        let id = seeder.mint();
        let name = str_of(row, "name").ok_or("an account needs a name")?;
        let account_currency =
            str_of(row, "currency").map_or_else(|| currency.clone(), str::to_uppercase);
        seeder.run(
            "money.add_account",
            json!({
                "account_id": id, "name": name,
                "kind": str_of(row, "kind").unwrap_or("checking"),
                "currency": account_currency,
            }),
        )?;
        let key = str_of(row, "key").ok_or("an account needs a key")?;
        if accounts
            .insert(key.to_owned(), (id, account_currency))
            .is_some()
        {
            return Err(format!("the account key \"{key}\" is used twice"));
        }
    }
    for (index, row) in rows(world, "transactions").iter().enumerate() {
        seeder.clock_for(row, "created")?;
        let account = str_of(row, "account").ok_or("a transaction needs an account")?;
        let (account_id, account_currency) = accounts
            .get(account)
            .cloned()
            .ok_or_else(|| format!("no account has the key \"{account}\""))?;
        let date = str_of(row, "date").ok_or("a transaction needs a date")?;
        let amount = row
            .get("amount")
            .and_then(Value::as_f64)
            .ok_or("a transaction needs a signed amount")?;
        let id = seeder.mint();
        let description = str_of(row, "description")
            .or_else(|| str_of(row, "name"))
            .ok_or("a transaction needs a description or a name")?;
        let mut line = json!({
            "txn_id": id,
            "external_id": format!("csv:{index:064x}"),
            "posted_on": date,
            "amount_minor": crate::world::minor_of(amount.abs(), &account_currency),
            "direction": if amount < 0.0 { "debit" } else { "credit" },
            "description": description,
        });
        if let Some(name) = str_of(row, "name") {
            line["display_name"] = json!(name);
        }
        if let Some(category) = str_of(row, "category") {
            line["category_concept_id"] = json!(format!("money:cat:{category}"));
        }
        seeder.run(
            "money.import_transactions",
            json!({"account_id": account_id, "source": "csv", "rows": [line]}),
        )?;
        if row.get("void").and_then(Value::as_bool) == Some(true) {
            seeder.run("money.void_transaction", json!({"txn_id": id}))?;
        }
        seeder.key(row, Kind::Transaction, id)?;
    }
    for link in rows(world, "links") {
        let (Some(from), Some(to)) = (str_of(link, "from"), str_of(link, "to")) else {
            return Err(format!("a link needs from and to: {link}"));
        };
        let (from_kind, from_id) = seeder
            .keys
            .get(from)
            .cloned()
            .ok_or_else(|| format!("no key \"{from}\""))?;
        let (to_kind, to_id) = seeder
            .keys
            .get(to)
            .cloned()
            .ok_or_else(|| format!("no key \"{to}\""))?;
        seeder.cursor += 60_000;
        seeder.handle.clock.set(seeder.cursor);
        seeder.run(
            "core.link_entities",
            json!({
                "from_type": from_kind.spec().entity,
                "from_id": from_id,
                "to_type": to_kind.spec().entity,
                "to_id": to_id,
                "relation": "about",
            }),
        )?;
    }
    for row in rows(world, "photos") {
        let id = seeder.id(str_of(row, "key").unwrap_or_default(), Kind::Photo)?;
        for person in row
            .get("people")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let party = seeder.id(person.as_str().unwrap_or_default(), Kind::Person)?;
            seeder.run(
                "core.link_entities",
                json!({"from_type": "media.asset", "from_id": id, "to_type": "core.party", "to_id": party, "relation": "about"}),
            )?;
        }
    }
    states(&mut seeder, world)?;
    let keys: Map<String, Value> = seeder
        .keys
        .iter()
        .map(|(key, (kind, id))| (key.clone(), json!({"kind": kind.name(), "id": id})))
        .collect();
    // THE VAULT NEVER CHECKPOINTS ON CLOSE (`NO_CKPT_ON_CLOSE`), so the
    // seed checkpoints itself: the vault is then one file (plus its `.blobs`
    // and `.seat` siblings) and a copy does not drag a large `-wal` along.
    seeder.handle.checkpoint()?;
    let dropped = std::mem::take(&mut seeder.dropped);
    seeder
        .handle
        .vault
        .close()
        .map_err(|error| error.to_string())?;
    Ok((Value::Object(keys), dropped))
}

/// Stars, completions, cancellations, contacts, edits, trash —
/// the states a row reaches after it is created, each at its own time.
fn states(seeder: &mut Seeder, world: &Value) -> Result<(), String> {
    let sections: [(&str, Kind); 11] = [
        ("people", Kind::Person),
        ("lists", Kind::List),
        ("notebooks", Kind::Notebook),
        ("folders", Kind::Folder),
        ("albums", Kind::Album),
        ("events", Kind::Event),
        ("tasks", Kind::Task),
        ("notes", Kind::Note),
        ("documents", Kind::Document),
        ("photos", Kind::Photo),
        ("locker", Kind::LockerItem),
    ];
    for (section, kind) in sections {
        for row in rows(world, section) {
            let id = seeder.id(str_of(row, "key").unwrap_or_default(), kind)?;
            let target = json!({ crate::act::id_param(kind): id });
            if row.get("starred").and_then(Value::as_bool) == Some(true) {
                let command = crate::meta::Verb::Star
                    .command(kind)
                    .ok_or_else(|| format!("a {} cannot be starred", kind.name()))?;
                let input = if kind == Kind::Photo {
                    json!({"asset_id": id, "favorite": 1})
                } else {
                    target.clone()
                };
                seeder.at_then(row, "starred_at", command, input)?;
            }
            if kind == Kind::Person
                && let Some(when) = str_of(row, "last_contacted")
            {
                seeder.handle.clock.set(at(when)?);
                seeder.run(
                    "people.log_interaction",
                    json!({"party_id": id, "kind": str_of(row, "last_contacted_kind").unwrap_or("call")}),
                )?;
            }
            if kind == Kind::Task {
                match (str_of(row, "status"), str_of(row, "completed")) {
                    (Some("completed"), _) | (_, Some(_)) => {
                        seeder.at_then(
                            row,
                            "completed",
                            "schedule.set_task_status",
                            json!({"task_id": id, "status": "completed"}),
                        )?;
                    }
                    (Some("in_progress"), _) => {
                        seeder.run(
                            "schedule.set_task_status",
                            json!({"task_id": id, "status": "in-process"}),
                        )?;
                    }
                    (Some("cancelled"), _) => {
                        seeder.run(
                            "schedule.set_task_status",
                            json!({"task_id": id, "status": "cancelled"}),
                        )?;
                    }
                    _ => {}
                }
            }
            if kind == Kind::Event
                && row
                    .get("cancelled")
                    .is_some_and(|v| v.as_bool() == Some(true) || v.is_string())
            {
                seeder.at_then(row, "cancelled", "schedule.cancel_event", target.clone())?;
            }
            if let Some(modified) = str_of(row, "modified") {
                seeder.handle.clock.set(at(modified)?);
                let name = str_of(row, "name").unwrap_or_default();
                let (command, param) = match kind {
                    Kind::Person => ("people.edit_person", "display_name"),
                    Kind::Event => ("schedule.edit_event", "summary"),
                    Kind::Task => ("schedule.edit_task", "title"),
                    Kind::Note => ("knowledge.edit_note", "title"),
                    Kind::Document => ("core.rename_document", "title"),
                    Kind::Photo => ("media.update_asset", "title"),
                    Kind::LockerItem => ("locker.edit_item", "title"),
                    _ => return Err(format!("modified is not supported on a {}", kind.name())),
                };
                let mut input = target.clone();
                input[param] = json!(name);
                seeder.run(command, input)?;
            }
            let trashed = row.get("trashed");
            if trashed.is_some_and(|value| value.as_bool() == Some(true) || value.is_string()) {
                let command = crate::meta::Verb::Delete
                    .command(kind)
                    .ok_or_else(|| format!("a {} cannot be trashed", kind.name()))?;
                if kind.spec().trash {
                    seeder.at_then(row, "trashed", command, target.clone())?;
                } else {
                    return Err(format!("a {} has no trash", kind.name()));
                }
            }
        }
    }
    Ok(())
}
