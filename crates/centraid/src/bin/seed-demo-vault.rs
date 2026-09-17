//! THE DEMO SCENARIO, PORTED (#1020, wave A; v0 `#290` and `#708`).
//!
//! ```text
//! cargo run -p centraid --bin seed-demo-vault -- <dir> [options]
//!
//!   --file <name>   the file to write inside <dir>  (default demo-vault.db)
//!   --name <text>   the vault's display name        (default "Demo vault")
//!   --only <a,b,c>  seed only these apps            (default: all seven)
//!   --force         overwrite a file that is ALREADY a vault
//! ```
//!
//! **WHY A SECOND VAULT IS SEEDABLE AT ALL.** The switcher is only testable
//! against two, and two vaults holding the same rows under the same name would
//! prove nothing: a switch that quietly did not happen would look exactly like
//! one that did. `--only` is what makes the difference VISIBLE on the
//! springboard — a vault seeded `--only docs,tasks,agenda` draws People, Notes,
//! Photos and Tally as genuinely empty, which is a state the grid already knows
//! how to say and does not have to invent.
//!
//! **One scenario across seven apps** — agenda, docs, notes, people, photos,
//! tally and tasks: one weekend at Tahoe with Maya, Jake, Grandpa Ray and
//! Chris, with notes, a packing list and an uneven expense ledger. A demo
//! corpus is for reading like somebody's life rather than like
//! `Item 1, Item 2`.
//!
//! **Locker has no seed.** A demo vault that fabricates a member's saved passwords is a
//! demo vault nobody should trust, and Locker's tile has something true to say
//! either way — its body is a STATE, not a query result.
//!
//! **THROUGH THE REAL COMMAND PLANE, never SQL.** `sql-confinement` refuses SQL
//! outside `crates/{ontology,vault,seat,search}` and `crates/apps/kit`, and the
//! refusal is what makes this fixture worth anything: rows written by
//! `Vault::execute` carry the `core_entity` siblings, the `row_version` and the
//! ledger entries a real write produces, so a tile reading them reads the shape
//! the product actually stores.
//!
//! **It is a DEV binary and it is not the product.** v0 kept the same
//! separation — its seeds sat behind a gateway route the shipped app called
//! only from a "fill with sample data" offer on the first-run screen. The vault
//! it writes is a throwaway.
//!
//! **AND `--file` IS THE INVITATION TO BREAK THAT, SO THE GUARD IS HERE.** This
//! run deletes `<dir>/<file>` and its `-wal`, `-shm` and `.bytes` siblings
//! before it founds, because a demo seeded on top of a previous run has counts
//! nobody can predict. Pointed at a gateway's own vault directory — which is
//! one `--file vault.db` away — that deletes the vault a gateway is serving and
//! founds a new one under a NEW `vault_id` in a directory still named after the
//! old one. It reported `CENTRAID_SEEDED` and looked like a success: a seat
//! bootstrapped off it, drew the founding state, and `MAX(seq)` in the log had
//! gone 1101 → 146. Two scenario runs were spent looking for a sync bug that
//! was not there.
//!
//! So a file that already holds a `core_vault` row is REFUSED by name, and
//! `--force` is the only way past. "It is a dev binary" is the argument for the
//! guard and not against it: a dev binary that can silently destroy a gateway's
//! vault is the one class worth guarding, and the cost is one read.
//!
//! **What did NOT come across, and why.** v0's photos seed generates real JPEG
//! bytes for eighteen frames and stages face proposals over them; the frames'
//! titles and capture times are here and the BYTES are not, because nothing on
//! either shell reads a thumbnail yet (Home's mosaic draws cells, not images).
//! When the blob door lands, the byte half of that seed is the next thing to
//! port and `v0 photos/seed.js` is where it is.

use std::path::PathBuf;

use centraid_api_proto::core_v1 as wire;
use centraid_vault::commands::{Command, CommandStatus, Registry};
use centraid_vault::{Principal, Vault};
use serde_json::{Value, json};

/// Where the scenario's "now" is anchored.
///
/// v0's seeds took `input.now` and derived every date from it, so a reload
/// reproduced the same week. Here it is the wall clock, because the whole point
/// of the scenario is that today has something on it — an agenda seeded around
/// a fixed instant is a demo that is empty by next month.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or_default()
}

const DAY_MS: i64 = 86_400_000;

/// An ISO-8601 instant `days` from the anchor, at `hour:minute` UTC.
///
/// Deliberately arithmetic: this file has no business carrying a second opinion
/// about civil time, and every consumer treats these as opaque ordering keys.
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
///
/// A refusal is LOUD and the run continues: one app's schema drifting is not a
/// reason to leave the other six empty, and a silent skip would be a demo whose
/// gaps nobody can see. `Failed` carries the owner-facing sentence, which is
/// the thing worth printing — it is the same sentence a member would have got.
struct Seeder<'a> {
    vault: &'a Vault,
    registry: &'a Registry,
    principal: &'a Principal,
    refused: Vec<String>,
    /// Commands that are registered and have no body yet, named once each.
    gaps: std::collections::BTreeSet<String>,
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
                eprintln!("seed-demo-vault: {name} refused: {why}");
                self.refused.push(format!("{name}: {why}"));
                None
            }
            // A COMMAND WITH NO BODY IS A GAP, NOT A REFUSAL, and the
            // difference is worth keeping: a refusal means the vault said no to
            // this input, and a gap means nobody can seed that app at all yet.
            // Exactly one command in the whole registry is in the second state
            // — `media.add_asset`, whose own comment says moving bytes needs a
            // blob door on `CommandCtx` — so Photos seeds to nothing and Home
            // draws it EMPTY, which is true.
            Err(centraid_vault::VaultError::NotImplemented { name }) => {
                self.gaps.insert(name);
                None
            }
            Err(error) => {
                eprintln!("seed-demo-vault: {name} errored: {error}");
                self.refused.push(format!("{name}: {error}"));
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

/// Which apps this run seeds.
///
/// `--only` NAMES WHAT TO KEEP rather than what to drop, because a list of
/// exclusions gets silently wrong every time an app is added: a new app would
/// join every vault that had never heard of it. A list of inclusions leaves a
/// new app out until somebody asks for it, which is the safer direction for a
/// fixture.
struct Wanted(Option<std::collections::BTreeSet<String>>);

impl Wanted {
    fn has(&self, app: &str) -> bool {
        self.0.as_ref().is_none_or(|only| only.contains(app))
    }
}

/// The scenario's options, off the command line.
struct Options {
    dir: PathBuf,
    file: String,
    name: String,
    wanted: Wanted,
    /// Overwrite a file that is already a vault. Off by default; see the
    /// module header for what it is protecting.
    force: bool,
}

fn options() -> Options {
    let mut args = std::env::args().skip(1);
    let mut dir = None;
    let mut file = "demo-vault.db".to_owned();
    let mut name = "Demo vault".to_owned();
    let mut wanted = Wanted(None);
    let mut force = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--force" => force = true,
            "--file" => file = args.next().expect("--file takes a name"),
            "--name" => name = args.next().expect("--name takes a display name"),
            "--only" => {
                wanted = Wanted(Some(
                    args.next()
                        .expect("--only takes a comma-separated list")
                        .split(',')
                        .map(|app| app.trim().to_owned())
                        .filter(|app| !app.is_empty())
                        .collect(),
                ));
            }
            // The FIRST bare argument is the directory; a second is a typo, and
            // a fixture generator that silently ignored one would write its
            // vault somewhere the caller is not looking.
            other if dir.is_none() => dir = Some(PathBuf::from(other)),
            other => panic!("seed-demo-vault: unexpected argument {other:?}"),
        }
    }
    Options {
        dir: dir.unwrap_or_else(|| PathBuf::from("/tmp/centraid-demo")),
        file,
        name,
        wanted,
        force,
    }
}

/// The process exit code a refusal leaves.
///
/// Non-zero and its own number, so a script that seeds before it runs a
/// scenario stops rather than carrying on over a vault it did not seed.
const REFUSED: i32 = 2;

/// Refuse a file that is already somebody's vault (#1025 S5).
///
/// Answered by `Vault::vault_id`, which is the vault's own question and needs
/// no SQL here — `sql-confinement` would refuse a query in this crate, and it
/// is right to.
///
/// A file that is NOT a vault is not a refusal: an empty file left by an
/// aborted run, or a path that does not exist, is exactly what this tool is
/// for. What it will not do is delete a founded vault it was not told to.
fn refuse_an_existing_vault(vault_path: &std::path::Path, force: bool) {
    if !vault_path.exists() {
        return;
    }
    let Ok(vault) = Vault::open(vault_path) else {
        // Not a Centraid file at all. The remove below is what it always was.
        return;
    };
    let found = vault.vault_id().ok().flatten();
    // Closed before anything else touches the path: an open handle over a file
    // that is about to be removed is how a `-wal` outlives its database.
    let _ = vault.close();
    let Some(vault_id) = found else {
        return;
    };
    if force {
        eprintln!(
            "seed-demo-vault: --force: overwriting vault {vault_id} at {}",
            vault_path.display()
        );
        return;
    }
    // BY NAME AND LOUDLY. The id is what tells a caller which vault they were
    // about to lose, and the path is what tells them how they got there.
    eprintln!(
        "seed-demo-vault: {} already holds vault {vault_id}.\n\
         This tool DELETES the file it seeds, so running here would destroy that vault \
         and found a new one with a new id.\n\
         Seed somewhere else, or pass --force if that is really what you meant.",
        vault_path.display()
    );
    std::process::exit(REFUSED);
}

fn main() {
    let Options {
        dir,
        file,
        name: vault_name,
        wanted,
        force,
    } = options();
    std::fs::create_dir_all(&dir).expect("the directory is made");
    let vault_path = dir.join(&file);
    // BEFORE A BYTE IS REMOVED. The removal below is unconditional and the
    // founding after it is too, so this is the only place the question can be
    // asked at all (see the module header for the run that proved it).
    refuse_an_existing_vault(&vault_path, force);
    // A FRESH FILE EVERY TIME. A demo vault seeded on top of a previous run's
    // rows has counts nobody can predict, and the counts are what Home draws.
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(dir.join(format!("{file}{suffix}")));
    }
    // AND ITS BYTES. The content store travels with the file it belongs to, so
    // a fresh vault over a previous run's store would dedupe against
    // photographs this run has not seeded yet and report counts nobody can
    // predict — which is the same reason the file itself is removed.
    let bytes_dir = vault_path.with_extension("bytes");
    let _ = std::fs::remove_dir_all(&bytes_dir);

    let handle = centraid_core::Core::open(centraid_core::CoreConfig::gateway(&vault_path))
        .expect("a core opens");

    // THE ONE CONTENT STORE, SEEDED DIRECTLY (#1025 S3, D-1025-S3-1).
    //
    // The bytes are the point of this seed: the first port sent titles with no
    // `data_uri` at all and Photos seeded zero on every run. A core with no
    // store refuses every photograph by name, so the store is opened here and
    // put on the vault's byte door — the SAME store `centraid gateway` then
    // serves a seat's `blob` streams from. There is no CAS to import any more,
    // and no second directory for the two halves to disagree about.
    //
    // The runtime is leaked with the process: this binary seeds and exits, and
    // shutting an iroh store down from a `Drop` that may run on one of its own
    // threads is a deadlock for no gain.
    let runtime = Box::leak(Box::new(
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("a runtime"),
    ));
    let store = runtime
        .block_on(centraid_blobs::ByteStore::open(&bytes_dir))
        .expect("the content store opens");
    // A CLONE KEPT TO CLOSE IT WITH (#1025 S7).
    //
    // iroh-blobs flushes its index on shutdown, and this binary never shut the
    // store down: it seeded, exited, and left `.data` files the store's own
    // index did not know were whole. A gateway opened on that directory then
    // RESET the `blob` stream for those blobs — and because the byte plane used
    // to stop the window on the first refusal, **the whole plane stopped for
    // ever and every photograph on the phone stayed a placeholder**. Nothing
    // failed at seed time and nothing was red; it took driving the loop end to
    // end to see it.
    let to_close = store.clone();
    handle.attach_bytes(centraid_blobs::ContentBytes::new(
        store,
        runtime.handle().clone(),
    ));

    // The calendar is discovered, never hard-coded — v0's agenda seed says so in
    // its own words. It exists because `Vault::found` mints a private
    // "Personal" calendar; see that function for why the port had to restore it.
    let calendar_id = first_row(&handle, "schedule_calendar", "calendar_id");

    let now = now_ms();
    let report = handle
        .with_vault(|vault| {
            let founded = vault.found(&vault_name, "Owner")?;
            let registry = Registry::with_system_commands()?;
            let principal = Principal::owner("demo-device");
            let mut seeder = Seeder {
                vault,
                registry: &registry,
                principal: &principal,
                refused: Vec::new(),
                gaps: std::collections::BTreeSet::new(),
            };
            let mut report = Report::default();
            if wanted.has("people") {
                report.people = seed_people(&mut seeder);
            }
            if wanted.has("notes") {
                report.notes = seed_notes(&mut seeder);
            }
            if wanted.has("docs") {
                report.docs = seed_docs(&mut seeder, now);
            }
            if wanted.has("photos") {
                report.photos = seed_photos(&mut seeder, now);
            }
            if wanted.has("tasks") {
                report.tasks = seed_tasks(&mut seeder, now);
            }
            if wanted.has("tally") {
                report.tally = seed_tally(&mut seeder, now, &founded.owner_party_id);
            }
            report.refused = seeder.refused;
            report.gaps = seeder.gaps;
            Ok(report)
        })
        .expect("the scenario seeds");

    // Agenda LAST and outside the `with_vault` above, because the calendar it
    // needs is written by `found` inside it: the read that discovers the id
    // cannot run while that borrow is alive.
    let calendar_id =
        calendar_id.or_else(|| first_row(&handle, "schedule_calendar", "calendar_id"));
    // NOT WANTED IS NOT MISSING. Folding the two together would make a vault
    // seeded without an agenda print the "this vault has no calendar" warning
    // below, which names a real defect and would then cry wolf on every run.
    let agenda = match calendar_id.filter(|_| wanted.has("agenda")) {
        Some(calendar_id) => handle
            .with_vault(|vault| {
                let registry = Registry::with_system_commands()?;
                let principal = Principal::owner("demo-device");
                let mut seeder = Seeder {
                    vault,
                    registry: &registry,
                    principal: &principal,
                    refused: Vec::new(),
                    gaps: std::collections::BTreeSet::new(),
                };
                Ok(seed_agenda(&mut seeder, now, &calendar_id))
            })
            .expect("the agenda seeds"),
        None => {
            if wanted.has("agenda") {
                eprintln!(
                    "seed-demo-vault: this vault has no calendar, so Agenda stays empty. \
                     `Vault::found` mints one; a vault founded by an older build does not have it."
                );
            }
            0
        }
    };
    handle.close();
    // THE STORE IS FLUSHED BEFORE THIS PROCESS GOES. See the clone above: the
    // artifact this binary leaves is a store another process has to serve from,
    // and an unflushed index is a fixture that lies.
    runtime.block_on(to_close.close());

    println!("CENTRAID_VAULT={}", vault_path.display());
    println!("CENTRAID_VAULT_NAME={vault_name}");
    println!(
        "CENTRAID_SEEDED people={} notes={} docs={} photos={} agenda={} tasks={} tally={} locker=0",
        report.people, report.notes, report.docs, report.photos, agenda, report.tasks, report.tally
    );
    for gap in &report.gaps {
        println!(
            "CENTRAID_GAP={gap} — registered with no body yet, so the app it belongs to seeds nothing"
        );
    }
    if report.refused.is_empty() {
        println!("CENTRAID_REFUSED=0");
    } else {
        // NON-ZERO EXIT ON A PARTIAL SEED. A demo vault that is quietly missing
        // an app is the thing this whole binary exists to stop being invisible.
        println!("CENTRAID_REFUSED={}", report.refused.len());
        for line in &report.refused {
            println!("  {line}");
        }
        std::process::exit(1);
    }
}

/// One column of the first row of a table, through the product's own read door.
///
/// A `PageRequest` and not a `SELECT`: `sql-confinement` refuses SQL in this
/// crate, and the refusal is right — a fixture that reached past the door would
/// be reading a shape no client can.
fn first_row(handle: &centraid_core::Handle, table: &str, column: &str) -> Option<String> {
    let request = wire::Request {
        kind: Some(wire::request::Kind::Page(wire::PageRequest {
            query: Some(wire::PageQuery {
                name: "seed.discover".to_owned(),
                select: vec![column.to_owned()],
                from: table.to_owned(),
                r#where: None,
                bind: Vec::new(),
                order: Some(wire::PageOrder {
                    sort_column: column.to_owned(),
                    pk_column: column.to_owned(),
                    descending: false,
                }),
                with_held_thumbnail: false,
                with_note_body: false,
            }),
            limit: 1,
            after: None,
        })),
    };
    let response = handle.call(&request).ok()?;
    let wire::response::Kind::Page(page) = response.kind? else {
        return None;
    };
    let value = page.rows.first()?.values.first()?;
    match value.kind.as_ref()? {
        wire::value::Kind::Text(text) => Some(text.clone()),
        _ => None,
    }
}

#[derive(Default)]
struct Report {
    people: u32,
    notes: u32,
    docs: u32,
    photos: u32,
    tasks: u32,
    tally: u32,
    refused: Vec<String>,
    gaps: std::collections::BTreeSet<String>,
}

// ---------------------------------------------------------------------------
// People.
//
// "A small living circle — people with contact cadences, logged interactions,
// birthdays, canonical gift tasks and one outstanding debt."
// ---------------------------------------------------------------------------

fn seed_people(seeder: &mut Seeder) -> u32 {
    let mut seeded = 0;
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
            seeded += 1;
            ids.push(party);
        }
    }
    let (maya, jake, grandpa, chris) = match ids.as_slice() {
        [maya, jake, grandpa, chris] => {
            (maya.clone(), jake.clone(), grandpa.clone(), chris.clone())
        }
        _ => return seeded,
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
        if seeder
            .run(
                "people.log_interaction",
                json!({ "party_id": party, "kind": kind, "text": text }),
            )
            .is_some()
        {
            seeded += 1;
        }
    }

    for (party, label, month_day, reminder) in [
        (&grandpa, "Birthday", "08-14", true),
        (&maya, "Birthday", "11-02", false),
    ] {
        if seeder
            .run(
                "people.add_important_date",
                json!({
                    "party_id": party,
                    "label": label,
                    "month_day": month_day,
                    "reminder_on": reminder,
                }),
            )
            .is_some()
        {
            seeded += 1;
        }
    }

    for (party, text) in [
        (&grandpa, "Large-print edition of Lonesome Dove"),
        (&chris, "Fountain pen ink sampler"),
    ] {
        if seeder
            .run(
                "people.add_gift",
                json!({ "party_id": party, "text": text }),
            )
            .is_some()
        {
            seeded += 1;
        }
    }

    if seeder
        .run(
            "people.add_debt",
            json!({
                "party_id": jake,
                "direction": "owe",
                "amount_minor": 15_000,
                "reason": "His half of the cabin deposit",
            }),
        )
        .is_some()
    {
        seeded += 1;
    }
    seeded
}

// ---------------------------------------------------------------------------
// Notes.
//
// "Two notebooks and a handful of lived-in markdown notes, plus one loose
// scratch note."
// ---------------------------------------------------------------------------

fn seed_notes(seeder: &mut Seeder) -> u32 {
    let mut seeded = 0;
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
    seeded += u32::from(travel.is_some()) + u32::from(recipes.is_some());

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
        if seeder.run("knowledge.create_note", input).is_some() {
            seeded += 1;
        }
    }
    seeded
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

fn seed_docs(seeder: &mut Seeder, now: i64) -> u32 {
    let mut seeded = 0;
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
    seeded += u32::from(travel.is_some()) + u32::from(home.is_some());

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
        seeded += 1;
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
    if seeder.run("core.add_document", cabin_input).is_some() {
        seeded += 1;
    }

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
    if seeder.run("core.add_document", insurance_input).is_some() {
        seeded += 1;
    }
    seeded
}

// ---------------------------------------------------------------------------
// Photos — the row half.
//
// The frames' titles and capture times are v0's. The BYTES are not: that seed
// generates eighteen JPEGs and stages face proposals over them, and nothing on
// either shell reads a thumbnail yet.
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

const fn frame(
    file: &'static str,
    title: &'static str,
    day: i64,
    hour: i64,
    width: i64,
    height: i64,
    thumbhash: &'static str,
    phash: &'static str,
) -> Frame {
    Frame {
        file,
        title,
        day,
        hour,
        month_offset: 0,
        width,
        height,
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
                -13,
                20,
                360,
                240,
                "DPcFFYJIeHl1eHdweIdoeJeAfAeI",
                "3727170f8b494d6e",
            )
        },
        Frame {
            month_offset: -24,
            ..frame(
                "harbor-lights.png",
                "Harbor lights from the pier",
                -13,
                21,
                270,
                360,
                "TPcFDQJoiHJ4B3dXiHqHR4hwiQcn",
                "935517099b3bb235",
            )
        },
        Frame {
            month_offset: -13,
            ..frame(
                "cabin-window-morning.png",
                "First morning from the cabin window",
                -11,
                7,
                270,
                360,
                "XdcVFQJ3d4+HV4hXh4eHd4dwhwk3",
                "0f0f0f272b958f27",
            )
        },
        Frame {
            month_offset: -8,
            ..frame(
                "trailhead-sign.png",
                "Trailhead before the climb",
                -9,
                9,
                270,
                360,
                "mOgNDQJoiI93R5dXd4h3h1iMgAeH",
                "0f072f0d4d554149",
            )
        },
        Frame {
            month_offset: -4,
            ..frame(
                "granite-switchback.png",
                "Granite switchbacks",
                -9,
                11,
                360,
                240,
                "G+cNLYZod3h/d3dzh1iId4iAhghY",
                "0f0f0f171f9f0f97",
            )
        },
        frame(
            "sand-harbor-dawn.png",
            "Sand Harbor at dawn",
            -4,
            6,
            360,
            240,
            "JNcJDYJYd3d/d4d0iCeIh5hwgAkn",
            "1f0f0f0e57334f25",
        ),
        Frame {
            favorite: true,
            ..frame(
                "truckee-river-bend.png",
                "Bend in the Truckee",
                -4,
                10,
                360,
                240,
                "m9cJFYQ3eIh/eXeGh0h3dKhwhApY",
                "170f0f0b1b09071f",
            )
        },
        Frame {
            favorite: true,
            ..frame(
                "emerald-bay-overlook.png",
                "Emerald Bay overlook",
                -3,
                19,
                360,
                240,
                "UwcKDYJnd3iPd4dzh1iHhrdwc/hX",
                "1f0f0f1337250d17",
            )
        },
        frame(
            "tahoe-dusk-ridge.png",
            "Dusk over the west shore",
            -3,
            20,
            360,
            240,
            "DAcKDYJod3d7h4hweHiIeJiAi2gH",
            "1d2b070f5b371e4b",
        ),
        frame(
            "backyard-last-light.png",
            "Last light in the backyard",
            -1,
            19,
            360,
            240,
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
            -12,
            9,
            270,
            360,
            "6QcKHQTqdn9pZme4V3x1Z3dvUvQF",
            "303878783ce480c0",
        ),
        frame(
            "marco-workshop.png",
            "Marco in the workshop",
            -10,
            15,
            270,
            360,
            "oSgKDQTod496lmfIV3x1ZzeAdQSI",
            "0070706c70e88080",
        ),
        frame(
            "ana-trailhead.png",
            "Ana at the trailhead",
            -8,
            11,
            270,
            360,
            "pecJHQTXeH+KdmjXSIxlZ0iJgIAI",
            "0070704454c88080",
        ),
        frame(
            "marco-harbor-wall.png",
            "Marco by the harbour wall",
            -6,
            17,
            270,
            360,
            "IQgKHQjZd495lmfIV3tmaDaAZwN4",
            "0030705064ec80c0",
        ),
        frame(
            "ana-and-marco-table.png",
            "Ana and Marco at the table",
            -4,
            20,
            270,
            360,
            "pCgODQKZp3+IuHe4d4lIWFDuBHRO",
            "0000ccccbcba30dc",
        ),
        frame(
            "ana-profile-doorway.png",
            "Someone in the doorway",
            -3,
            18,
            270,
            360,
            "IwgOFQSQd2iXd4iYaIl2eISfYOYJ",
            "0060e0a890100000",
        ),
        frame(
            "ana-porch-evening.png",
            "Ana on the porch",
            -2,
            19,
            270,
            360,
            "oygKNQaod496hoe3V3yUZ5h/hvlX",
            "007070544cec8086",
        ),
        frame(
            "empty-hallway.png",
            "The hallway, no one in it",
            -1,
            13,
            270,
            360,
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
/// `include_bytes!` and not a runtime read: this binary is run from wherever
/// cargo puts it, and a fixture that resolved its assets relative to the
/// working directory is a fixture that works from the repository root and
/// nowhere else. 672 KB of PNG across eighteen frames, every one of them 360 px
/// or less on its long edge — which is v0's own ceiling, chosen so the grid
/// paints an original directly instead of probing a `?variant=thumb`
/// derivative nothing has generated.
macro_rules! sample {
    ($($file:literal),* $(,)?) => {
        fn sample_bytes(file: &str) -> Option<&'static [u8]> {
            match file {
                $($file => Some(include_bytes!(concat!("seed-assets/photos/", $file))),)*
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
fn seed_photos(seeder: &mut Seeder, now: i64) -> u32 {
    let mut seeded = 0;
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
        seeded += 1;
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

    // THE ONE VIDEO, which is what makes the mosaic's poster variant reachable
    // and the video badge something a screenshot can show.
    if seeder
        .run(
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
        )
        .is_some()
    {
        seeded += 1;
    }

    seed_album(seeder, &asset_by_file);
    seeded
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
// done items, a someday idea."
// ---------------------------------------------------------------------------

fn seed_tasks(seeder: &mut Seeder, now: i64) -> u32 {
    let mut seeded = 0;
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
        if add(seeder, input).is_some() {
            seeded += 1;
        }
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
    if trip.is_some() {
        seeded += 1;
    }
    if let Some(trip) = trip.as_ref() {
        for input in [
            json!({ "title": "Compare cabins — South Lake vs Truckee", "parent_task_id": trip, "effort_min": 45 }),
            json!({ "title": "Book the Tahoe cabin", "parent_task_id": trip, "due_at": at(now, 3, 9, 0) }),
        ] {
            if add(seeder, input).is_some() {
                seeded += 1;
            }
        }
        let packed = add(
            seeder,
            json!({ "title": "Draft packing list", "parent_task_id": trip }),
        );
        if let Some(packed) = packed {
            seeded += 1;
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
        seeded += 1;
        seeder.run(
            "schedule.set_task_status",
            json!({ "task_id": groceries, "status": "completed" }),
        );
    }
    if add(
        seeder,
        json!({ "title": "Learn to make sourdough", "priority": 1 }),
    )
    .is_some()
    {
        seeded += 1;
    }
    seeded
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

fn seed_agenda(seeder: &mut Seeder, now: i64, calendar_id: &str) -> u32 {
    let slot = |days: i64, hour: i64, minute: i64, minutes: i64| {
        let start = at(now, days, hour, minute);
        let end = at(now, days, hour, minute + minutes);
        (start, end)
    };
    let mut seeded = 0;
    let events: [(&str, Option<&str>, (String, String), Option<&str>); 5] = [
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
        if seeder.run("schedule.propose_event", input).is_some() {
            seeded += 1;
        }
    }
    seeded
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

fn seed_tally(seeder: &mut Seeder, now: i64, me: &str) -> u32 {
    let mut seeded = 0;
    let mut friends = Vec::new();
    for name in ["Maya", "Jake", "Chris"] {
        let output = seeder.run("tally.add_friend", json!({ "name": name }));
        if let Some(party) = Seeder::id(output.as_ref(), "party_id") {
            seeded += 1;
            friends.push(party);
        }
    }
    if friends.len() != 3 {
        return seeded;
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
    let Some(group) = group else { return seeded };
    seeded += 1;

    let everyone: Vec<String> = std::iter::once(me.to_owned())
        .chain(friends.iter().cloned())
        .collect();
    let expenses: [(&str, i64, &String, &str, i64, Option<Vec<String>>); 5] = [
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
        if seeder
            .run(
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
            )
            .is_some()
        {
            seeded += 1;
        }
    }

    if seeder
        .run(
            "tally.settle_up",
            json!({
                "from_party": chris,
                "to_party": me,
                "amount_minor": 5_000,
                "group_id": group,
                "paid_on": day(now, -2),
            }),
        )
        .is_some()
    {
        seeded += 1;
    }
    seeded
}
