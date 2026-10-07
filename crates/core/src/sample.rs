//! THE SAMPLE SCENARIO: one weekend at Tahoe, across seven apps.
//!
//! A member's first vault opens onto nothing, and an app full of empty states
//! teaches nobody what it is for. So a phone that founds its first vault also
//! founds a SECOND, separate vault — the **sample vault** — and fills it with
//! this scenario: Maya, Jake, Grandpa Ray and Chris, notes and a packing list,
//! a week on the calendar, a camera roll with real bytes, and an uneven expense
//! ledger. The member's own vault stays clean; removing the sample is
//! forgetting its directory, and nothing of the member's goes with it.
//!
//! **One scenario, two callers.** The phone reaches it through `FoundRequest`
//! with `FOUND_CONTENT_SAMPLE` ([`crate::api::found`]); the dev binary
//! `seed-demo-vault` (`crates/centraid`) seeds the same rows into a fixture
//! vault and adds Locker on top. Keeping one copy is what keeps a screenshot of
//! a demo fixture and a member's sample vault the same product.
//!
//! **LOCKER IS SEALED UNDER THE MEMBER'S OWN KEYS, never the demo's.** A phone
//! that holds the member's seed founds the sample KEYED at an index of its own
//! (`Shelf.foundSample`), and [`found`] then seeds a handful of obviously fake
//! Locker items through the same door the shell uses — a Locker unlock with the
//! vault's keys, then `locker.add_item`, whose secrets the core seals under that
//! vault's `K` ([`locker`]). The dev binary's Locker is sealed under the PUBLIC
//! all-`abandon` words, which is right for a fixture and must never exist in a
//! product vault: nothing here names those words, a demo seed or a seed of this
//! module's own, and `sample_vault_tests` asserts the items open under the
//! member's seed and index and DO NOT open under the demo's. A core opened with
//! no seed has no `K`, so it founds the sample without Locker rather than
//! minting a stand-in. Locker is not one of [`APPS`] (the dev binary's `--only`
//! names those); it is seeded by its own step.
//!
//! **THROUGH THE REAL COMMAND PLANE, never SQL.** Every row is a
//! `Vault::execute` of a registered command, so it carries the `core_entity`
//! siblings, the `row_version` and the ledger entries a real write produces,
//! and a tile reading it reads the shape the product actually stores. The one
//! read — the calendar Agenda files events under — is a page through
//! [`crate::api::page`], the same door a shell reads through.
//!
//! **Dates are relative to now.** An agenda seeded around a fixed instant is a
//! sample that is empty by next month, so every date is the wall clock plus or
//! minus whole days.
//!
//! **The bytes ship with the library.** Eighteen PNG frames, 672 KB, every one
//! 360 px or less on its long edge, compiled in with `include_bytes!` — so the
//! core library, and every phone slice of it, carries them.

use std::collections::{BTreeMap, BTreeSet};

use centraid_api_proto::core_v1 as wire;
use centraid_vault::bootstrap::Founded;
use centraid_vault::commands::{Command, CommandStatus, Registry};
use centraid_vault::{Principal, Vault};
use serde_json::{Value, json};

use crate::error::{CoreError, Result};

mod locker;

pub use locker::Sealing;

/// The apps the scenario seeds through [`seed`], in the order it seeds them.
/// Locker is not one of them: it needs the vault's keys, so [`found`] seeds it
/// as its own step ([`locker`]); see the module header.
pub const APPS: [&str; 7] = [
    "people", "notes", "docs", "photos", "tasks", "tally", "agenda",
];

/// What a seeding pass did not do.
///
/// A refusal is LOUD and the pass continues: one app's schema drifting is not
/// a reason to leave the other six empty, and a silent skip would be a sample
/// whose gaps nobody can see. The caller decides what a refusal costs — the
/// phone fails the whole found, the dev binary exits non-zero.
#[derive(Debug, Default)]
pub struct Report {
    /// `"<command>: <reason>"`, one per refused command.
    pub refused: Vec<String>,
    /// Commands that are registered and have no body yet, named once each.
    pub gaps: BTreeSet<String>,
}

impl Report {
    /// Every command ran and every one was executed.
    #[must_use]
    pub fn is_whole(&self) -> bool {
        self.refused.is_empty() && self.gaps.is_empty()
    }
}

/// The wall clock, in milliseconds — the scenario's "now".
#[must_use]
pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| i64::try_from(since.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

/// FOUND THE SAMPLE VAULT in an open, empty file, and seed it.
///
/// The order is the crash story ([`centraid_vault::bootstrap::SampleMark`]):
/// the vault row and the mark at `seeding` in one commit, the scenario through
/// the command plane, **Locker last when the core holds keys**, the mark at
/// `ready` after both. A pass that is not whole fails here and leaves the mark
/// at `seeding`, so the file is never mistaken for a finished sample — the
/// phone deletes its directory, and with it every sealed item.
///
/// `sealing` is the open core's keys and Locker session; `None` is a core
/// opened with no seed, which founds the sample without Locker.
///
/// # Errors
///
/// [`CoreError::VaultAlreadyHeld`] over a file that is already a vault, and
/// [`CoreError::Invariant`] naming every refusal when the scenario did not
/// land whole.
pub fn found(
    vault: &Vault,
    registry: &Registry,
    principal: &Principal,
    display_name: &str,
    owner_name: &str,
    now_ms: i64,
    sealing: Option<&Sealing<'_>>,
) -> Result<Founded> {
    if let Some(vault_id) = vault.vault_id()? {
        return Err(CoreError::VaultAlreadyHeld { vault_id });
    }
    let founded = vault.found_sample(display_name, owner_name)?;
    let mut report = seed(
        vault,
        registry,
        principal,
        &founded.owner_party_id,
        &|_| true,
        now_ms,
    )?;
    if let Some(sealing) = sealing {
        report
            .refused
            .extend(locker::seed(vault, registry, principal, sealing));
    }
    if !report.is_whole() {
        let mut why = report.refused;
        why.extend(report.gaps.into_iter().map(|gap| format!("{gap}: no body")));
        return Err(CoreError::Invariant {
            context: format!("the sample vault did not seed whole: {}", why.join("; ")),
        });
    }
    vault.finish_sample()?;
    Ok(founded)
}

/// SEED THE SCENARIO into a founded vault, one app at a time.
///
/// `wanted` names the apps to seed (by [`APPS`]' names); the dev binary's
/// `--only` is what passes anything but "all of them". Tally enrols the
/// parties People made, so the two name one human with one party.
///
/// # Errors
///
/// Only when the registry cannot be built. A command's refusal is a line in
/// the [`Report`], not an error.
pub fn seed(
    vault: &Vault,
    registry: &Registry,
    principal: &Principal,
    owner_party_id: &str,
    wanted: &dyn Fn(&str) -> bool,
    now_ms: i64,
) -> Result<Report> {
    let mut seeder = Seeder {
        vault,
        registry,
        principal,
        report: Report::default(),
    };
    let people = if wanted("people") {
        seed_people(&mut seeder)
    } else {
        BTreeMap::new()
    };
    if wanted("notes") {
        seed_notes(&mut seeder);
    }
    if wanted("docs") {
        seed_docs(&mut seeder, now_ms);
    }
    if wanted("photos") {
        seed_photos(&mut seeder, now_ms);
    }
    if wanted("tasks") {
        seed_tasks(&mut seeder, now_ms);
    }
    if wanted("tally") {
        seed_tally(&mut seeder, now_ms, owner_party_id, &people);
    }
    if wanted("agenda") {
        // THE CALENDAR IS DISCOVERED, never hard-coded: `Vault::found` mints a
        // private "Personal" one, and a vault with none cannot hold an event.
        match first_calendar(vault) {
            Some(calendar_id) => seed_agenda(&mut seeder, now_ms, &calendar_id),
            None => seeder
                .report
                .refused
                .push("agenda: this vault has no calendar".to_owned()),
        }
    }
    Ok(seeder.report)
}

/// TWO STARTER ROWS in a member's own first vault: a note and a task, so the
/// vault they just made is not a blank wall. Best-effort by design — a refused
/// starter leaves an empty vault, which is still a vault.
#[must_use]
pub fn starters(vault: &Vault, registry: &Registry, principal: &Principal) -> Report {
    let mut seeder = Seeder {
        vault,
        registry,
        principal,
        report: Report::default(),
    };
    seeder.run(
        "knowledge.create_note",
        json!({
            "title": "Start here",
            "body_text": "This note lives in your vault, on this phone. Edit it, or delete it once you have written your own.",
            "format": "plain",
        }),
    );
    seeder.run(
        "schedule.add_task",
        json!({
            "title": "Pair your laptop so this vault has a backup",
            "priority": 5,
        }),
    );
    seeder.report
}

/// The first calendar's id, read through the page door a shell reads through.
fn first_calendar(vault: &Vault) -> Option<String> {
    let request = wire::PageRequest {
        query: Some(wire::PageQuery {
            name: "sample.calendar".to_owned(),
            select: vec!["calendar_id".to_owned()],
            from: "schedule_calendar".to_owned(),
            r#where: None,
            bind: Vec::new(),
            order: Some(wire::PageOrder {
                sort_column: "calendar_id".to_owned(),
                pk_column: "calendar_id".to_owned(),
                descending: false,
            }),
            with_held_thumbnail: false,
            with_note_body: false,
            with_document_size: false,
            with_minor_units: false,
            local_day_columns: Vec::new(),
            tz: String::new(),
        }),
        limit: 1,
        after: None,
    };
    let page = crate::api::page(vault, &request).ok()?;
    let value = page.rows.first()?.values.first()?;
    match value.kind.as_ref()? {
        wire::value::Kind::Text(text) => Some(text.clone()),
        _ => None,
    }
}

const DAY_MS: i64 = 86_400_000;

/// An ISO-8601 instant `days` from the anchor, at `hour:minute` UTC.
///
/// Deliberately arithmetic: this module has no business carrying a second
/// opinion about civil time, and every consumer treats these as opaque ordering
/// keys.
fn at(now: i64, days: i64, hour: i64, minute: i64) -> String {
    let midnight = (now / DAY_MS) * DAY_MS + days * DAY_MS;
    let millis = midnight + hour * 3_600_000 + minute * 60_000;
    iso(millis)
}

/// The date alone, `YYYY-MM-DD`, `days` from the anchor.
fn day(now: i64, days: i64) -> String {
    iso((now / DAY_MS) * DAY_MS + days * DAY_MS)[..10].to_owned()
}

fn iso(millis: i64) -> String {
    let seconds = millis.div_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let time = seconds.rem_euclid(86_400);
    // Civil-from-days (Howard Hinnant's algorithm), which is the same one
    // `crates/vault`'s time module uses and is exact for every date this
    // scenario reaches.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if m <= 2 { y + 1 } else { y };
    format!(
        "{year:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
        time / 3600,
        (time % 3600) / 60,
        time % 60
    )
}

/// One command, run and reported.
struct Seeder<'a> {
    vault: &'a Vault,
    registry: &'a Registry,
    principal: &'a Principal,
    report: Report,
}

impl Seeder<'_> {
    fn run(&mut self, name: &'static str, body: Value) -> Option<Value> {
        match self
            .vault
            .execute(self.registry, self.principal, &Command::new(name, body))
        {
            Ok(outcome) if outcome.status == CommandStatus::Executed => Some(outcome.output),
            Ok(outcome) => {
                let why = outcome.reason.unwrap_or_else(|| "no reason".to_owned());
                tracing::warn!(command = name, %why, "a sample command was refused");
                self.report.refused.push(format!("{name}: {why}"));
                None
            }
            // A COMMAND WITH NO BODY IS A GAP, NOT A REFUSAL, and the
            // difference is worth keeping: a refusal means the vault said no to
            // this input, and a gap means nobody can seed that app at all yet.
            Err(centraid_vault::VaultError::NotImplemented { name }) => {
                self.report.gaps.insert(name);
                None
            }
            Err(error) => {
                tracing::warn!(command = name, %error, "a sample command errored");
                self.report.refused.push(format!("{name}: {error}"));
                None
            }
        }
    }

    /// A minted id out of a command's output, or nothing.
    fn id(output: Option<&Value>, field: &str) -> Option<String> {
        output?
            .get(field)
            .and_then(Value::as_str)
            .map(str::to_owned)
    }
}

// ---------------------------------------------------------------------------
// People.
//
// "A small living circle — people with contact cadences, logged interactions,
// birthdays, canonical gift tasks and one outstanding debt."
// ---------------------------------------------------------------------------

/// The four people, and each one's party by first name — Tally's friends.
fn seed_people(seeder: &mut Seeder) -> std::collections::BTreeMap<&'static str, String> {
    let mut by_first_name = std::collections::BTreeMap::new();
    let mut ids = Vec::new();
    for (name, role, cadence) in [
        ("Maya Alvarez", "College friend", 30),
        ("Jake Bennett", "Old roommate from Portland", 45),
        ("Grandpa Ray", "Grandfather", 7),
        ("Chris Okafor", "Design lead, ex-colleague", 60),
    ] {
        let output = seeder.run(
            "people.add_person",
            json!({ "display_name": name, "role": role, "cadence_days": cadence }),
        );
        if let Some(party) = Seeder::id(output.as_ref(), "party_id") {
            if let Some(first) = name.split(' ').next() {
                by_first_name.insert(first, party.clone());
            }
            ids.push(party);
        }
    }
    let (maya, jake, grandpa, chris) = match ids.as_slice() {
        [maya, jake, grandpa, chris] => {
            (maya.clone(), jake.clone(), grandpa.clone(), chris.clone())
        }
        _ => return by_first_name,
    };

    for (party, kind, text) in [
        (
            &maya,
            "call",
            "Caught up about her Denver move; she wants the Tahoe dates.",
        ),
        (
            &grandpa,
            "visit",
            "Sunday lunch. Blood pressure is under control again; he beat me at cribbage twice.",
        ),
        (
            &chris,
            "message",
            "Sent the portfolio feedback he asked for.",
        ),
    ] {
        seeder.run(
            "people.log_interaction",
            json!({ "party_id": party, "kind": kind, "text": text }),
        );
    }

    for (party, label, month_day, reminder) in [
        (&grandpa, "Birthday", "08-14", true),
        (&maya, "Birthday", "11-02", false),
    ] {
        seeder.run(
            "people.add_important_date",
            json!({
                "party_id": party,
                "label": label,
                "month_day": month_day,
                "reminder_on": reminder,
            }),
        );
    }

    for (party, text) in [
        (&grandpa, "Large-print edition of Lonesome Dove"),
        (&chris, "Fountain pen ink sampler"),
    ] {
        seeder.run(
            "people.add_gift",
            json!({ "party_id": party, "text": text }),
        );
    }

    seeder.run(
        "people.add_debt",
        json!({
            "party_id": jake,
            "direction": "owe",
            "amount_minor": 15_000,
            "reason": "His half of the cabin deposit",
        }),
    );
    by_first_name
}

// ---------------------------------------------------------------------------
// Notes.
//
// "Two notebooks and a handful of lived-in markdown notes, plus one loose
// scratch note."
// ---------------------------------------------------------------------------

fn seed_notes(seeder: &mut Seeder) {
    let travel = Seeder::id(
        seeder
            .run("knowledge.create_notebook", json!({ "name": "Travel" }))
            .as_ref(),
        "notebook_id",
    );
    let recipes = Seeder::id(
        seeder
            .run("knowledge.create_notebook", json!({ "name": "Recipes" }))
            .as_ref(),
        "notebook_id",
    );

    let notes: [(&str, &str, &str, Option<&String>); 5] = [
        (
            "Tahoe long weekend — shortlist",
            "## Stays\n- South Lake: walkable, closer to the good food\n- Truckee: quieter, longer drive to the water\n\n## Rough budget\nCabin ~$180/night, plus gas both ways.",
            "markdown",
            travel.as_ref(),
        ),
        (
            "Drive vs fly",
            "I-80 is four hours clean, six if we leave Friday after five. Reno flight lands 09:40 but door-to-door is a wash. Book by Thursday either way.",
            "plain",
            travel.as_ref(),
        ),
        (
            "Mom's chili, written down properly",
            "1. Brown 2 lb chuck in batches — crowding steams it.\n2. Onion, garlic, one poblano until soft.\n3. Chili powder 3 tbsp, cumin 1 tbsp, bloom in the fat.\n4. Crushed tomatoes, beans, a splash of coffee. Two hours low.\n\n*Do not skip the coffee.*",
            "markdown",
            recipes.as_ref(),
        ),
        (
            "Weeknight mac and cheese",
            "Boil the pasta short. Butter, flour, milk, then sharp cheddar off the heat. Freezes well in 2-portion boxes.",
            "plain",
            recipes.as_ref(),
        ),
        (
            "Scratch — books people keep recommending",
            "The Design of Everyday Things (again), Salt Fat Acid Heat, Project Hail Mary.",
            "plain",
            None,
        ),
    ];
    for (title, body, format, notebook) in notes {
        let mut input = json!({ "title": title, "body_text": body, "format": format });
        if let Some(notebook) = notebook {
            input["notebook_id"] = json!(notebook);
        }
        seeder.run("knowledge.create_note", input);
    }
}

// ---------------------------------------------------------------------------
// Docs.
//
// "Two folders, three filed documents, a star, a tag, and one document with a
// SECOND version so the history walk has something to walk." The bytes ride the
// inline `data:` door as text/markdown, which is v0's choice and the reason the
// FTS triggers index them.
// ---------------------------------------------------------------------------

fn markdown(text: &str) -> String {
    // Percent-encoding by hand: the alternative is a URL crate in a fixture,
    // and the set of characters these documents use is small and known.
    let mut encoded = String::with_capacity(text.len() * 3);
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    format!("data:text/markdown;charset=utf-8,{encoded}")
}

fn seed_docs(seeder: &mut Seeder, now: i64) {
    let travel = Seeder::id(
        seeder
            .run("core.create_folder", json!({ "name": "Travel" }))
            .as_ref(),
        "folder_id",
    );
    let home = Seeder::id(
        seeder
            .run("core.create_folder", json!({ "name": "Home" }))
            .as_ref(),
        "folder_id",
    );

    let leaving = day(now, 3);
    let back = day(now, 6);
    let packing_body = format!(
        "# Tahoe packing list\n\nLeaving {leaving}, back {back}.\n\n\
         - Rain shell\n- Hiking boots\n- Headlamp\n- Swimsuit (the cabin has a hot tub)\n- Board games\n"
    );
    let mut packing_input = json!({
        "title": "Tahoe packing list",
        "data_uri": markdown(&packing_body),
    });
    if let Some(travel) = travel.as_ref() {
        packing_input["folder_id"] = json!(travel);
    }
    let packing = Seeder::id(
        seeder.run("core.add_document", packing_input).as_ref(),
        "document_id",
    );
    if let Some(packing) = packing.as_ref() {
        // ONE EDIT, so version history has two versions to show: the walk is
        // `revises` links between CONTENT items, minted by this call.
        let revised = format!(
            "{packing_body}- Tire chains (I-80 requires them after a storm)\n- Cooler for the drive\n"
        );
        seeder.run(
            "core.edit_document",
            json!({ "document_id": packing, "body_text": revised }),
        );
        seeder.run("core.star_document", json!({ "document_id": packing }));
        seeder.run(
            "core.tag_item",
            json!({
                "subject_type": "core.document",
                "subject_id": packing,
                "label": "tahoe",
            }),
        );
    }

    // "(sample)" IN THE TITLE, which is v0's own rule: a rental agreement and an
    // insurance policy are exactly the records a member must never mistake for
    // the real thing.
    let cabin = format!(
        "# Cabin rental agreement (sample)\n\nThis is sample demo data, not a real agreement.\n\n\
         - Property: 3BR cabin, South Lake Tahoe\n- Nights: {leaving} to {back}\n\
         - Rate: $180 per night\n- Deposit: $300, refundable\n- Check-in 4pm, check-out 10am\n\
         - No smoking; dogs welcome\n"
    );
    let mut cabin_input = json!({
        "title": "Cabin rental agreement (sample)",
        "data_uri": markdown(&cabin),
    });
    if let Some(travel) = travel.as_ref() {
        cabin_input["folder_id"] = json!(travel);
    }
    seeder.run("core.add_document", cabin_input);

    let insurance = "# Renters insurance policy (sample)\n\nThis is sample demo data, not a real policy.\n\n\
         - Policy number: SAMPLE-0000-0000\n- Personal property: $30,000\n- Liability: $100,000\n\
         - Deductible: $500\n- Renews annually\n";
    let mut insurance_input = json!({
        "title": "Renters insurance policy (sample)",
        "data_uri": markdown(insurance),
    });
    if let Some(home) = home.as_ref() {
        insurance_input["folder_id"] = json!(home);
    }
    seeder.run("core.add_document", insurance_input);
}

// ---------------------------------------------------------------------------
// Photos.
//
// The frames' titles, places and capture times are v0's, and the bytes are the
// eighteen PNGs under `sample/photos/`, compiled in.
// ---------------------------------------------------------------------------

/// WHERE THE ROLL WAS SHOT, frame by frame.
///
/// v0's own table (`photos/seed.js:63`-`:80`), and three of its properties are
/// deliberate rather than incidental — each is a behaviour you can only see if
/// the data has it:
///
///   - Several frames SHARE a coordinate. `find_or_create_place` rounds to
///     four decimals (~11m) for identity, so those collapse into ONE place row
///     with a count above 1 — which is the only way to tell grouping working
///     from grouping being skipped.
///   - Portraits share coordinates with landscapes (Ana at the trailhead sits
///     at the trailhead), so People and Places intersect on one asset.
///   - The home frames sit hundreds of kilometres from the trip, so the shelf
///     has to show a trip AND a home rather than one undifferentiated blob.
///
/// Frames left OUT stay place-less, and that is a case too: a camera roll where
/// every frame knows where it was is not a camera roll anybody has.
const HOME_BACKYARD: (f64, f64) = (37.4419, -122.143);
const EMBARCADERO: (f64, f64) = (37.7955, -122.3937);
const TALLAC_TRAILHEAD: (f64, f64) = (38.9186, -120.0836);
const WEST_SHORE_RIDGE: (f64, f64) = (39.0021, -120.1131);

fn place_of(file: &str) -> Option<(f64, f64)> {
    Some(match file {
        "downtown-blue-hour.png" | "harbor-lights.png" | "marco-harbor-wall.png" => EMBARCADERO,
        "cabin-window-morning.png" => (39.0682, -120.1268),
        "trailhead-sign.png" | "ana-trailhead.png" => TALLAC_TRAILHEAD,
        "granite-switchback.png" => (38.9067, -120.0917),
        "sand-harbor-dawn.png" => (39.1979, -119.9308),
        "truckee-river-bend.png" => (39.1682, -120.1429),
        "emerald-bay-overlook.png" => (38.9542, -120.1094),
        "tahoe-dusk-ridge.png" | "tahoe-pan.mp4" => WEST_SHORE_RIDGE,
        "backyard-last-light.png"
        | "ana-kitchen-window.png"
        | "ana-porch-evening.png"
        | "ana-and-marco-table.png" => HOME_BACKYARD,
        _ => return None,
    })
}

/// Pacific daylight time — the whole roll is one American trip.
const TZ_OFFSET_MIN: i64 = -420;

/// One frame of v0's roll.
///
/// `thumbhash` and `phash` are PRECOMPUTED off the same rasters, because a real
/// client's canvas pays for them at upload time and a seeded vault that skipped
/// them would exercise neither the placeholder nor the near-duplicate join.
struct Frame {
    file: &'static str,
    title: &'static str,
    day: i64,
    hour: i64,
    month_offset: i64,
    width: i64,
    height: i64,
    thumbhash: &'static str,
    phash: &'static str,
    favorite: bool,
}

/// `at` is `(day, hour)` and `size` is `(width, height)`.
///
/// Grouped into pairs rather than eight positionals: clippy's
/// `too_many_arguments` fires at eight, and two of the four numbers were
/// already a coordinate and two were already a dimension — so the pairs are
/// what the call sites meant, not a workaround for the lint.
const fn frame(
    file: &'static str,
    title: &'static str,
    at: (i64, i64),
    size: (i64, i64),
    thumbhash: &'static str,
    phash: &'static str,
) -> Frame {
    Frame {
        file,
        title,
        day: at.0,
        hour: at.1,
        month_offset: 0,
        width: size.0,
        height: size.1,
        thumbhash,
        phash,
        favorite: false,
    }
}

/// THE LANDSCAPE ROLL, newest last (`photos/seed.js:98`-`:203`).
///
/// The `month_offset` frames are months old on purpose: a timeline whose every
/// frame is from this fortnight has no scroll and no year headers in it.
fn roll() -> Vec<Frame> {
    vec![
        Frame {
            month_offset: -24,
            ..frame(
                "downtown-blue-hour.png",
                "Downtown at blue hour",
                (-13, 20),
                (360, 240),
                "DPcFFYJIeHl1eHdweIdoeJeAfAeI",
                "3727170f8b494d6e",
            )
        },
        Frame {
            month_offset: -24,
            ..frame(
                "harbor-lights.png",
                "Harbor lights from the pier",
                (-13, 21),
                (270, 360),
                "TPcFDQJoiHJ4B3dXiHqHR4hwiQcn",
                "935517099b3bb235",
            )
        },
        Frame {
            month_offset: -13,
            ..frame(
                "cabin-window-morning.png",
                "First morning from the cabin window",
                (-11, 7),
                (270, 360),
                "XdcVFQJ3d4+HV4hXh4eHd4dwhwk3",
                "0f0f0f272b958f27",
            )
        },
        Frame {
            month_offset: -8,
            ..frame(
                "trailhead-sign.png",
                "Trailhead before the climb",
                (-9, 9),
                (270, 360),
                "mOgNDQJoiI93R5dXd4h3h1iMgAeH",
                "0f072f0d4d554149",
            )
        },
        Frame {
            month_offset: -4,
            ..frame(
                "granite-switchback.png",
                "Granite switchbacks",
                (-9, 11),
                (360, 240),
                "G+cNLYZod3h/d3dzh1iId4iAhghY",
                "0f0f0f171f9f0f97",
            )
        },
        frame(
            "sand-harbor-dawn.png",
            "Sand Harbor at dawn",
            (-4, 6),
            (360, 240),
            "JNcJDYJYd3d/d4d0iCeIh5hwgAkn",
            "1f0f0f0e57334f25",
        ),
        Frame {
            favorite: true,
            ..frame(
                "truckee-river-bend.png",
                "Bend in the Truckee",
                (-4, 10),
                (360, 240),
                "m9cJFYQ3eIh/eXeGh0h3dKhwhApY",
                "170f0f0b1b09071f",
            )
        },
        Frame {
            favorite: true,
            ..frame(
                "emerald-bay-overlook.png",
                "Emerald Bay overlook",
                (-3, 19),
                (360, 240),
                "UwcKDYJnd3iPd4dzh1iHhrdwc/hX",
                "1f0f0f1337250d17",
            )
        },
        frame(
            "tahoe-dusk-ridge.png",
            "Dusk over the west shore",
            (-3, 20),
            (360, 240),
            "DAcKDYJod3d7h4hweHiIeJiAi2gH",
            "1d2b070f5b371e4b",
        ),
        frame(
            "backyard-last-light.png",
            "Last light in the backyard",
            (-1, 19),
            (360, 240),
            "GDgOJYhneHiIeHeAiKh3h3eAcVcI",
            "0f170f0f0f4f4bc9",
        ),
    ]
}

/// THE PORTRAIT HALF (`photos/seed.js:212`-`:348`).
///
/// The landscape roll has no people in it, so People, face review and the whole
/// triage verb had nothing to render on a fresh vault — the one flow v0's pass
/// rewrote was also the one flow a seeded vault could not reach.
///
/// These are ORIGINAL procedurally drawn frames, not photographs of anyone and
/// not any third party's character art: every byte here has to be ours to
/// distribute. v0's note says they are drawn with human face geometry rather
/// than a stylised one, because a detector trained on human faces is what would
/// eventually run over them.
///
/// **The face BOXES are not ported.** v0 stages them as `media.face_region`
/// proposals; that is the recognition plane, and seeding boxes for a plane this
/// build does not run would be rows nothing reads. The frames themselves carry
/// the faces, so the boxes are one detection pass away whenever that lands.
fn portraits() -> Vec<Frame> {
    vec![
        frame(
            "ana-kitchen-window.png",
            "Ana by the kitchen window",
            (-12, 9),
            (270, 360),
            "6QcKHQTqdn9pZme4V3x1Z3dvUvQF",
            "303878783ce480c0",
        ),
        frame(
            "marco-workshop.png",
            "Marco in the workshop",
            (-10, 15),
            (270, 360),
            "oSgKDQTod496lmfIV3x1ZzeAdQSI",
            "0070706c70e88080",
        ),
        frame(
            "ana-trailhead.png",
            "Ana at the trailhead",
            (-8, 11),
            (270, 360),
            "pecJHQTXeH+KdmjXSIxlZ0iJgIAI",
            "0070704454c88080",
        ),
        frame(
            "marco-harbor-wall.png",
            "Marco by the harbour wall",
            (-6, 17),
            (270, 360),
            "IQgKHQjZd495lmfIV3tmaDaAZwN4",
            "0030705064ec80c0",
        ),
        frame(
            "ana-and-marco-table.png",
            "Ana and Marco at the table",
            (-4, 20),
            (270, 360),
            "pCgODQKZp3+IuHe4d4lIWFDuBHRO",
            "0000ccccbcba30dc",
        ),
        frame(
            "ana-profile-doorway.png",
            "Someone in the doorway",
            (-3, 18),
            (270, 360),
            "IwgOFQSQd2iXd4iYaIl2eISfYOYJ",
            "0060e0a890100000",
        ),
        frame(
            "ana-porch-evening.png",
            "Ana on the porch",
            (-2, 19),
            (270, 360),
            "oygKNQaod496hoe3V3yUZ5h/hvlX",
            "007070544cec8086",
        ),
        frame(
            "empty-hallway.png",
            "The hallway, no one in it",
            (-1, 13),
            (270, 360),
            "aAgKBQB3iI94d4iXd3iHiEd/dYA3",
            "0030300c0c0c0000",
        ),
    ]
}

/// The four frames that made the "where are we staying" shortlist.
const ALBUM_TITLE: &str = "Tahoe scouting";
const ALBUM_FILES: [&str; 4] = [
    "emerald-bay-overlook.png",
    "tahoe-dusk-ridge.png",
    "truckee-river-bend.png",
    "granite-switchback.png",
];
const ALBUM_COVER: &str = "emerald-bay-overlook.png";

/// THE SAMPLE ROLL, COMPILED IN.
///
/// `include_bytes!` and not a runtime read: a phone has no repository to read
/// them from, and the dev binary is run from wherever cargo puts it. 672 KB of PNG across eighteen frames, every one of them 360 px
/// or less on its long edge — which is v0's own ceiling, chosen so the grid
/// paints an original directly instead of probing a `?variant=thumb`
/// derivative nothing has generated.
macro_rules! sample {
    ($($file:literal),* $(,)?) => {
        fn sample_bytes(file: &str) -> Option<&'static [u8]> {
            match file {
                $($file => Some(include_bytes!(concat!("sample/photos/", $file))),)*
                _ => None,
            }
        }
    };
}

sample!(
    "ana-and-marco-table.png",
    "ana-kitchen-window.png",
    "ana-porch-evening.png",
    "ana-profile-doorway.png",
    "ana-trailhead.png",
    "backyard-last-light.png",
    "cabin-window-morning.png",
    "downtown-blue-hour.png",
    "emerald-bay-overlook.png",
    "empty-hallway.png",
    "granite-switchback.png",
    "harbor-lights.png",
    "marco-harbor-wall.png",
    "marco-workshop.png",
    "sand-harbor-dawn.png",
    "tahoe-dusk-ridge.png",
    "trailhead-sign.png",
    "truckee-river-bend.png",
);

/// A tiny deterministic MP4 payload — a `ftyp` box and nothing else.
///
/// v0's own fixture, and its reason holds: the corpus needs media-kind
/// DIVERSITY, not playback fidelity. The viewer's capability rows and the
/// video badge read the vault's honest kind and duration; the bytes only have
/// to be real enough to have a sha and a media type.
const VIDEO_BASE64: &str = "AAAAHGZ0eXBtcDQyAAAAAG1wNDJpc29t";

/// ONE FRAME'S CALL, with its bytes.
///
/// The coordinate pair is spread in only when the frame has one: a
/// place-less frame must send NEITHER, because `media.add_asset` refuses half
/// a coordinate — half of one is no location at all, and accepting it would
/// let this seeder believe it had placed a photograph it had not.
fn frame_input(frame: &Frame, now: i64) -> Option<Value> {
    let bytes = sample_bytes(frame.file)?;
    let mut input = json!({
        "data_uri": format!(
            "data:image/png;base64,{}",
            base64_of(bytes),
        ),
        "kind": "photo",
        "title": frame.title,
        "captured_at": at(now, frame.day, frame.hour, frame.month_offset),
        "tz_offset_min": TZ_OFFSET_MIN,
        "width": frame.width,
        "height": frame.height,
        "thumbhash": frame.thumbhash,
        "phash": frame.phash,
    });
    if let Some((lat, lng)) = place_of(frame.file) {
        let object = input.as_object_mut().expect("the input is an object");
        object.insert("latitude".to_owned(), json!(lat));
        object.insert("longitude".to_owned(), json!(lng));
    }
    Some(input)
}

/// Standard base64, no line breaks — what a `data:` URI carries.
fn base64_of(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let packed = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for shift in [18, 12, 6, 0] {
            out.push(char::from(ALPHABET[((packed >> shift) & 0x3F) as usize]));
        }
        // The pad says how many of the last four characters are real.
        let padding = 3 - chunk.len();
        out.truncate(out.len() - padding);
        for _ in 0..padding {
            out.push('=');
        }
    }
    out
}

/// The camera roll: eighteen frames with REAL BYTES, one video, one album.
///
/// **The bytes are the point.** The first port of this seed sent titles and
/// capture times with no `data_uri` at all, because `media.add_asset` had no
/// handler — the blob door was missing from `CommandCtx`, so a vault could
/// hold a note and not a photograph, and Photos seeded zero on every run. The
/// door exists now (`Vault::with_blobs`), so this is v0's scenario entire:
/// the same frames, the same places, the same two favourites, the same
/// shortlist album.
fn seed_photos(seeder: &mut Seeder, now: i64) {
    let mut asset_by_file: std::collections::BTreeMap<&str, String> =
        std::collections::BTreeMap::new();
    // STRICTLY IN ORDER, as v0 runs them: ids are minted per invocation, so a
    // shuffled roll shuffles the timeline's tie-breaks and the album's member
    // positions run to run — and reproducibility is what a scenario generator
    // is for.
    for frame in roll().into_iter().chain(portraits()) {
        let Some(input) = frame_input(&frame, now) else {
            continue;
        };
        let Some(output) = seeder.run("media.add_asset", input) else {
            continue;
        };
        let Some(asset_id) = Seeder::id(Some(&output), "asset_id") else {
            continue;
        };
        asset_by_file.insert(frame.file, asset_id.clone());
        if frame.favorite {
            // The general editor rather than `set_favorite`: one command, and
            // it is the path the app's own detail pane takes.
            seeder.run(
                "media.update_asset",
                json!({ "asset_id": asset_id, "favorite": 1 }),
            );
        }
    }

    // THE ONE VIDEO, which is what makes the video badge something a screenshot
    // can show — and the one cell in the demo library that draws no image.
    // Nothing in this workspace writes a `poster` derivative, so the mosaic has
    // no still to fall back to and says so by drawing an empty cell.
    seeder.run(
        "media.add_asset",
        json!({
            "data_uri": format!("data:video/mp4;base64,{VIDEO_BASE64}"),
            "kind": "video",
            "title": "Tahoe shoreline pan",
            "captured_at": at(now, -2, 17, 0),
            "tz_offset_min": TZ_OFFSET_MIN,
            "width": 360,
            "height": 240,
            "duration_s": 12,
            "latitude": WEST_SHORE_RIDGE.0,
            "longitude": WEST_SHORE_RIDGE.1,
        }),
    );

    seed_album(seeder, &asset_by_file);
}

/// The shortlist, as an album with a cover.
///
/// Separate from the roll because it can only run AFTER it: an album of four
/// frames needs those four frames to have ids, and a cover needs to be a member
/// of the album it covers.
fn seed_album(seeder: &mut Seeder, asset_by_file: &std::collections::BTreeMap<&str, String>) {
    let Some(output) = seeder.run("media.create_album", json!({ "title": ALBUM_TITLE })) else {
        return;
    };
    let Some(album_id) = Seeder::id(Some(&output), "album_id") else {
        return;
    };
    for file in ALBUM_FILES {
        let Some(asset_id) = asset_by_file.get(file) else {
            continue;
        };
        seeder.run(
            "media.add_to_album",
            json!({ "album_id": album_id, "asset_id": asset_id }),
        );
    }
    if let Some(cover) = asset_by_file.get(ALBUM_COVER) {
        seeder.run(
            "media.set_album_cover",
            json!({ "album_id": album_id, "asset_id": cover }),
        );
    }
}

// ---------------------------------------------------------------------------
// Tasks.
//
// "A believable week on the board — overdue errands, a project with subtasks,
// done items, a someday idea." The project is a real `schedule_project` with a
// section, so the project place is reachable (#1047).
// ---------------------------------------------------------------------------

fn seed_tasks(seeder: &mut Seeder, now: i64) {
    let add = |seeder: &mut Seeder, input: Value| -> Option<String> {
        let output = seeder.run("schedule.add_task", input);
        Seeder::id(output.as_ref(), "task_id")
    };

    for input in [
        json!({ "title": "Rotate the tires before the drive", "due_at": at(now, -2, 9, 0), "priority": 8 }),
        json!({ "title": "Book dentist appointment", "due_at": at(now, 1, 9, 0), "priority": 5, "effort_min": 15 }),
        json!({
            "title": "Pick up the dry cleaning",
            "description": "Ticket is on the fridge.",
            "due_at": at(now, 0, 9, 0),
            "priority": 3,
        }),
    ] {
        add(seeder, input);
    }

    let trip = add(
        seeder,
        json!({
            "title": "Plan the Tahoe trip",
            "description": "Long weekend at the lake with Maya, Jake and Chris.",
            "due_at": at(now, 7, 9, 0),
            "priority": 6,
        }),
    );
    // A PROJECT, so Tasks' project place has something to open (#1047): the
    // trip, filed under its "Booking" section, with a second task beside it.
    let project = Seeder::id(
        seeder
            .run(
                "schedule.save_project",
                json!({ "name": "Tahoe trip", "color": "steelblue", "sort_order": 1 }),
            )
            .as_ref(),
        "project_id",
    );
    if let Some(project) = project.as_ref() {
        let section = Seeder::id(
            seeder
                .run(
                    "schedule.save_section",
                    json!({ "project_id": project, "name": "Booking", "sort_order": 1 }),
                )
                .as_ref(),
            "section_id",
        );
        let lift = add(
            seeder,
            json!({ "title": "Buy lift tickets online", "due_at": at(now, 5, 9, 0), "priority": 4 }),
        );
        for (task, sort_order) in [(trip.as_ref(), 1), (lift.as_ref(), 2)] {
            let Some(task) = task else { continue };
            let mut input =
                json!({ "task_id": task, "project_id": project, "sort_order": sort_order });
            if let Some(section) = section.as_ref() {
                input["section_id"] = json!(section);
            }
            seeder.run("schedule.organize_task", input);
        }
    }
    if let Some(trip) = trip.as_ref() {
        for input in [
            json!({ "title": "Compare cabins — South Lake vs Truckee", "parent_task_id": trip, "effort_min": 45 }),
            json!({ "title": "Book the Tahoe cabin", "parent_task_id": trip, "due_at": at(now, 3, 9, 0) }),
        ] {
            add(seeder, input);
        }
        let packed = add(
            seeder,
            json!({ "title": "Draft packing list", "parent_task_id": trip }),
        );
        if let Some(packed) = packed {
            seeder.run(
                "schedule.set_task_status",
                json!({ "task_id": packed, "status": "completed" }),
            );
        }
    }

    let groceries = add(
        seeder,
        json!({ "title": "Weekly grocery run", "due_at": at(now, -1, 9, 0), "priority": 4 }),
    );
    if let Some(groceries) = groceries {
        seeder.run(
            "schedule.set_task_status",
            json!({ "task_id": groceries, "status": "completed" }),
        );
    }
    add(
        seeder,
        json!({ "title": "Learn to make sourdough", "priority": 1 }),
    );
}

// ---------------------------------------------------------------------------
// Agenda.
//
// "One lived-in week on the calendar — something small today so the brief is
// never blank, dinner with a friend, a deadline, a weekly recurring run with a
// reminder, and next week's dentist." Every slot is DISJOINT: `propose_event`
// refuses any busy overlap, vault-wide.
//
// No attendees, which is v0's own note: resolving "Maya" to a party here would
// either race the people seed or mint a duplicate of their friend. The dinner
// names her in the summary instead.
// ---------------------------------------------------------------------------

fn seed_agenda(seeder: &mut Seeder, now: i64, calendar_id: &str) {
    let slot = |days: i64, hour: i64, minute: i64, minutes: i64| {
        let start = at(now, days, hour, minute);
        let end = at(now, days, hour, minute + minutes);
        (start, end)
    };
    /// One seeded event: title, description, `(starts_at, ends_at)`, rrule.
    type SeededEvent = (
        &'static str,
        Option<&'static str>,
        (String, String),
        Option<&'static str>,
    );
    let events: [SeededEvent; 5] = [
        ("Pick up the dry cleaning", None, slot(0, 17, 0, 30), None),
        (
            "Morning run",
            Some("Loop around the reservoir."),
            slot(1, 6, 30, 45),
            Some("FREQ=WEEKLY"),
        ),
        (
            "Dinner with Maya",
            Some("She picked the place — Thai, near the park."),
            slot(2, 19, 0, 120),
            None,
        ),
        (
            "Book the Tahoe cabin",
            Some("Last call before the long-weekend rates jump."),
            slot(3, 9, 0, 30),
            None,
        ),
        ("Dentist — cleaning", None, slot(8, 15, 0, 60), None),
    ];
    for (summary, description, (dtstart, dtend), rrule) in events {
        let mut input = json!({
            "calendar_id": calendar_id,
            "summary": summary,
            "dtstart": dtstart,
            "dtend": dtend,
        });
        if let Some(description) = description {
            input["description"] = json!(description);
        }
        if let Some(rrule) = rrule {
            input["rrule"] = json!(rrule);
        }
        seeder.run("schedule.propose_event", input);
    }
}

// ---------------------------------------------------------------------------
// Tally.
//
// "Three friends, one trip group and a lived-in expense ledger — uneven payers,
// exact splits, one settlement." Balances stay DERIVED, never stored, so the
// seeded ledger exercises the whole projection.
// ---------------------------------------------------------------------------

/// Split `amount` across `parties` exactly — the remainder lands on the payer.
fn even(amount: i64, parties: &[String], payer: &str) -> Vec<Value> {
    let base = amount / parties.len() as i64;
    let mut rest = amount - base * parties.len() as i64;
    parties
        .iter()
        .map(|party| {
            let mut share = base;
            if party == payer {
                share += rest;
                rest = 0;
            }
            json!({ "party_id": party, "share_minor": share })
        })
        .collect()
}

fn seed_tally(
    seeder: &mut Seeder,
    now: i64,
    me: &str,
    people: &std::collections::BTreeMap<&'static str, String>,
) {
    let mut friends = Vec::new();
    for name in ["Maya", "Jake", "Chris"] {
        // The People party when there is one — `add_friend`'s existing-party
        // branch — so Tally and People name one human with one party.
        let input = match people.get(name) {
            Some(party_id) => json!({ "name": name, "party_id": party_id }),
            None => json!({ "name": name }),
        };
        let output = seeder.run("tally.add_friend", input);
        if let Some(party) = Seeder::id(output.as_ref(), "party_id") {
            friends.push(party);
        }
    }
    if friends.len() != 3 {
        return;
    }
    let (maya, jake, chris) = (friends[0].clone(), friends[1].clone(), friends[2].clone());

    // The icon is rendered verbatim and must come from the emoji set, never a
    // lucide name.
    let group = Seeder::id(
        seeder
            .run(
                "tally.create_group",
                json!({
                    "name": "Tahoe Trip",
                    "icon": "🏔️",
                    "color": "steelblue",
                    "member_ids": friends,
                }),
            )
            .as_ref(),
        "group_id",
    );
    let Some(group) = group else { return };

    let everyone: Vec<String> = std::iter::once(me.to_owned())
        .chain(friends.iter().cloned())
        .collect();
    /// One seeded expense: description, minor units, payer, category, days
    /// ago, and the parties it splits between (`None` is everyone).
    type SeededExpense<'a> = (&'a str, i64, &'a String, &'a str, i64, Option<Vec<String>>);
    let expenses: [SeededExpense<'_>; 5] = [
        ("Cabin deposit", 30_000, &everyone[0], "travel", 6, None),
        ("Gas for the drive up", 4_820, &jake, "transport", 6, None),
        (
            "Groceries for the cabin",
            11_267,
            &maya,
            "groceries",
            5,
            None,
        ),
        (
            "Ski rentals",
            9_200,
            &chris,
            "fun",
            4,
            Some(vec![me.to_owned(), maya.clone(), chris.clone()]),
        ),
        ("Lift tickets", 6_000, &everyone[0], "travel", 4, None),
    ];
    for (description, amount, payer, category, days_ago, parties) in expenses {
        let parties = parties.unwrap_or_else(|| everyone.clone());
        seeder.run(
            "tally.add_expense",
            json!({
                "group_id": group,
                "description": description,
                "amount_minor": amount,
                "paid_by": payer,
                "category": category,
                "spent_on": day(now, -days_ago),
                "splits": even(amount, &parties, payer),
            }),
        );
    }

    seeder.run(
        "tally.settle_up",
        json!({
            "from_party": chris,
            "to_party": me,
            "amount_minor": 5_000,
            "group_id": group,
            "paid_on": day(now, -2),
        }),
    );
}
