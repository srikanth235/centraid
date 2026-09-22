//! THE SCENARIO — one household, eight apps, and the ambiguities on purpose.
//!
//! Sam Whitaker's vault in the middle of June. A long weekend at Tahoe is being
//! planned, a course of dental work is being paid for, and the contact list has
//! the ordinary mess of a real one: the same person entered twice, two friends
//! who share a first name, and a handful of rows somebody deleted.
//!
//! **Read the planting, not just the prose.** Every `planted:` note in this
//! file names a row that exists to be confusable with another, and those notes
//! ride into `inventory.json`. A world where "dentist" matches one row would
//! score every candidate architecture as excellent at a job it never had to do.
//!
//! **Every write here is a typed command.** There is no SQL in this crate and
//! no way to add one: `sql-confinement` refuses it, and that refusal is what
//! makes the world worth scoring against — a row written any other way would
//! carry no `core_entity` sibling, no `row_version` and no FTS trigger firing.

use centraid_apps_kit::page::PageRequest;
use centraid_apps_kit::reads::{read_by_id, read_page};
use centraid_apps_kit::row::Cell;
use centraid_apps_kit::statement::{PageOrder, PageQuery};
use centraid_apps_kit::testdoor::TestDoor;
use serde_json::{Value, json};

use crate::inventory::State;
use crate::{Seeder, at, day};

/// Seed the whole world, app by app.
pub(crate) fn seed(seeder: &mut Seeder, me: &str, keys_dir: &std::path::Path, vault_id: &str) {
    // THE LONG TAIL FIRST, then the clock is jumped to where the story has
    // always started. Written first so that every story row's `created_at` is
    // exactly what it was when the world held 73 rows; the ids move, and stable
    // handles are what made that survivable. See `crate::bulk`.
    let locker_key = found_key(seeder, keys_dir, vault_id);
    crate::bulk::seed(
        seeder,
        me,
        locker_key
            .as_ref()
            .map(|(key, key_id)| (key.as_slice(), key_id.as_str())),
    );
    seeder.jump_to(crate::NOW_MS - crate::STORY_STARTS_DAYS_BEFORE * crate::DAY_MS);
    seeder.set_step_ms(crate::CLOCK_STEP_MS);

    // DOCS FIRST, and inside it the permit first of all. `core.restore_document`
    // refuses a document whose thirty-day grace window has run out, and the
    // permit is the row that has to STAY lapsed — it sat six hours inside its
    // window the moment the story grew by a dozen commands. Filing it at the
    // top of the story buys it forty days of margin instead of six hours, and
    // `the_grace_windows_are_not_on_a_knife_edge` is what keeps it there.
    let late_trash = docs(seeder);
    let people = people(seeder);
    notes(seeder);
    let ticked = tasks(seeder);
    agenda(seeder, &people);
    photos(seeder);
    tally(seeder, me, &people);
    if let Some((key, key_id)) = &locker_key {
        locker(seeder, key, key_id);
    }
    // THE JOINS, LAST, because every one of them names two rows that already
    // exist: a link, a tag and an album entry are all assertions ABOUT rows,
    // and a pass that ran earlier would have to mint its own subjects.
    depth(seeder, &people);
    tick_off(seeder, &ticked, late_trash.as_deref());
}

// ---------------------------------------------------------------------------
// The joins.
// ---------------------------------------------------------------------------

/// THE ROW THIS WORLD ALREADY WROTE, found by what a member would call it.
///
/// Every row the scenario seeds is recorded in [`Seeder::note`] before this
/// pass runs, so a join can name its two ends the way a case does — by app,
/// entity and label — rather than by threading ids through six functions. A
/// label that names no row answers `None` and the join is simply not made; the
/// world's own tests are what say whether a join that should exist does.
fn found(seeder: &Seeder, app: &str, entity: &str, label: &str) -> Option<String> {
    seeder
        .entities
        .iter()
        .find(|row| row.app == app && row.entity == entity && row.label == label)
        .map(|row| row.id.clone())
}

/// **THE LINK GRAPH, THE TAGS AND THE COLLECTION EDGES** — the part of the
/// ontology a vault grows once it has been lived in.
///
/// A world whose apps only share a WORD is a world in which every cross-app
/// question is a string match, and a candidate that never reads an edge scores
/// the same as one that does. So the two anchors this household actually has —
/// a trip and a person — are wired through `core_link` as the product wires
/// them, and the rows a member would file together carry the same label.
fn depth(seeder: &mut Seeder, circle: &Circle) {
    link_the_trip(seeder);
    link_the_dentist(seeder, circle);
    tag_the_two_anchors(seeder);
}

/// One asserted edge, by the two rows' own names.
fn link(
    seeder: &mut Seeder,
    from: (&str, &str, &str),
    from_type: &str,
    to: (&str, &str, &str),
    to_type: &str,
    relation: &str,
) {
    let (Some(from_id), Some(to_id)) = (
        found(seeder, from.0, from.1, from.2),
        found(seeder, to.0, to.1, to.2),
    ) else {
        return;
    };
    seeder.run(
        "core.link_entities",
        json!({
            "from_type": from_type,
            "from_id": from_id,
            "to_type": to_type,
            "to_id": to_id,
            "relation": relation,
        }),
    );
}

/// THE TRIP, as a graph rather than as a word.
///
/// The long weekend is a task, an event pair, an album, a folder of documents
/// and a ledger group, and until now the only thing holding them together was
/// the string "Tahoe". A member who renamed the trip would have broken every
/// one of those associations, which is the argument for the edge.
fn link_the_trip(seeder: &mut Seeder) {
    let plan = ("tasks", "schedule.task", "Plan the Tahoe trip");
    for (target, target_type, relation) in [
        (
            ("agenda", "core.event", "Cabin check-in"),
            "core.event",
            "about",
        ),
        (
            ("agenda", "core.event", "Cabin check-out"),
            "core.event",
            "about",
        ),
        (
            ("agenda", "core.event", "Emerald Bay"),
            "core.event",
            "about",
        ),
        (
            ("docs", "core.document", "Cabin rental agreement (sample)"),
            "core.document",
            "references",
        ),
        (
            ("docs", "core.document", "Tahoe packing list"),
            "core.document",
            "references",
        ),
        (
            ("notes", "knowledge.note", "Tahoe long weekend — shortlist"),
            "knowledge.note",
            "references",
        ),
        (
            ("tally", "tally.expense", "Cabin deposit"),
            "tally.expense",
            "about",
        ),
        (
            ("tally", "tally.expense", "Lift tickets"),
            "tally.expense",
            "about",
        ),
    ] {
        link(
            seeder,
            plan,
            "schedule.task",
            target,
            target_type,
            relation,
        );
    }
    // THE PERMIT IS NOT LINKED, AND COULD NOT BE. `core.link_entities` has a
    // `subject_is_live` precondition, so a row already in the bin cannot be
    // joined to anything — which means the graph can never answer "was this
    // deleted thing part of the trip". Recorded here rather than worked
    // around: it is a fact about the product, and a fixture that reached past
    // the precondition would be seeding a state no member can reach.
}

/// THE COURSE OF DENTAL WORK, wired to the person it is with.
///
/// The word "dentist" reaches nine rows in seven apps on purpose. The EDGE
/// reaches only the ones that are really about this course of treatment, which
/// is what makes a graph worth having next to an index.
fn link_the_dentist(seeder: &mut Seeder, circle: &Circle) {
    let Some(neha_rao) = circle.get("Neha Rao").cloned() else {
        return;
    };
    for (app, entity, label, logical) in [
        (
            "agenda",
            "core.event",
            "Dentist — cleaning",
            "core.event",
        ),
        (
            "notes",
            "knowledge.note",
            "Dentist — what Dr. Rao said",
            "knowledge.note",
        ),
        (
            "docs",
            "core.document",
            "Dentist pre-authorisation (sample)",
            "core.document",
        ),
        (
            "tally",
            "tally.expense",
            "Dentist copay",
            "tally.expense",
        ),
    ] {
        let Some(from_id) = found(seeder, app, entity, label) else {
            continue;
        };
        seeder.run(
            "core.link_entities",
            json!({
                "from_type": logical,
                "from_id": from_id,
                "to_type": "core.party",
                "to_id": neha_rao.clone(),
                "relation": "about",
            }),
        );
    }
}

/// TWO LABELS, ON EVERY ROW THAT CARRIES THEM.
///
/// A tag is the member's own word for a pile, and it is the one grouping that
/// crosses apps without a join table per pair. The packing list already
/// carried `tahoe`; it was the only tagged row in the world, which made "what
/// is tagged" answerable by returning it.
fn tag_the_two_anchors(seeder: &mut Seeder) {
    let subjects: [(&str, &str, &str, &str); 21] = [
        ("tahoe", "tasks", "schedule.task", "Plan the Tahoe trip"),
        (
            "tahoe",
            "tasks",
            "schedule.task",
            "Compare cabins — South Lake vs Truckee",
        ),
        ("tahoe", "tasks", "schedule.task", "Book the Tahoe cabin"),
        ("tahoe", "tasks", "schedule.task", "Draft packing list"),
        (
            "tahoe",
            "tasks",
            "schedule.task",
            "Rotate the tires before the drive",
        ),
        (
            "tahoe",
            "notes",
            "knowledge.note",
            "Tahoe long weekend — shortlist",
        ),
        (
            "tahoe",
            "notes",
            "knowledge.note",
            "Emerald Bay — where to park",
        ),
        (
            "tahoe",
            "docs",
            "core.document",
            "Cabin rental agreement (sample)",
        ),
        (
            "tahoe",
            "photos",
            "core.content_item",
            "Emerald Bay overlook",
        ),
        (
            "tahoe",
            "photos",
            "core.content_item",
            "Dusk over the west shore",
        ),
        (
            "tahoe",
            "photos",
            "core.content_item",
            "Bend in the Truckee",
        ),
        (
            "tahoe",
            "photos",
            "core.content_item",
            "Ana at the trailhead",
        ),
        (
            "dental",
            "tasks",
            "schedule.task",
            "Book dentist appointment",
        ),
        (
            "dental",
            "tasks",
            "schedule.task",
            "Call the dentist about the invoice",
        ),
        (
            "dental",
            "notes",
            "knowledge.note",
            "Dentist — what Dr. Rao said",
        ),
        (
            "dental",
            "docs",
            "core.document",
            "Dentist pre-authorisation (sample)",
        ),
        ("home", "docs", "core.document", "Renters insurance policy (sample)"),
        ("home", "notes", "knowledge.note", "Mom's chili, written down properly"),
        ("home", "tasks", "schedule.task", "Weekly grocery run"),
        ("home", "tasks", "schedule.task", "Learn to make sourdough"),
        (
            "home",
            "photos",
            "core.content_item",
            "Last light in the backyard",
        ),
    ];
    for (label, app, entity, row_label) in subjects {
        let Some(subject_id) = found(seeder, app, entity, row_label) else {
            continue;
        };
        // `core.tag_item` names a PHOTOGRAPH `media.asset`, which is the row
        // the inventory records; the other three subject types are spelled the
        // same in both places.
        let subject_type = if entity == "core.content_item" {
            "media.asset"
        } else {
            entity
        };
        seeder.run(
            "core.tag_item",
            json!({
                "subject_type": subject_type,
                "subject_id": subject_id,
                "label": label,
            }),
        );
    }
}

// ---------------------------------------------------------------------------
// People.
// ---------------------------------------------------------------------------

/// The People rows, by display name.
///
/// Keyed by name rather than by a field per person because the whole point of
/// this roster is that names are NOT unique: a struct with a `neha` field would
/// be the fixture quietly asserting the thing the world exists to deny.
type Circle = std::collections::BTreeMap<&'static str, String>;

/// A small living circle — **with two Nehas and two Marcos in it**.
///
/// The duplication is the point. "Dinner with Neha" is a sentence a member
/// writes without ambiguity in their own head and with plenty of it in their
/// vault, and a runtime that resolves it by taking the first row is a runtime
/// that will one day log an interaction against their dentist.
fn people(seeder: &mut Seeder) -> Circle {
    let mut circle = Circle::new();

    let roster: [(&str, &str, i64, Option<&str>); 7] = [
        (
            "Neha Rao",
            "Dentist",
            180,
            Some("one of three parties called Neha; also the only 'dentist' PERSON"),
        ),
        (
            "Neha Kulkarni",
            "College friend",
            30,
            Some("one of three parties called Neha"),
        ),
        (
            "Marco Ferreira",
            "Old roommate from Portland",
            45,
            Some("one of three parties called Marco"),
        ),
        (
            "Ana Ferreira",
            "Marco's sister",
            60,
            Some("shares a surname with Marco Ferreira"),
        ),
        ("Ray Alvarez", "Grandfather", 7, None),
        ("Priya Raman", "Design lead, ex-colleague", 90, None),
        (
            "Marco Silva",
            "Climbing partner",
            120,
            Some("one of three parties called Marco"),
        ),
    ];
    for (name, role, cadence, planted) in roster {
        let Some(party) = seeder.id(
            "people.add_person",
            "party_id",
            json!({ "display_name": name, "role": role, "cadence_days": cadence }),
        ) else {
            continue;
        };
        seeder.note(
            &party,
            ("people", "core.party"),
            name,
            None,
            State::Live,
            planted,
        );
        // THE CADENCE IS A COLUMN, NOT A ROW. `people_profile.cadence_days` has
        // no id of its own, so "who am I overdue to see" cannot be scored by
        // naming a row — it is scored by naming the party and the number.
        seeder.value(&party, cadence.to_string());
        circle.insert(name, party);
    }

    // THE DUPLICATE SOMEBODY MADE AND THEN TRASHED. A contact list that has
    // never had one is a contact list nobody has used — and a read that
    // forgets `deleted_at` answers with it.
    if let Some(party) = seeder.id(
        "people.add_person",
        "party_id",
        json!({ "display_name": "Marco Ferriera", "role": "Duplicate — misspelled", "cadence_days": 45 }),
    ) {
        seeder.note(
            &party,
            ("people", "core.party"),
            "Marco Ferriera",
            None,
            State::Live,
            Some("a misspelled duplicate of Marco Ferreira, trashed below"),
        );
        seeder.value(&party, "45");
        if seeder
            .run("people.trash_person", json!({ "party_id": party }))
            .is_some()
        {
            seeder.restate(&party, State::Trashed);
        }
    }

    // THE INTERACTION IS LOGGED AGAINST THE FRIEND, NOT THE DENTIST — named in
    // full here precisely because a member saying "Neha" would not have.
    //
    // Recorded in the inventory as `core.activity`, which is the table
    // `people.log_interaction` actually writes: "when did I last speak to
    // them" is a question about a row, and a corpus that could only name the
    // party would score a candidate correct for finding the person and
    // inventing the date.
    //
    // FIVE OF THEM, across five people. Two of these made "when did I last
    // hear from X" answerable by returning whichever of the pair existed;
    // five make the question about the row that names the right party.
    for (name, kind, text) in [
        (
            "Neha Kulkarni",
            "call",
            "Caught up about her Denver move; she wants the Tahoe dates.",
        ),
        ("Marco Ferreira", "message", "Sent him the cabin shortlist."),
        ("Ana Ferreira", "message", "Confirmed she is driving up with Marco."),
        ("Priya Raman", "call", "Portfolio review; she is hiring again."),
        ("Ray Alvarez", "call", "Sunday call. The mower is running."),
    ] {
        let Some(party) = circle.get(name) else {
            continue;
        };
        let party = party.clone();
        if let Some(interaction) = seeder.id(
            "people.log_interaction",
            "interaction_id",
            json!({ "party_id": party, "kind": kind, "text": text }),
        ) {
            seeder.note(
                &interaction,
                ("people", "core.activity"),
                &format!("{kind} — {name}"),
                None,
                State::Live,
                None,
            );
            seeder.value(&interaction, kind);
        }
    }

    // A birthday inside the trip window, so "what is happening that weekend"
    // has an answer that is not on the calendar. The row carries BOTH its
    // recurrence key (`MM-DD`, the value) and the day it next falls on (the
    // date), because "when is Ana's birthday" and "is anything happening on
    // the 21st" are the same row reached two different ways.
    //
    // TWO OF THEM, because a world with one important date scores "return the
    // only date row" as perfect birthday resolution.
    for (name, label, days, planted) in [
        (
            "Ana Ferreira",
            "Birthday",
            6_i64,
            Some("falls on the trip weekend, and is NOT on the calendar"),
        ),
        ("Ray Alvarez", "Birthday", 40, None),
        ("Marco Ferreira", "Anniversary", 20, None),
    ] {
        let Some(party) = circle.get(name).cloned() else {
            continue;
        };
        if let Some(date_row) = seeder.id(
            "people.add_important_date",
            "date_id",
            json!({
                "party_id": party,
                "label": label,
                "month_day": day(days)[5..].to_owned(),
                "reminder_on": true,
            }),
        ) {
            seeder.note(
                &date_row,
                ("people", "people.important_date"),
                &format!("{label} — {name}"),
                Some(day(days)),
                State::Live,
                planted,
            );
            seeder.value(&date_row, day(days)[5..].to_owned());
        }
    }
    // THE DEBT IS A `tally.obligation`, which is what `people.add_debt`
    // writes — the same table Tally's own balances live in, reached through
    // the People door.
    if let Some(party) = circle.get("Neha Rao").cloned() {
        if let Some(debt) = seeder.id(
            "people.add_debt",
            "debt_id",
            json!({
                "party_id": party,
                "direction": "owe",
                "amount_minor": 12_500,
                "reason": "Dentist balance after insurance",
            }),
        ) {
            seeder.note(
                &debt,
                ("people", "tally.obligation"),
                "Dentist balance after insurance",
                None,
                State::Live,
                Some("an eighth row saying 'dentist', and the only debt the OWNER owes"),
            );
            seeder.value(&debt, "12500");
            seeder.fact(&debt, "direction", "owe");
            seeder.fact(&debt, "party", "Neha Rao");
        }
    }

    // FOUR MORE OBLIGATIONS, and every one of them points the OTHER WAY.
    //
    // While the world held one debt, "does anyone owe anyone anything" was
    // answered by returning the only obligation row there is, and a candidate
    // that never read `direction` scored the same as one that did. Four rows
    // owed TO the owner make the direction load-bearing without making the
    // question that names a person ambiguous: exactly one party in this vault
    // is owed money BY the owner, and it is still the dentist.
    for (name, amount, reason) in [
        ("Marco Ferreira", 4_500_i64, "Concert tickets I fronted"),
        ("Ana Ferreira", 7_800, "Her half of the cabin deposit"),
        ("Priya Raman", 2_200, "Lunch, twice"),
        ("Ray Alvarez", 15_000, "Lent him for the new mower"),
    ] {
        let Some(party) = circle.get(name).cloned() else {
            continue;
        };
        if let Some(debt) = seeder.id(
            "people.add_debt",
            "debt_id",
            json!({
                "party_id": party,
                "direction": "owed",
                "amount_minor": amount,
                "reason": reason,
            }),
        ) {
            seeder.note(
                &debt,
                ("people", "tally.obligation"),
                reason,
                None,
                State::Live,
                Some("owed TO the owner, so the direction has to be read"),
            );
            seeder.value(&debt, amount.to_string());
            seeder.fact(&debt, "direction", "owed");
            seeder.fact(&debt, "party", name);
        }
    }

    // CONTACT CHANNELS, on the two people a question would reach for — and on
    // BOTH Nehas, so "text Neha" is ambiguous at the channel level too rather
    // than resolving itself by only one of them being reachable.
    for (name, kind, label, value) in [
        ("Neha Rao", "phone", "Clinic", "+1-555-0142"),
        ("Neha Kulkarni", "phone", "Mobile", "+1-555-0197"),
        ("Neha Kulkarni", "email", "Personal", "neha.k@example.com"),
        ("Marco Ferreira", "phone", "Mobile", "+1-555-0168"),
    ] {
        let Some(party) = circle.get(name).cloned() else {
            continue;
        };
        if let Some(channel) = seeder.id(
            "people.save_contact_channel",
            "channel_id",
            json!({ "party_id": party, "kind": kind, "label": label, "value": value }),
        ) {
            seeder.note(
                &channel,
                ("people", "social.contact_channel"),
                &format!("{name} — {label} {kind}"),
                None,
                State::Live,
                (name.starts_with("Neha"))
                    .then_some("both Nehas are reachable, so neither resolves by elimination"),
            );
            seeder.value(&channel, value);
        }
    }

    // ONE JOURNAL ENTRY. It lands in `knowledge_note` — the People journal and
    // the Notes app are the same table — so it is deliberately written about
    // nothing else in this world: an entry that mentioned the trip would
    // silently widen every note question the corpus asks.
    if let Some(entry) = seeder.id(
        "people.add_journal_entry",
        "entry_id",
        json!({
            "mood": "steady",
            "text": "Quiet Sunday. Fixed the fence, read on the porch.",
            // SATURDAY. The entry sat on a Monday, and "what did I write over
            // the weekend" then had no correct answer for a reader that
            // implements Sat-Sun properly: it would answer nothing and be
            // marked wrong for being right. This is an argument, not a
            // command, so moving it shifts no ids.
            "entry_date": day(-2),
        }),
    ) {
        seeder.note(
            &entry,
            ("people", "knowledge.note"),
            "People journal · steady",
            Some(at(-2, 12, 0)),
            State::Live,
            Some(
                "a People journal entry stored as a NOTE — the two apps share a table, and \
                 `centraid_apps_notes::load_library` does NOT return it",
            ),
        );
        seeder.value(&entry, "steady");
    }
    circle
}

// ---------------------------------------------------------------------------
// Notes.
// ---------------------------------------------------------------------------

/// One seeded note: title, body, format, the notebook it is filed in, and the
/// ambiguity it plants.
type SeededNote<'a> = (
    &'a str,
    &'a str,
    &'a str,
    &'a Option<String>,
    Option<&'a str>,
);

fn notes(seeder: &mut Seeder) {
    let notebook = |seeder: &mut Seeder, name: &str| {
        seeder.id(
            "knowledge.create_notebook",
            "notebook_id",
            json!({ "name": name }),
        )
    };
    let travel = notebook(seeder, "Travel");
    let health = notebook(seeder, "Health");
    let recipes = notebook(seeder, "Recipes");

    let library: [SeededNote<'_>; 6] = [
        (
            "Dentist — what Dr. Rao said",
            "Crown on the lower right, two visits. The first is the cleaning; the crown is fitted after. \
             Insurance covers 60% once the pre-authorisation is filed.",
            "markdown",
            &health,
            Some("one of seven rows saying 'dentist'"),
        ),
        (
            "Tahoe long weekend — shortlist",
            "## Stays\n- South Lake: walkable, closer to the good food\n- Truckee: quieter, longer drive to the water\n\n## Rough budget\nCabin ~$180/night, plus gas both ways.",
            "markdown",
            &travel,
            None,
        ),
        (
            "Emerald Bay — where to park",
            "The overlook lot fills by eight. The second pullout a mile north is usually open and adds ten minutes on foot.",
            "plain",
            &travel,
            Some("one of five rows saying 'Emerald Bay'; also a place and an event"),
        ),
        (
            "Mom's chili, written down properly",
            "1. Brown 2 lb chuck in batches — crowding steams it.\n2. Onion, garlic, one poblano until soft.\n3. Chili powder 3 tbsp, cumin 1 tbsp, bloom in the fat.\n4. Crushed tomatoes, beans, a splash of coffee. Two hours low.\n\n*Do not skip the coffee.*",
            "markdown",
            &recipes,
            None,
        ),
        (
            "Scratch — books people keep recommending",
            "The Design of Everyday Things (again), Salt Fat Acid Heat, Project Hail Mary.",
            "plain",
            &None,
            None,
        ),
        (
            "Dentist — old clinic notes",
            "Notes from the practice on Fourth Street, before the move. Superseded.",
            "plain",
            &health,
            Some(
                "a TRASHED row saying 'dentist' — a reader that ignores deleted_at answers with it",
            ),
        ),
    ];
    for (title, body, format, notebook, planted) in library {
        let mut input = json!({ "title": title, "body_text": body, "format": format });
        if let Some(notebook) = notebook {
            input["notebook_id"] = json!(notebook);
        }
        let Some(note) = seeder.id("knowledge.create_note", "note_id", input) else {
            continue;
        };
        seeder.note(
            &note,
            ("notes", "knowledge.note"),
            title,
            None,
            State::Live,
            planted,
        );
        if title == "Dentist — old clinic notes"
            && seeder
                .run("knowledge.delete_note", json!({ "note_id": note }))
                .is_some()
        {
            seeder.restate(&note, State::Trashed);
        }
    }
}

// ---------------------------------------------------------------------------
// Docs.
// ---------------------------------------------------------------------------

/// Bytes as an inline `data:` URI.
///
/// Percent-encoded by hand: the alternative is a URL crate in a fixture, and
/// the character set these documents use is small and known.
pub(crate) fn markdown(text: &str) -> String {
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

/// The filed documents — and the id of the one that gets trashed LATE.
///
/// `core.restore_document` refuses a document whose thirty-day grace window
/// has run out, and every trashed document in this world used to be past it:
/// the command's success path was unreachable and a corpus could only score
/// its refusal. One document is therefore trashed at the very end of the
/// build, two days before the world's now, which is the difference between a
/// restore that can be asked for and one that cannot.
fn docs(seeder: &mut Seeder) -> Option<String> {
    let folder = |seeder: &mut Seeder, name: &str| {
        seeder.id("core.create_folder", "folder_id", json!({ "name": name }))
    };
    let travel = folder(seeder, "Travel");
    let home = folder(seeder, "Home");
    let health = folder(seeder, "Health");

    let leaving = day(5);
    let back = day(8);
    let packing_body = format!(
        "# Tahoe packing list\n\nLeaving {leaving}, back {back}.\n\n\
         - Rain shell\n- Hiking boots\n- Headlamp\n- Swimsuit (the cabin has a hot tub)\n- Board games\n"
    );

    // "(sample)" IN THE TITLE for anything that imitates a real record. A
    // rental agreement, an insurance policy and a clinical pre-authorisation
    // are exactly the documents a member must never mistake for the real
    // thing, and a fixture that dropped the marker would be one somebody
    // eventually reads as genuine.
    let mut late_trash = None;
    let filed: [(&str, String, &Option<String>, Option<&str>); 6] = [
        // FIRST, so its grace window is the story's whole runway. See `seed`.
        (
            "Emerald Bay permit (sample)",
            "# Emerald Bay permit (sample)\n\nThis is sample demo data, not a real permit.\n\n\
             Day-use parking, one vehicle. Superseded — we are taking the north pullout.\n"
                .to_owned(),
            &travel,
            Some("a TRASHED row saying 'Emerald Bay', and PAST its thirty-day grace window"),
        ),
        (
            "Tahoe packing list",
            packing_body.clone(),
            &travel,
            None,
        ),
        (
            "Cabin rental agreement (sample)",
            format!(
                "# Cabin rental agreement (sample)\n\nThis is sample demo data, not a real agreement.\n\n\
                 - Property: 3BR cabin, South Lake Tahoe\n- Nights: {leaving} to {back}\n\
                 - Rate: $180 per night\n- Deposit: $300, refundable\n- Check-in 4pm, check-out 10am\n"
            ),
            &travel,
            Some("its nights overlap the calendar's trip window and the 'Plan the Tahoe trip' task"),
        ),
        (
            "Dentist pre-authorisation (sample)",
            "# Dentist pre-authorisation (sample)\n\nThis is sample demo data, not a real form.\n\n\
             - Member: SAMPLE-0000-0000\n- Procedure: crown, lower right\n- Covered: 60%\n- Filed by the practice\n"
                .to_owned(),
            &health,
            Some("one of seven rows saying 'dentist'"),
        ),
        (
            "Renters insurance policy (sample)",
            "# Renters insurance policy (sample)\n\nThis is sample demo data, not a real policy.\n\n\
             - Policy number: SAMPLE-0000-0000\n- Personal property: $30,000\n- Liability: $100,000\n"
                .to_owned(),
            &home,
            None,
        ),
        (
            "Trip receipts (sample)",
            "# Trip receipts (sample)\n\nThis is sample demo data, not a real receipt.\n\n\
             - Cabin deposit\n- Gas, both ways\n- Lift tickets\n"
                .to_owned(),
            &travel,
            Some("trashed INSIDE its thirty-day grace window, so a restore is reachable"),
        ),
    ];
    for (title, body, folder, planted) in filed {
        let mut input = json!({ "title": title, "data_uri": markdown(&body) });
        if let Some(folder) = folder {
            input["folder_id"] = json!(folder);
        }
        let Some(document) = seeder.id("core.add_document", "document_id", input) else {
            continue;
        };
        seeder.note(
            &document,
            ("docs", "core.document"),
            title,
            None,
            State::Live,
            planted,
        );
        if title == "Tahoe packing list" {
            // ONE EDIT, so the version walk has two versions to walk.
            seeder.run(
                "core.edit_document",
                json!({
                    "document_id": document,
                    "body_text": format!("{packing_body}- Tire chains (I-80 requires them after a storm)\n"),
                }),
            );
            seeder.run("core.star_document", json!({ "document_id": document }));
            seeder.run(
                "core.tag_item",
                json!({
                    "subject_type": "core.document",
                    "subject_id": document,
                    "label": "tahoe",
                }),
            );
        }
        if title == "Emerald Bay permit (sample)"
            && seeder
                .run("core.trash_document", json!({ "document_id": document }))
                .is_some()
        {
            seeder.restate(&document, State::Trashed);
        }
        if title == "Trip receipts (sample)" {
            // NOT TRASHED HERE. The story's clock runs out around eighteen
            // days back, which is inside thirty days today but will not be
            // once the story's runway grows. It is trashed with the last two
            // commands of the build instead, so the window is a fact of the
            // world rather than of how long the seeding happens to take.
            late_trash = Some(document.clone());
        }
    }
    late_trash
}

// ---------------------------------------------------------------------------
// Tasks.
// ---------------------------------------------------------------------------

/// A believable week on the board — **with two dentist tasks due on the same
/// day**, and one task whose title is also an event's.
/// The Tasks board, returning the two rows that get TICKED OFF LAST.
///
/// `schedule.set_task_status` stamps `completed_at` at command time and takes
/// no date, so WHEN a task is finished is decided by where in the seeding order
/// it is finished. Both of these used to be closed in place, five weeks before
/// the world's now, which nothing could distinguish from the two years of
/// logbook underneath them. They are handed back and closed at the very end
/// instead, which is also simply true of them: a weekly grocery run is finished
/// the week it was due.
fn tasks(seeder: &mut Seeder) -> Vec<String> {
    let mut ticked: Vec<String> = Vec::new();
    let add = |seeder: &mut Seeder,
               title: &str,
               input: Value,
               date: Option<String>,
               planted: Option<&str>| {
        let task = seeder.id("schedule.add_task", "task_id", input)?;
        seeder.note(
            &task,
            ("tasks", "schedule.task"),
            title,
            date,
            State::Live,
            planted,
        );
        Some(task)
    };

    add(
        seeder,
        "Book dentist appointment",
        json!({ "title": "Book dentist appointment", "due_at": at(2, 9, 0), "priority": 5, "effort_min": 15 }),
        Some(at(2, 9, 0)),
        Some("one of seven rows saying 'dentist', and one of two tasks due the same day"),
    );
    add(
        seeder,
        "Call the dentist about the invoice",
        json!({ "title": "Call the dentist about the invoice", "due_at": at(2, 14, 0), "priority": 4 }),
        Some(at(2, 14, 0)),
        Some("one of seven rows saying 'dentist', and one of two tasks due the same day"),
    );
    add(
        seeder,
        "Rotate the tires before the drive",
        json!({ "title": "Rotate the tires before the drive", "due_at": at(-3, 9, 0), "priority": 8 }),
        Some(at(-3, 9, 0)),
        Some("overdue at the world's now"),
    );

    let trip = add(
        seeder,
        "Plan the Tahoe trip",
        json!({
            "title": "Plan the Tahoe trip",
            "description": "Long weekend at the lake with Neha, Marco and Ana.",
            "due_at": at(7, 9, 0),
            "priority": 6,
            // A SECOND TASK WITH AN ESTIMATE, and deliberately a different
            // one. While exactly one task in the world carried an `effort_min`
            // at all, any question about that field could be answered by
            // returning the row that HAS one, without ever reading its value.
            // Two estimates, far apart, is the smallest change that makes the
            // value load-bearing (QUALITY G5).
            "effort_min": 120,
        }),
        Some(at(7, 9, 0)),
        Some("its due date falls INSIDE the calendar's trip window (+5 to +8)"),
    );
    if let Some(trip) = trip.as_ref() {
        add(
            seeder,
            "Compare cabins — South Lake vs Truckee",
            json!({ "title": "Compare cabins — South Lake vs Truckee", "parent_task_id": trip, "effort_min": 45 }),
            None,
            None,
        );
        add(
            seeder,
            "Book the Tahoe cabin",
            json!({ "title": "Book the Tahoe cabin", "parent_task_id": trip, "due_at": at(3, 9, 0) }),
            Some(at(3, 9, 0)),
            Some("a task and an EVENT share this exact title"),
        );
        if let Some(packing) = add(
            seeder,
            "Draft packing list",
            json!({ "title": "Draft packing list", "parent_task_id": trip }),
            None,
            None,
        ) {
            ticked.push(packing);
        }
    }

    if let Some(groceries) = add(
        seeder,
        "Weekly grocery run",
        json!({ "title": "Weekly grocery run", "due_at": at(-1, 9, 0), "priority": 4 }),
        Some(at(-1, 9, 0)),
        None,
    ) {
        ticked.push(groceries);
    }

    add(
        seeder,
        "Learn to make sourdough",
        json!({ "title": "Learn to make sourdough", "priority": 1 }),
        None,
        Some("no due date at all — a question about 'this week' must not match it"),
    );

    if let Some(library) = add(
        seeder,
        "Return the library books",
        json!({ "title": "Return the library books", "due_at": at(3, 9, 0) }),
        Some(at(3, 9, 0)),
        Some("a TRASHED task still carrying a due date inside the week"),
    ) && seeder
        .run("schedule.delete_task", json!({ "task_id": library }))
        .is_some()
    {
        seeder.restate(&library, State::Trashed);
    }
    ticked
}

/// TICK THE TWO OFF, last of everything and two days before the world's now.
///
/// See [`tasks`]: `set_task_status` stamps `completed_at` at command time, and
/// the story's own clock runs out around eighteen days back, which is not "this
/// week" by any reading. The clock is therefore moved to where these two
/// actually happened — a weekly grocery run is ticked off the week it was due —
/// which is the last thing the world does.
fn tick_off(seeder: &mut Seeder, ticked: &[String], late_trash: Option<&str>) {
    seeder.jump_to(crate::NOW_MS - 2 * crate::DAY_MS);
    // THE DOCUMENT TRASHED TWO DAYS AGO — see [`docs`]. Its grace window has
    // twenty-eight days left, which is what makes `core.restore_document`'s
    // success path reachable at all.
    if let Some(document) = late_trash
        && seeder
            .run("core.trash_document", json!({ "document_id": document }))
            .is_some()
    {
        seeder.restate(document, State::Trashed);
    }
    for task in ticked {
        if seeder
            .run(
                "schedule.set_task_status",
                json!({ "task_id": task, "status": "completed" }),
            )
            .is_some()
        {
            seeder.restate(task, State::Completed);
        }
    }
}

// ---------------------------------------------------------------------------
// Agenda.
// ---------------------------------------------------------------------------

/// One lived-in fortnight. **Every slot is disjoint**, because
/// `schedule.propose_event` refuses any busy overlap vault-wide — so the
/// overlapping windows this world needs are between the calendar and the
/// board, which is also where they overlap in a real week.
/// One seeded event: summary, description, `(dtstart, dtend)`, rrule, and the
/// ambiguity it plants.
type SeededEvent = (
    &'static str,
    Option<&'static str>,
    (String, String),
    Option<&'static str>,
    &'static [&'static str],
    Option<&'static str>,
);

fn agenda(seeder: &mut Seeder, circle: &Circle) {
    let Some(calendar) = first_calendar(seeder) else {
        seeder
            .refusals
            .push("schedule.propose_event: this vault has no calendar to write into".to_owned());
        return;
    };

    let slot = |days: i64, hour: i64, minute: i64, minutes: i64| {
        (at(days, hour, minute), at(days, hour, minute + minutes))
    };
    // WHO IS COMING IS A ROW, NOT A WORD IN THE SUMMARY. "Dinner with Neha"
    // names a Neha the vault cannot resolve; the ATTENDEE says which one, and
    // it is the only thing in this world that does. An event with no attendee
    // list makes "who's coming to this" a question about a title.
    let diary: [SeededEvent; 7] = [
        (
            "Morning run",
            Some("Loop around the reservoir."),
            slot(1, 6, 30, 45),
            Some("FREQ=WEEKLY"),
            &[],
            Some("the only recurring event, and the only one with nobody else on it"),
        ),
        (
            "Dinner with Neha",
            Some("She picked the place — Thai, near the park."),
            slot(1, 19, 0, 120),
            None,
            // NO ATTENDEE, AND THAT IS THE POINT. An attendee row would say
            // which Neha, and this is the one event in the world whose whole
            // value is that nothing in the vault does.
            &[],
            Some("three parties are called Neha; the summary names none of them"),
        ),
        (
            "Dentist — cleaning",
            None,
            slot(2, 15, 0, 60),
            None,
            &["Neha Rao"],
            Some("one of seven rows saying 'dentist', on the same day as two dentist TASKS"),
        ),
        (
            "Book the Tahoe cabin",
            Some("Last call before the long-weekend rates jump."),
            slot(3, 9, 0, 30),
            None,
            &[],
            Some("a task and an EVENT share this exact title"),
        ),
        (
            "Emerald Bay",
            Some("Park at the north pullout and walk in."),
            slot(6, 8, 0, 240),
            None,
            &["Neha Kulkarni", "Marco Ferreira", "Ana Ferreira"],
            Some("an EVENT and a PLACE share this exact name"),
        ),
        (
            "Cabin check-in",
            None,
            slot(5, 16, 0, 60),
            None,
            &["Neha Kulkarni", "Marco Ferreira", "Ana Ferreira"],
            Some(
                "opens the trip window +5 to +8, which the 'Plan the Tahoe trip' task ends inside",
            ),
        ),
        (
            "Cabin check-out",
            None,
            slot(8, 10, 0, 60),
            None,
            &["Neha Kulkarni", "Marco Ferreira", "Ana Ferreira"],
            None,
        ),
    ];
    for (summary, description, (dtstart, dtend), rrule, guests, planted) in diary {
        let mut input = json!({
            "calendar_id": calendar,
            "summary": summary,
            "dtstart": dtstart,
            "dtend": dtend,
        });
        let attendees: Vec<String> = guests
            .iter()
            .filter_map(|name| circle.get(name).cloned())
            .collect();
        if !attendees.is_empty() {
            input["attendee_party_ids"] = json!(attendees);
        }
        if let Some(description) = description {
            input["description"] = json!(description);
        }
        if let Some(rrule) = rrule {
            input["rrule"] = json!(rrule);
        }
        if let Some(event) = seeder.id("schedule.propose_event", "event_id", input) {
            seeder.note(
                &event,
                ("agenda", "core.event"),
                summary,
                Some(dtstart),
                State::Live,
                planted,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// Photos.
// ---------------------------------------------------------------------------

/// THE SAMPLE ROLL, COMPILED IN — and borrowed rather than copied.
///
/// These rasters already exist as the demo seed's assets
/// (`crates/centraid/src/bin/seed-assets/photos/`), they are original
/// procedurally drawn frames rather than any photograph of a person, and they
/// carry the `thumbhash` and `phash` values computed off these exact bytes.
/// Copying 200 KB of PNG into a second crate to avoid one relative path would
/// be two sets of bytes to keep in step; if that directory moves, this breaks
/// at compile time and loudly, which is the failure mode worth having.
macro_rules! sample {
    ($file:literal) => {
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../centraid/src/bin/seed-assets/photos/",
            $file
        ))
    };
}

/// Pacific daylight time — the whole roll is one American trip.
const TZ_OFFSET_MIN: i64 = -420;

/// Standard base64, no line breaks — what a `data:` URI carries.
pub(crate) fn base64_of(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let triple = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let packed =
            (u32::from(triple[0]) << 16) | (u32::from(triple[1]) << 8) | u32::from(triple[2]);
        for shift in [18, 12, 6, 0] {
            out.push(char::from(ALPHABET[((packed >> shift) & 0x3F) as usize]));
        }
        let padding = 3 - chunk.len();
        out.truncate(out.len() - padding);
        for _ in 0..padding {
            out.push('=');
        }
    }
    out
}

/// One frame: bytes, title, when, where, and the hashes computed off it.
struct Frame {
    bytes: &'static [u8],
    title: &'static str,
    days: i64,
    hour: i64,
    size: (i64, i64),
    place: Option<(f64, f64)>,
    thumbhash: &'static str,
    phash: &'static str,
    favorite: bool,
    planted: Option<&'static str>,
}

const EMERALD_BAY: (f64, f64) = (38.9542, -120.1094);
const WEST_SHORE_RIDGE: (f64, f64) = (39.0021, -120.1131);
const TALLAC_TRAILHEAD: (f64, f64) = (38.9186, -120.0836);
const HOME_BACKYARD: (f64, f64) = (37.4419, -122.143);

fn roll() -> Vec<Frame> {
    vec![
        Frame {
            bytes: sample!("emerald-bay-overlook.png"),
            title: "Emerald Bay overlook",
            days: -9,
            hour: 19,
            size: (360, 240),
            place: Some(EMERALD_BAY),
            thumbhash: "UwcKDYJnd3iPd4dzh1iHhrdwc/hX",
            phash: "1f0f0f1337250d17",
            favorite: true,
            planted: Some("its place is NAMED 'Emerald Bay', which is also an event's summary"),
        },
        Frame {
            bytes: sample!("tahoe-dusk-ridge.png"),
            title: "Dusk over the west shore",
            days: -9,
            hour: 20,
            size: (360, 240),
            place: Some(WEST_SHORE_RIDGE),
            thumbhash: "DAcKDYJod3d7h4hweHiIeJiAi2gH",
            phash: "1d2b070f5b371e4b",
            favorite: false,
            planted: None,
        },
        Frame {
            bytes: sample!("truckee-river-bend.png"),
            title: "Bend in the Truckee",
            days: -10,
            hour: 10,
            size: (360, 240),
            place: Some(WEST_SHORE_RIDGE),
            thumbhash: "m9cJFYQ3eIh/eXeGh0h3dKhwhApY",
            phash: "170f0f0b1b09071f",
            favorite: true,
            planted: Some(
                "shares a coordinate with 'Dusk over the west shore', so the two collapse into ONE place row",
            ),
        },
        Frame {
            bytes: sample!("ana-trailhead.png"),
            title: "Ana at the trailhead",
            days: -11,
            hour: 11,
            size: (270, 360),
            place: Some(TALLAC_TRAILHEAD),
            thumbhash: "pecJHQTXeH+KdmjXSIxlZ0iJgIAI",
            phash: "0070704454c88080",
            favorite: false,
            planted: Some("names Ana, who is also a party and a Tally friend"),
        },
        Frame {
            bytes: sample!("marco-workshop.png"),
            title: "Marco in the workshop",
            days: -20,
            hour: 15,
            size: (270, 360),
            place: None,
            thumbhash: "oSgKDQTod496lmfIV3x1ZzeAdQSI",
            phash: "0070706c70e88080",
            favorite: false,
            planted: Some("PLACE-LESS on purpose, and names one of three Marcos"),
        },
        Frame {
            bytes: sample!("backyard-last-light.png"),
            title: "Last light in the backyard",
            days: -2,
            hour: 19,
            size: (360, 240),
            place: Some(HOME_BACKYARD),
            thumbhash: "GDgOJYhneHiIeHeAiKh3h3eAcVcI",
            phash: "0f170f0f0f4f4bc9",
            favorite: false,
            planted: Some("hundreds of km from the trip, so the shelf has a trip AND a home"),
        },
        Frame {
            bytes: sample!("empty-hallway.png"),
            title: "The hallway, no one in it",
            days: -2,
            hour: 13,
            size: (270, 360),
            place: Some(HOME_BACKYARD),
            thumbhash: "aAgKBQB3iI94d4iXd3iHiEd/dYA3",
            phash: "0030300c0c0c0000",
            favorite: false,
            planted: Some("deleted below — a TRASHED photograph"),
        },
    ]
}

fn photos(seeder: &mut Seeder) {
    let mut assets: Vec<(String, &'static str)> = Vec::new();
    let mut emerald_bay_asset = None;
    let mut west_shore_asset = None;
    let mut backyard_asset = None;
    let mut trailhead_asset = None;
    for frame in roll() {
        let mut input = json!({
            "data_uri": format!("data:image/png;base64,{}", base64_of(frame.bytes)),
            "kind": "photo",
            "title": frame.title,
            "captured_at": at(frame.days, frame.hour, 0),
            "tz_offset_min": TZ_OFFSET_MIN,
            "width": frame.size.0,
            "height": frame.size.1,
            "thumbhash": frame.thumbhash,
            "phash": frame.phash,
        });
        // A place-less frame must send NEITHER coordinate: `media.add_asset`
        // refuses half of one, because half a coordinate is no location at all.
        if let Some((latitude, longitude)) = frame.place {
            let object = input.as_object_mut().expect("the input is an object");
            object.insert("latitude".to_owned(), json!(latitude));
            object.insert("longitude".to_owned(), json!(longitude));
        }
        let Some(asset) = seeder.id("media.add_asset", "asset_id", input) else {
            continue;
        };
        seeder.note(
            &asset,
            ("photos", "core.content_item"),
            frame.title,
            Some(at(frame.days, frame.hour, 0)),
            State::Live,
            frame.planted,
        );
        if frame.title == "Emerald Bay overlook" {
            emerald_bay_asset = Some(asset.clone());
        }
        if frame.title == "Dusk over the west shore" {
            west_shore_asset = Some(asset.clone());
        }
        if frame.title == "Last light in the backyard" {
            backyard_asset = Some(asset.clone());
        }
        if frame.title == "Ana at the trailhead" {
            trailhead_asset = Some(asset.clone());
        }
        if frame.favorite {
            seeder.run(
                "media.set_favorite",
                json!({ "asset_id": asset, "favorite": 1 }),
            );
        }
        if frame.title == "The hallway, no one in it" {
            if seeder
                .run("media.delete_asset", json!({ "asset_id": asset }))
                .is_some()
            {
                seeder.restate(&asset, State::Trashed);
            }
            continue;
        }
        assets.push((asset, frame.title));
    }

    // THE PLACE, NAMED. `media.add_asset` mints a place row per rounded
    // coordinate; naming one is what turns a latitude into a word a member
    // would search for — and this word is also an event's summary.
    if let Some(asset) = emerald_bay_asset
        && let Some(place) = place_of_asset(seeder, &asset)
        && seeder
            .run(
                "media.name_place",
                json!({ "place_id": place, "name": "Emerald Bay", "kind": "venue" }),
            )
            .is_some()
    {
        seeder.note(
            &place,
            ("photos", "core.place"),
            "Emerald Bay",
            None,
            State::Live,
            Some("a PLACE and an EVENT share this exact name"),
        );
    }

    // THE THIRD NAMED PLACE — HOME, so that "home" is a row and not a
    // subtraction.
    //
    // While it had no name, the only way to ask for the frames taken at home
    // was *every placed frame that is not on the trip* — which is a definition
    // of home holding solely in a world of ten photographs, and which a full
    // camera roll answers with the whole roll. Home is a PLACE; naming it is
    // what a member would have done anyway, and it survives any size of tail.
    if let Some(asset) = backyard_asset
        && let Some(place) = place_of_asset(seeder, &asset)
        && seeder
            .run(
                "media.name_place",
                json!({ "place_id": place, "name": "Home", "kind": "home" }),
            )
            .is_some()
    {
        seeder.note(
            &place,
            ("photos", "core.place"),
            "Home",
            None,
            State::Live,
            Some("the place 'photos from home' means, named so the question survives a full camera roll"),
        );
    }

    // A SECOND NAMED PLACE. One named place in the world makes "where was this
    // taken" answerable by returning the only place row there is, which scores
    // a lookup that never happened. This one is also the place TWO frames
    // collapsed into, so it is the row that distinguishes a reader that walks
    // the asset's place from one that matches a title.
    if let Some(asset) = west_shore_asset
        && let Some(place) = place_of_asset(seeder, &asset)
        && seeder
            .run(
                "media.name_place",
                json!({ "place_id": place, "name": "West shore ridge", "kind": "region" }),
            )
            .is_some()
    {
        seeder.note(
            &place,
            ("photos", "core.place"),
            "West shore ridge",
            None,
            State::Live,
            Some("TWO frames collapsed into this one place row"),
        );
    }

    // THE PLACE NOBODY NAMED, recorded as the member SEES it.
    //
    // `media.add_asset` mints a place row per rounded coordinate and names it
    // with the coordinate itself, so a place nobody has named is shown to the
    // member as a latitude and a longitude. That is a fact about the product
    // and not about this fixture, and a world that only recorded the named
    // places would hide it from every corpus written against this file.
    if let Some(asset) = trailhead_asset
        && let Some(place) = place_of_asset(seeder, &asset)
    {
        seeder.note(
            &place,
            ("photos", "core.place"),
            &format!("{}, {}", TALLAC_TRAILHEAD.0, TALLAC_TRAILHEAD.1),
            None,
            State::Live,
            Some("a place NOBODY NAMED — the member sees its coordinates as its name"),
        );
    }

    // The shortlist, as an album with a cover.
    if let Some(album) = seeder.id(
        "media.create_album",
        "album_id",
        json!({ "title": "Tahoe scouting" }),
    ) {
        seeder.note(
            &album,
            ("photos", "media.album"),
            "Tahoe scouting",
            None,
            State::Live,
            None,
        );
        for (asset, title) in &assets {
            if matches!(
                *title,
                "Emerald Bay overlook" | "Dusk over the west shore" | "Bend in the Truckee"
            ) {
                seeder.run(
                    "media.add_to_album",
                    json!({ "album_id": album, "asset_id": asset }),
                );
            }
        }
        if let Some((cover, _)) = assets
            .iter()
            .find(|(_, title)| *title == "Emerald Bay overlook")
        {
            seeder.run(
                "media.set_album_cover",
                json!({ "album_id": album, "asset_id": cover }),
            );
        }
    }

    // THREE MORE ALBUMS, AND NONE OF THEM HOLDS A TRIP FRAME.
    //
    // One album made "what album is that in" answerable by returning the only
    // album there is, and "what else is in there" answerable by returning
    // every photograph the world holds. Three more make the membership edge
    // load-bearing — and they are kept off the three Tahoe frames on purpose,
    // because a frame in two albums would make "what album is that in" a
    // question with two right answers and no way to say which was meant.
    for (title, members) in [
        ("People of mine", ["Ana at the trailhead", "Marco in the workshop"].as_slice()),
        ("Around the house", ["Last light in the backyard"].as_slice()),
        ("Rolls to sort", ["Marco in the workshop"].as_slice()),
    ] {
        let Some(album) = seeder.id(
            "media.create_album",
            "album_id",
            json!({ "title": title }),
        ) else {
            continue;
        };
        seeder.note(
            &album,
            ("photos", "media.album"),
            title,
            None,
            State::Live,
            Some("a second, third and fourth album, so the only-album answer stops working"),
        );
        for (asset, asset_title) in &assets {
            if members.contains(asset_title) {
                seeder.run(
                    "media.add_to_album",
                    json!({ "album_id": album, "asset_id": asset }),
                );
            }
        }
    }
}

/// The place row an asset's coordinate collapsed into.
///
/// Discovered rather than minted: `media.add_asset` rounds a coordinate to four
/// decimals and finds-or-creates the place itself, so the id only exists after
/// the frame is filed. Read through [`read_by_id`], which is the app plane's
/// own door — this crate holds statements as DATA and never as SQL.
pub(crate) fn place_of_asset(seeder: &mut Seeder, asset_id: &str) -> Option<String> {
    seeder
        .vault()
        .read(|connection| {
            let door = TestDoor::new(connection);
            Ok(read_by_id(
                &door,
                "evalworld.place_of_asset",
                "place_id",
                "media_asset",
                "asset_id",
                asset_id,
            )
            .ok()
            .flatten()
            .and_then(|row| row.get("place_id").and_then(Cell::text).map(str::to_owned)))
        })
        .ok()
        .flatten()
}

/// The private calendar `Vault::found` mints.
///
/// Discovered, never hard-coded: a vault founded by an older build does not
/// have one, and a scenario that guessed an id would write its whole diary into
/// nothing.
pub(crate) fn first_calendar(seeder: &mut Seeder) -> Option<String> {
    seeder
        .vault()
        .read(|connection| {
            let door = TestDoor::new(connection);
            let query = PageQuery::new(
                "evalworld.first_calendar",
                "calendar_id",
                "schedule_calendar",
                PageOrder::asc("calendar_id", "calendar_id"),
            );
            Ok(read_page(&door, &query, &PageRequest::first(1))
                .ok()
                .and_then(|page| {
                    page.rows
                        .first()
                        .and_then(|row| row.get("calendar_id"))
                        .and_then(Cell::text)
                        .map(str::to_owned)
                }))
        })
        .ok()
        .flatten()
}

// ---------------------------------------------------------------------------
// Tally.
// ---------------------------------------------------------------------------

/// Split `amount` across `parties` exactly — the remainder lands on the payer.
pub(crate) fn even(amount: i64, parties: &[String], payer: &str) -> Vec<Value> {
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

/// Two groups and an uneven ledger — **and three friends whose display names
/// are bare first names that already belong to People rows**.
///
/// That is not sloppiness in the fixture, it is what a vault looks like: Tally
/// friends and contacts are separate rows for the same humans, and "how much
/// does Neha owe me" is therefore a question with two candidate subjects before
/// anyone has even asked which Neha.
/// One seeded expense: description, minor units, which member paid, category,
/// days before the world's now, and the ambiguity it plants.
type SeededExpense = (
    &'static str,
    i64,
    usize,
    &'static str,
    i64,
    Option<&'static str>,
);

fn tally(seeder: &mut Seeder, me: &str, _circle: &Circle) {
    let mut friends = Vec::new();
    let mut names: Vec<String> = vec![crate::OWNER.to_owned()];
    for name in ["Neha", "Marco", "Ana"] {
        let Some(party) = seeder.id("tally.add_friend", "party_id", json!({ "name": name })) else {
            continue;
        };
        seeder.note(
            &party,
            ("tally", "core.party"),
            name,
            None,
            State::Live,
            Some("a Tally friend whose bare first name also belongs to People rows"),
        );
        friends.push(party);
        names.push(name.to_owned());
    }
    if friends.len() != 3 {
        return;
    }
    let everyone: Vec<String> = std::iter::once(me.to_owned())
        .chain(friends.iter().cloned())
        .collect();

    let Some(trip) = seeder.id(
        "tally.create_group",
        "group_id",
        json!({
            "name": "Tahoe Trip",
            "icon": "🏔️",
            "color": "steelblue",
            "member_ids": friends,
        }),
    ) else {
        return;
    };
    seeder.note(
        &trip,
        ("tally", "tally.group"),
        "Tahoe Trip",
        None,
        State::Live,
        None,
    );
    let clinic = seeder.id(
        "tally.create_group",
        "group_id",
        json!({ "name": "Clinic costs", "icon": "🦷", "color": "seagreen", "member_ids": [] }),
    );
    if let Some(clinic) = clinic.as_ref() {
        seeder.note(
            clinic,
            ("tally", "tally.group"),
            "Clinic costs",
            None,
            State::Live,
            Some("a SECOND group, so 'what did I spend' has to choose one"),
        );
    }

    let ledger: [SeededExpense; 6] = [
        ("Cabin deposit", 30_000, 0, "travel", -12, None),
        ("Gas for the drive up", 4_820, 2, "transport", -11, None),
        ("Groceries for the cabin", 11_267, 1, "groceries", -10, None),
        ("Lift tickets", 6_000, 0, "travel", -10, None),
        (
            "Ski rentals",
            9_200,
            3,
            "fun",
            -9,
            Some("deleted below — a TRASHED expense"),
        ),
        (
            "Dentist copay",
            12_500,
            0,
            // `general`, because Tally's CHECK admits nine categories and
            // `health` is not one of them. The refusal is the schema's and the
            // fixture takes it rather than arguing with it.
            "general",
            -6,
            Some("one of seven rows saying 'dentist'; filed in the OTHER group"),
        ),
    ];
    for (description, amount, payer_index, category, days_ago, planted) in ledger {
        let dentist = description == "Dentist copay";
        let group = if dentist {
            match clinic.as_ref() {
                Some(clinic) => clinic.clone(),
                None => continue,
            }
        } else {
            trip.clone()
        };
        let parties: Vec<String> = if dentist {
            vec![me.to_owned()]
        } else {
            everyone.clone()
        };
        let payer = everyone[payer_index].clone();
        let Some(expense) = seeder.id(
            "tally.add_expense",
            "expense_id",
            json!({
                "group_id": group,
                "description": description,
                "amount_minor": amount,
                "paid_by": payer,
                "category": category,
                "spent_on": day(days_ago),
                "splits": even(amount, &parties, &payer),
            }),
        ) else {
            continue;
        };
        seeder.note(
            &expense,
            ("tally", "tally.expense"),
            description,
            Some(day(days_ago)),
            State::Live,
            planted,
        );
        // WHAT IT COST, WHICH GROUP IT IS IN, AND WHO PAID — as words, so a
        // question about a pile of these can say which pile without naming a
        // uuid. See `Entity::facts`.
        seeder.value(&expense, amount.to_string());
        seeder.fact(
            &expense,
            "group",
            if dentist { "Clinic costs" } else { "Tahoe Trip" },
        );
        seeder.fact(&expense, "paid_by", names[payer_index].clone());
        if description == "Ski rentals"
            && seeder
                .run("tally.delete_expense", json!({ "expense_id": expense }))
                .is_some()
        {
            seeder.restate(&expense, State::Trashed);
        }
    }

    seeder.run(
        "tally.settle_up",
        json!({
            "from_party": everyone[3],
            "to_party": me,
            "amount_minor": 5_000,
            "group_id": trip,
            "paid_on": day(-4),
        }),
    );
}

// ---------------------------------------------------------------------------
// Locker — the eighth app, and the one the search plane cannot reach.
// ---------------------------------------------------------------------------

/// A shelf of five items.
///
/// **Locker is structurally absent from `crates/search`'s domains** — "a secret
/// cannot become a link target by adding a probe" — so a question whose answer
/// is in here cannot be answered by the FTS plane at all. That is precisely why
/// it is seeded: a candidate runtime that reaches every app through one text
/// index will be scored against two rows in here that it structurally cannot
/// see, and that is information the evaluation exists to produce.
///
/// The custody is real. `found_locker_key` writes the key file and the live
/// row at founding, `encrypt_under_locker_key` seals each cell against its own
/// row id and key generation, and the command refuses anything that is not
/// already ciphertext. Which is also why this is the one part of the world
/// whose BYTES differ between builds: the nonce is drawn fresh every call.
/// One seeded Locker item: type, title, its cells as `(field, plaintext)`, and
/// the ambiguity it plants. The plaintext never leaves this array — it is
/// sealed before it reaches a command and it never reaches the inventory.
type SeededSecret = (
    &'static str,
    &'static str,
    &'static [(&'static str, &'static str)],
    Option<&'static str>,
);

/// MINT THE LOCKER KEY, on its own, before anything is sealed under it.
///
/// Split out from the shelf so that the KEY exists before the long tail runs
/// and the tail's own secrets can be sealed under the same custody as the
/// story's. A Locker with five items in it is a Locker a reader can afford to
/// open and read end to end, which would have made the one app the search plane
/// cannot reach the one app a board scan gets for free — exactly the artefact
/// that would corrupt a search-versus-board comparison.
pub(crate) fn found_key(
    seeder: &mut Seeder,
    keys_dir: &std::path::Path,
    vault_id: &str,
) -> Option<(Vec<u8>, String)> {
    let custody = centraid_vault::custody::MemberKeyCustody::with_store(
        centraid_vault::custody::KeyStore::new(keys_dir),
        vault_id,
    );
    let key_id = seeder.mint();
    let now = centraid_vault::clock::format_iso_ms(crate::NOW_MS - 40 * crate::DAY_MS);
    // THE KEY FILE FIRST, THEN THE ROW, and both inside the commit the rest of
    // the vault's writes go through. `found_locker_key` has its own error type
    // — key custody is not a vault error — so the failure is carried out
    // through a cell rather than through `?`, which would need a `From` this
    // crate has no business adding to `VaultError`.
    let mut minted: Result<Vec<u8>, String> = Err("the locker key was never minted".to_owned());
    let committed = seeder.vault().commit(|tx| {
        tx.set_producer("evalworld.locker_key");
        minted =
            centraid_vault::custody::found_locker_key(tx.connection(), &custody, &key_id, &now)
                .map(|(_, key)| key)
                .map_err(|error| format!("locker key custody: {error}"));
        Ok(())
    });
    match (committed, minted) {
        (Ok(_), Ok(key)) => Some((key, key_id)),
        (Err(error), _) => {
            seeder.refusals.push(format!("locker key custody: {error}"));
            None
        }
        (_, Err(why)) => {
            seeder.refusals.push(why);
            None
        }
    }
}

/// SEAL ONE ITEM ONTO THE SHELF and hand back its id.
///
/// Shared with [`crate::bulk`] so the tail's hundred-odd secrets are sealed the
/// same way the story's five are — same custody, same AAD, same split between
/// the cells that are sealed and the `url` that is not. A fixture that faked
/// the tail's ciphertext would be a fixture asserting the thing Locker exists
/// to deny.
pub(crate) fn add_secret(
    seeder: &mut Seeder,
    key: &[u8],
    key_id: &str,
    item_type: &str,
    title: &str,
    fields: &[(&str, &str)],
) -> Option<String> {
    // THE SEAT MINTS THE ID (D-1020-L9): `AAD = rowId ‖ keyId`, so the party
    // that encrypts has to know the row's id before the row exists.
    let item_id = seeder.mint();
    let mut input = json!({
        "item_id": item_id,
        "type": item_type,
        "title": title,
        "key_id": key_id,
    });
    for (field, plaintext) in fields {
        match centraid_vault::custody::encrypt_under_locker_key(key, key_id, &item_id, plaintext) {
            // A `url` is not a secret and the command wants it in the clear:
            // only the sealed cells are sealed, which is the same split the
            // registry declares.
            Ok(cell) if *field != "url" => input[*field] = json!(cell),
            Ok(_) => input[*field] = json!(plaintext),
            Err(error) => {
                seeder
                    .refusals
                    .push(format!("locker.add_item {title}: {error}"));
                return None;
            }
        }
    }
    if fields.iter().any(|(field, _)| *field == "password") {
        // A password that is being stored is a password whose rotation state
        // the command requires be DECLARED rather than guessed.
        input["password_rotated"] = json!(false);
    }
    seeder.run("locker.add_item", input).map(|_| item_id)
}

/// RESEAL AN ITEM'S PASSWORD at a later moment than it was created.
///
/// A password's age is readable from its own stamp against the row's creation
/// stamp, and a shelf on which no password was ever re-sealed makes that field
/// carry no information: every row answers the same. The tail rotates, which is
/// what a password manager somebody has actually used looks like anyway.
pub(crate) fn rotate_secret(
    seeder: &mut Seeder,
    key: &[u8],
    key_id: &str,
    item_id: &str,
    plaintext: &str,
) {
    let Ok(cell) = centraid_vault::custody::encrypt_under_locker_key(key, key_id, item_id, plaintext)
    else {
        return;
    };
    // `key_id` IS REQUIRED HERE TOO, not just on `add_item`: a sealed write
    // must name the key generation it was sealed under, or the vault refuses it
    // rather than storing a cell nothing can open.
    seeder.run(
        "locker.edit_item",
        json!({
            "item_id": item_id,
            "key_id": key_id,
            "password": cell,
            "password_rotated": true,
        }),
    );
}

fn locker(seeder: &mut Seeder, key: &[u8], key_id: &str) {
    let shelf: [SeededSecret; 5] = [
        (
            "login",
            "Emerald Bay Cabins",
            &[
                ("username", "sam.whitaker@example.com"),
                ("password", "correct-horse-battery-staple"),
                ("url", "https://emeraldbaycabins.example"),
            ],
            Some(
                "one of five rows saying 'Emerald Bay' — and the only one the FTS plane cannot reach",
            ),
        ),
        (
            "login",
            "Dentist portal",
            &[
                ("username", "swhitaker"),
                ("password", "molar-crown-june"),
                ("url", "https://dentalportal.example"),
            ],
            Some(
                "one of seven rows saying 'dentist' — and the only one the FTS plane cannot reach",
            ),
        ),
        (
            "card",
            "Household Visa",
            &[
                ("cardholder", "Sam Whitaker"),
                ("card_number", "4000000000000002"),
                ("expiry", "09/29"),
                ("cvv", "123"),
            ],
            None,
        ),
        (
            "wifi",
            "Cabin wifi",
            &[("network", "EmeraldBayGuest"), ("password", "lakeside2026")],
            None,
        ),
        (
            "login",
            "Airline — old account",
            &[("username", "swhitaker"), ("password", "superseded-2024")],
            Some("a TRASHED locker item"),
        ),
    ];
    for (item_type, title, fields, planted) in shelf {
        let Some(item_id) = add_secret(seeder, key, key_id, item_type, title, fields) else {
            continue;
        };
        seeder.note(
            &item_id,
            ("locker", "locker.item"),
            title,
            None,
            State::Live,
            planted,
        );
        if title == "Airline — old account"
            && seeder
                .run("locker.trash_item", json!({ "item_id": item_id }))
                .is_some()
        {
            seeder.restate(&item_id, State::Trashed);
        }
    }
}
