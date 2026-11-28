use std::collections::BTreeMap;
use std::path::Path;

use serde_json::{Map, Value, json};

use crate::dates::Stamp;
use crate::meta::Kind;
use crate::vaultio::{Handle, SetClock, millis_of};

struct Seeder {
    handle: Handle,
    keys: BTreeMap<String, (Kind, String)>,
    cursor: i64,
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

fn floating_time(stamp: Stamp) -> String {
    match stamp.time {
        Some(time) => format!("{}T{}", stamp.date, crate::dates::clock(time)),
        None => stamp.date.to_string(),
    }
}

fn vault_time(text: &str) -> Result<String, String> {
    Stamp::parse(text)
        .map(Stamp::vault)
        .ok_or_else(|| format!("\"{text}\" is not YYYY-MM-DD[THH:MM]"))
}

fn due_time(text: &str) -> Result<String, String> {
    Stamp::parse(text)
        .map(floating_time)
        .ok_or_else(|| format!("\"{text}\" is not YYYY-MM-DD[THH:MM]"))
}

impl Seeder {
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

    fn id(&self, key: &str, expected: Kind) -> Result<String, String> {
        let (kind, id) = self
            .keys
            .get(key)
            .ok_or_else(|| format!("no {} has the key \"{key}\"", expected.name()))?;
        if *kind != expected {
            return Err(format!(
                "\"{key}\" is a {}, not a {}",
                kind.name(),
                expected.name()
            ));
        }
        Ok(id.clone())
    }

    fn run(&self, command: &str, input: Value) -> Result<Value, String> {
        self.handle.must(command, input)
    }

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
    "health_days",
    "workouts",
    "transfers",
    "categories",
    "rules",
    "budgets",
    "links",
];

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

pub fn seed(world: &Value, path: &Path) -> Result<Value, String> {
    seed_report(world, path).map(|(keys, _)| keys)
}

pub fn seed_report(world: &Value, path: &Path) -> Result<(Value, Vec<String>), String> {
    reject_unknown_sections(world)?;
    let me = str_of(world, "me").unwrap_or("Me");
    let epoch = at(str_of(world, "epoch").unwrap_or("2026-01-01T09:00"))?;
    let clock = SetClock::at(epoch);
    let seed = format!("nativetools:seed:{}", str_of(world, "seed").unwrap_or("0"));
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
        dropped: Vec::new(),
    };
    seeder
        .keys
        .insert("me".to_owned(), (Kind::Person, founded.me.clone()));

    for row in rows(world, "people") {
        seeder.clock_for(row, "created")?;
        let id = seeder.mint();
        let mut input =
            json!({"id": id, "title": str_of(row, "name").ok_or("a person needs a name")?});
        if let Some(days) = row
            .get("cadence")
            .and_then(Value::as_i64)
            .filter(|days| *days > 0)
        {
            input["cadence_days"] = json!(days);
        }
        for field in ["role", "nickname", "met"] {
            if let Some(value) = str_of(row, field) {
                input[field] = json!(value);
            }
        }
        seeder.run("person.add", input)?;
        seeder.key(row, Kind::Person, id)?;
    }
    for row in rows(world, "lists") {
        seeder.clock_for(row, "created")?;
        let id = seeder.mint();
        let input = json!({
            "id": id,
            "kind": "task_list",
            "title": str_of(row, "name").ok_or("a list needs a name")?,
        });
        seeder.run("container.create", input)?;
        seeder.key(row, Kind::List, id)?;
    }
    for (section, noun, kind, vault_kind) in [
        ("notebooks", "notebook", Kind::Notebook, "notebook"),
        ("folders", "folder", Kind::Folder, "folder"),
        ("albums", "album", Kind::Album, "album"),
    ] {
        for row in rows(world, section) {
            seeder.clock_for(row, "created")?;
            let id = seeder.mint();
            let title = str_of(row, "name").ok_or_else(|| format!("a {noun} needs a name"))?;
            seeder.run(
                "container.create",
                json!({"id": id, "kind": vault_kind, "title": title}),
            )?;
            seeder.key(row, kind, id)?;
        }
    }
    for row in rows(world, "events") {
        seeder.clock_for(row, "created")?;
        let id = seeder.mint();
        let start = Stamp::parse(str_of(row, "start").ok_or("an event needs a start")?)
            .ok_or("an event start is YYYY-MM-DD[THH:MM]")?;
        let end = str_of(row, "end")
            .map(|end| Stamp::parse(end).ok_or("an event end is YYYY-MM-DD[THH:MM]"))
            .transpose()?;
        let mut input = json!({
            "id": id,
            "title": str_of(row, "name").ok_or("an event needs a name")?,
            "status": "tentative",
        });
        match (start.time, end) {
            (None, end) => {
                let last = match end {
                    Some(end) => end
                        .date
                        .yesterday()
                        .ok()
                        .filter(|day| *day >= start.date)
                        .unwrap_or(start.date),
                    None => start.date,
                };
                input["timing"] = json!("all-day");
                input["starts"] = json!(start.date.to_string());
                input["ends"] = json!(last.to_string());
            }
            (Some(_), end) => {
                let end_text = match end {
                    Some(end) => floating_time(end),
                    None => {
                        let end = start
                            .at()
                            .checked_add(jiff::Span::new().hours(1))
                            .map_err(|e| e.to_string())?;
                        format!("{}T{}", end.date(), crate::dates::clock(end.time()))
                    }
                };
                input["timing"] = json!("floating");
                input["starts"] = json!(floating_time(start));
                input["ends"] = json!(end_text);
            }
        }
        let mut guests = Vec::new();
        for person in row
            .get("attendees")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let person_id = seeder.id(person.as_str().unwrap_or_default(), Kind::Person)?;
            guests.push(json!({"person_id": person_id}));
        }
        if !guests.is_empty() {
            input["guests"] = json!(guests);
        }
        if let Some(description) = str_of(row, "description") {
            input["description"] = json!(description);
        }
        seeder.run("event.propose", input)?;
        seeder.key(row, Kind::Event, id)?;
    }
    for row in rows(world, "tasks") {
        seeder.clock_for(row, "created")?;
        let id = seeder.mint();
        let mut input =
            json!({"id": id, "title": str_of(row, "name").ok_or("a task needs a name")?});
        if let Some(due) = str_of(row, "due") {
            input["due"] = json!(due_time(due)?);
        }
        if let Some(priority) = row.get("priority").and_then(Value::as_i64) {
            input["priority"] = json!(priority);
        }
        if let Some(description) = str_of(row, "description") {
            input["description"] = json!(description);
        }
        if let Some(parent) = str_of(row, "parent") {
            input["parent_id"] = json!(seeder.id(parent, Kind::Task)?);
        }
        if let Some(list) = str_of(row, "list")
            && input.get("parent_id").is_none()
        {
            input["parent_id"] = json!(seeder.id(list, Kind::List)?);
        }
        seeder.run("task.add", input)?;
        seeder.key(row, Kind::Task, id)?;
    }
    for row in rows(world, "notes") {
        seeder.clock_for(row, "created")?;
        let id = seeder.mint();
        let name = str_of(row, "name").ok_or("a note needs a name")?;
        let mut input =
            json!({"id": id, "title": name, "body": str_of(row, "body").unwrap_or(name)});
        if let Some(notebook) = str_of(row, "notebook") {
            input["notebook_id"] = json!(seeder.id(notebook, Kind::Notebook)?);
        }
        seeder.run("note.create", input)?;
        seeder.key(row, Kind::Note, id.clone())?;
        if row.get("pinned").and_then(Value::as_bool) == Some(true) {
            seeder.run("flag.set", json!({"id": id, "flag": "pinned"}))?;
        }
    }
    for row in rows(world, "documents") {
        seeder.clock_for(row, "created")?;
        let id = seeder.mint();
        let name = str_of(row, "name").ok_or("a document needs a name")?;
        let body = str_of(row, "text").unwrap_or(name);
        let mut input = json!({
            "id": id,
            "title": name,
            "body_text": format!("{body}\n[{}]", str_of(row, "key").unwrap_or_default()),
            "media_type": "text/plain",
        });
        if let Some(folder) = str_of(row, "folder") {
            input["folder_id"] = json!(seeder.id(folder, Kind::Folder)?);
        }
        seeder.run("document.create_text", input)?;
        seeder.key(row, Kind::Document, id)?;
    }
    for row in rows(world, "photos") {
        seeder.clock_for(row, "created")?;
        let key = str_of(row, "key").unwrap_or_default();
        let bytes = format!(
            "nativetools-photo:{}:{key}",
            str_of(world, "seed").unwrap_or("0")
        );
        let id = seeder.mint();
        let (blob, size) = seeder.handle.keep(bytes.as_bytes())?;
        let mut input = json!({
            "id": id, "blob": blob, "size": size, "media_type": "image/jpeg", "form": "photo",
        });
        if let Some(name) = str_of(row, "name") {
            input["title"] = json!(name);
        }
        if let Some(taken) = str_of(row, "taken") {
            input["taken_at"] = json!(vault_time(taken)?);
        }
        seeder.run("photo.add", input)?;
        seeder.key(row, Kind::Photo, id.clone())?;
        for album in row
            .get("albums")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let album = seeder.id(album.as_str().unwrap_or_default(), Kind::Album)?;
            seeder.run(
                "edge.add",
                json!({"from": album, "rel": "contains", "to": id}),
            )?;
        }
        for person in row
            .get("people")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let person = seeder.id(person.as_str().unwrap_or_default(), Kind::Person)?;
            seeder.run(
                "edge.add",
                json!({"from": id, "rel": "depicts", "to": person}),
            )?;
        }
    }
    for row in rows(world, "locker") {
        seeder.clock_for(row, "created")?;
        let id = seeder.mint();
        let item_type = str_of(row, "type").unwrap_or("login");
        let mut fields: Vec<Value> = Vec::new();
        for (name, column) in crate::meta::REVEAL_FIELDS {
            if let Some(value) = str_of(row, name) {
                fields.push(json!({"field_key": column, "value": value}));
            }
        }
        for field in ["username", "url", "notes"] {
            let Some(value) = str_of(row, field) else {
                continue;
            };
            match crate::meta::locker_column(item_type, field) {
                Some(column) => fields.push(json!({"field_key": column, "value": value})),
                None => seeder.dropped.push(format!(
                    "{}.{field} (a {item_type} item keeps no {field})",
                    str_of(row, "key").unwrap_or_default()
                )),
            }
        }
        let mut input = json!({
            "item_id": id,
            "type": item_type,
            "title": str_of(row, "name").ok_or("a locker item needs a name")?,
        });
        if !fields.is_empty() {
            input["fields"] = json!(fields);
        }
        seeder.run("locker.add_item", input)?;
        seeder.key(row, Kind::LockerItem, id)?;
    }
    let mut accounts: BTreeMap<String, (String, String, String)> = BTreeMap::new();
    for row in rows(world, "accounts") {
        seeder.clock_for(row, "created")?;
        let id = seeder.mint();
        let name = str_of(row, "name").ok_or("an account needs a name")?;
        let account_currency =
            str_of(row, "currency").map_or_else(|| currency.clone(), str::to_uppercase);
        seeder.run(
            "account.add",
            json!({
                "id": id,
                "title": name,
                "type": str_of(row, "kind").unwrap_or("checking"),
                "currency": account_currency,
            }),
        )?;
        let key = str_of(row, "key").ok_or("an account needs a key")?;
        if accounts
            .insert(
                key.to_owned(),
                (id.clone(), account_currency, name.to_owned()),
            )
            .is_some()
        {
            return Err(format!("the account key \"{key}\" is used twice"));
        }
        seeder.key(row, Kind::Account, id)?;
    }
    for (index, row) in rows(world, "transactions").iter().enumerate() {
        seeder.clock_for(row, "created")?;
        let account = str_of(row, "account").ok_or("a transaction needs an account")?;
        let (account_id, account_currency, account_name) = accounts
            .get(account)
            .cloned()
            .ok_or_else(|| format!("no account has the key \"{account}\""))?;
        let date = str_of(row, "date").ok_or("a transaction needs a date")?;
        let amount = row
            .get("amount")
            .and_then(Value::as_f64)
            .ok_or("a transaction needs a signed amount")?;
        let description = str_of(row, "description")
            .or_else(|| str_of(row, "name"))
            .ok_or("a transaction needs a description or a name")?;
        let external = format!("csv:{index:064x}");
        let title = str_of(row, "name").unwrap_or(description);
        let signed = crate::world::minor_of(amount.abs(), &account_currency)
            * if amount < 0.0 { -1 } else { 1 };
        seeder.run(
            "follow.statement",
            json!({
                "origin": {"ref": account_id, "label": account_name, "fills": account_id},
                "records": [{
                    "external_id": external,
                    "fields": {
                        "title": title,
                        "posted_on": date,
                        "amount_minor": signed,
                        "line": {"description": description, "imported_from": "csv"},
                    },
                }],
            }),
        )?;
        let id = seeder.handle.followed(&external)?;
        if let Some(category) = str_of(row, "category") {
            seeder.run(
                "txn.categorize",
                json!({"ids": [id], "category_id": format!("category:{category}")}),
            )?;
        }
        if row.get("void").and_then(Value::as_bool) == Some(true) {
            seeder.run("entity.trash", json!({"id": id}))?;
        }
        seeder.key(row, Kind::Transaction, id)?;
    }
    let workout_rows = rows(world, "workouts");
    let health_days = rows(world, "health_days");
    if workout_rows.is_empty() && !health_days.is_empty() {
        seeder.run(
            "follow.health",
            json!({
                "origin": {"ref": "store:seed", "label": "Health"},
                "records": [],
            }),
        )?;
    }
    for row in workout_rows {
        seeder.clock_for(row, "created")?;
        let key = str_of(row, "key").ok_or("a workout needs a key")?;
        let external = format!("store:{key}");
        let mut fields = Map::new();
        for name in ["kind", "starts", "ends"] {
            if let Some(value) = row.get(name) {
                fields.insert(name.to_owned(), value.clone());
            }
        }
        let metric_source = row.get("workout").and_then(Value::as_object);
        for name in [
            "recorded_by",
            "moving_s",
            "distance_m",
            "energy_kcal",
            "heart_bpm",
            "climb_m",
        ] {
            if let Some(value) = row
                .get(name)
                .or_else(|| metric_source.and_then(|obj| obj.get(name)))
            {
                fields.insert(name.to_owned(), value.clone());
            }
        }
        seeder.run(
            "follow.health",
            json!({
                "origin": {"ref": "store:seed", "label": "Health"},
                "records": [{"external_id": external, "fields": fields}],
            }),
        )?;
        let id = seeder.handle.followed(&external)?;
        seeder.key(row, Kind::Workout, id)?;
    }
    if !health_days.is_empty() {
        let mut totals = Vec::new();
        let mut readings = Vec::new();
        for entry in health_days {
            let metric = str_of(entry, "metric").unwrap_or_default();
            if matches!(
                metric,
                "weight_kg" | "blood_pressure" | "glucose_mmol" | "body_temp_c"
            ) {
                readings.push(entry);
            } else {
                totals.push(entry.clone());
            }
        }
        if !totals.is_empty() {
            seeder.run(
                "measurement.record",
                json!({
                    "origin": {"system": "health", "ref": "store:seed"},
                    "days": totals,
                }),
            )?;
        }
        for entry in readings {
            if let (Some(day), Some(metric), Some(value)) = (
                str_of(entry, "day"),
                str_of(entry, "metric"),
                entry.get("value").and_then(Value::as_f64),
            ) {
                seeder.run(
                    "reading.add",
                    json!({
                        "metric": metric,
                        "at": format!("{day}T12:00:00.000Z"),
                        "value": value,
                    }),
                )?;
            }
        }
    }
    for transfer in rows(world, "transfers") {
        let (Some(a), Some(b)) = (str_of(transfer, "a"), str_of(transfer, "b")) else {
            return Err(format!("a transfer needs a and b: {transfer}"));
        };
        let (a, b) = (
            seeder.id(a, Kind::Transaction)?,
            seeder.id(b, Kind::Transaction)?,
        );
        seeder.run("txn.link_transfer", json!({"id": a, "other_id": b}))?;
    }
    for row in rows(world, "categories") {
        seeder.clock_for(row, "created")?;
        let name = str_of(row, "name").ok_or("a category needs a name")?;
        let made = seeder.run("category.add", json!({"title": name}))?;
        let id = made["id"]
            .as_str()
            .ok_or("category.add answered no id")?
            .to_owned();
        seeder.key(row, Kind::Category, id)?;
    }
    for row in rows(world, "rules") {
        seeder.clock_for(row, "created")?;
        let id = seeder.mint();
        let category = str_of(row, "category").ok_or("a rule needs a category")?;
        seeder.run(
            "rule.add",
            json!({
                "id": id,
                "match": str_of(row, "match").unwrap_or("contains"),
                "text": str_of(row, "text").ok_or("a rule needs text")?,
                "category_id": format!("category:{category}"),
            }),
        )?;
        seeder.key(row, Kind::Rule, id)?;
    }
    for row in rows(world, "budgets") {
        seeder.clock_for(row, "created")?;
        let month = str_of(row, "month").ok_or("a budget needs a month")?;
        let category = str_of(row, "category").ok_or("a budget needs a category")?;
        let amount = row
            .get("amount")
            .and_then(Value::as_f64)
            .ok_or("a budget needs an amount")?;
        let mut input = json!({
            "month": month,
            "category_id": format!("category:{category}"),
            "amount_minor": crate::world::minor_of(amount, &currency),
        });
        if let Some(carry) = row.get("carry").and_then(Value::as_bool) {
            input["carry"] = json!(carry);
        }
        seeder.run("budget.set", input)?;
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
        if matches!(from_kind, Kind::Document) && to_kind != Kind::Person {
            seeder
                .dropped
                .push(format!("{from}.links (a document is only about a person)"));
            continue;
        }
        if from_kind == Kind::Event {
            seeder.cursor += 60_000;
            seeder.handle.clock.set(seeder.cursor);
            let (a, b) = if from_id < to_id {
                (from_id, to_id)
            } else {
                (to_id, from_id)
            };
            seeder.run("link.add", json!({"a": a, "b": b}))?;
            continue;
        }
        if !matches!(from_kind, Kind::Note | Kind::Task | Kind::Document) {
            return Err(format!(
                "a {} is not about anything: only a note, a task, an event or a document is ({link})",
                from_kind.name()
            ));
        }
        seeder.cursor += 60_000;
        seeder.handle.clock.set(seeder.cursor);
        seeder.run(
            "edge.add",
            json!({"from": from_id, "rel": "about", "to": to_id}),
        )?;
    }
    states(&mut seeder, world)?;
    let keys: Map<String, Value> = seeder
        .keys
        .iter()
        .map(|(key, (kind, id))| (key.clone(), json!({"kind": kind.name(), "id": id})))
        .collect();
    seeder.handle.checkpoint()?;
    let dropped = std::mem::take(&mut seeder.dropped);
    seeder
        .handle
        .vault
        .close()
        .map_err(|error| error.to_string())?;
    Ok((Value::Object(keys), dropped))
}

fn touch_kind(word: &str) -> &str {
    match word {
        "visit" | "coffee" => "met-up",
        other => other,
    }
}

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
            let target = json!({ "id": id });
            if row.get("starred").and_then(Value::as_bool) == Some(true) {
                let command = crate::meta::Verb::Star
                    .command(kind)
                    .ok_or_else(|| format!("a {} cannot be starred", kind.name()))?;
                let input = json!({"id": id, "flag": "starred"});
                seeder.at_then(row, "starred_at", command, input)?;
            }
            if kind == Kind::Person
                && let Some(when) = str_of(row, "last_contacted")
            {
                seeder.handle.clock.set(at(when)?);
                let kind_word = touch_kind(str_of(row, "last_contacted_kind").unwrap_or("call"));
                seeder.run("touch.log", json!({"people": [id], "kind": kind_word}))?;
            }
            if kind == Kind::Task {
                match (str_of(row, "status"), str_of(row, "completed")) {
                    (Some("completed"), _) | (_, Some(_)) => {
                        seeder.at_then(row, "completed", "task.complete", target.clone())?;
                    }
                    (Some("cancelled"), _) => {
                        seeder.run("task.cancel", target.clone())?;
                    }
                    (Some("in_progress"), _) => {
                        return Err(
                            "a task is open, completed or cancelled: it has no in_progress status"
                                .to_owned(),
                        );
                    }
                    _ => {}
                }
            }
            if kind == Kind::Event
                && row
                    .get("cancelled")
                    .is_some_and(|v| v.as_bool() == Some(true) || v.is_string())
            {
                seeder.at_then(row, "cancelled", "event.cancel", target.clone())?;
            }
            if let Some(modified) = str_of(row, "modified") {
                seeder.handle.clock.set(at(modified)?);
                let name = str_of(row, "name").unwrap_or_default();
                let command = match kind {
                    Kind::Person => "person.edit",
                    Kind::Event => "event.edit",
                    Kind::Task => "task.edit",
                    Kind::Note => "note.edit",
                    Kind::Document | Kind::Photo | Kind::LockerItem => "entity.retitle",
                    _ => return Err(format!("modified is not supported on a {}", kind.name())),
                };
                let mut input = target.clone();
                input["title"] = json!(name);
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
