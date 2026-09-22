//! THE SECOND SCENARIO — a different household, the same eight apps, its own
//! ambiguities.
//!
//! Dara Okonjo's vault in the middle of June. A weekend on the Mendocino coast
//! is being planned, a course of optometry is being paid for, and the contact
//! list has the ordinary mess of a real one: two Yusufs, two Hallas, a surname
//! shared by a couple, and a handful of rows somebody deleted.
//!
//! ## Why there are two worlds
//!
//! `suite.json` and `blind.json` are two corpora over ONE world. That holds
//! out wording and nothing else: a third of the blind set's handles are rows
//! the primary suite also names, and half its requests share a three-gram with
//! a primary one. A candidate that has memorised *this cast, this trip, this
//! dentist* transfers straight across, and the blind-versus-primary gap
//! reports generalisation it has not measured.
//!
//! This world exists so that `holdout.json` can hold out the SCENARIO. Nothing
//! in it shares a proper noun with the first world — not a person, not a
//! place, not a trip, not a merchant, not a tail template —
//! and `the_two_worlds_share_no_proper_noun` asserts it rather than trusting
//! it.
//!
//! ## What it deliberately keeps
//!
//! The SHAPE of the first world, because the shape is what makes a vault a
//! vault and is not the thing being held out:
//!
//! | Planted | Where |
//! |---|---|
//! | Rows saying **optometrist**, across the apps | notes ×2 (one trashed), docs, tasks ×2 (same due day), agenda, tally, locker, a People debt |
//! | Two whole people called **Yusuf**, both reachable, and an event that names neither | people ×2 + channels ×3, tally ×1, agenda ×1 |
//! | Two people called **Halla**, one of them a trashed misspelling | people ×3, tally ×1, photos ×0 |
//! | An **event and a place with the same name** — "Glass Beach" — plus a second named place so "where was this taken" is not answered by elimination | agenda, photos ×3, notes, docs, locker |
//! | A **task and an event with the same title** — "Reserve the Mendocino cottage" | tasks, agenda |
//! | **Five obligations across five people**, one of them owed BY the owner | people |
//! | **Four albums**, none of them holding a coast frame twice | photos |
//! | **A document trashed INSIDE its thirty-day grace window**, so a restore is reachable | docs |
//! | **Soft-deleted rows in seven apps**, several colliding with live labels | notes, docs, tasks, tally, photos, locker, people |
//!
//! Every write here is a typed command, for the reason
//! [`crate::scenario`] gives: this crate holds no SQL and `sql-confinement`
//! refuses it one.

use serde_json::{Value, json};

use crate::inventory::State;
use crate::scenario::{
    add_secret, base64_of, even, first_calendar, found_key, markdown, place_of_asset,
};
use crate::{Seeder, at, day};

/// Seed the whole second world, app by app.
pub(crate) fn seed(seeder: &mut Seeder, me: &str, keys_dir: &std::path::Path, vault_id: &str) {
    // THE LONG TAIL FIRST, then the clock is jumped to where the story starts
    // — the same ordering the first world uses and for the same reason.
    let locker_key = found_key(seeder, keys_dir, vault_id);
    crate::bulk2::seed(
        seeder,
        me,
        &crate::bulk2::SECOND,
        locker_key
            .as_ref()
            .map(|(key, key_id)| (key.as_slice(), key_id.as_str())),
    );
    seeder.jump_to(crate::NOW_MS - crate::STORY_STARTS_DAYS_BEFORE * crate::DAY_MS);
    seeder.set_step_ms(crate::CLOCK_STEP_MS);

    // DOCS FIRST, and inside it the permit first of all: `core.restore_document`
    // refuses a document whose thirty-day grace window has run out, and the
    // permit is the row that has to STAY lapsed. Filing it at the top of the
    // story buys it the story's whole runway of margin.
    let late_trash = docs(seeder);
    let people = people(seeder);
    notes(seeder);
    let ticked = tasks(seeder);
    agenda(seeder, &people);
    photos(seeder);
    tally(seeder, me);
    if let Some((key, key_id)) = &locker_key {
        locker(seeder, key, key_id);
    }
    // THE JOINS LAST, because every one of them names two rows that already
    // exist.
    depth(seeder, &people);
    tick_off(seeder, &ticked, late_trash.as_deref());
}

// ---------------------------------------------------------------------------
// The joins.
// ---------------------------------------------------------------------------

/// The row this world already wrote, found by what a member would call it.
fn found(seeder: &Seeder, app: &str, entity: &str, label: &str) -> Option<String> {
    seeder
        .entities
        .iter()
        .find(|row| row.app == app && row.entity == entity && row.label == label)
        .map(|row| row.id.clone())
}

/// The link graph, the tags and the collection edges.
///
/// A world whose apps only share a WORD is a world in which every cross-app
/// question is a string match, and a candidate that never reads an edge scores
/// the same as one that does.
fn depth(seeder: &mut Seeder, circle: &Circle) {
    link_the_weekend(seeder);
    link_the_optometry(seeder, circle);
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

/// THE WEEKEND, as a graph rather than as a word.
fn link_the_weekend(seeder: &mut Seeder) {
    let plan = ("tasks", "schedule.task", "Organise the Mendocino weekend");
    for (target, target_type, relation) in [
        (
            ("agenda", "core.event", "Cottage arrival"),
            "core.event",
            "about",
        ),
        (
            ("agenda", "core.event", "Cottage departure"),
            "core.event",
            "about",
        ),
        (
            ("agenda", "core.event", "Glass Beach"),
            "core.event",
            "about",
        ),
        (
            ("docs", "core.document", "Cottage rental agreement (sample)"),
            "core.document",
            "references",
        ),
        (
            ("docs", "core.document", "Mendocino kit list"),
            "core.document",
            "references",
        ),
        (
            ("notes", "knowledge.note", "Mendocino weekend — shortlist"),
            "knowledge.note",
            "references",
        ),
        (
            ("tally", "tally.expense", "Cottage deposit"),
            "tally.expense",
            "about",
        ),
        (
            ("tally", "tally.expense", "Kayak hire"),
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
    // THE PERMIT IS NOT LINKED, AND COULD NOT BE: `core.link_entities` has a
    // `subject_is_live` precondition, so a row already in the bin cannot be
    // joined to anything. Recorded rather than worked around — it is a fact
    // about the product.
}

/// THE COURSE OF EYE WORK, wired to the person it is with.
///
/// The word "optometrist" reaches eight rows across the apps on purpose. The
/// EDGE reaches only the ones really about this course of treatment, which is
/// what makes a graph worth having next to an index.
fn link_the_optometry(seeder: &mut Seeder, circle: &Circle) {
    let Some(bergmann) = circle.get("Yusuf Bergmann").cloned() else {
        return;
    };
    for (app, entity, label, logical) in [
        (
            "agenda",
            "core.event",
            "Optometrist — fitting",
            "core.event",
        ),
        (
            "notes",
            "knowledge.note",
            "Optometrist — what Bergmann said",
            "knowledge.note",
        ),
        (
            "docs",
            "core.document",
            "Optometrist pre-authorisation (sample)",
            "core.document",
        ),
        (
            "tally",
            "tally.expense",
            "Optometrist copay",
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
                "to_id": bergmann.clone(),
                "relation": "about",
            }),
        );
    }
}

/// Three labels, on every row that carries them. A tag is the member's own
/// word for a pile, and the one grouping that crosses apps without a join
/// table per pair.
fn tag_the_two_anchors(seeder: &mut Seeder) {
    let subjects: [(&str, &str, &str, &str); 20] = [
        (
            "mendocino",
            "tasks",
            "schedule.task",
            "Organise the Mendocino weekend",
        ),
        (
            "mendocino",
            "tasks",
            "schedule.task",
            "Weigh cottages — Elk vs Albion",
        ),
        (
            "mendocino",
            "tasks",
            "schedule.task",
            "Reserve the Mendocino cottage",
        ),
        ("mendocino", "tasks", "schedule.task", "Write the kit list"),
        (
            "mendocino",
            "tasks",
            "schedule.task",
            "Swap the wiper blades before the drive",
        ),
        (
            "mendocino",
            "notes",
            "knowledge.note",
            "Mendocino weekend — shortlist",
        ),
        (
            "mendocino",
            "notes",
            "knowledge.note",
            "Glass Beach — where to park",
        ),
        (
            "mendocino",
            "docs",
            "core.document",
            "Cottage rental agreement (sample)",
        ),
        (
            "mendocino",
            "photos",
            "core.content_item",
            "Glass Beach shingle",
        ),
        (
            "mendocino",
            "photos",
            "core.content_item",
            "Fog over the pygmy pines",
        ),
        (
            "mendocino",
            "photos",
            "core.content_item",
            "Curve of the Noyo",
        ),
        (
            "mendocino",
            "photos",
            "core.content_item",
            "Tomoko on the headland",
        ),
        (
            "optical",
            "tasks",
            "schedule.task",
            "Arrange optometrist appointment",
        ),
        (
            "optical",
            "tasks",
            "schedule.task",
            "Ring the optometrist about the invoice",
        ),
        (
            "optical",
            "notes",
            "knowledge.note",
            "Optometrist — what Bergmann said",
        ),
        (
            "optical",
            "docs",
            "core.document",
            "Optometrist pre-authorisation (sample)",
        ),
        (
            "maisonette",
            "docs",
            "core.document",
            "Contents insurance policy (sample)",
        ),
        (
            "maisonette",
            "notes",
            "knowledge.note",
            "Grandpa's gumbo, written out properly",
        ),
        (
            "maisonette",
            "tasks",
            "schedule.task",
            "Fortnightly veg box",
        ),
        (
            "maisonette",
            "photos",
            "core.content_item",
            "Late sun in the courtyard",
        ),
    ];
    for (label, app, entity, row_label) in subjects {
        let Some(subject_id) = found(seeder, app, entity, row_label) else {
            continue;
        };
        // `core.tag_item` names a PHOTOGRAPH `media.asset`, which is the row
        // the inventory records; the other subject types are spelled the same
        // in both places.
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

/// The People rows, by display name. Keyed by name rather than by a field per
/// person because the whole point of this roster is that names are NOT unique.
type Circle = std::collections::BTreeMap<&'static str, String>;

/// A small living circle — **with two Yusufs and two Hallas in it**.
fn people(seeder: &mut Seeder) -> Circle {
    let mut circle = Circle::new();

    let roster: [(&str, &str, i64, Option<&str>); 7] = [
        (
            "Yusuf Bergmann",
            "Optometrist",
            180,
            Some("one of two parties called Yusuf; also the only 'optometrist' PERSON"),
        ),
        (
            "Yusuf Castellanos",
            "Choir tenor",
            30,
            Some("one of two parties called Yusuf"),
        ),
        (
            "Halla Brennan",
            "Cousin",
            45,
            Some("one of two live parties called Halla"),
        ),
        (
            "Tomoko Brennan",
            "Halla's wife",
            60,
            Some("shares a surname with Halla Brennan"),
        ),
        ("Ezra Finch", "Grandfather", 7, None),
        ("Winona Achebe", "Studio lead, ex-colleague", 90, None),
        (
            "Halla Sigurdsson",
            "Rowing partner",
            120,
            Some("one of two live parties called Halla"),
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
        // THE CADENCE IS A COLUMN, NOT A ROW — `people_profile.cadence_days`
        // has no id of its own, so "who am I overdue to see" is scored by
        // naming the party and the number.
        seeder.value(&party, cadence.to_string());
        circle.insert(name, party);
    }

    // THE DUPLICATE SOMEBODY MADE AND THEN TRASHED. A contact list that has
    // never had one is a contact list nobody has used.
    if let Some(party) = seeder.id(
        "people.add_person",
        "party_id",
        json!({ "display_name": "Halla Brennen", "role": "Duplicate — misspelled", "cadence_days": 45 }),
    ) {
        seeder.note(
            &party,
            ("people", "core.party"),
            "Halla Brennen",
            None,
            State::Live,
            Some("a misspelled duplicate of Halla Brennan, trashed below"),
        );
        seeder.value(&party, "45");
        if seeder
            .run("people.trash_person", json!({ "party_id": party }))
            .is_some()
        {
            seeder.restate(&party, State::Trashed);
        }
    }

    // FIVE INTERACTIONS ACROSS FIVE PEOPLE, so "when did I last hear from X"
    // is a question about the row that names the right party rather than about
    // whichever of a pair exists. Recorded as `core.activity`, the table
    // `people.log_interaction` actually writes.
    for (name, kind, text) in [
        (
            "Yusuf Castellanos",
            "call",
            "Caught up about the choir tour; he wants the coast dates.",
        ),
        ("Halla Brennan", "message", "Sent her the cottage shortlist."),
        (
            "Tomoko Brennan",
            "message",
            "Confirmed she is driving down with Halla.",
        ),
        (
            "Winona Achebe",
            "call",
            "Portfolio review; the studio is hiring again.",
        ),
        ("Ezra Finch", "call", "Sunday call. The shell is repaired."),
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

    // THREE IMPORTANT DATES, because a world with one scores "return the only
    // date row" as perfect birthday resolution. One falls inside the weekend
    // window and is NOT on the calendar.
    for (name, label, days, planted) in [
        (
            "Tomoko Brennan",
            "Birthday",
            6_i64,
            Some("falls on the weekend away, and is NOT on the calendar"),
        ),
        ("Ezra Finch", "Birthday", 40, None),
        ("Halla Brennan", "Wedding", 20, None),
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

    // THE DEBT THE OWNER OWES — a `tally.obligation`, which is what
    // `people.add_debt` writes.
    if let Some(party) = circle.get("Yusuf Bergmann").cloned()
        && let Some(debt) = seeder.id(
            "people.add_debt",
            "debt_id",
            json!({
                "party_id": party,
                "direction": "owe",
                "amount_minor": 9_400,
                "reason": "Lens balance after insurance",
            }),
        )
    {
        seeder.note(
            &debt,
            ("people", "tally.obligation"),
            "Lens balance after insurance",
            None,
            State::Live,
            Some("an eighth row saying 'optometrist' by subject, and the only debt the OWNER owes"),
        );
        seeder.value(&debt, "9400");
        seeder.fact(&debt, "direction", "owe");
        seeder.fact(&debt, "party", "Yusuf Bergmann");
    }

    // FOUR MORE OBLIGATIONS, every one of them pointing the OTHER WAY, so
    // `direction` is load-bearing without making the question that names a
    // person ambiguous. Five obligations across five people.
    for (name, amount, reason) in [
        ("Halla Brennan", 5_600_i64, "Rail tickets I fronted"),
        ("Tomoko Brennan", 8_300, "Half the cottage deposit"),
        ("Winona Achebe", 1_900, "Coffee, three times"),
        ("Ezra Finch", 11_000, "Fronted him the rowing shell"),
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

    // CONTACT CHANNELS on BOTH Yusufs, so "message Yusuf" is ambiguous at the
    // channel level too rather than resolving itself by only one of them being
    // reachable.
    for (name, kind, label, value) in [
        ("Yusuf Bergmann", "phone", "Practice line", "+44-20-7946-0142"),
        ("Yusuf Castellanos", "phone", "Cell", "+44-20-7946-0197"),
        (
            "Yusuf Castellanos",
            "email",
            "Private",
            "yusuf.c@example.com",
        ),
        ("Halla Brennan", "phone", "Cell", "+44-20-7946-0168"),
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
                (name.starts_with("Yusuf"))
                    .then_some("both Yusufs are reachable, so neither resolves by elimination"),
            );
            seeder.value(&channel, value);
        }
    }

    // ONE JOURNAL ENTRY. It lands in `knowledge_note` — the People journal and
    // the Notes app are the same table — so it is deliberately written about
    // nothing else in this world. SATURDAY, so "what did I write over the
    // weekend" has a correct answer for a reader that implements Sat–Sun.
    if let Some(entry) = seeder.id(
        "people.add_journal_entry",
        "entry_id",
        json!({
            "mood": "restless",
            "text": "Slow Saturday. Repaired the trellis, read on the steps.",
            "entry_date": day(-2),
        }),
    ) {
        seeder.note(
            &entry,
            ("people", "knowledge.note"),
            "People journal · restless",
            Some(at(-2, 12, 0)),
            State::Live,
            Some(
                "a People journal entry stored as a NOTE — the two apps share a table, and \
                 `centraid_apps_notes::load_library` does NOT return it",
            ),
        );
        seeder.value(&entry, "restless");
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
    let voyages = notebook(seeder, "Voyages");
    let eyes = notebook(seeder, "Eyes");
    let kitchen = notebook(seeder, "Kitchen");

    let library: [SeededNote<'_>; 6] = [
        (
            "Optometrist — what Bergmann said",
            "Astigmatism in the right eye, two visits. The first is the fitting; the lenses come after. \
             Insurance covers 55% once the pre-authorisation is filed.",
            "markdown",
            &eyes,
            Some("one of several rows about the optometrist"),
        ),
        (
            "Mendocino weekend — shortlist",
            "## Stays\n- Elk: on the bluff, ten minutes to the water\n- Albion: quieter, longer drive to anywhere\n\n## Rough budget\nCottage ~$165/night, plus fuel both ways.",
            "markdown",
            &voyages,
            None,
        ),
        (
            "Glass Beach — where to park",
            "The headland lot fills by nine. The second pullout half a mile south is usually open and adds eight minutes on foot.",
            "plain",
            &voyages,
            Some("one of five rows saying 'Glass Beach'; also a place and an event"),
        ),
        (
            "Grandpa's gumbo, written out properly",
            "1. Dark roux, twenty minutes, do not walk away.\n2. Onion, celery, one green pepper until soft.\n3. Paprika 2 tbsp, thyme 1 tbsp, into the fat.\n4. Stock, okra, the sausage last. An hour low.\n\n*Do not rush the roux.*",
            "markdown",
            &kitchen,
            None,
        ),
        (
            "Jotting — records worth hunting",
            "Bitches Brew on vinyl, the Sibelius box, whatever the Quayside shop has in the folk racks.",
            "plain",
            &None,
            None,
        ),
        (
            "Optometrist — superseded chart",
            "Readings from the practice on Ninth, before the move. Superseded.",
            "plain",
            &eyes,
            Some(
                "a TRASHED row about the optometrist — a reader that ignores deleted_at answers with it",
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
        if title == "Optometrist — superseded chart"
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

/// The filed documents — and the id of the one that gets trashed LATE.
///
/// See [`crate::scenario::docs`]: one document is trashed at the very end of
/// the build, two days before the world's now, which is the difference between
/// a restore that can be asked for and one that cannot.
fn docs(seeder: &mut Seeder) -> Option<String> {
    let folder = |seeder: &mut Seeder, name: &str| {
        seeder.id("core.create_folder", "folder_id", json!({ "name": name }))
    };
    let voyages = folder(seeder, "Voyages");
    let flat = folder(seeder, "Flat");
    let eyes = folder(seeder, "Eyes");

    let leaving = day(5);
    let back = day(8);
    let kit_body = format!(
        "# Mendocino kit list\n\nLeaving {leaving}, back {back}.\n\n\
         - Oilskin\n- Walking boots\n- Head torch\n- Swimming things (the cottage has a sauna)\n- Cards\n"
    );

    // "(sample)" IN THE TITLE for anything that imitates a real record.
    let mut late_trash = None;
    let filed: [(&str, String, &Option<String>, Option<&str>); 6] = [
        // FIRST, so its grace window is the story's whole runway.
        (
            "Glass Beach permit (sample)",
            "# Glass Beach permit (sample)\n\nThis is sample demo data, not a real permit.\n\n\
             Day-use parking, one vehicle. Superseded — we are taking the south pullout.\n"
                .to_owned(),
            &voyages,
            Some("a TRASHED row saying 'Glass Beach', and PAST its thirty-day grace window"),
        ),
        ("Mendocino kit list", kit_body.clone(), &voyages, None),
        (
            "Cottage rental agreement (sample)",
            format!(
                "# Cottage rental agreement (sample)\n\nThis is sample demo data, not a real agreement.\n\n\
                 - Property: 2BR cottage, Elk\n- Nights: {leaving} to {back}\n\
                 - Rate: $165 per night\n- Deposit: $275, refundable\n- Arrival 4pm, departure 10am\n"
            ),
            &voyages,
            Some("its nights overlap the calendar's weekend window and the 'Organise the Mendocino weekend' task"),
        ),
        (
            "Optometrist pre-authorisation (sample)",
            "# Optometrist pre-authorisation (sample)\n\nThis is sample demo data, not a real form.\n\n\
             - Member: SAMPLE-0000-0000\n- Procedure: progressive lenses, both eyes\n- Covered: 55%\n- Filed by the practice\n"
                .to_owned(),
            &eyes,
            Some("one of several rows about the optometrist"),
        ),
        (
            "Contents insurance policy (sample)",
            "# Contents insurance policy (sample)\n\nThis is sample demo data, not a real policy.\n\n\
             - Policy number: SAMPLE-0000-0000\n- Personal property: $28,000\n- Liability: $100,000\n"
                .to_owned(),
            &flat,
            None,
        ),
        (
            "Weekend receipts (sample)",
            "# Weekend receipts (sample)\n\nThis is sample demo data, not a real receipt.\n\n\
             - Cottage deposit\n- Fuel, both ways\n- Kayak hire\n"
                .to_owned(),
            &voyages,
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
        if title == "Mendocino kit list" {
            // ONE EDIT, so the version walk has two versions to walk.
            seeder.run(
                "core.edit_document",
                json!({
                    "document_id": document,
                    "body_text": format!("{kit_body}- Chains (the coast road closes after a slide)\n"),
                }),
            );
            seeder.run("core.star_document", json!({ "document_id": document }));
            seeder.run(
                "core.tag_item",
                json!({
                    "subject_type": "core.document",
                    "subject_id": document,
                    "label": "mendocino",
                }),
            );
        }
        if title == "Glass Beach permit (sample)"
            && seeder
                .run("core.trash_document", json!({ "document_id": document }))
                .is_some()
        {
            seeder.restate(&document, State::Trashed);
        }
        if title == "Weekend receipts (sample)" {
            // NOT TRASHED HERE — see [`tick_off`].
            late_trash = Some(document.clone());
        }
    }
    late_trash
}

// ---------------------------------------------------------------------------
// Tasks.
// ---------------------------------------------------------------------------

/// A believable week on the board — **with two optometrist tasks due on the
/// same day**, and one task whose title is also an event's.
///
/// Returns the two rows that get TICKED OFF LAST; see [`tick_off`].
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
        "Arrange optometrist appointment",
        json!({ "title": "Arrange optometrist appointment", "due_at": at(2, 9, 0), "priority": 5, "effort_min": 15 }),
        Some(at(2, 9, 0)),
        Some("one of several optometrist rows, and one of two tasks due the same day"),
    );
    add(
        seeder,
        "Ring the optometrist about the invoice",
        json!({ "title": "Ring the optometrist about the invoice", "due_at": at(2, 14, 0), "priority": 4 }),
        Some(at(2, 14, 0)),
        Some("one of several optometrist rows, and one of two tasks due the same day"),
    );
    add(
        seeder,
        "Swap the wiper blades before the drive",
        json!({ "title": "Swap the wiper blades before the drive", "due_at": at(-3, 9, 0), "priority": 8 }),
        Some(at(-3, 9, 0)),
        Some("overdue at the world's now"),
    );

    let weekend = add(
        seeder,
        "Organise the Mendocino weekend",
        json!({
            "title": "Organise the Mendocino weekend",
            "description": "Two nights on the coast with Yusuf, Halla and Tomoko.",
            "due_at": at(7, 9, 0),
            // A SECOND TASK WITH AN ESTIMATE, deliberately far from the first:
            // while exactly one task carried an `effort_min`, any question
            // about that field was answerable by returning the row that HAS
            // one, without ever reading its value.
            "priority": 6,
            "effort_min": 120,
        }),
        Some(at(7, 9, 0)),
        Some("its due date falls INSIDE the calendar's weekend window (+5 to +8)"),
    );
    if let Some(weekend) = weekend.as_ref() {
        add(
            seeder,
            "Weigh cottages — Elk vs Albion",
            json!({ "title": "Weigh cottages — Elk vs Albion", "parent_task_id": weekend, "effort_min": 45 }),
            None,
            None,
        );
        add(
            seeder,
            "Reserve the Mendocino cottage",
            json!({ "title": "Reserve the Mendocino cottage", "parent_task_id": weekend, "due_at": at(3, 9, 0) }),
            Some(at(3, 9, 0)),
            Some("a task and an EVENT share this exact title"),
        );
        if let Some(kit) = add(
            seeder,
            "Write the kit list",
            json!({ "title": "Write the kit list", "parent_task_id": weekend }),
            None,
            None,
        ) {
            ticked.push(kit);
        }
    }

    if let Some(veg) = add(
        seeder,
        "Fortnightly veg box",
        json!({ "title": "Fortnightly veg box", "due_at": at(-1, 9, 0), "priority": 4 }),
        Some(at(-1, 9, 0)),
        None,
    ) {
        ticked.push(veg);
    }

    add(
        seeder,
        "Take up bookbinding",
        json!({ "title": "Take up bookbinding", "priority": 1 }),
        None,
        Some("no due date at all — a question about 'this week' must not match it"),
    );

    if let Some(tent) = add(
        seeder,
        "Send back the borrowed tent",
        json!({ "title": "Send back the borrowed tent", "due_at": at(3, 9, 0) }),
        Some(at(3, 9, 0)),
        Some("a TRASHED task still carrying a due date inside the week"),
    ) && seeder
        .run("schedule.delete_task", json!({ "task_id": tent }))
        .is_some()
    {
        seeder.restate(&tent, State::Trashed);
    }
    ticked
}

/// TICK THE TWO OFF, last of everything and two days before the world's now.
///
/// `set_task_status` stamps `completed_at` at command time, so WHEN a task is
/// finished is decided by where in the seeding order it is finished.
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

/// One seeded event: summary, description, `(dtstart, dtend)`, rrule,
/// attendees and the ambiguity it plants.
type SeededEvent = (
    &'static str,
    Option<&'static str>,
    (String, String),
    Option<&'static str>,
    &'static [&'static str],
    Option<&'static str>,
);

/// One lived-in fortnight. **Every slot is disjoint**, because
/// `schedule.propose_event` refuses any busy overlap vault-wide.
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
    // WHO IS COMING IS A ROW, NOT A WORD IN THE SUMMARY. "Supper with Yusuf"
    // names a Yusuf the vault cannot resolve; the ATTENDEE says which one, and
    // it is the only thing in this world that does.
    let diary: [SeededEvent; 7] = [
        (
            "Evening swim",
            Some("Two lengths of the harbour and out."),
            slot(1, 6, 30, 45),
            Some("FREQ=WEEKLY"),
            &[],
            Some("the only recurring event, and the only one with nobody else on it"),
        ),
        (
            "Supper with Yusuf",
            Some("He picked the place — Georgian, by the bridge."),
            slot(1, 19, 0, 120),
            None,
            // NO ATTENDEE, AND THAT IS THE POINT: an attendee row would say
            // which Yusuf, and this is the one event whose whole value is that
            // nothing in the vault does.
            &[],
            Some("two parties are called Yusuf; the summary names neither"),
        ),
        (
            "Optometrist — fitting",
            None,
            slot(2, 15, 0, 60),
            None,
            &["Yusuf Bergmann"],
            Some("one of several optometrist rows, on the same day as two optometrist TASKS"),
        ),
        (
            "Reserve the Mendocino cottage",
            Some("Last call before the weekend rates jump."),
            slot(3, 9, 0, 30),
            None,
            &[],
            Some("a task and an EVENT share this exact title"),
        ),
        (
            "Glass Beach",
            Some("Park at the south pullout and walk in."),
            slot(6, 8, 0, 240),
            None,
            &["Yusuf Castellanos", "Halla Brennan", "Tomoko Brennan"],
            Some("an EVENT and a PLACE share this exact name"),
        ),
        (
            "Cottage arrival",
            None,
            slot(5, 16, 0, 60),
            None,
            &["Yusuf Castellanos", "Halla Brennan", "Tomoko Brennan"],
            Some(
                "opens the weekend window +5 to +8, which the 'Organise the Mendocino weekend' \
                 task ends inside",
            ),
        ),
        (
            "Cottage departure",
            None,
            slot(8, 10, 0, 60),
            None,
            &["Yusuf Castellanos", "Halla Brennan", "Tomoko Brennan"],
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

/// THE SAMPLE ROLL, COMPILED IN — the same original, procedurally drawn frames
/// the first world borrows from the demo seed, under this world's own
/// captions and coordinates. The bytes are what the `thumbhash` and `phash`
/// below were computed off, so they travel with them.
macro_rules! sample {
    ($file:literal) => {
        include_bytes!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../centraid/src/bin/seed-assets/photos/",
            $file
        ))
    };
}

/// Pacific daylight time — the whole roll is one American weekend.
const TZ_OFFSET_MIN: i64 = -420;

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

const GLASS_BEACH: (f64, f64) = (39.4498, -123.8117);
const PYGMY_RIDGE: (f64, f64) = (39.3021, -123.7931);
const ELK_HEADLAND: (f64, f64) = (39.1286, -123.7136);
const COURTYARD: (f64, f64) = (37.1419, -121.843);

fn roll() -> Vec<Frame> {
    vec![
        Frame {
            bytes: sample!("emerald-bay-overlook.png"),
            title: "Glass Beach shingle",
            days: -9,
            hour: 19,
            size: (360, 240),
            place: Some(GLASS_BEACH),
            thumbhash: "UwcKDYJnd3iPd4dzh1iHhrdwc/hX",
            phash: "1f0f0f1337250d17",
            favorite: true,
            planted: Some("its place is NAMED 'Glass Beach', which is also an event's summary"),
        },
        Frame {
            bytes: sample!("tahoe-dusk-ridge.png"),
            title: "Fog over the pygmy pines",
            days: -9,
            hour: 20,
            size: (360, 240),
            place: Some(PYGMY_RIDGE),
            thumbhash: "DAcKDYJod3d7h4hweHiIeJiAi2gH",
            phash: "1d2b070f5b371e4b",
            favorite: false,
            planted: None,
        },
        Frame {
            bytes: sample!("truckee-river-bend.png"),
            title: "Curve of the Noyo",
            days: -10,
            hour: 10,
            size: (360, 240),
            place: Some(PYGMY_RIDGE),
            thumbhash: "m9cJFYQ3eIh/eXeGh0h3dKhwhApY",
            phash: "170f0f0b1b09071f",
            favorite: true,
            planted: Some(
                "shares a coordinate with 'Fog over the pygmy pines', so the two collapse into ONE place row",
            ),
        },
        Frame {
            bytes: sample!("ana-trailhead.png"),
            title: "Tomoko on the headland",
            days: -11,
            hour: 11,
            size: (270, 360),
            place: Some(ELK_HEADLAND),
            thumbhash: "pecJHQTXeH+KdmjXSIxlZ0iJgIAI",
            phash: "0070704454c88080",
            favorite: false,
            planted: Some("names Tomoko, who is also a party and a Tally friend"),
        },
        Frame {
            bytes: sample!("marco-workshop.png"),
            title: "Ezra at the boathouse",
            days: -20,
            hour: 15,
            size: (270, 360),
            place: None,
            thumbhash: "oSgKDQTod496lmfIV3x1ZzeAdQSI",
            phash: "0070706c70e88080",
            favorite: false,
            planted: Some("PLACE-LESS on purpose, and names a party the weekend does not include"),
        },
        Frame {
            bytes: sample!("backyard-last-light.png"),
            title: "Late sun in the courtyard",
            days: -2,
            hour: 19,
            size: (360, 240),
            place: Some(COURTYARD),
            thumbhash: "GDgOJYhneHiIeHeAiKh3h3eAcVcI",
            phash: "0f170f0f0f4f4bc9",
            favorite: false,
            planted: Some("hundreds of km from the coast, so the shelf has a weekend AND a home"),
        },
        Frame {
            bytes: sample!("empty-hallway.png"),
            title: "Stairwell, nobody on it",
            days: -2,
            hour: 13,
            size: (270, 360),
            place: Some(COURTYARD),
            thumbhash: "aAgKBQB3iI94d4iXd3iHiEd/dYA3",
            phash: "0030300c0c0c0000",
            favorite: false,
            planted: Some("deleted below — a TRASHED photograph"),
        },
    ]
}

fn photos(seeder: &mut Seeder) {
    let mut assets: Vec<(String, &'static str)> = Vec::new();
    let mut beach_asset = None;
    let mut ridge_asset = None;
    let mut courtyard_asset = None;
    let mut headland_asset = None;
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
        // refuses half of one, because half a coordinate is no location.
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
        match frame.title {
            "Glass Beach shingle" => beach_asset = Some(asset.clone()),
            "Fog over the pygmy pines" => ridge_asset = Some(asset.clone()),
            "Late sun in the courtyard" => courtyard_asset = Some(asset.clone()),
            "Tomoko on the headland" => headland_asset = Some(asset.clone()),
            _ => {}
        }
        if frame.favorite {
            seeder.run(
                "media.set_favorite",
                json!({ "asset_id": asset, "favorite": 1 }),
            );
        }
        if frame.title == "Stairwell, nobody on it" {
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

    // THE THREE NAMED PLACES. `media.add_asset` mints a place row per rounded
    // coordinate; naming one is what turns a latitude into a word a member
    // would search for — and one of these words is also an event's summary.
    for (asset, name, kind, planted) in [
        (
            beach_asset,
            "Glass Beach",
            "venue",
            "a PLACE and an EVENT share this exact name",
        ),
        (
            ridge_asset,
            "Pygmy forest ridge",
            "region",
            "TWO frames collapsed into this one place row",
        ),
        (
            courtyard_asset,
            "Courtyard",
            "home",
            "the place 'photos from home' means, named so the question survives a full camera roll",
        ),
    ] {
        let Some(asset) = asset else { continue };
        if let Some(place) = place_of_asset(seeder, &asset)
            && seeder
                .run(
                    "media.name_place",
                    json!({ "place_id": place, "name": name, "kind": kind }),
                )
                .is_some()
        {
            seeder.note(
                &place,
                ("photos", "core.place"),
                name,
                None,
                State::Live,
                Some(planted),
            );
        }
    }

    // THE PLACE NOBODY NAMED, recorded as the member SEES it: `media.add_asset`
    // names a fresh place with the coordinate itself. That is a fact about the
    // product, and a world that recorded only its named places would hide it.
    if let Some(asset) = headland_asset
        && let Some(place) = place_of_asset(seeder, &asset)
    {
        seeder.note(
            &place,
            ("photos", "core.place"),
            &format!("{}, {}", ELK_HEADLAND.0, ELK_HEADLAND.1),
            None,
            State::Live,
            Some("a place NOBODY NAMED — the member sees its coordinates as its name"),
        );
    }

    // The shortlist, as an album with a cover.
    if let Some(album) = seeder.id(
        "media.create_album",
        "album_id",
        json!({ "title": "Mendocino scouting" }),
    ) {
        seeder.note(
            &album,
            ("photos", "media.album"),
            "Mendocino scouting",
            None,
            State::Live,
            None,
        );
        for (asset, title) in &assets {
            if matches!(
                *title,
                "Glass Beach shingle" | "Fog over the pygmy pines" | "Curve of the Noyo"
            ) {
                seeder.run(
                    "media.add_to_album",
                    json!({ "album_id": album, "asset_id": asset }),
                );
            }
        }
        if let Some((cover, _)) = assets
            .iter()
            .find(|(_, title)| *title == "Glass Beach shingle")
        {
            seeder.run(
                "media.set_album_cover",
                json!({ "album_id": album, "asset_id": cover }),
            );
        }
    }

    // THREE MORE ALBUMS, AND NONE OF THEM HOLDS A COAST FRAME.
    //
    // One album makes "what album is that in" answerable by returning the only
    // album there is. Three more make the membership edge load-bearing — and
    // they are kept off the three coast frames, because a frame in two albums
    // would make "what album is that in" a question with two right answers.
    for (title, members) in [
        (
            "Kin of mine",
            ["Tomoko on the headland", "Ezra at the boathouse"].as_slice(),
        ),
        ("Inside the flat", ["Late sun in the courtyard"].as_slice()),
        ("Negatives to file", ["Ezra at the boathouse"].as_slice()),
    ] {
        let Some(album) = seeder.id("media.create_album", "album_id", json!({ "title": title }))
        else {
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

// ---------------------------------------------------------------------------
// Tally.
// ---------------------------------------------------------------------------

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

/// Two groups and an uneven ledger — **and three friends whose display names
/// are bare first names that already belong to People rows**.
///
/// That is what a vault looks like: Tally friends and contacts are separate
/// rows for the same humans, so "how much does Yusuf owe me" is a question
/// with two candidate subjects before anyone has asked which Yusuf.
fn tally(seeder: &mut Seeder, me: &str) {
    let mut friends = Vec::new();
    let mut names: Vec<String> = vec![crate::OWNER_SECOND.to_owned()];
    for name in ["Yusuf", "Halla", "Tomoko"] {
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

    let Some(weekend) = seeder.id(
        "tally.create_group",
        "group_id",
        json!({
            "name": "Mendocino weekend",
            "icon": "🌊",
            "color": "cadetblue",
            "member_ids": friends,
        }),
    ) else {
        return;
    };
    seeder.note(
        &weekend,
        ("tally", "tally.group"),
        "Mendocino weekend",
        None,
        State::Live,
        None,
    );
    let practice = seeder.id(
        "tally.create_group",
        "group_id",
        json!({ "name": "Optical costs", "icon": "👓", "color": "darkcyan", "member_ids": [] }),
    );
    if let Some(practice) = practice.as_ref() {
        seeder.note(
            practice,
            ("tally", "tally.group"),
            "Optical costs",
            None,
            State::Live,
            Some("a SECOND group, so 'what did I spend' has to choose one"),
        );
    }

    let ledger: [SeededExpense; 6] = [
        ("Cottage deposit", 27_500, 0, "travel", -12, None),
        ("Fuel for the drive down", 5_140, 2, "transport", -11, None),
        ("Food for the cottage", 10_880, 1, "groceries", -10, None),
        ("Kayak hire", 7_400, 0, "fun", -10, None),
        (
            "Wetsuit hire",
            8_600,
            3,
            "fun",
            -9,
            Some("deleted below — a TRASHED expense"),
        ),
        (
            "Optometrist copay",
            9_400,
            0,
            // `general`, because Tally's CHECK admits nine categories and
            // `health` is not one of them. The refusal is the schema's.
            "general",
            -6,
            Some("one of several optometrist rows; filed in the OTHER group"),
        ),
    ];
    for (description, amount, payer_index, category, days_ago, planted) in ledger {
        let optical = description == "Optometrist copay";
        let group = if optical {
            match practice.as_ref() {
                Some(practice) => practice.clone(),
                None => continue,
            }
        } else {
            weekend.clone()
        };
        let parties: Vec<String> = if optical {
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
            if optical {
                "Optical costs"
            } else {
                "Mendocino weekend"
            },
        );
        seeder.fact(&expense, "paid_by", names[payer_index].clone());
        if description == "Wetsuit hire"
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
            "amount_minor": 4_000,
            "group_id": weekend,
            "paid_on": day(-4),
        }),
    );
}

// ---------------------------------------------------------------------------
// Locker — the eighth app, and the one the search plane cannot reach.
// ---------------------------------------------------------------------------

/// One seeded Locker item: type, title, its cells as `(field, plaintext)`, and
/// the ambiguity it plants. The plaintext never leaves this array — it is
/// sealed before it reaches a command and it never reaches the inventory.
type SeededSecret = (
    &'static str,
    &'static str,
    &'static [(&'static str, &'static str)],
    Option<&'static str>,
);

/// A shelf of five items, on top of the tail's hundred and twenty.
///
/// **Locker is structurally absent from `crates/search`'s domains** — "a
/// secret cannot become a link target by adding a probe" — so a question whose
/// answer is in here cannot be answered by the FTS plane at all. That is
/// precisely why it is seeded.
fn locker(seeder: &mut Seeder, key: &[u8], key_id: &str) {
    let shelf: [SeededSecret; 5] = [
        (
            "login",
            "Glass Beach Cottages",
            &[
                ("username", "dara.okonjo@example.com"),
                ("password", "correct-anchor-lantern-spoon"),
                ("url", "https://glassbeachcottages.example"),
            ],
            Some(
                "one of five rows saying 'Glass Beach' — and the only one the FTS plane cannot reach",
            ),
        ),
        (
            "login",
            "Optometrist portal",
            &[
                ("username", "dokonjo"),
                ("password", "lens-fitting-june"),
                ("url", "https://opticalportal.example"),
            ],
            Some(
                "one of several optometrist rows — and the only one the FTS plane cannot reach",
            ),
        ),
        (
            "card",
            "Joint Mastercard",
            &[
                ("cardholder", "Dara Okonjo"),
                ("card_number", "4000000000000002"),
                ("expiry", "11/30"),
                ("cvv", "456"),
            ],
            None,
        ),
        (
            "wifi",
            "Cottage wifi",
            &[("network", "GlassBeachGuest"), ("password", "shoreline2026")],
            None,
        ),
        (
            "login",
            "Rail — dormant account",
            &[("username", "dokonjo"), ("password", "superseded-2024")],
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
        if title == "Rail — dormant account"
            && seeder
                .run("locker.trash_item", json!({ "item_id": item_id }))
                .is_some()
        {
            seeder.restate(&item_id, State::Trashed);
        }
    }
    // THE STORY'S SHELF IS NEVER ROTATED, and that is what makes "which
    // logins have I never changed the password on" a question with an answer:
    // the tail's hundred and twenty rotate, these five do not.
}
