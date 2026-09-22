//! THE ENTITY INVENTORY — what a later lane writes utterances against.
//!
//! An evaluation suite is only worth its ground truth, and ground truth over a
//! vault is a set of **row ids**. A case that says "the answer is the dentist
//! appointment" and names it by title is scoring a string; a case that names
//! `schedule.task/0191…` is scoring an outcome. So the world emits every row it
//! planted, by id, with the label a member would recognise it by — and an
//! author who cannot find a row in here cannot write a case about it.
//!
//! **It carries no secret and it carries no body.** A locker item appears as an
//! id, a type and a title; its sealed cells do not. The inventory is a file on
//! disk that a corpus author reads, and a fixture that leaked a password into
//! one would be a fixture nobody could check in.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Where a row stands, because "it is in the vault" is not one state.
///
/// A candidate runtime that answers with a trashed row has not made a small
/// error — it has told a member something is on their list that they deleted.
/// So the state is part of the ground truth and not a footnote to it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    /// Present and current: what a default read returns.
    Live,
    /// Soft-deleted — `deleted_at` is set. Restorable, and absent from every
    /// ordinary list.
    Trashed,
    /// Finished rather than removed. A completed task is still a task.
    Completed,
}

/// One row of the seeded world.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entity {
    /// The primary key, exactly as the vault minted it. THE thing a case
    /// asserts on.
    pub id: String,
    /// The app a member would open this in — the eight ids of the springboard.
    pub app: String,
    /// The logical entity, e.g. `schedule.task`. Spelled as
    /// `centraid_search::Domain::entity` spells it, so a case that walks the
    /// FTS plane and a case that walks an app door name the same thing.
    pub entity: String,
    /// What a member would call it: the title, summary, display name or
    /// description the row carries.
    pub label: String,
    /// The row's own salient date, when it has one — a due date, a start, the
    /// day an expense was spent. `None` is a real answer: a someday task has no
    /// date and a question about "this week" must not match it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    /// THE ROW'S OWN SALIENT SCALAR, when it has one and the scalar is the
    /// answer rather than the row.
    ///
    /// "Who do I owe money to" is answered by a party id; "how much do I owe
    /// them" is answered by `12500`, and a corpus that could only name the row
    /// would score a candidate as correct for finding the debt and saying the
    /// wrong number. So a debt carries its minor units, a birthday its
    /// `MM-DD`, a contact channel its address, and a person their cadence in
    /// days. Always a string, because the alternative is a JSON number whose
    /// unit is a guess: `"12500"` is minor units because the debt says so, and
    /// an author reads the unit off the entity, not off the value.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// **THE ROW'S OWN ATTRIBUTES, SPELLED THE WAY A PERSON WOULD SAY THEM.**
    ///
    /// A corpus that asks what a pile of rows adds up to has to be able to say
    /// WHICH pile, and the honest place for that is the world rather than a
    /// number typed in by hand. A label and a date are enough for some piles
    /// ("everything at the farmers market") and not for others: the four
    /// expenses of one trip share no substring, and "the part I paid for
    /// myself" is not in any label at all.
    ///
    /// So a row may record the attributes a question might group it by, as
    /// words and never as ids — `group: "Tahoe Trip"`, `paid_by: "Sam
    /// Whitaker"`. A uuid here would be unreadable in a case and would move on
    /// every rebuild, which is the whole defect stable handles exist to close.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub facts: BTreeMap<String, String>,
    pub state: State,
    /// WHY THIS ROW IS HERE, when it was planted to be confusable.
    ///
    /// A world without ambiguity flatters every candidate architecture, so the
    /// ambiguities are deliberate — and an author who does not know which rows
    /// collide will write the easy case by accident. This names the collision
    /// in one phrase.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub planted: Option<String>,
}

/// Everything the world holds, plus what it could not write.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Inventory {
    /// The world's "now", as every read should be given it. Not the wall
    /// clock: a suite whose expected answers drift with the calendar is a suite
    /// that goes red on a Tuesday for no reason.
    pub now: String,
    /// The id seed. With [`Inventory::now`] it is the whole of the world's
    /// reproducibility.
    pub seed: String,
    /// The vault's own id and its owner, so a case can talk about "me".
    pub vault_id: String,
    pub owner_party_id: String,
    pub entities: Vec<Entity>,
    /// Commands the vault REFUSED, verbatim.
    ///
    /// Loud rather than silent: a world that quietly seeded six apps instead of
    /// eight is a world every later lane scores against without knowing. A
    /// build with a non-empty refusal list is a failed build.
    pub refusals: Vec<String>,
}

impl Inventory {
    /// Every entity of one app, in the order it was seeded.
    #[must_use]
    pub fn of_app(&self, app: &str) -> Vec<&Entity> {
        self.entities
            .iter()
            .filter(|entity| entity.app == app)
            .collect()
    }

    /// How many rows each app holds, live and otherwise — the shape of the
    /// world in one line.
    #[must_use]
    pub fn counts(&self) -> Vec<(String, usize)> {
        let mut counts: Vec<(String, usize)> = Vec::new();
        for entity in &self.entities {
            match counts.iter_mut().find(|(app, _)| *app == entity.app) {
                Some((_, count)) => *count += 1,
                None => counts.push((entity.app.clone(), 1)),
            }
        }
        counts.sort();
        counts
    }

    /// Every row whose label contains `needle`, case-insensitively.
    ///
    /// The collision probe: `matching("dentist")` answering one row means the
    /// world has stopped being ambiguous and the suite built on it has started
    /// flattering whatever reads it.
    #[must_use]
    pub fn matching(&self, needle: &str) -> Vec<&Entity> {
        let needle = needle.to_lowercase();
        self.entities
            .iter()
            .filter(|entity| entity.label.to_lowercase().contains(&needle))
            .collect()
    }

    /// Pretty JSON, with a trailing newline — a file a human reads in a diff.
    ///
    /// # Errors
    ///
    /// [`serde_json::Error`] if the inventory cannot be serialised, which would
    /// mean a label held something that is not a string.
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        let mut text = serde_json::to_string_pretty(self)?;
        text.push('\n');
        Ok(text)
    }
}
