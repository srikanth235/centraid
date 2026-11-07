//! PEOPLE: a small living circle, each with a way to reach them.
//!
//! "People with contact cadences, logged interactions, birthdays and canonical
//! gift tasks" (v0), and since #1173 the rows the revamped screens draw:
//!
//! - a phone and an email on most of them, so the sheet's hero has its call and
//!   message buttons and the roster has something to say under a name;
//! - a birthday column on three of them (the other two have a yearly date
//!   instead, which Agenda's window reads), a cadence on five, and ONE person
//!   overdue to reconnect: "overdue" is elapsed time since a touch, a touch is
//!   stamped by the vault's clock, so the seed writes each person's last touch
//!   at its age and lets the caller's clock catch up between them
//!   ([`super::REWIND_MS`]);
//! - edges that "In your vault" lists: a note and a task about a person here,
//!   and the invitations Agenda seeds name them as guests (the [`Circle`] this
//!   returns is how it finds them);
//! - the owner's own card, which is where "My card" opens.

use std::collections::BTreeMap;

use serde_json::json;

use super::{Seeder, day};

/// The people the scenario made, by first name, for the apps that name them as
/// guests (Agenda) or write about them (Notes).
#[derive(Debug, Default)]
pub(super) struct Circle {
    pub(super) by_name: BTreeMap<&'static str, String>,
    /// The vault owner's own person row ("My card").
    pub(super) owner: Option<String>,
}

impl Circle {
    pub(super) fn get(&self, name: &str) -> Option<&str> {
        self.by_name.get(name).map(String::as_str)
    }
}

/// Name, role, cadence in days (0 is none), birthday, phone, email.
type Row = (
    &'static str,
    &'static str,
    &'static str,
    i64,
    Option<&'static str>,
    &'static str,
    &'static str,
);

const PEOPLE: [Row; 6] = [
    (
        "Maya",
        "Maya Alvarez",
        "College friend",
        30,
        None,
        "+1 303 555 0142",
        "maya.alvarez@example.com",
    ),
    (
        "Jake",
        "Jake Bennett",
        "Old roommate from Portland",
        45,
        Some("1991-03-14"),
        "+1 503 555 0177",
        "jake.bennett@example.com",
    ),
    (
        "Ray",
        "Grandpa Ray",
        "Grandfather",
        7,
        None,
        "+1 530 555 0109",
        "",
    ),
    (
        "Chris",
        "Chris Okafor",
        "Design lead, ex-colleague",
        60,
        Some("1986-09-02"),
        "+1 415 555 0163",
        "chris.okafor@example.com",
    ),
    (
        "Priya",
        "Priya Nair",
        "Climbing partner",
        21,
        Some("1993-12-20"),
        "+1 415 555 0128",
        "priya.nair@example.com",
    ),
    (
        "Dana",
        "Dana Whitfield",
        "Next-door neighbour",
        0,
        None,
        "",
        "dana.whitfield@example.com",
    ),
];

/// Seed the circle, the owner's card, and the touches at their ages.
///
/// Clock choreography (the caller started [`super::REWIND_MS`] = 75 days back):
/// Chris was last touched 75 days ago, Jake 30, Maya and Priya 12, Grandpa 3.
/// Chris's cadence is 60, so he alone is overdue.
pub(super) fn seed_people(seeder: &mut Seeder, now: i64, elapse: &dyn Fn(i64)) -> Circle {
    let mut circle = Circle::default();
    for (key, name, role, cadence, birthday, phone, email) in PEOPLE {
        let mut input = json!({ "title": name, "role": role, "cadence_days": cadence });
        if let Some(birthday) = birthday {
            input["birthday"] = json!(birthday);
        }
        let output = seeder.run("person.add", input);
        let Some(party) = Seeder::id(output.as_ref(), "id") else {
            continue;
        };
        for (kind, value, label) in [("phone", phone, "mobile"), ("email", email, "home")] {
            if !value.is_empty() {
                seeder.run(
                    "person.save_contact_point",
                    json!({ "id": party, "kind": kind, "value": value, "label": label,
                            "preferred": true }),
                );
            }
        }
        circle.by_name.insert(key, party);
    }

    // THE OWNER'S CARD: the vault's own person, so "My card" has a face, a number
    // and an address, and a birthday.
    if let Ok(Some(owner)) = seeder.vault.self_id() {
        seeder.run(
            "person.edit",
            json!({ "id": owner, "role": "Product designer",
                    "birthday": "1990-06-21" }),
        );
        for (kind, value, label) in [
            ("phone", "+1 415 555 0100", "mobile"),
            ("email", "owner@example.com", "home"),
        ] {
            seeder.run(
                "person.save_contact_point",
                json!({ "id": owner, "kind": kind, "value": value, "label": label,
                        "preferred": true }),
            );
        }
        circle.owner = Some(owner);
    }

    let touch = |seeder: &mut Seeder, who: &str, kind: &str, text: &str| {
        if let Some(party) = circle.get(who) {
            seeder.run(
                "person.log_interaction",
                json!({ "id": party, "kind": kind, "text": text }),
            );
        }
    };
    let mut remaining = super::REWIND_MS;
    let mut step = |days: i64| {
        let ms = (days * super::DAY_MS).min(remaining);
        remaining -= ms;
        elapse(ms);
    };

    touch(
        seeder,
        "Chris",
        "message",
        "Sent the portfolio feedback he asked for.",
    );
    step(45);
    touch(seeder, "Jake", "call", "");
    step(18);
    touch(
        seeder,
        "Maya",
        "call",
        "Caught up about her Denver move; she wants the Tahoe dates.",
    );
    touch(seeder, "Priya", "message", "");
    step(9);
    touch(
        seeder,
        "Ray",
        "visit",
        "Sunday lunch. Blood pressure is under control again; he beat me at cribbage twice.",
    );
    step(i64::MAX / super::DAY_MS); // whatever is left, so the clock lands on "now"

    // Birthdays recur yearly, so they are a month-day: Maya's falls inside
    // Agenda's 45-day window and Grandpa's outside it, whatever today is.
    for (who, label, days, reminder) in [
        ("Ray", "Birthday", 120, true),
        ("Maya", "Birthday", 12, false),
    ] {
        let Some(party) = circle.get(who) else {
            continue;
        };
        let month_day = day(now, days)[5..].to_owned();
        seeder.run(
            "person.add_date",
            json!({ "id": party, "label": label, "month_day": month_day, "reminder_on": reminder }),
        );
    }

    for (who, text) in [
        ("Ray", "Large-print edition of Lonesome Dove"),
        ("Chris", "Fountain pen ink sampler"),
    ] {
        if let Some(party) = circle.get(who) {
            seeder.run("person.add_gift", json!({ "id": party, "text": text }));
        }
    }

    // THE EDGES "IN YOUR VAULT" LISTS: notes and tasks about a person (events
    // reach them as guests, in Agenda's seed).
    for (who, text) in [
        (
            "Maya",
            "Maya is allergic to shellfish. Pick the Thai place with the peanut-free kitchen.",
        ),
        (
            "Jake",
            "Jake's lease ends in March; he is deciding between Seattle and staying put.",
        ),
    ] {
        if let Some(party) = circle.get(who) {
            seeder.run("person.add_note", json!({ "id": party, "text": text }));
        }
    }
    for (who, text) in [
        ("Maya", "Send Maya the Tahoe dates"),
        ("Jake", "Ask Jake about the cabin split"),
        ("Dana", "Return Dana's ladder"),
    ] {
        if let Some(party) = circle.get(who) {
            seeder.run("person.add_task", json!({ "id": party, "text": text }));
        }
    }
    circle
}

/// THE CLASSIC FOUR: the people the chat's and the screens' tests were written
/// against (no phone, no email, nobody overdue). [`seed_people`] is the demo's
/// richer circle; [`super::seed`] keeps this one.
pub(super) fn seed_classic(seeder: &mut Seeder, now: i64) {
    let mut ids = Vec::new();
    for (name, role, cadence) in [
        ("Maya Alvarez", "College friend", 30),
        ("Jake Bennett", "Old roommate from Portland", 45),
        ("Grandpa Ray", "Grandfather", 7),
        ("Chris Okafor", "Design lead, ex-colleague", 60),
    ] {
        let output = seeder.run(
            "person.add",
            json!({ "title": name, "role": role, "cadence_days": cadence }),
        );
        if let Some(party) = Seeder::id(output.as_ref(), "id") {
            ids.push(party);
        }
    }
    let (maya, grandpa, chris) = match ids.as_slice() {
        [maya, _, grandpa, chris] => (maya.clone(), grandpa.clone(), chris.clone()),
        _ => return,
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
            "person.log_interaction",
            json!({ "id": party, "kind": kind, "text": text }),
        );
    }

    // Birthdays recur yearly, so they are a month-day: Maya's falls inside
    // Agenda's 45-day window and Grandpa's outside it, whatever today is.
    for (party, label, days, reminder) in [
        (&grandpa, "Birthday", 120, true),
        (&maya, "Birthday", 12, false),
    ] {
        let month_day = day(now, days)[5..].to_owned();
        seeder.run(
            "person.add_date",
            json!({
                "id": party,
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
        seeder.run("person.add_gift", json!({ "id": party, "text": text }));
    }
}
