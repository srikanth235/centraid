//! THE LONG TAIL — the years of vault the story week sits on top of.
//!
//! ## Why a world of 73 rows was a harness defect
//!
//! "Open all eight boards and read every label" is FREE at 73 rows and
//! impossible at 73,000, so a corpus of 73 rows cannot decide the one
//! architectural question an assistant evaluation exists to decide: whether a
//! runtime should search or scan. Worse, every recall number it produces is
//! inflated — a naive keyword query is a far better strategy over 73 rows than
//! over a vault somebody has actually lived in. The fix is not more story; it
//! is the ordinary mass a real vault carries around the story.
//!
//! ## What "realistic" means here, and what it does not
//!
//! Five thousand lorem rows would be as unreal as seventy-three. Real vaults
//! have SHAPE, and this file seeds the shapes rather than the volume:
//!
//! * **Recurrence.** A standup every weekday for two years, a rent expense
//!   every month, a grocery run every week — the same words, hundreds of times,
//!   differing only by date. "When is my standup" is then a question with four
//!   hundred true answers and one useful one.
//! * **A long tail of old notes**, most of them never touched again.
//! * **Few counterparties, many transactions**: a dozen merchants carry most of
//!   the ledger, which is what makes "how much did I spend at the market" a
//!   grouping question rather than a lookup.
//! * **Photo bursts**: two dozen frames from one afternoon, which is what a
//!   camera roll is, and what makes "the photos from that day" a question with
//!   thirty answers.
//! * **Duplicated and near-duplicated names**: a first name carried by a dozen
//!   people, a surname by twenty, and one person entered twice with the surname
//!   mistyped.
//!
//! ## IT COLLIDES IN MEANING, NOT IN THE SUITE'S GROUND TRUTH
//!
//! The first cut of this file deepened the story's own collisions — more rows
//! saying "dentist", more saying "Emerald Bay", more people called Neha — and
//! the reference fell from 129/129 to 63 of 85 sessions. **Every one of those
//! failures returned the whole expected answer and more besides**: not one
//! expected row was missed. That is not a broken reference, it is the world
//! telling the truth. A note titled "Tahoe — loose ends" really IS a note about
//! Tahoe, and a case whose expected set is one row was written against a vault
//! where only one existed.
//!
//! So the tail collides one step to the side of the suite's own nouns. It is
//! full of dental appointments, lake weekends and cabins — `Dental check`,
//! `Donner weekend`, `the lake place` — which a reader that understands words
//! has to tell apart from the dentist and from Tahoe, and which an exact-token
//! index does not confuse with either. That is a harder world for a candidate
//! that reasons and an honestly unchanged one for the ground truth. It also
//! makes the near-miss the interesting measurement: the gap between a runtime
//! that matches tokens and one that matches meaning is now VISIBLE, where in a
//! 73-row world there was nothing to be wrong about.
//!
//! ## SCARCITY IS NOT DIFFICULTY, AND THIS FILE MUST NOT SUPPLY EITHER
//!
//! Growing the world exposed a second thing, which is that some questions are
//! answerable only while a world is small — the sole person with a given first
//! name, the sole reminder of its kind, the sole row carrying a given field.
//! Deepening any of those does not make such a question harder; it makes it
//! WRONG, because the new rows are true answers to it.
//!
//! The rule this file follows is therefore: **a corpus may not be kept honest
//! by keeping the world thin.** Where a question leaned on scarcity, the
//! question was rewritten to narrow by something real — a full name, a role, a
//! window, a named place — and only then was the tail allowed to deepen. What
//! remains below as avoidance is avoidance of a DIFFERENT thing: ground truth
//! the tail would change rather than crowd. Each of those is marked where it
//! is, with the property it protects and no more.
//!
//! **This file deliberately does not describe the corpus.** Naming the cases,
//! or their subjects, turns the world's source into a readable index of what is
//! scored — and a lane authoring a second, blind corpus was told to read the
//! world. Every comment here states a PROPERTY the tail must hold. The reader
//! who needs to know which case depends on it can look in the suite.
//!
//! The tail is also OLD. No bulk row's own date falls within two hundred days
//! of the world's now, because the suite's questions are about this week and a
//! tail that answered them would be changing their answers rather than
//! crowding them.
//!
//! ## And the one thing it must not touch
//!
//! **No bulk row may carry a story row's exact label within the same app and
//! entity.** The suite names rows by stable handle, and a handle is an app, an
//! entity and a label; a bulk row that collided with one would make the handle
//! ambiguous. That is not a silent hazard — `Suite::resolve` refuses it by name
//! — but it is a hazard worth not creating, so every label below is built from
//! a vocabulary the story does not use verbatim.
//!
//! ## Written first, in the past
//!
//! This phase runs BEFORE the story and the clock is jumped forward afterwards,
//! so every story row's `created_at` is exactly what it was when the world held
//! 73 rows. The ids move — the seed replays a longer sequence now — and that is
//! precisely what stable handles made survivable.

use serde_json::json;

use crate::inventory::State;
use crate::{Seeder, at, day};

// ---------------------------------------------------------------------------
// How big, and how it is shaped.
// ---------------------------------------------------------------------------

/// Notes. The biggest pile, because notes are what a vault accumulates.
const NOTES: usize = 1_500;
/// Tasks, all but a handful long since ticked off.
const TASKS: usize = 700;
/// Calendar events. Every slot disjoint — `schedule.propose_event` refuses a
/// busy overlap vault-wide, so the whole tail is laid out one hour per day.
const EVENTS: usize = 620;
/// Expenses, across a handful of groups and a dozen recurring merchants.
const EXPENSES: usize = 1_250;
/// Documents.
const DOCS: usize = 320;
/// Photographs, in bursts.
const PHOTOS: usize = 420;
/// Locker items. A password manager somebody has actually used, and the count
/// that decides whether a board scan of the one app the search plane cannot
/// reach is free. See [`locker`].
const SECRETS: usize = 120;

/// Parties. Kept deliberately lower than the rest: the People board walks three
/// paged queries PER PARTY, so this count is the one that prices a board scan
/// rather than the row total.
const PEOPLE: usize = 220;

/// How far back the tail reaches, in days before the world's now.
const TAIL_DAYS: i64 = 900;

/// THE DAY OFFSETS A TAIL BIRTHDAY'S `MM-DD` IS DRAWN FROM.
///
/// `(-110, 177)` — every day from 287 days before the world's now up to 110
/// days before it, which is September 2025 through February 2026, so the
/// `MM-DD` that falls out of it always lands in September–February.
///
/// A recurring `MM-DD` carries no year, so it cannot be placed safely in the
/// past: it comes round in its month every year, this world's own year
/// included. The property held is that **the tail adds no recurring date inside
/// the months the story's calendar covers** — such a row would not crowd a
/// windowed answer, it would be part of it. Widening this backwards does not
/// help: `MM-DD` wraps, and a day 394 days ago is a day in June.
const MONTH_DAYS_CLEAR_OF_THE_WINDOW: (i64, usize) = (-110, 177);

/// THE CLOSEST A BULK ROW'S OWN DATE MAY COME TO THE WORLD'S NOW.
///
/// The story is one lived-in fortnight and everything asked of this world is
/// asked about that fortnight or near it. Two hundred days of clear air behind
/// it means a tail row is never inside a window the story's own rows define: it
/// is context, not a competing answer.
const TAIL_FLOOR_DAYS: i64 = 200;

/// A 1×1 PNG. Distinct bytes per frame come from a counter appended after
/// `IEND`, which every decoder ignores and which the vault's content hash does
/// not — `media.add_asset` ADOPTS an existing asset when two files hash the
/// same, so a roll of identical bytes would silently be one photograph.
const PIXEL: [u8; 69] = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x38, 0x91, 0x62, 0x04,
    0x00, 0x03, 0x56, 0x01, 0x5f, 0xe8, 0x17, 0x84, 0x52, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
];

/// A deterministic stream of small numbers.
///
/// Not `rand`: the world's whole worth is that the same seed replays the same
/// rows, and a dependency whose algorithm may change between minor versions is
/// a world that quietly stops replaying. This is a 64-bit xorshift written out,
/// which is four lines and cannot drift.
struct Dice(u64);

impl Dice {
    const fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    /// A number in `0..bound`.
    fn upto(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }

    fn pick<'a, T>(&mut self, from: &'a [T]) -> &'a T {
        &from[self.upto(from.len())]
    }

    /// True `percent` of the time.
    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
}

// ---------------------------------------------------------------------------
// The vocabularies. Overlapping on purpose.
// ---------------------------------------------------------------------------

/// First names, repeated hard — **the story's five among them**.
///
/// A vault where every first name is unique makes "text Dan" a lookup, so this
/// pool is short and drawn from two hundred times: most first names here are
/// carried by a dozen people and several surnames by twenty.
///
/// The story's own first names are in it ON PURPOSE. An earlier cut left them
/// out, because two questions elsewhere resolved a first name to a person and
/// did so only while the world held exactly one of each — so a twelfth person
/// of that name did not make them harder, it made their expected answers wrong.
/// The right fix was to those questions, and it has been made: both now narrow
/// by something other than scarcity. With that done the pool can say what a
/// real address book says, which is that a first name is not an identifier.
const FIRST_NAMES: &[&str] = &[
    "Neha", "Marco", "Ana", "Priya", "Ray", "Dan", "Mira", "Tomas", "Sara", "Ben", "Leah", "Owen",
    "Nina", "Raj", "Ines", "Luis", "Iris", "Kai", "Nadia", "Theo", "Elif", "Pim", "Rosa", "Gus",
];

/// Surnames, short on purpose, so first-name-plus-surname collides too.
///
/// The story's six surnames stay out, and this one is NOT a scarcity artefact
/// in disguise: a handle is an app, an entity and a label, so a tail party
/// called "Ana Ferreira" would make the handle `people/ana-ferreira` resolve to
/// two rows and stop the run by name. Full names are how the suite points at a
/// person; first names are what it has to disambiguate.
const SURNAMES: &[&str] = &[
    "Nunes", "Okafor", "Lindqvist", "Moreau", "Bianchi", "Haddad", "Novak", "Petrov", "Reyes",
    "Osei", "Vargas", "Kowal", "Berger", "Aitken", "Duarte",
];

const ROLES: &[&str] = &[
    "Neighbour",
    "Former colleague",
    "Climbing gym",
    "Book club",
    "Cousin",
    "Landlord's agent",
    "Vet",
    "Plumber",
    "School parent",
];

/// The recurring merchants. A dozen names carrying most of a ledger, which is
/// what a real one looks like and what makes a grouping question a real one.
const MERCHANTS: &[(&str, &str, i64)] = &[
    ("Blue Bottle", "food", 550),
    ("Corner Market", "groceries", 4_200),
    ("Rossi's", "food", 3_100),
    ("Metro card top-up", "transport", 2_000),
    ("Shell on Fourth", "transport", 5_400),
    ("Bookshop", "shopping", 1_800),
    ("Pharmacy", "general", 1_450),
    ("Hardware store", "shopping", 2_600),
    ("Laundry", "general", 900),
    ("Cinema", "fun", 1_900),
    ("Climbing gym", "fun", 2_400),
    ("Farmers market", "groceries", 3_300),
];

/// The note vocabulary — ONE STEP TO THE SIDE of the story's nouns.
///
/// Dental work, lake weekends, cooking and paperwork: the same neighbourhoods
/// the story's notes live in, named with different words. A reader that
/// understands "dental" and "dentist" are the same subject has a thousand more
/// rows to sort through; an exact-token index does not confuse them, so the
/// ground truth of every dentist case is untouched.
const NOTE_SUBJECTS: &[&str] = &[
    "the dental plan",
    "orthodontist quotes",
    "Donner weekend",
    "the lake place",
    "Kirkwood parking",
    "the rental car",
    "focaccia",
    "the ragu",
    "the standup",
    "the boiler",
    "the bike",
    "the garden",
    "podcasts",
    "the move",
    "the fence",
    "what to bring",
];

const NOTE_SHAPES: &[&str] = &[
    "Notes — {} ({})",
    "Thinking about {} — {}",
    "{}: loose ends ({})",
    "Scratch on {} — {}",
    "Read later: {} ({})",
];

/// Task titles whose words a suite question would also reach for.
const TASK_SHAPES: &[&str] = &[
    "Chase the dental invoice ({})",
    "Weekly shop ({})",
    "Water the plants ({})",
    "Pay the card ({})",
    "Back up the photos ({})",
    "Call the landlord ({})",
    "Renew the parking permit ({})",
    "Book the Donner lodge viewing ({})",
    "Check the tyre pressures ({})",
    "File the cover paperwork ({})",
    "Refill the prescription ({})",
    "Email the climbing group ({})",
];

/// Events whose summaries a "what's on my calendar" question sweeps up.
const EVENT_SHAPES: &[&str] = &[
    "Standup",
    "1:1 with Dan",
    "Dental check",
    "Hygienist",
    "Dinner with Mira",
    "Dinner with Tomas",
    "Climbing session",
    "Book club",
    "Parents' evening",
    "Physio",
    "Car service",
    "Haircut",
];

const DOC_SHAPES: &[&str] = &[
    "Payslip {} (sample)",
    "Bank statement {} (sample)",
    "Utility bill {} (sample)",
    "Dental statement {} (sample)",
    "Rent receipt {} (sample)",
    "Car service record {} (sample)",
];

/// The bursts. Each is a day, a coordinate and a caption stem — twenty frames
/// from one afternoon share all three, which is what a camera roll is.
/// EIGHT BURSTS, EIGHT COORDINATES — two dozen frames from one afternoon at one
/// place, which is what a camera roll is and what collapses into one place row.
///
/// None of the eight is the story's home coordinate, and that is now the whole
/// of the constraint: `media.add_asset` mints one place row per rounded
/// coordinate, so a burst that shared the home coordinate would not be a burst
/// near home, it would BE home. Everywhere else on earth is available.
///
/// An earlier cut carried no coordinates at all, because "photos from home" was
/// being resolved as *every placed frame that is not on the trip* — which is a
/// definition of home only in a world holding ten photographs. The world now
/// names the place instead, and the tail can be photographed freely.
const BURSTS: &[(&str, f64, f64)] = &[
    ("Harbour walk", 37.8060, -122.4100),
    ("Mission rooftop", 37.7590, -122.4180),
    ("Donner shore", 39.3210, -120.2360),
    ("Fallen Leaf trail", 38.8880, -120.0590),
    ("City rooftop", 37.7890, -122.4010),
    ("Coast road", 37.5100, -122.5000),
    ("Rubicon water", 39.0080, -120.1000),
    ("The old flat", 37.7620, -122.4340),
];

// ---------------------------------------------------------------------------
// The phase.
// ---------------------------------------------------------------------------

/// Seed the long tail. Runs BEFORE the story; see the module note.
///
/// `locker` is `Some` once the story's key custody has been founded ahead of
/// this phase, which is the only reason the tail can hold sealed secrets at
/// all — see [`crate::scenario::found_key`].
pub(crate) fn seed(seeder: &mut Seeder, me: &str, locker_key: Option<(&[u8], &str)>) {
    let mut dice = Dice::new(0x5EED_10_C0_FFEE_u64);
    let friends = people(seeder, &mut dice);
    notes(seeder, &mut dice);
    tasks(seeder, &mut dice);
    docs(seeder, &mut dice);
    events(seeder, &mut dice, &friends);
    photos(seeder, &mut dice);
    tally(seeder, &mut dice, me, &friends);
    if let Some((key, key_id)) = locker_key {
        locker(seeder, &mut dice, key, key_id);
    }
}

// ---------------------------------------------------------------------------
// People.
// ---------------------------------------------------------------------------

/// A roster where first names repeat hard, and a surname is spelled two ways.
fn people(seeder: &mut Seeder, dice: &mut Dice) -> Vec<String> {
    let mut made = Vec::with_capacity(PEOPLE);
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    // THE STORY'S OWN PEOPLE, BY NAME. Never minted here — a second
    // "Neha Rao" would make the suite's handle for the first one ambiguous,
    // which is the one thing the bulk may not do.
    for reserved in [
        "Neha Rao",
        "Neha Kulkarni",
        "Marco Ferreira",
        "Marco Ferriera",
        "Marco Silva",
        "Ana Ferreira",
        "Ray Alvarez",
        "Priya Raman",
        "Neha",
        "Marco",
        "Ana",
    ] {
        seen.insert(reserved.to_owned());
    }
    // A SURNAME SPELLED TWO WAYS, which every contact list eventually has.
    let mut misspelled_once = false;
    for index in 0..PEOPLE {
        let first = *dice.pick(FIRST_NAMES);
        let last = *dice.pick(SURNAMES);
        let name = format!("{first} {last}");
        if !seen.insert(name.clone()) {
            continue;
        }
        let cadence = *dice.pick(&[7_i64, 14, 30, 30, 60, 90, 90, 180, 365]);
        let Some(party) = seeder.id(
            "people.add_person",
            "party_id",
            json!({
                "display_name": name,
                "role": dice.pick(ROLES),
                "cadence_days": cadence,
            }),
        ) else {
            continue;
        };
        seeder.note(
            &party,
            ("people", "core.party"),
            &name,
            None,
            State::Live,
            None,
        );
        seeder.value(&party, cadence.to_string());

        // A SIXTH OF THEM CARRY A PHONE NUMBER, not all — a roster where
        // everybody is reachable makes "who can I actually call" a no-op.
        if dice.chance(16) {
            if let Some(channel) = seeder.id(
                "people.save_contact_channel",
                "channel_id",
                json!({
                    "party_id": party,
                    "kind": "phone",
                    "label": "Mobile",
                    "value": format!("+1-555-{:04}", 1000 + index),
                }),
            ) {
                seeder.note(
                    &channel,
                    ("people", "social.contact_channel"),
                    &format!("{name} — Mobile phone"),
                    None,
                    State::Live,
                    None,
                );
                seeder.value(&channel, format!("+1-555-{:04}", 1000 + index));
            }
        }
        // A FIFTH CARRY A REMINDER, most of them REAL BIRTHDAYS, so that a
        // birthday is an ordinary row in this world and not a unique one.
        //
        // The one thing they may not do is fall inside the months the story's
        // own calendar covers — see `MONTH_DAYS_CLEAR_OF_THE_WINDOW` for why a
        // recurring date cannot be put safely in the past.
        if dice.chance(20) {
            let label = *dice.pick(&[
                "Birthday",
                "Birthday",
                "Birthday",
                "Work anniversary",
                "Moved in",
                "Name day",
            ]);
            let days = MONTH_DAYS_CLEAR_OF_THE_WINDOW.0
                - (dice.upto(MONTH_DAYS_CLEAR_OF_THE_WINDOW.1) as i64);
            if let Some(date_row) = seeder.id(
                "people.add_important_date",
                "date_id",
                json!({
                    "party_id": party,
                    "label": label,
                    "month_day": day(days)[5..].to_owned(),
                    "reminder_on": false,
                }),
            ) {
                seeder.note(
                    &date_row,
                    ("people", "people.important_date"),
                    &format!("{label} — {name}"),
                    Some(day(days)),
                    State::Live,
                    None,
                );
                seeder.value(&date_row, day(days)[5..].to_owned());
            }
        }
        // ...and once, the same person entered twice with the surname
        // mistyped. One is plenty: it is a shape, not a population.
        if !misspelled_once && index > 40 {
            misspelled_once = true;
            let typo = format!("{first} {}", last.replace("er", "re").replace("an", "en"));
            if typo != name
                && seen.insert(typo.clone())
                && let Some(double) = seeder.id(
                    "people.add_person",
                    "party_id",
                    json!({ "display_name": typo, "role": "Duplicate — misspelled",
                            "cadence_days": cadence }),
                )
            {
                seeder.note(
                    &double,
                    ("people", "core.party"),
                    &typo,
                    None,
                    State::Live,
                    Some("long tail: a misspelled second entry for one person"),
                );
                seeder.value(&double, cadence.to_string());
            }
        }
        made.push(party);
    }
    made
}

// ---------------------------------------------------------------------------
// Notes.
// ---------------------------------------------------------------------------

fn notes(seeder: &mut Seeder, dice: &mut Dice) {
    let mut notebooks = Vec::new();
    for name in ["Work", "House", "Reading", "Admin", "Archive"] {
        if let Some(id) = seeder.id(
            "knowledge.create_notebook",
            "notebook_id",
            json!({ "name": name }),
        ) {
            notebooks.push(id);
        }
    }
    for index in 0..NOTES {
        let subject = *dice.pick(NOTE_SUBJECTS);
        let shape = *dice.pick(NOTE_SHAPES);
        // `{}` twice: the subject, then a discriminator, so a thousand notes
        // about sixteen subjects are still individually nameable.
        let title = shape
            .replacen("{}", subject, 1)
            .replacen("{}", &format!("{:03}", index % 400), 1);
        let body = format!(
            "{subject}. Picked this up again and wrote down what I remembered.\n\n\
             - the bit I keep forgetting\n- what to do next\n- who to ask\n\nEntry {index}."
        );
        let mut input = json!({ "title": title, "body_text": body, "format": "plain" });
        if !notebooks.is_empty() && dice.chance(70) {
            input["notebook_id"] = json!(dice.pick(&notebooks));
        }
        let Some(note) = seeder.id("knowledge.create_note", "note_id", input) else {
            continue;
        };
        seeder.note(
            &note,
            ("notes", "knowledge.note"),
            &title,
            None,
            State::Live,
            None,
        );
        // A FEW PER CENT WERE DELETED. A trash that is always empty is a trash
        // a reader is never punished for ignoring.
        if dice.chance(4)
            && seeder
                .run("knowledge.delete_note", json!({ "note_id": note }))
                .is_some()
        {
            seeder.restate(&note, State::Trashed);
        }
    }
}

// ---------------------------------------------------------------------------
// Tasks.
// ---------------------------------------------------------------------------

/// Two years of logbook behind a board. See the note inside on why the tail is
/// finished rather than open.
fn tasks(seeder: &mut Seeder, dice: &mut Dice) {
    for index in 0..TASKS {
        let shape = *dice.pick(TASK_SHAPES);
        let title = shape.replace("{}", &format!("wk {:02}", index % 104 + 1));
        // TWO YEARS OF LOGBOOK: dated, long past, and every one of them
        // finished. That is what a board somebody has actually used looks like.
        //
        // It is also the shape that was hardest to arrive at. A task's state
        // decides which unwindowed question it answers — open and past due is
        // overdue, undated has no deadline, completed is done — and a tail of
        // several hundred answers whichever of those it is in. An earlier cut
        // dodged all three by dating the tail into the future, which was the
        // wrong trade: it bent the world to keep thin questions passing. The
        // questions were given windows instead, and the tail may be ordinary.
        let days = -(dice.upto(TAIL_DAYS as usize) as i64) - TAIL_FLOOR_DAYS;
        let mut input = json!({
            "title": title,
            "priority": dice.upto(9) as i64 + 1,
            "due_at": at(days, 9, 0),
        });
        if dice.chance(25) {
            // THE WHOLE BAND. An estimate is an ordinary field of a task and
            // the tail estimates like one. It could not, while the world held a
            // single row carrying this field at all — a question about the
            // field was then answerable without reading its value. The story
            // carries two such rows now, so the value is load-bearing and this
            // is free to be honest.
            input["effort_min"] = json!((dice.upto(8) as i64 + 1) * 15);
        }
        let Some(task) = seeder.id("schedule.add_task", "task_id", input) else {
            continue;
        };
        seeder.note(
            &task,
            ("tasks", "schedule.task"),
            &title,
            Some(at(days, 9, 0)),
            State::Live,
            None,
        );
        if dice.chance(94) {
            if seeder
                .run(
                    "schedule.set_task_status",
                    json!({ "task_id": task, "status": "completed" }),
                )
                .is_some()
            {
                seeder.restate(&task, State::Completed);
            }
        } else if seeder
            // A FEW PER CENT WERE DELETED RATHER THAN DONE. A trash that is
            // always empty is a trash a reader is never punished for ignoring.
            .run("schedule.delete_task", json!({ "task_id": task }))
            .is_some()
        {
            seeder.restate(&task, State::Trashed);
        }
    }
}

// ---------------------------------------------------------------------------
// Docs.
// ---------------------------------------------------------------------------

fn docs(seeder: &mut Seeder, dice: &mut Dice) {
    let mut folders = Vec::new();
    for name in ["Statements", "Receipts", "Work", "Archive"] {
        if let Some(id) = seeder.id("core.create_folder", "folder_id", json!({ "name": name })) {
            folders.push(id);
        }
    }
    for index in 0..DOCS {
        let shape = *dice.pick(DOC_SHAPES);
        let title = shape.replace("{}", &format!("{:03}", index));
        // "(sample)" is in every shape above, and it stays there: a fixture
        // that imitates a statement without saying so is one somebody
        // eventually reads as genuine.
        let body = format!(
            "# {title}\n\nThis is sample demo data, not a real record.\n\n- Reference: SAMPLE-{index:04}\n"
        );
        let mut input = json!({ "title": title, "data_uri": crate::scenario::markdown(&body) });
        if !folders.is_empty() {
            input["folder_id"] = json!(dice.pick(&folders));
        }
        let Some(document) = seeder.id("core.add_document", "document_id", input) else {
            continue;
        };
        seeder.note(
            &document,
            ("docs", "core.document"),
            &title,
            None,
            State::Live,
            None,
        );
        if dice.chance(5)
            && seeder
                .run("core.trash_document", json!({ "document_id": document }))
                .is_some()
        {
            seeder.restate(&document, State::Trashed);
        }
    }
}

// ---------------------------------------------------------------------------
// Agenda.
// ---------------------------------------------------------------------------

/// Two years of calendar, ONE EVENT PER DAY SLOT.
///
/// `schedule.propose_event` refuses any busy overlap vault-wide, so the tail
/// cannot be laid out by drawing random times — it walks backwards a day at a
/// time and takes one fixed hour. What that costs in prettiness it buys in a
/// calendar that actually accepted every row.
fn events(seeder: &mut Seeder, dice: &mut Dice, friends: &[String]) {
    let Some(calendar) = crate::scenario::first_calendar(seeder) else {
        return;
    };
    for index in 0..EVENTS {
        // Backwards from the tail floor, one slot a day, so no tail event lands
        // in any window the suite's calendar questions reach.
        let days = -(index as i64) - TAIL_FLOOR_DAYS;
        let summary = *dice.pick(EVENT_SHAPES);
        let hour = 8 + (index % 9) as i64;
        let mut input = json!({
            "calendar_id": calendar,
            "summary": summary,
            "dtstart": at(days, hour, 0),
            "dtend": at(days, hour, 45),
        });
        // SOME OF THE TAIL HAS OTHER PEOPLE ON IT. A vault in which only the
        // story's own events carry an attendee list makes "who was at that"
        // answerable by "whichever event has one" — the same scarcity that
        // made one birthday row score as perfect birthday resolution.
        if index % 37 == 0 && !friends.is_empty() {
            let who = friends[index % friends.len()].clone();
            input["attendee_party_ids"] = json!([who]);
        }
        if let Some(event) = seeder.id("schedule.propose_event", "event_id", input) {
            seeder.note(
                &event,
                ("agenda", "core.event"),
                summary,
                Some(at(days, hour, 0)),
                State::Live,
                None,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Photos.
// ---------------------------------------------------------------------------

/// Bursts, not a scatter. Twenty-odd frames from one afternoon, at one
/// coordinate — so the place table collapses hundreds of frames into eight
/// rows, exactly as a camera roll does.
fn photos(seeder: &mut Seeder, dice: &mut Dice) {
    for index in 0..PHOTOS {
        let burst = index / 24;
        let (stem, latitude, longitude) = BURSTS[burst % BURSTS.len()];
        let days = -(burst as i64) * 11 - TAIL_FLOOR_DAYS;
        let hour = 10 + (index % 7) as i64;
        let title = format!("{stem} {:03}", index);
        let mut bytes = PIXEL.to_vec();
        // DISTINCT BYTES PER FRAME — see [`PIXEL`].
        bytes.extend_from_slice(&(index as u32).to_be_bytes());
        let input = json!({
            "data_uri": format!("data:image/png;base64,{}", crate::scenario::base64_of(&bytes)),
            "kind": "photo",
            "title": title,
            "captured_at": at(days, hour, (index % 50) as i64),
            "tz_offset_min": -420,
            "width": 1,
            "height": 1,
            "latitude": latitude,
            "longitude": longitude,
        });
        let Some(asset) = seeder.id("media.add_asset", "asset_id", input) else {
            continue;
        };
        seeder.note(
            &asset,
            ("photos", "core.content_item"),
            &title,
            Some(at(days, hour, (index % 50) as i64)),
            State::Live,
            None,
        );
        // THE FIRST FRAME OF A BURST NAMES ITS PLACE.
        //
        // `media.add_asset` mints one place row per rounded coordinate, and
        // an unnamed place is a latitude: nothing a member would search for,
        // and nothing a question can be asked about. Three named places in
        // the whole world made "where was this taken" a choice between three;
        // five more make the place table a table.
        // ONCE PER COORDINATE, not once per burst: the bursts cycle through
        // eight coordinates, and naming the ninth burst's place would rename a
        // row that already has a name and record it in the inventory twice.
        if index % 24 == 0
            && index / 24 < BURSTS.len()
            && let Some(place) = crate::scenario::place_of_asset(seeder, &asset)
            && seeder
                .run(
                    "media.name_place",
                    json!({ "place_id": place, "name": stem, "kind": "region" }),
                )
                .is_some()
        {
            seeder.note(
                &place,
                ("photos", "core.place"),
                stem,
                None,
                State::Live,
                None,
            );
        }
        // NO FAVOURITES IN THE TAIL. A star is a flag with no noun and no
        // window behind it: every starred frame in the world is an answer to
        // the same question, so a starred tail frame would not crowd that
        // answer, it would be part of it. The remaining question is what that
        // question should narrow BY — until it does, the flag stays the
        // story's.
        let _ = dice;
    }
}

// ---------------------------------------------------------------------------
// Locker.
// ---------------------------------------------------------------------------

/// The services a shelf accumulates. Ordinary, and deliberately sharing no
/// title with the story's five: a handle is an app, an entity and a LABEL, so a
/// repeated title would make a handle resolve to two rows.
const SERVICES: &[&str] = &[
    "Utility account",
    "Council tax portal",
    "Train tickets",
    "Grocery delivery",
    "Streaming — music",
    "Streaming — film",
    "Pharmacy account",
    "Bike shop",
    "Bookshop",
    "Camera store",
    "Cloud backup",
    "Domain registrar",
    "Newspaper",
    "Climbing gym",
    "Parcel locker",
    "Hardware store",
    "Language app",
    "Photo printing",
    "Ferry booking",
    "Car hire",
];

/// A HUNDRED AND TWENTY SEALED ITEMS, because five was a free board scan.
///
/// Locker is structurally absent from the search plane: a secret is not a
/// document and is not indexed. That makes it the app where "open the board and
/// read every label" is the ONLY strategy — which is fine, so long as reading
/// the whole board is not FREE. At five items it was, and a five-item Locker
/// inside a five-thousand-row world would have been the one place a
/// board-scanner paid nothing while a searcher paid everything: precisely the
/// artefact that corrupts the search-versus-board comparison this world exists
/// to price.
///
/// Every item is really sealed, under the story's own custody, through the
/// story's own helper — see [`crate::scenario::add_secret`].
fn locker(seeder: &mut Seeder, dice: &mut Dice, key: &[u8], key_id: &str) {
    for index in 0..SECRETS {
        let service = SERVICES[index % SERVICES.len()];
        let title = format!("{service} ({:02})", index / SERVICES.len() + 1);
        let user = format!("sam.whitaker+{index:03}@example.com");
        let password = format!("sample-only-{index:04}-not-a-real-secret");
        let kind = index % 10;
        let item = match kind {
            0 | 1 => crate::scenario::add_secret(
                seeder,
                key,
                key_id,
                "card",
                &title,
                &[
                    ("cardholder", "Sam Whitaker"),
                    ("card_number", "4000000000000002"),
                    ("expiry", "01/30"),
                    ("cvv", "999"),
                ],
            ),
            2 => crate::scenario::add_secret(
                seeder,
                key,
                key_id,
                "note",
                &title,
                &[("content", "Sample demo data, not a real secret.")],
            ),
            _ => crate::scenario::add_secret(
                seeder,
                key,
                key_id,
                "login",
                &title,
                &[("username", &user), ("password", &password)],
            ),
        };
        let Some(item) = item else { continue };
        seeder.note(
            &item,
            ("locker", "locker.item"),
            &title,
            None,
            State::Live,
            None,
        );
        if kind > 2 {
            // ROTATED, at a later step than it was created, so that a
            // password's age is a property that VARIES across this shelf
            // rather than one every row shares. See
            // [`crate::scenario::rotate_secret`].
            crate::scenario::rotate_secret(
                seeder,
                key,
                key_id,
                &item,
                &format!("{password}-rotated"),
            );
        }
        // A HANDFUL IN THE TRASH, so that counting this shelf means counting
        // the LIVE rows on it and not the rows there are.
        if dice.chance(4)
            && seeder
                .run("locker.trash_item", json!({ "item_id": item }))
                .is_some()
        {
            seeder.restate(&item, State::Trashed);
        }
    }
}

// ---------------------------------------------------------------------------
// Tally.
// ---------------------------------------------------------------------------

/// A ledger with a shape: a dozen merchants, a handful of groups, amounts that
/// vary around a per-merchant typical rather than uniformly at random.
fn tally(seeder: &mut Seeder, dice: &mut Dice, me: &str, _friends: &[String]) {
    // TALLY FRIENDS ARE THEIR OWN ROWS, and a short list of them is what makes
    // "how much does Neha owe me" ambiguous rather than unanswered.
    let mut members = Vec::new();
    let mut member_names: Vec<&str> = Vec::new();
    for name in ["Dev", "Mira", "Tomas", "Lena", "Ike", "Bo"] {
        if let Some(party) = seeder.id("tally.add_friend", "party_id", json!({ "name": name })) {
            seeder.note(
                &party,
                ("tally", "core.party"),
                name,
                None,
                State::Live,
                None,
            );
            members.push(party);
            member_names.push(name);
        }
    }
    let mut groups = Vec::new();
    let mut group_names: Vec<&str> = Vec::new();
    for (name, icon, color) in [
        ("Household", "🏠", "slateblue"),
        ("Weekends away", "🚗", "darkorange"),
        ("Climbing crew", "🧗", "teal"),
        ("Old flat", "🗝️", "indianred"),
    ] {
        if let Some(group) = seeder.id(
            "tally.create_group",
            "group_id",
            json!({ "name": name, "icon": icon, "color": color, "member_ids": members }),
        ) {
            seeder.note(
                &group,
                ("tally", "tally.group"),
                name,
                None,
                State::Live,
                None,
            );
            groups.push(group);
            group_names.push(name);
        }
    }
    if groups.is_empty() {
        return;
    }
    let everyone: Vec<String> = std::iter::once(me.to_owned())
        .chain(members.iter().cloned())
        .collect();
    let by_name: Vec<String> = std::iter::once(crate::OWNER.to_owned())
        .chain(member_names.iter().map(|name| (*name).to_owned()))
        .collect();

    for index in 0..EXPENSES {
        let (merchant, category, typical) = *dice.pick(MERCHANTS);
        // Around the typical, never uniform: a ledger of uniform amounts makes
        // "the big one" a question with no shape.
        let amount = (typical * (60 + dice.upto(120) as i64)) / 100 + 1;
        let days = -(dice.upto(TAIL_DAYS as usize) as i64) - TAIL_FLOOR_DAYS;
        let description = format!("{merchant} — {:03}", index % 250);
        let group_index = dice.upto(groups.len());
        let payer_index = dice.upto(everyone.len());
        let payer = everyone[payer_index].clone();
        // MOST ARE PERSONAL, a minority shared. A ledger where every line is
        // split is a ledger nobody keeps.
        let parties: Vec<String> = if dice.chance(30) {
            everyone.clone()
        } else {
            vec![payer.clone()]
        };
        let Some(expense) = seeder.id(
            "tally.add_expense",
            "expense_id",
            json!({
                "group_id": groups[group_index].clone(),
                "description": description,
                "amount_minor": amount,
                "paid_by": payer,
                "category": category,
                "spent_on": day(days),
                "splits": crate::scenario::even(amount, &parties, &payer),
            }),
        ) else {
            continue;
        };
        seeder.note(
            &expense,
            ("tally", "tally.expense"),
            &description,
            Some(day(days)),
            State::Live,
            None,
        );
        // THE AMOUNT, THE GROUP AND THE PAYER, ON THE INVENTORY ROW. A corpus
        // that asks what a pile of rows adds up to has to get that number from
        // somewhere, and the only honest somewhere is the world itself: an
        // expected total typed in by hand stops being true the moment this file
        // changes, silently, with nothing to catch it. Recording the facts a
        // question might group by is what lets a validator recompute such a
        // total instead of trusting it. See `Entity::facts`.
        seeder.value(&expense, amount.to_string());
        seeder.fact(&expense, "group", group_names[group_index]);
        seeder.fact(&expense, "paid_by", by_name[payer_index].clone());
        if dice.chance(3)
            && seeder
                .run("tally.delete_expense", json!({ "expense_id": expense }))
                .is_some()
        {
            seeder.restate(&expense, State::Trashed);
        }
    }
}
