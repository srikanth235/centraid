//! THE SECOND WORLD'S LONG TAIL — the same shapes, a disjoint vocabulary.
//!
//! ## Why a second tail exists at all
//!
//! `blind.json` holds out WORDING, not SCENARIO: it names the same cast, the
//! same trip and the same collisions as `suite.json`, so a candidate that
//! memorised "the dentist is Neha Rao, the trip is Tahoe" transfers across it
//! unpunished. A holdout that measures generalisation needs a SECOND WORLD —
//! a disjoint cast, disjoint places, a different trip and a collision
//! structure of its own — and a corpus written against that.
//!
//! ## What it shares with the first tail, and what it must not
//!
//! It shares the SHAPES, because the shapes are what make a vault realistic
//! and they are not the thing being held out: recurrence, a long tail of old
//! notes, few counterparties carrying many transactions, photo bursts,
//! duplicated names. Every one of those is a property of vaults, not of this
//! household.
//!
//! It shares no WORD. Every vocabulary below is disjoint from
//! [`crate::bulk`]'s on proper nouns, and so are the label TEMPLATES: a tail
//! that reused `"Notes — {} ({})"` would hand a candidate the shape of a label
//! it had already been fitted to, which is the wording holdout failing one
//! level down. `the_two_worlds_share_no_proper_noun` in `tests/` is what
//! keeps that true rather than intended.
//!
//! ## Parameterised, not copied
//!
//! The generators here take a [`Vocabulary`] rather than reading constants, so
//! a third world is a word list and not a third file. The first world's tail
//! is NOT rewritten onto it in this pass — `crates/evalworld/src/bulk.rs` is
//! held by another lane — and that is the only reason the two generators are
//! separate functions rather than one.
//!
//! Every other invariant of [`crate::bulk`] holds here unchanged and for the
//! same reasons: no bulk row carries a story row's exact label within the same
//! app and entity, no bulk row's own date falls within [`TAIL_FLOOR_DAYS`] of
//! the world's now, and the phase runs BEFORE the story so the story's
//! `created_at` stamps do not move.

use serde_json::json;

use crate::inventory::State;
use crate::{Seeder, at, day};

// ---------------------------------------------------------------------------
// How big, and how it is shaped. The same size class as the first world.
// ---------------------------------------------------------------------------

const NOTES: usize = 1_500;
const TASKS: usize = 700;
const EVENTS: usize = 620;
const EXPENSES: usize = 1_250;
const DOCS: usize = 320;
const PHOTOS: usize = 420;
const SECRETS: usize = 120;
const PEOPLE: usize = 220;

/// How far back the tail reaches, in days before the world's now.
const TAIL_DAYS: i64 = 900;

/// See [`crate::bulk`]: a recurring `MM-DD` carries no year, so it cannot be
/// placed safely in the past. This window lands every tail reminder in
/// September–February, clear of the months the story's calendar covers.
const MONTH_DAYS_CLEAR_OF_THE_WINDOW: (i64, usize) = (-110, 177);

/// The closest a bulk row's own date may come to the world's now.
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

/// A deterministic stream of small numbers — a 64-bit xorshift written out.
///
/// Not `rand`, for the reason [`crate::bulk`] gives: a dependency whose
/// algorithm may change between minor versions is a world that quietly stops
/// replaying.
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

    fn upto(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }

    fn pick<'a, T>(&mut self, from: &'a [T]) -> &'a T {
        &from[self.upto(from.len())]
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next() % 100 < percent
    }
}

// ---------------------------------------------------------------------------
// The vocabulary, as a parameter.
// ---------------------------------------------------------------------------

/// **EVERY WORD A TAIL IS MADE OF, IN ONE PLACE.**
///
/// The generators below read this and nothing else, so what distinguishes one
/// world's tail from another's is a value rather than a file. That is the
/// whole of the holdout's mechanism: the SHAPES are shared because shapes are
/// what a vault is, and the WORDS are disjoint because words are what a
/// fine-tune memorises.
pub(crate) struct Vocabulary {
    /// First names, repeated hard — a first name is not an identifier.
    pub(crate) first_names: &'static [&'static str],
    /// Surnames, short on purpose, so first-name-plus-surname collides too.
    /// The story's surnames stay out: a tail party sharing a story party's
    /// full name would make that story handle resolve to two rows.
    pub(crate) surnames: &'static [&'static str],
    pub(crate) roles: &'static [&'static str],
    /// Recurring merchants — `(name, category, typical minor units)`.
    pub(crate) merchants: &'static [(&'static str, &'static str, i64)],
    /// Note subjects, one step to the side of the story's nouns.
    pub(crate) note_subjects: &'static [&'static str],
    /// Note label templates. Two `{}`: the subject, then a discriminator.
    pub(crate) note_shapes: &'static [&'static str],
    /// Task label templates. One `{}`.
    pub(crate) task_shapes: &'static [&'static str],
    /// Event summaries, used verbatim.
    pub(crate) event_shapes: &'static [&'static str],
    /// Document label templates. One `{}`; every one carries `(sample)`.
    pub(crate) doc_shapes: &'static [&'static str],
    /// Photo bursts — `(caption stem, latitude, longitude)`. None of these may
    /// be the story's home coordinate: a burst sharing it would not be a burst
    /// near home, it would BE home.
    pub(crate) bursts: &'static [(&'static str, f64, f64)],
    /// Locker services. Deliberately sharing no title with the story's shelf.
    pub(crate) services: &'static [&'static str],
    /// Notebooks, folders, Tally friends and Tally groups.
    pub(crate) notebooks: &'static [&'static str],
    pub(crate) folders: &'static [&'static str],
    pub(crate) tally_friends: &'static [&'static str],
    pub(crate) tally_groups: &'static [(&'static str, &'static str, &'static str)],
    /// The story's own names, which the tail may never mint a second copy of.
    pub(crate) reserved: &'static [&'static str],
    /// The seed for this tail's dice. A different world is a different draw.
    pub(crate) dice_seed: u64,
}

/// THE SECOND WORLD'S WORDS.
///
/// Read them beside `crates/evalworld/src/bulk.rs`'s: not one proper noun is
/// shared, and not one template is either. `"Notes — {} ({})"` has become
/// `"{} — jotted down, {}"`, which is a different SHAPE and not a renaming of
/// the same one, because a candidate fitted to the first would otherwise still
/// recognise the second.
pub(crate) const SECOND: Vocabulary = Vocabulary {
    first_names: &[
        "Yusuf", "Halla", "Tomoko", "Ezra", "Winona", "Isolde", "Bram", "Sunniva", "Kwabena",
        "Liesel", "Otso", "Maribel", "Tarek", "Eilidh", "Ngozi", "Ruslan", "Solveig", "Tadeo",
        "Fenella", "Casimir", "Oleander", "Xiulan", "Zohar", "Berit",
    ],
    surnames: &[
        "Kirilenko",
        "Abiodun",
        "Strandberg",
        "Quintanilla",
        "Falconer",
        "Yamashiro",
        "Delacroix",
        "Mbeki",
        "Halvorsen",
        "Tremblay",
        "Sandoval",
        "Ashworth",
        "Pellegrini",
        "Ogundimu",
        "Weatherby",
    ],
    roles: &[
        "Allotment neighbour",
        "Choir",
        "Rowing club",
        "Film society",
        "Second cousin",
        "Letting agent",
        "Farrier",
        "Electrician",
        "Nursery parent",
    ],
    merchants: &[
        ("Sparrow Roasters", "food", 620),
        ("Quayside Grocer", "groceries", 4_400),
        ("Taverna Leda", "food", 3_400),
        ("Tram pass", "transport", 2_100),
        ("Forecourt on Ninth", "transport", 5_700),
        ("Print shop", "shopping", 1_600),
        ("Dispensary", "general", 1_350),
        ("Ironmonger", "shopping", 2_800),
        ("Launderette", "general", 950),
        ("Picture house", "fun", 2_100),
        ("Rowing club dues", "fun", 2_500),
        ("Allotment shop", "groceries", 3_100),
    ],
    note_subjects: &[
        "the eye plan",
        "contact lens quotes",
        "Albion weekend",
        "the coast cottage",
        "Elk parking",
        "the hire van",
        "sourdough crumpets",
        "the gumbo",
        "the sprint review",
        "the immersion heater",
        "the kayak",
        "the allotment",
        "audiobooks",
        "the flit",
        "the trellis",
        "what to pack down",
    ],
    note_shapes: &[
        "{} — jotted down, {}",
        "Half a thought on {}, {}",
        "{}: what is left over, {}",
        "Margin note on {}, {}",
        "Come back to {}, {}",
    ],
    task_shapes: &[
        "Settle the optical invoice ({})",
        "Veg box pickup ({})",
        "Feed the starter ({})",
        "Clear the card ({})",
        "Archive the negatives ({})",
        "Ring the letting agent ({})",
        "Reinstate the residents permit ({})",
        "Arrange the Albion viewing ({})",
        "Top up the screenwash ({})",
        "Lodge the cover paperwork ({})",
        "Reorder the lens solution ({})",
        "Write round the rowing eight ({})",
    ],
    event_shapes: &[
        "Sprint review",
        "1:1 with Bram",
        "Eye check",
        "Contact lens fitting",
        "Supper with Isolde",
        "Supper with Tarek",
        "Rowing outing",
        "Film society",
        "Nursery evening",
        "Osteopath",
        "Van service",
        "Barber",
    ],
    doc_shapes: &[
        "Wage slip {} (sample)",
        "Building society statement {} (sample)",
        "Mains bill {} (sample)",
        "Optical statement {} (sample)",
        "Ground rent receipt {} (sample)",
        "Van service record {} (sample)",
    ],
    bursts: &[
        ("Quayside walk", 37.2060, -121.9100),
        ("Rooftop of the flit", 37.1590, -121.9180),
        ("Albion shore", 39.2210, -123.7660),
        ("Russian Gulch trail", 39.3280, -123.8050),
        ("Ninth street roofs", 37.1890, -121.9010),
        ("Cliff lane", 37.0100, -122.0000),
        ("Caspar water", 39.3610, -123.8190),
        ("Maisonette yard", 37.1620, -121.9340),
    ],
    services: &[
        "Water account",
        "Rates portal",
        "Coach tickets",
        "Veg box delivery",
        "Podcast subscription",
        "Film subscription",
        "Dispensary account",
        "Kayak club",
        "Print shop",
        "Lens supplier",
        "Offsite backup",
        "Hosting account",
        "Daily paper",
        "Rowing club",
        "Collection point",
        "Ironmonger",
        "Phrasebook app",
        "Album printing",
        "Coach booking",
        "Van hire",
    ],
    notebooks: &["Studio", "Maisonette", "Listening", "Paperwork", "Stowed"],
    folders: &["Slips", "Dockets", "Studio", "Stowed"],
    tally_friends: &["Bram", "Isolde", "Tarek", "Sunniva", "Otso", "Berit"],
    tally_groups: &[
        ("Maisonette", "🏚️", "rebeccapurple"),
        ("Coastal outings", "🚐", "goldenrod"),
        ("Rowing eight", "🚣", "olivedrab"),
        ("Former share", "🔑", "sienna"),
    ],
    reserved: &[
        "Yusuf Bergmann",
        "Yusuf Castellanos",
        "Halla Brennan",
        "Halla Brennen",
        "Halla Sigurdsson",
        "Tomoko Brennan",
        "Ezra Finch",
        "Winona Achebe",
        "Yusuf",
        "Halla",
        "Tomoko",
    ],
    dice_seed: 0x5EED_20C0_FFEE_u64,
};

// ---------------------------------------------------------------------------
// The phase.
// ---------------------------------------------------------------------------

/// Seed the long tail. Runs BEFORE the story; see the module note.
pub(crate) fn seed(
    seeder: &mut Seeder,
    me: &str,
    words: &Vocabulary,
    locker_key: Option<(&[u8], &str)>,
) {
    let mut dice = Dice::new(words.dice_seed);
    let friends = people(seeder, &mut dice, words);
    notes(seeder, &mut dice, words);
    tasks(seeder, &mut dice, words);
    docs(seeder, &mut dice, words);
    events(seeder, &mut dice, words, &friends);
    photos(seeder, &mut dice, words);
    tally(seeder, &mut dice, words, me);
    if let Some((key, key_id)) = locker_key {
        locker(seeder, &mut dice, words, key, key_id);
    }
}

// ---------------------------------------------------------------------------
// People.
// ---------------------------------------------------------------------------

/// A roster where first names repeat hard, and one surname is spelled twice.
fn people(seeder: &mut Seeder, dice: &mut Dice, words: &Vocabulary) -> Vec<String> {
    let mut made = Vec::with_capacity(PEOPLE);
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for reserved in words.reserved {
        seen.insert((*reserved).to_owned());
    }
    let mut misspelled_once = false;
    for index in 0..PEOPLE {
        let first = *dice.pick(words.first_names);
        let last = *dice.pick(words.surnames);
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
                "role": dice.pick(words.roles),
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

        // A SIXTH OF THEM CARRY A PHONE NUMBER — a roster where everybody is
        // reachable makes "who can I actually call" a no-op.
        if dice.chance(16)
            && let Some(channel) = seeder.id(
                "people.save_contact_channel",
                "channel_id",
                json!({
                    "party_id": party,
                    "kind": "phone",
                    "label": "Cell",
                    "value": format!("+44-20-7946-{:04}", 1000 + index),
                }),
            )
        {
            seeder.note(
                &channel,
                ("people", "social.contact_channel"),
                &format!("{name} — Cell phone"),
                None,
                State::Live,
                None,
            );
            seeder.value(&channel, format!("+44-20-7946-{:04}", 1000 + index));
        }
        // A FIFTH CARRY A REMINDER, and none of them may fall inside the
        // months the story's own calendar covers — see the constant.
        if dice.chance(20) {
            let label = *dice.pick(&[
                "Birthday",
                "Birthday",
                "Birthday",
                "Started at the studio",
                "Moved in",
                "Saint's day",
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

fn notes(seeder: &mut Seeder, dice: &mut Dice, words: &Vocabulary) {
    let mut notebooks = Vec::new();
    for name in words.notebooks {
        if let Some(id) = seeder.id(
            "knowledge.create_notebook",
            "notebook_id",
            json!({ "name": name }),
        ) {
            notebooks.push(id);
        }
    }
    for index in 0..NOTES {
        let subject = *dice.pick(words.note_subjects);
        let shape = *dice.pick(words.note_shapes);
        let title = shape
            .replacen("{}", subject, 1)
            .replacen("{}", &format!("{:03}", index % 400), 1);
        let body = format!(
            "{subject}. Came back to this and put down what I still remembered.\n\n\
             - the part that keeps slipping\n- the next move\n- who would know\n\nLeaf {index}."
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

/// Two years of logbook behind a board: dated, long past, and nearly all of it
/// finished. See [`crate::bulk`] for why the tail is allowed to be ordinary.
fn tasks(seeder: &mut Seeder, dice: &mut Dice, words: &Vocabulary) {
    for index in 0..TASKS {
        let shape = *dice.pick(words.task_shapes);
        let title = shape.replace("{}", &format!("w/c {:02}", index % 104 + 1));
        let days = -(dice.upto(TAIL_DAYS as usize) as i64) - TAIL_FLOOR_DAYS;
        let mut input = json!({
            "title": title,
            "priority": dice.upto(9) as i64 + 1,
            "due_at": at(days, 9, 0),
        });
        if dice.chance(25) {
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

fn docs(seeder: &mut Seeder, dice: &mut Dice, words: &Vocabulary) {
    let mut folders = Vec::new();
    for name in words.folders {
        if let Some(id) = seeder.id("core.create_folder", "folder_id", json!({ "name": name })) {
            folders.push(id);
        }
    }
    for index in 0..DOCS {
        let shape = *dice.pick(words.doc_shapes);
        let title = shape.replace("{}", &format!("{index:03}"));
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

/// Two years of calendar, ONE EVENT PER DAY SLOT — `schedule.propose_event`
/// refuses any busy overlap vault-wide.
fn events(seeder: &mut Seeder, dice: &mut Dice, words: &Vocabulary, friends: &[String]) {
    let Some(calendar) = crate::scenario::first_calendar(seeder) else {
        return;
    };
    for index in 0..EVENTS {
        let days = -(index as i64) - TAIL_FLOOR_DAYS;
        let summary = *dice.pick(words.event_shapes);
        let hour = 8 + (index % 9) as i64;
        let mut input = json!({
            "calendar_id": calendar,
            "summary": summary,
            "dtstart": at(days, hour, 0),
            "dtend": at(days, hour, 45),
        });
        // SOME OF THE TAIL HAS OTHER PEOPLE ON IT, so "who was at that" is not
        // answerable by "whichever event has an attendee list".
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

/// Bursts, not a scatter — two dozen frames from one afternoon at one
/// coordinate, which is what collapses hundreds of frames into eight places.
fn photos(seeder: &mut Seeder, dice: &mut Dice, words: &Vocabulary) {
    for index in 0..PHOTOS {
        let burst = index / 24;
        let (stem, latitude, longitude) = words.bursts[burst % words.bursts.len()];
        let days = -(burst as i64) * 11 - TAIL_FLOOR_DAYS;
        let hour = 10 + (index % 7) as i64;
        let title = format!("{stem}, frame {index:03}");
        let mut bytes = PIXEL.to_vec();
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
        // ONCE PER COORDINATE, not once per burst: naming the ninth burst's
        // place would rename a row that already has a name.
        if index % 24 == 0
            && index / 24 < words.bursts.len()
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
        // NO FAVOURITES IN THE TAIL — a star is a flag with no noun and no
        // window behind it, so a starred tail frame would be part of the
        // answer rather than a crowd around it.
        let _ = dice;
    }
}

// ---------------------------------------------------------------------------
// Locker.
// ---------------------------------------------------------------------------

/// A HUNDRED AND TWENTY SEALED ITEMS, because five is a free board scan.
///
/// Locker is structurally absent from the search plane, which makes it the app
/// where reading the whole board is the only strategy — fine, so long as
/// reading the whole board is not free. See [`crate::bulk`].
fn locker(seeder: &mut Seeder, dice: &mut Dice, words: &Vocabulary, key: &[u8], key_id: &str) {
    for index in 0..SECRETS {
        let service = words.services[index % words.services.len()];
        let title = format!("{service} [{:02}]", index / words.services.len() + 1);
        let user = format!("dara.okonjo+{index:03}@example.com");
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
                    ("cardholder", "Dara Okonjo"),
                    ("card_number", "4000000000000002"),
                    ("expiry", "04/31"),
                    ("cvv", "888"),
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
            // ROTATED at a later step than it was created, so a password's age
            // VARIES across this shelf rather than being one every row shares.
            crate::scenario::rotate_secret(
                seeder,
                key,
                key_id,
                &item,
                &format!("{password}-rotated"),
            );
        }
        // A HANDFUL IN THE TRASH, so counting the shelf means counting the
        // LIVE rows on it.
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
fn tally(seeder: &mut Seeder, dice: &mut Dice, words: &Vocabulary, me: &str) {
    let mut members = Vec::new();
    let mut member_names: Vec<&str> = Vec::new();
    for name in words.tally_friends {
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
    for (name, icon, color) in words.tally_groups {
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
    let by_name: Vec<String> = std::iter::once(crate::OWNER_SECOND.to_owned())
        .chain(member_names.iter().map(|name| (*name).to_owned()))
        .collect();

    for index in 0..EXPENSES {
        let (merchant, category, typical) = *dice.pick(words.merchants);
        let amount = (typical * (60 + dice.upto(120) as i64)) / 100 + 1;
        let days = -(dice.upto(TAIL_DAYS as usize) as i64) - TAIL_FLOOR_DAYS;
        let description = format!("{merchant}, no. {:03}", index % 250);
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
