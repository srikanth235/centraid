//! THE DEMO SCENARIO: one weekend at Tahoe, across six apps.
//!
//! Maya, Jake, Grandpa Ray and Chris, notes and a packing list, a week on the
//! calendar, a camera roll with real bytes, and an uneven expense ledger — a
//! corpus that reads like somebody's life rather than like `Item 1, Item 2`.
//!
//! **TWO DEPTHS, ONE SCENARIO.** [`seed`] writes the classic scenario above, the
//! exact rows the chat's and the screens' tests were written against.
//! [`seed_demo`] writes the same scenario RICHER, which is what the dev binary
//! seeds, so every revamped screen can be checked against its mockup (#1173).
//!
//! **What the demo adds.** Each app seeds what its revamped screens draw: Health's
//! 120 days and a dozen workouts
//! ([`health`]); people with numbers, a birthday, a cadence one of them is past,
//! the edges "In your vault" lists and the owner's own card ([`people`]); a
//! document with three versions, coloured labels, a PDF and an image, a starred
//! file and three folders; a note pinned, a checklist note and a note with three
//! versions; ~47 photographs over fourteen months and a dozen places, the extras
//! drawn deterministically ([`synth`]); a week with overlapping and all-day
//! events, flagged and overdue tasks in four coloured lists, and two invitations
//! to answer; and a ledger with a refund, accepted transfers and unfiled lines.
//! `tests/demo_scenario.rs` asserts the counts. Everything is a function of
//! `now`, with no randomness, so the same day seeds the same vault.
//!
//! **One scenario, two kinds of caller, and neither is a member's found.** The
//! dev binary `seed-demo-vault` (`crates/centraid`) seeds these rows through
//! [`seed`] into a fixture vault and adds its own Locker on top; the chat's
//! integration tests (`crates/core/tests/common/chat.rs`, `assist_door.rs`,
//! `crates/core-ffi/tests/assist.rs`) seed them into a vault founded with no
//! content, so they read the rows a phone holds. No `FoundContent` writes this
//! scenario: onboarding's goal is time to the member's OWN data, and a vault the
//! member keeps gets only [`crate::starters`]. There is NO LOCKER here: Locker's secrets are sealed
//! under a vault's keys, and the scenario carries none.
//!
//! **THROUGH THE REAL COMMAND PLANE, never SQL.** Every row is a
//! `Vault::execute` of a registered command, so it carries the
//! stamps a real write produces, and a tile reading it reads the shape the product actually stores. The one
//! read — the calendar Agenda files events under — is a page through
//! [`crate::api::page`], the same door a shell reads through.
//!
//! **Dates are relative to now.** An agenda seeded around a fixed instant is a
//! fixture that is empty by next month, so every date is the wall clock plus or
//! minus whole days.
//!
//! **The bytes ship with the library.** Eighteen PNG frames, 672 KB, every one
//! 360 px or less on its long edge, compiled in with `include_bytes!` — so the
//! core library, and every phone slice of it, carries them.

use std::collections::BTreeSet;

use centraid_vault::commands::{Command, CommandStatus, Registry};
use centraid_vault::{Principal, Vault};
use serde_json::{Value, json};

use crate::error::Result;

mod health;
mod people;
mod synth;

pub use health::{HEALTH_DAYS, WORKOUT_COUNT};

/// The apps the scenario seeds through [`seed`], in the order it seeds them.
/// Locker is not one of them, and never will be: see the module header.
/// [`seed_demo`] also seeds `health` ([`DEMO_APPS`]).
pub const APPS: [&str; 6] = ["people", "notes", "docs", "photos", "agenda", "money"];

/// The apps [`seed_demo`] seeds: [`APPS`] and Health, which only the demo has.
pub const DEMO_APPS: [&str; 7] = [
    "people", "notes", "docs", "photos", "agenda", "money", "health",
];

/// HOW FAR BEFORE "NOW" THE DEMO'S CALLER STARTS THE VAULT'S CLOCK, so the people
/// the scenario "last spoke to" weeks ago were written weeks ago.
///
/// A touch is stamped by the vault's clock (`person.log_interaction` takes no
/// date), and "overdue to reconnect" is an ELAPSED-time question, so a person
/// can only be overdue if a touch was written long enough ago. The caller that
/// owns a movable clock (the dev binary) starts it this far back and hands
/// [`seed_demo`] a hook that moves it forward to "now".
pub const REWIND_MS: i64 = 75 * DAY_MS;

/// What a seeding pass did not do.
///
/// A refusal is LOUD and the pass continues: one app's schema drifting is not
/// a reason to leave the other five empty, and a silent skip would be a fixture
/// whose gaps nobody can see. The caller decides what a refusal costs — the
/// dev binary exits non-zero, a test asserts the pass whole, and a starter row
/// ([`crate::starters`]) is only a warning.
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

/// SEED THE SCENARIO into a founded vault, one app at a time.
///
/// `wanted` names the apps to seed (by [`APPS`]' names); the dev binary's
/// `--only` is what passes anything but "all of them".
///
/// # Errors
///
/// Only when the registry cannot be built. A command's refusal is a line in
/// the [`Report`], not an error.
pub fn seed(
    vault: &Vault,
    registry: &Registry,
    principal: &Principal,
    wanted: &dyn Fn(&str) -> bool,
    now_ms: i64,
) -> Result<Report> {
    seed_scenario(vault, registry, principal, wanted, now_ms, None)
}

/// THE DEMO VAULT: the scenario [`seed`] writes, richer, so every revamped screen
/// has its data (#1173). See the module header for what is added.
///
/// The classic scenario stays what [`seed`] writes because the chat's and the
/// screens' tests are written against its exact rows (twelve tasks, four
/// people); the demo is the one that is "rich enough to look at", and it is
/// asserted on its own (`tests/demo_scenario.rs`).
///
/// `elapse` is called with [`REWIND_MS`] after the people phase, which is the only
/// one that needs the past: the caller's clock started that far back, and this
/// moves it forward to "now". A caller on the wall clock passes a no-op, and
/// nobody is overdue.
///
/// # Errors
///
/// As [`seed`].
pub fn seed_demo(
    vault: &Vault,
    registry: &Registry,
    principal: &Principal,
    wanted: &dyn Fn(&str) -> bool,
    now_ms: i64,
    elapse: &dyn Fn(i64),
) -> Result<Report> {
    seed_scenario(vault, registry, principal, wanted, now_ms, Some(elapse))
}

/// `Some(elapse)` is the demo; `None` is the classic scenario.
fn seed_scenario(
    vault: &Vault,
    registry: &Registry,
    principal: &Principal,
    wanted: &dyn Fn(&str) -> bool,
    now_ms: i64,
    demo: Option<&dyn Fn(i64)>,
) -> Result<Report> {
    let mut seeder = Seeder {
        vault,
        registry,
        principal,
        report: Report::default(),
    };
    let rich = demo.is_some();
    let circle = match demo {
        Some(elapse) if wanted("people") => people::seed_people(&mut seeder, now_ms, elapse),
        Some(elapse) => {
            elapse(REWIND_MS);
            people::Circle::default()
        }
        None => {
            if wanted("people") {
                people::seed_classic(&mut seeder, now_ms);
            }
            people::Circle::default()
        }
    };
    if wanted("notes") {
        seed_notes(&mut seeder, rich);
    }
    if wanted("docs") {
        seed_docs(&mut seeder, now_ms, rich);
    }
    if wanted("photos") {
        seed_photos(&mut seeder, now_ms, rich);
    }
    // THE TASKS ARE AGENDA'S (#1128): one app, so one name to seed them under.
    if wanted("agenda") {
        seed_tasks(&mut seeder, now_ms, rich);
        seed_agenda(&mut seeder, now_ms, &circle, rich);
    }
    if wanted("money") {
        seed_money(&mut seeder, now_ms, rich);
    }
    if rich && wanted("health") {
        health::seed_health(&mut seeder, now_ms);
    }
    Ok(seeder.report)
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

/// One command, run and reported. `pub(crate)` because the starter rows
/// ([`crate::starters`]) run through the same door and report the same way.
pub(crate) struct Seeder<'a> {
    pub(crate) vault: &'a Vault,
    pub(crate) registry: &'a Registry,
    pub(crate) principal: &'a Principal,
    pub(crate) report: Report,
}

impl Seeder<'_> {
    pub(crate) fn run(&mut self, name: &'static str, body: Value) -> Option<Value> {
        match self
            .vault
            .execute(self.registry, self.principal, &Command::new(name, body))
        {
            Ok(outcome) if outcome.status == CommandStatus::Executed => Some(outcome.output),
            Ok(outcome) => {
                let why = outcome.reason.unwrap_or_else(|| "no reason".to_owned());
                tracing::warn!(command = name, %why, "a scenario command was refused");
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
                tracing::warn!(command = name, %error, "a scenario command errored");
                self.report.refused.push(format!("{name}: {error}"));
                None
            }
        }
    }

    /// Put bytes in the content store the scenario's vault holds and answer their
    /// hash, or report that it holds none (the commands that name bytes claim
    /// them by hash and size).
    fn spill(&mut self, bytes: &[u8]) -> Option<String> {
        let stored = self.vault.blobs().map(|store| store.put(bytes));
        match stored {
            Some(Ok(hash)) => Some(hash),
            other => {
                let why = match other {
                    Some(Err(error)) => error.to_string(),
                    _ => "the vault has no content store".to_owned(),
                };
                self.report.refused.push(format!("content store: {why}"));
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
// Money.
//
// "Three accounts and about three months of statement lines, imported the way a
// member imports them: through `follow.statement`, with the dedupe key the app's
// own reader would have computed. A few rules file the regulars; a
// handful of lines stay unfiled so Activity has something to ask, and one move
// between checking and savings is left for the member to accept." (#1099, R-1099-9)
//
// Only the dev fixture seeds this; no member's vault ever gets sample rows.
// ---------------------------------------------------------------------------

/// One statement line: how many days before the anchor, the signed minor
/// amount and the bank's words.
struct MoneyLine {
    days_ago: i64,
    signed_minor: i64,
    text: String,
}

/// A line the seed writes into `account`, at most once per (day, amount, text):
/// a record the account's statement origin follows.
fn money_rows(
    now: i64,
    lines: &[MoneyLine],
    ordinals: &mut centraid_apps_money::import::keys::Ordinals,
) -> Vec<Value> {
    lines
        .iter()
        .map(|line| {
            let posted_on = day(now, -line.days_ago);
            let external_id = centraid_apps_money::import::keys::csv_key(
                ordinals,
                &posted_on,
                line.signed_minor,
                &line.text,
            );
            json!({
                "external_id": external_id,
                "fields": {
                    "title": line.text,
                    "posted_on": posted_on,
                    "amount_minor": line.signed_minor,
                    "line": { "imported_from": "csv" },
                },
            })
        })
        .collect()
}

fn seed_money(seeder: &mut Seeder, now: i64, rich: bool) {
    for (id, name, kind, reference) in [
        (
            "demo-money-everyday",
            "Everyday",
            "checking",
            Some("000123456789"),
        ),
        (
            "demo-money-rainy",
            "Rainy day",
            "savings",
            Some("000987654321"),
        ),
        ("demo-money-visa", "Visa", "credit_card", None),
    ] {
        let mut input = json!({
            "id": id, "title": name, "type": kind, "currency": "USD",
        });
        if let Some(reference) = reference {
            input["external_ref"] = json!(reference);
        }
        seeder.run("account.add", input);
    }

    let line = |days_ago: i64, signed_minor: i64, text: &str| MoneyLine {
        days_ago,
        signed_minor,
        text: text.to_owned(),
    };
    let mut everyday = Vec::new();
    let mut rainy = Vec::new();
    let mut visa = Vec::new();
    // Pay every other Friday, rent and a streaming charge once a month.
    for fortnight in 0..7 {
        everyday.push(line(
            3 + fortnight * 14,
            214_000,
            "PAYROLL SIERRA DESIGN CO",
        ));
    }
    for month in 0..3 {
        let base = 4 + month * 30;
        everyday.push(line(base, -165_000, "RENT PAYMENT ALPINE PROPERTIES"));
        everyday.push(line(base + 2, -1_549, "NETFLIX.COM"));
        everyday.push(line(base + 6, -7_200, "COMCAST CABLE 8001234"));
        everyday.push(line(base + 9, -50_000, "TRANSFER TO RAINY DAY"));
        rainy.push(line(base + 9, 50_000, "TRANSFER FROM EVERYDAY"));
        rainy.push(line(base + 1, -100, "MONTHLY SERVICE FEE"));
    }
    // Groceries and coffee on the checking card; fuel and dining on the Visa.
    for visit in 0..16 {
        let cents = 5_100 + (visit * 977) % 6_400;
        everyday.push(line(1 + visit * 5, -cents, "WHOLE FOODS MKT #10234"));
    }
    for visit in 0..28 {
        everyday.push(line(
            visit * 3,
            -(575 + (visit % 4) * 25),
            "STARBUCKS STORE 12345",
        ));
    }
    for fill in 0..7 {
        visa.push(line(
            2 + fill * 12,
            -(4_200 + (fill * 313) % 1_900),
            "SHELL OIL 574441",
        ));
    }
    for night in 0..12 {
        visa.push(line(
            5 + night * 7,
            -(3_800 + (night * 541) % 4_700),
            "SQ *CORNER BISTRO",
        ));
    }
    // A REFUND: money back on the card for a fill-up (the "SHELL OIL" rule files it
    // under fuel, as a credit, which is how a refund reads in Spending).
    if rich {
        visa.push(line(14, 3_150, "SHELL OIL 574441 REFUND"));
    }
    // Two lines no rule files, so Activity has something to ask about.
    visa.push(line(9, -6_480, "AMZN MKTP US*2K4LM1"));
    visa.push(line(21, -12_999, "SQ *LOCAL SHOP"));

    // Dated oldest first within each account, as a statement is; the keys carry
    // an ordinal per (day, amount, text) triple so identical lines stay two.
    for (account, reference, mut lines) in [
        ("demo-money-everyday", "000123456789", everyday),
        ("demo-money-rainy", "000987654321", rainy),
        ("demo-money-visa", "demo-money-visa", visa),
    ] {
        lines.sort_by_key(|l| std::cmp::Reverse(l.days_ago));
        let mut ordinals = centraid_apps_money::import::keys::Ordinals::default();
        let records = money_rows(now, &lines, &mut ordinals);
        // The statement origin's `ref` is the bank's number, or the account's own id.
        seeder.run(
            "follow.statement",
            json!({
                "origin": { "ref": reference, "label": account, "fills": account },
                "records": records,
            }),
        );
    }

    // The regulars are filed by rules, applied to what is already in.
    for (rule, pattern, category) in [
        ("demo-money-rule-pay", "PAYROLL", "category:income.pay"),
        (
            "demo-money-rule-rent",
            "RENT PAYMENT",
            "category:housing.rent",
        ),
        (
            "demo-money-rule-netflix",
            "NETFLIX",
            "category:fun.subscriptions",
        ),
        (
            "demo-money-rule-comcast",
            "COMCAST",
            "category:utilities.phone",
        ),
        (
            "demo-money-rule-wf",
            "WHOLE FOODS",
            "category:food.groceries",
        ),
        ("demo-money-rule-sbux", "STARBUCKS", "category:food.dining"),
        (
            "demo-money-rule-shell",
            "SHELL OIL",
            "category:transport.fuel",
        ),
        (
            "demo-money-rule-bistro",
            "CORNER BISTRO",
            "category:food.dining",
        ),
    ] {
        seeder.run(
            "rule.add",
            json!({
                "id": rule, "match": "contains", "text": pattern, "category_id": category,
            }),
        );
        seeder.run("rule.apply", json!({ "id": rule }));
    }

    // A plan for this month, so Spending has something to be measured against.
    let month = day(now, 0)[..7].to_owned();
    for (category, minor) in [
        ("category:food.groceries", 55_000),
        ("category:food.dining", 30_000),
        ("category:transport.fuel", 25_000),
    ] {
        seeder.run(
            "budget.set",
            json!({
                "month": month, "category_id": category,
                "amount_minor": minor, "currency": "USD", "carry": true,
            }),
        );
    }

    if rich {
        link_older_transfers(seeder);
    }
}

/// ACCEPT THE OLDER TRANSFERS, and leave the newest to the member.
///
/// A move between Everyday and Rainy day is two lines, one on each account, and
/// the member accepts the pair as a transfer. Two of the three months' pairs are
/// linked here (so Activity shows linked transfers, out of Spending), and the
/// newest pair stays unlinked, so the "is this a transfer?" suggestion has
/// something to offer. The ids are minted by the import, so they are read back
/// through Money's own ledger loader, the door a screen reads through.
fn link_older_transfers(seeder: &mut Seeder) {
    let door = crate::app_query::VaultDoor::new(seeder.vault);
    let ledger = |account: &str| {
        centraid_apps_money::queries::load_ledger(&door, account)
            .map(|held| held.value)
            .unwrap_or_default()
    };
    let (out, back) = (ledger("demo-money-everyday"), ledger("demo-money-rainy"));
    let mut pairs: Vec<(String, String, String)> = out
        .iter()
        .filter(|line| line.signed_minor() == -50_000)
        .filter_map(|line| {
            let other = back.iter().find(|other| {
                other.signed_minor() == 50_000 && other.posted_on == line.posted_on
            })?;
            Some((
                line.posted_on.clone(),
                line.txn_id.clone(),
                other.txn_id.clone(),
            ))
        })
        .collect();
    pairs.sort();
    for (_, from, into) in pairs.into_iter().take(2) {
        seeder.run("txn.link_transfer", json!({ "id": from, "other_id": into }));
    }
}

// ---------------------------------------------------------------------------
// Notes.
//
// "Two notebooks and a handful of lived-in markdown notes, plus one loose
// scratch note."
// ---------------------------------------------------------------------------

fn seed_notes(seeder: &mut Seeder, rich: bool) {
    let travel = Seeder::id(
        seeder
            .run(
                "container.create",
                json!({ "kind": "notebook", "title": "Travel" }),
            )
            .as_ref(),
        "id",
    );
    let recipes = Seeder::id(
        seeder
            .run(
                "container.create",
                json!({ "kind": "notebook", "title": "Recipes" }),
            )
            .as_ref(),
        "id",
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
        let mut input = json!({ "title": title, "body": body, "format": format });
        if let Some(notebook) = notebook {
            input["notebook_id"] = json!(notebook);
        }
        let made = Seeder::id(seeder.run("note.create", input).as_ref(), "id");
        let Some(note) = made else { continue };
        if !rich {
            continue;
        }
        match title {
            // PINNED: the chili sits above the shelf's recents.
            "Mom's chili, written down properly" => {
                seeder.run("flag.set", json!({ "id": note, "flag": "pinned" }));
            }
            // THREE VERSIONS, so the history sheet has two older ones to walk:
            // the shortlist grows a budget, then a decision.
            "Drive vs fly" => {
                seeder.run(
                    "note.edit",
                    json!({ "id": note, "body": "I-80 is four hours clean, six if we leave Friday after five. Reno flight lands 09:40 but door-to-door is a wash. Book by Thursday either way.\n\nGas both ways is about $90; the flight is $240 for two plus a rental." }),
                );
                seeder.run(
                    "note.edit",
                    json!({ "id": note, "body": "DECIDED: drive. Leave Friday at 13:00 to beat the traffic and the chain control.\n\nI-80 is four hours clean, six if we leave after five. Gas both ways is about $90; the flight was $240 for two plus a rental." }),
                );
            }
            _ => {}
        }
    }
    // A CHECKLIST: `- [x]` and `- [ ]` lines, so the shelf draws a tally and the
    // editor draws boxes. Its title shares no word with a task's, on purpose: the
    // chat's repair for a verb on the wrong kind ("did you mean") would otherwise
    // read it as a near-miss for one.
    if rich {
        seeder.run(
            "note.create",
            json!({
                "title": "Lake house checklist",
                "body": "## Before we leave\n- [x] Book the cabin\n- [x] Chains in the trunk\n- [ ] Rain shell and boots\n- [ ] Groceries for two nights\n- [ ] Download offline maps\n- [ ] Charge the headlamp",
                "format": "markdown",
                "notebook_id": travel,
            }),
        );
        // LINKS (#1173): a note whose body links to a live note, a trashed one and none at all,
        // and holds a web address, so the editor's link chips draw every state they have.
        let old_plans = Seeder::id(
            seeder
                .run(
                    "note.create",
                    json!({
                        "title": "Old plans",
                        "body": "Superseded by the shortlist.",
                        "format": "plain",
                        "notebook_id": travel,
                    }),
                )
                .as_ref(),
            "id",
        );
        if let Some(id) = old_plans {
            seeder.run("entity.trash", json!({ "id": id }));
        }
        seeder.run(
            "note.create",
            json!({
                "title": "Trip hub",
                "body": "Start with [[Drive vs fly]], then see [[Old plans]]. Still to write: [[Packing ideas]].\n\nCabin listing: https://example.com/tahoe-cabin",
                "format": "markdown",
                "notebook_id": travel,
            }),
        );
    }
}

// ---------------------------------------------------------------------------
// Docs.
//
// "Two folders, three filed documents, a star, a tag, and one document with a
// SECOND version so the history walk has something to walk." Each is written as
// text/markdown through `document.create_text`, so its words are what the index
// finds it by.
// ---------------------------------------------------------------------------

fn seed_docs(seeder: &mut Seeder, now: i64, rich: bool) {
    let travel = Seeder::id(
        seeder
            .run(
                "container.create",
                json!({ "kind": "folder", "title": "Travel" }),
            )
            .as_ref(),
        "id",
    );
    let home = Seeder::id(
        seeder
            .run(
                "container.create",
                json!({ "kind": "folder", "title": "Home" }),
            )
            .as_ref(),
        "id",
    );

    let leaving = day(now, 3);
    let back = day(now, 6);
    let packing_body = format!(
        "# Tahoe packing list\n\nLeaving {leaving}, back {back}.\n\n\
         - Rain shell\n- Hiking boots\n- Headlamp\n- Swimsuit (the cabin has a hot tub)\n- Board games\n"
    );
    let mut packing_input = json!({
        "title": "Tahoe packing list",
        "body_text": packing_body,
        "media_type": "text/markdown",
    });
    if let Some(travel) = travel.as_ref() {
        packing_input["folder_id"] = json!(travel);
    }
    let packing = Seeder::id(
        seeder.run("document.create_text", packing_input).as_ref(),
        "id",
    );
    if let Some(packing) = packing.as_ref() {
        // ONE EDIT, so version history has two versions to show: the words it
        // replaced are version one.
        let revised = format!(
            "{packing_body}- Tire chains (I-80 requires them after a storm)\n- Cooler for the drive\n"
        );
        seeder.run(
            "document.edit",
            json!({ "id": packing, "body_text": revised }),
        );
        // A SECOND EDIT in the demo, so the history has three versions: the
        // sheet's list shows two older ones and the current.
        if rich {
            seeder.run(
                "document.edit",
                json!({ "id": packing,
                        "body_text": format!("{revised}- Snacks for the lift line\n- Phone chargers (two)\n") }),
            );
        }
        seeder.run("flag.set", json!({ "id": packing, "flag": "starred" }));
        // LABELS WEAR COLOURS, the palette keys (`tag.add` takes one for a new label).
        let mut tag = json!({ "id": packing, "label": "tahoe" });
        if rich {
            tag["color"] = json!("petrol");
        }
        seeder.run("tag.add", tag);
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
        "body_text": cabin,
        "media_type": "text/markdown",
    });
    if let Some(travel) = travel.as_ref() {
        cabin_input["folder_id"] = json!(travel);
    }
    seeder.run("document.create_text", cabin_input);

    let insurance = "# Renters insurance policy (sample)\n\nThis is sample demo data, not a real policy.\n\n\
         - Policy number: SAMPLE-0000-0000\n- Personal property: $30,000\n- Liability: $100,000\n\
         - Deductible: $500\n- Renews annually\n";
    let mut insurance_input = json!({
        "title": "Renters insurance policy (sample)",
        "body_text": insurance,
        "media_type": "text/markdown",
    });
    if let Some(home) = home.as_ref() {
        insurance_input["folder_id"] = json!(home);
    }
    let policy = Seeder::id(
        seeder.run("document.create_text", insurance_input).as_ref(),
        "id",
    );
    // EVERYTHING BELOW IS THE DEMO'S (#1173).
    if !rich {
        return;
    }
    if let Some(policy) = policy.as_ref() {
        seeder.run(
            "tag.add",
            json!({ "id": policy, "label": "important", "color": "raspberry" }),
        );
    }

    // A THIRD FOLDER AND TWO FILES WITH BYTES, so the drive draws a PDF and an
    // image thumbnail beside the text documents. The bytes are generated
    // (`synth`), a few KB each, and "(sample)" is in every title for the same
    // reason it is above.
    let receipts = Seeder::id(
        seeder
            .run(
                "container.create",
                json!({ "kind": "folder", "title": "Receipts" }),
            )
            .as_ref(),
        "id",
    );
    let itinerary = synth::text_pdf(
        "Reno flight itinerary (sample)",
        &[
            "This is sample demo data, not a real booking.",
            "Confirmation: SAMPLE1",
            "Outbound: Fri 13:05  SFO to RNO  (1h 05m)",
            "Return:   Mon 18:40  RNO to SFO",
            "Passengers: 2    Total: $240.00",
        ],
    );
    let floor_plan = synth::gradient_png(7, 160, 120);
    for (title, bytes, media_type, folder, tag) in [
        (
            "Reno flight itinerary (sample)",
            &itinerary,
            "application/pdf",
            travel.as_ref(),
            Some(("tahoe", "petrol")),
        ),
        (
            "Cabin floor plan (sample)",
            &floor_plan,
            "image/png",
            travel.as_ref(),
            None,
        ),
    ] {
        let Some(blob) = seeder.spill(bytes) else {
            continue;
        };
        let mut input = json!({
            "title": title, "blob": blob, "media_type": media_type, "size": bytes.len(),
        });
        if let Some(folder) = folder {
            input["folder_id"] = json!(folder);
        }
        let Some(document) = Seeder::id(seeder.run("document.add", input).as_ref(), "id") else {
            continue;
        };
        if media_type == "application/pdf" {
            seeder.run("flag.set", json!({ "id": document, "flag": "starred" }));
        }
        if let Some((label, color)) = tag {
            seeder.run(
                "tag.add",
                json!({ "id": document, "label": label, "color": color }),
            );
        }
    }
    let mut dentist = json!({
        "title": "Dentist receipt (sample)",
        "body_text": "# Dentist receipt (sample)\n\nThis is sample demo data, not a real receipt.\n\n- Cleaning and exam: $185.00\n- Insurance paid: $148.00\n- You paid: $37.00\n",
        "media_type": "text/markdown",
    });
    if let Some(receipts) = receipts.as_ref() {
        dentist["folder_id"] = json!(receipts);
    }
    let dentist = Seeder::id(seeder.run("document.create_text", dentist).as_ref(), "id");
    if let Some(dentist) = dentist.as_ref() {
        seeder.run(
            "tag.add",
            json!({ "id": dentist, "label": "receipts", "color": "mustard" }),
        );
    }
}

// ---------------------------------------------------------------------------
// Photos.
//
// The frames' titles, places and capture times are v0's, and the bytes are the
// eighteen PNGs under `example/photos/`, compiled in.
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
/// The landscape roll has no people in it, so a fresh vault had no portraits to
/// show.
///
/// These are ORIGINAL procedurally drawn frames, not photographs of anyone and
/// not any third party's character art: every byte here has to be ours to
/// distribute. They are ordinary photographs of the roll: nothing recognises the
/// faces in them, and no surface draws a face (R-FP-10, Q-1047-2).
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

/// THE EXAMPLE ROLL, COMPILED IN.
///
/// `include_bytes!` and not a runtime read: a phone has no repository to read
/// them from, and the dev binary is run from wherever cargo puts it. 672 KB of PNG across eighteen frames, every one of them 360 px
/// or less on its long edge — which is v0's own ceiling, chosen so the grid
/// paints an original directly instead of probing a `?variant=thumb`
/// derivative nothing has generated.
macro_rules! roll {
    ($($file:literal),* $(,)?) => {
        fn roll_bytes(file: &str) -> Option<&'static [u8]> {
            match file {
                $($file => Some(include_bytes!(concat!("example/photos/", $file))),)*
                _ => None,
            }
        }
    };
}

roll!(
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
const VIDEO_BYTES: [u8; 24] = *b"\0\0\0\x1cftypmp42\0\0\0\0mp42isom";

fn video_bytes() -> Vec<u8> {
    VIDEO_BYTES.to_vec()
}

/// ONE FRAME'S CALL, over bytes the seeder has put in the store.
///
/// The coordinate pair is spread in only when the frame has one: a place-less
/// frame must send NEITHER, because `photo.add` refuses half a coordinate — half
/// of one is no location at all, and accepting it would let this seeder believe
/// it had placed a photograph it had not.
fn frame_input(frame: &Frame, now: i64, blob: &str, size: usize) -> Value {
    let mut input = json!({
        "blob": blob,
        "size": size,
        "media_type": "image/png",
        "title": frame.title,
        "taken_at": at(now, frame.day, frame.hour, frame.month_offset),
        "offset_min": TZ_OFFSET_MIN,
        "width": frame.width,
        "height": frame.height,
        "thumbhash": frame.thumbhash,
        "phash": frame.phash,
    });
    if let Some((lat, lon)) = place_of(frame.file) {
        let object = input.as_object_mut().expect("the input is an object");
        object.insert("lat".to_owned(), json!(lat));
        object.insert("lon".to_owned(), json!(lon));
    }
    input
}

/// The camera roll: eighteen frames with REAL BYTES, one video, one album.
///
/// **The bytes are the point.** A vault that holds a note and not a photograph
/// seeds zero photographs on every run, so the frames are put in the content
/// store (`Vault::with_blobs`) and filed by `photo.add`, which claims them by
/// hash and size: v0's scenario entire — the same frames, the same places, the
/// same two favourites, the same shortlist album.
fn seed_photos(seeder: &mut Seeder, now: i64, rich: bool) {
    let mut photo_by_file: std::collections::BTreeMap<&str, String> =
        std::collections::BTreeMap::new();
    // STRICTLY IN ORDER, as v0 runs them: ids are minted per invocation, so a
    // shuffled roll shuffles the timeline's tie-breaks and the album's member
    // positions run to run — and reproducibility is what a scenario generator
    // is for.
    for frame in roll().into_iter().chain(portraits()) {
        let Some(bytes) = roll_bytes(frame.file) else {
            continue;
        };
        let Some(blob) = seeder.spill(bytes) else {
            continue;
        };
        let input = frame_input(&frame, now, &blob, bytes.len());
        let Some(output) = seeder.run("photo.add", input) else {
            continue;
        };
        let Some(photo_id) = Seeder::id(Some(&output), "id") else {
            continue;
        };
        photo_by_file.insert(frame.file, photo_id.clone());
        if frame.favorite {
            seeder.run("flag.set", json!({ "id": photo_id, "flag": "starred" }));
        }
    }

    // THE ONE VIDEO, which is what makes the video badge something a screenshot
    // can show — and the one cell in the demo library that draws no image.
    // Nothing in this workspace writes a `poster` derivative, so the mosaic has
    // no still to fall back to and says so by drawing an empty cell.
    let film = video_bytes();
    if let Some(blob) = seeder.spill(&film) {
        seeder.run(
            "photo.add",
            json!({
                "blob": blob,
                "size": film.len(),
                "media_type": "video/mp4",
                "title": "Tahoe shoreline pan",
                "taken_at": at(now, -2, 17, 0),
                "offset_min": TZ_OFFSET_MIN,
                "width": 360,
                "height": 240,
                "duration_s": 12,
                "lat": WEST_SHORE_RIDGE.0,
                "lon": WEST_SHORE_RIDGE.1,
            }),
        );
    }

    seed_album(seeder, &photo_by_file);
    if rich {
        seed_older_roll(seeder, now);
    }
}

/// A trip or a stretch of the year: where, how long ago it began, the hour of
/// day, and a title for each frame.
type Stretch = (
    &'static str,
    (f64, f64),
    i64,
    &'static [(&'static str, i64)],
);

/// THE OLDER ROLL: ~30 more frames across the last fourteen months, in six
/// places, so Library has years and months to scroll, Places has pins that are
/// not all in California, and the viewer has neighbours to swipe between.
///
/// The bytes are generated (`synth::gradient_png`): photographs are
/// content-addressed, so each frame needs its own bytes, and the index is the
/// whole recipe. One more album, "Lisbon", gathers the first stretch.
const STRETCHES: [Stretch; 6] = [
    (
        "Lisbon",
        (38.7139, -9.1394),
        420,
        &[
            ("Tram 28 on the hill", 10),
            ("Alfama rooftops", 12),
            ("Pastel de nata, still warm", 9),
            ("Miradouro at sunset", 19),
            ("Tiles on the Rua Augusta", 15),
            ("Night walk home", 22),
        ],
    ),
    (
        "Big Sur",
        (36.2704, -121.8081),
        255,
        &[
            ("Bixby Bridge, fog lifting", 8),
            ("McWay Falls", 11),
            ("Pull-off on Highway 1", 14),
            ("Elephant seals at San Simeon", 16),
            ("Campfire", 21),
        ],
    ),
    (
        "Denver",
        (39.7392, -104.9903),
        160,
        &[
            ("Maya's new place", 15),
            ("Red Rocks, empty", 9),
            ("Larimer Square at dusk", 19),
            ("Coffee with Maya", 10),
            ("Boxes everywhere", 13),
        ],
    ),
    (
        "Portland",
        (45.5152, -122.6784),
        104,
        &[
            ("Jake's old street", 11),
            ("Powell's, second floor", 14),
            ("Rain on the Hawthorne", 17),
            ("Food carts", 12),
        ],
    ),
    (
        "Yosemite",
        (37.8651, -119.5383),
        64,
        &[
            ("Tunnel View", 9),
            ("Half Dome from the meadow", 11),
            ("Mist Trail", 13),
            ("Valley floor at golden hour", 18),
            ("Stars over Glacier Point", 23),
        ],
    ),
    (
        "Home",
        HOME_BACKYARD,
        31,
        &[
            ("Sunday on the porch", 11),
            ("Tomatoes, finally", 15),
            ("The new bookshelf", 18),
        ],
    ),
];

fn seed_older_roll(seeder: &mut Seeder, now: i64) {
    let mut index = 100_u32;
    let mut lisbon = Vec::new();
    for (stretch, (place, (lat, lon), began, frames)) in STRETCHES.iter().enumerate() {
        for (frame, (title, hour)) in frames.iter().enumerate() {
            index += 1;
            // Every fifth frame is a portrait: the grid has both shapes.
            let portrait = index.is_multiple_of(5);
            let (width, height) = if portrait { (64, 96) } else { (96, 64) };
            let bytes = synth::gradient_png(index, width, height);
            let Some(blob) = seeder.spill(&bytes) else {
                continue;
            };
            let frame_day = i64::try_from(frame).unwrap_or(0);
            let mut input = json!({
                "blob": blob,
                "size": bytes.len(),
                "media_type": "image/png",
                "title": title,
                "taken_at": at(now, -(began - frame_day / 2), *hour, 0),
                "offset_min": if *place == "Lisbon" { 0 } else { TZ_OFFSET_MIN },
                "width": width,
                "height": height,
                "lat": lat,
                "lon": lon,
            });
            // A frame in three has no coordinates, which is a camera roll's honest shape.
            if (stretch + frame) % 7 == 3 {
                let object = input.as_object_mut().expect("the input is an object");
                object.remove("lat");
                object.remove("lon");
            }
            let Some(photo) = Seeder::id(seeder.run("photo.add", input).as_ref(), "id") else {
                continue;
            };
            if frame == 1 && *place != "Home" {
                seeder.run("flag.set", json!({ "id": photo, "flag": "starred" }));
            }
            if *place == "Lisbon" {
                lisbon.push(photo);
            }
        }
    }
    let Some(album) = Seeder::id(
        seeder
            .run(
                "container.create",
                json!({ "kind": "album", "title": "Lisbon" }),
            )
            .as_ref(),
        "id",
    ) else {
        return;
    };
    for photo in &lisbon {
        seeder.run(
            "edge.add",
            json!({ "from": album, "rel": "contains", "to": photo }),
        );
    }
    if let Some(cover) = lisbon.get(3) {
        seeder.run("album.set_cover", json!({ "id": album, "photo_id": cover }));
    }
}

/// The shortlist, as an album with a cover.
///
/// Separate from the roll because it can only run AFTER it: an album of four
/// frames needs those four frames to have ids, and a cover needs to be a member
/// of the album it covers.
fn seed_album(seeder: &mut Seeder, photo_by_file: &std::collections::BTreeMap<&str, String>) {
    let Some(output) = seeder.run(
        "container.create",
        json!({ "kind": "album", "title": ALBUM_TITLE }),
    ) else {
        return;
    };
    let Some(album_id) = Seeder::id(Some(&output), "id") else {
        return;
    };
    for file in ALBUM_FILES {
        let Some(photo_id) = photo_by_file.get(file) else {
            continue;
        };
        seeder.run(
            "edge.add",
            json!({ "from": album_id, "rel": "contains", "to": photo_id }),
        );
    }
    if let Some(cover) = photo_by_file.get(ALBUM_COVER) {
        seeder.run(
            "album.set_cover",
            json!({ "id": album_id, "photo_id": cover }),
        );
    }
}

// ---------------------------------------------------------------------------
// Tasks.
//
// "A believable week on the board — overdue errands, a project with subtasks,
// done items, a someday idea." The project is a real container with a
// section, so the project place is reachable (#1047).
// ---------------------------------------------------------------------------

fn seed_tasks(seeder: &mut Seeder, now: i64, rich: bool) {
    let add = |seeder: &mut Seeder, input: Value| -> Option<String> {
        let output = seeder.run("task.add", input);
        Seeder::id(output.as_ref(), "id")
    };

    for input in [
        json!({ "title": "Rotate the tires before the drive", "due": at(now, -2, 9, 0), "priority": 8 }),
        json!({ "title": "Book dentist appointment", "due": at(now, 1, 9, 0), "priority": 5, "effort_min": 15 }),
        json!({
            "title": "Pick up the dry cleaning",
            "description": "Ticket is on the fridge.",
            "due": at(now, 0, 9, 0),
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
            "due": at(now, 7, 9, 0),
            "priority": 6,
        }),
    );
    // A PROJECT, so Tasks' project place has something to open (#1047): the
    // trip, filed under its "Booking" section, with a second task beside it.
    let project = Seeder::id(
        seeder
            .run(
                "container.create",
                json!({ "kind": "project", "title": "Tahoe trip", "color": if rich { "petrol" } else { "blue" }, "position": 1 }),
            )
            .as_ref(),
        "id",
    );
    if let Some(project) = project.as_ref() {
        let section = Seeder::id(
            seeder
                .run(
                    "container.create",
                    json!({ "kind": "section", "title": "Booking", "parent": project, "position": 1 }),
                )
                .as_ref(),
            "id",
        );
        let lift = add(
            seeder,
            json!({ "title": "Buy lift tickets online", "due": at(now, 5, 9, 0), "priority": 4 }),
        );
        for (task, position) in [(trip.as_ref(), 1), (lift.as_ref(), 2)] {
            let Some(task) = task else { continue };
            let mut input = json!({ "id": task, "project_id": project, "position": position });
            if let Some(section) = section.as_ref() {
                input["section_id"] = json!(section);
            }
            seeder.run("task.organize", input);
        }
    }
    if let Some(trip) = trip.as_ref() {
        for input in [
            json!({ "title": "Compare cabins — South Lake vs Truckee", "parent_id": trip, "effort_min": 45 }),
            json!({ "title": "Book the Tahoe cabin", "parent_id": trip, "due": at(now, 3, 9, 0) }),
        ] {
            add(seeder, input);
        }
        let packed = add(
            seeder,
            json!({ "title": "Draft packing list", "parent_id": trip }),
        );
        if let Some(packed) = packed {
            seeder.run("task.complete", json!({ "id": packed }));
        }
    }

    let groceries = add(
        seeder,
        json!({ "title": "Weekly grocery run", "due": at(now, -1, 9, 0), "priority": 4 }),
    );
    if let Some(groceries) = groceries {
        seeder.run("task.complete", json!({ "id": groceries }));
    }
    add(
        seeder,
        json!({ "title": "Learn to make sourdough", "priority": 1 }),
    );

    if !rich {
        return;
    }
    // THE DEMO'S: LISTS THAT WEAR A COLOUR (the palette's keys), each with a few reminders
    // in it: Reminders' "My Lists" and a list's own screen both have something to draw.
    // Overdue ones carry a due day in the past; FLAGGED ones carry the starred flag.
    for (position, (title, color, tasks)) in [
        (
            "Home",
            "mustard",
            &[
                ("Replace the hallway bulb", Some(-3_i64), false),
                ("Ask the landlord about the heater", Some(-1), true),
                ("Descale the kettle", Some(6), false),
            ][..],
        ),
        (
            "Work",
            "violet",
            &[
                ("Send the design review notes", Some(0), true),
                ("Book the offsite room", Some(4), false),
                ("Expense the October train pass", Some(-6), false),
                ("Prep the Friday demo", Some(2), true),
            ][..],
        ),
        (
            "Errands",
            "raspberry",
            &[
                ("Renew the car registration", Some(-5), true),
                ("Return the cabin keys deposit form", Some(9), false),
                ("Pick up the prescription", Some(1), false),
            ][..],
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let list = Seeder::id(
            seeder
                .run(
                    "container.create",
                    json!({ "kind": "project", "title": title, "color": color,
                            "position": position + 2 }),
                )
                .as_ref(),
            "id",
        );
        let Some(list) = list else { continue };
        for (index, (name, due, flagged)) in tasks.iter().enumerate() {
            let mut input = json!({ "title": name, "project_id": list, "position": index + 1,
                                    "priority": 3 });
            if let Some(due) = due {
                input["due"] = json!(at(now, *due, 9, 0));
            }
            let Some(task) = add(seeder, input) else {
                continue;
            };
            if *flagged {
                seeder.run("flag.set", json!({ "id": task, "flag": "starred" }));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Agenda.
//
// "One lived-in week on the calendar — something small today so the brief is
// never blank, dinner with a friend, a deadline, a weekly recurring run with a
// reminder, and next week's dentist." Every slot is DISJOINT: `event.propose`
// refuses any busy overlap, vault-wide.
//
// No attendees, which is v0's own note: resolving "Maya" to a party here would
// either race the people seed or mint a duplicate of their friend. The dinner
// names her in the summary instead.
// ---------------------------------------------------------------------------

fn seed_agenda(seeder: &mut Seeder, now: i64, circle: &people::Circle, rich: bool) {
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
            "title": summary,
            "starts": dtstart,
            "ends": dtend,
            "zone": "Etc/UTC",
        });
        if let Some(description) = description {
            input["description"] = json!(description);
        }
        if let Some(rrule) = rrule {
            input["rule"] = json!(rrule);
        }
        let dinner = summary == "Dinner with Maya";
        if dinner && let Some(maya) = circle.get("Maya") {
            input["attendees"] = json!([maya]);
        }
        let id = Seeder::id(seeder.run("event.propose", input).as_ref(), "id");
        if dinner && let (Some(id), Some(maya)) = (id, circle.get("Maya")) {
            seeder.run(
                "event.respond",
                json!({ "id": id, "person_id": maya, "state": "accepted" }),
            );
        }
    }
    if rich {
        seed_busy_week(seeder, now, circle);
    }
}

/// A timed event of the busy week: title, `(day, hour, minute, minutes)`, whether
/// it blocks the calendar, and the guests by name (`"owner"` is the member).
type Slot = (
    &'static str,
    (i64, i64, i64, i64),
    bool,
    &'static [&'static str],
);

/// THE WEEK THE DAY AND WEEK GRIDS ARE CHECKED AGAINST (#1173).
///
/// `event.propose` refuses a BUSY event that overlaps another busy one, and a
/// grid with no overlaps proves nothing about its column layout, so the
/// overlapping half of each pair is a FREE event (`busy: false`), which is also
/// what a "maybe" on a real calendar is. Beside them: an all-day span, two
/// events in the past, and TWO INVITATIONS, where the member is a guest who has
/// not answered, which is what the Invites place lists.
const BUSY_WEEK: [Slot; 15] = [
    ("Design review", (0, 10, 0, 60), true, &[]),
    ("Team standup", (0, 10, 30, 30), false, &[]),
    ("Lunch with Chris", (0, 12, 30, 60), true, &["Chris"]),
    ("Gym", (0, 12, 45, 30), false, &[]),
    ("Focus block", (0, 14, 0, 120), true, &[]),
    ("Sync with Priya", (0, 15, 0, 30), false, &["Priya"]),
    ("Sprint planning", (1, 14, 0, 60), true, &[]),
    ("1:1 with Jake", (1, 14, 30, 45), false, &["Jake"]),
    ("Climbing with Priya", (4, 18, 0, 90), true, &["Priya"]),
    ("Board games", (4, 18, 30, 90), false, &[]),
    ("Cabin check-in", (5, 16, 0, 60), true, &[]),
    (
        "Cabin walkthrough with Alpine Rentals",
        (5, 11, 0, 60),
        true,
        &["owner"],
    ),
    (
        "Chris's design crit",
        (6, 15, 0, 60),
        true,
        &["owner", "Chris"],
    ),
    ("Sprint demo", (7, 16, 0, 60), true, &[]),
    ("Kayak lesson", (9, 10, 0, 120), true, &["Dana"]),
];

/// Two more calendars beside the vault's own, so the grids draw more than one
/// colour: the titles of the busy week that go on each.
const WORK_EVENTS: [&str; 6] = [
    "Design review",
    "Team standup",
    "Focus block",
    "Sprint planning",
    "1:1 with Jake",
    "Sprint demo",
];
const FAMILY_EVENTS: [&str; 4] = [
    "Lunch with Chris",
    "Climbing with Priya",
    "Board games",
    "Kayak lesson",
];

fn seed_busy_week(seeder: &mut Seeder, now: i64, circle: &people::Circle) {
    let mut calendar = |title: &str, color: &str, position: i64| {
        Seeder::id(
            seeder
                .run(
                    "container.create",
                    json!({ "kind": "calendar", "title": title, "color": color, "position": position }),
                )
                .as_ref(),
            "id",
        )
    };
    let work = calendar("Work", "blue", 1);
    let family = calendar("Family", "violet", 2);
    for (title, (days, hour, minute, minutes), busy, guests) in BUSY_WEEK {
        let calendar_id = if WORK_EVENTS.contains(&title) {
            work.clone()
        } else if FAMILY_EVENTS.contains(&title) {
            family.clone()
        } else {
            None
        };
        let guests: Vec<&str> = guests
            .iter()
            .filter_map(|name| {
                if *name == "owner" {
                    circle.owner.as_deref()
                } else {
                    circle.get(name)
                }
            })
            .collect();
        let mut input = json!({
            "title": title,
            "starts": at(now, days, hour, minute),
            "ends": at(now, days, hour, minute + minutes),
            "zone": "Etc/UTC",
            "busy": busy,
            "attendees": guests,
            "reminders": [15],
        });
        if let Some(calendar_id) = calendar_id {
            input["calendar_id"] = json!(calendar_id);
        }
        seeder.run("event.propose", input);
    }
    // The two that already happened, so "earlier this week" has a row.
    for (title, days, hour) in [("Team retro", -1, 15), ("Haircut", -2, 12)] {
        seeder.run(
            "event.propose",
            json!({
                "title": title,
                "starts": at(now, days, hour, 0),
                "ends": at(now, days, hour, 45),
                "zone": "Etc/UTC",
            }),
        );
    }
    // An all-day event TODAY, so the Calendar header's all-day lane has a chip.
    let mut offsite = json!({
        "title": "Company offsite",
        "starts": day(now, 0),
        "ends": day(now, 0),
        "timing": "all-day",
    });
    if let Some(work) = work {
        offsite["calendar_id"] = json!(work);
    }
    seeder.run("event.propose", offsite);
    // The long weekend, as ONE ALL-DAY SPAN: `ends` is the LAST day, inclusive.
    seeder.run(
        "event.propose",
        json!({
            "title": "Tahoe long weekend",
            "starts": day(now, 3),
            "ends": day(now, 5),
            "timing": "all-day",
            "description": "Cabin on the south shore.",
        }),
    );
}
