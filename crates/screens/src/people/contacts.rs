//! CONTACTS → PEOPLE, IMPORTED AND FOLLOWED (docs/decisions.md, "Onboarding
//! without sample data"; #1127; #1135).
//!
//! The phone is read by the shell (iOS `CNContactStore`, Android
//! `ContactsContract`), which performs a [`wire::ContactsRead`] effect and
//! answers a [`wire::ContactsSnapshot`]: every contact, with the account it was
//! read in. Everything else is decided here: what to send, how it maps, what the
//! status line says, when a following pass runs.
//!
//! ## The vault does the merge
//!
//! One `follow-contacts` per account carries that account's records and the
//! vault merges: a field the member never changed follows the phone, one they
//! changed stands, a contact the vault does not know is matched by name to a
//! person of the member's own before one is added, and one gone from a complete
//! read goes to the trash if the member never edited it. The phone sends
//! records; it keeps no fingerprint and no link, and writes nothing else.
//!
//! A refused account is counted and the rest go on: one malformed address must
//! not cost the member the other hundred people.
//!
//! ## Following ([`ContactsFollow`])
//!
//! A screen that lives as long as People does (its home) hosts one
//! [`ContactsFollow`]. The member's Import tap asks the OS for permission and
//! imports; from then on this device FOLLOWS: a [`wire::PhoneWatch`] makes the
//! shell report each change of the address book, bursts are coalesced (the first
//! change arms a two-second timer, the ones before it fires join it, and changes
//! during a pass queue exactly one more), and a pass reads the address book only
//! if the OS already allows it. **A pass never asks the OS for permission and
//! never runs before this device imported.**
//!
//! "This device imported" is a per-device habit kept in the keychain
//! ([`IMPORTED_KEY`]), not a fact read back from the vault: the OS permission a
//! pass needs is per device too, and a vault restored onto a new phone must be
//! imported from there once. Agenda's calendar follows by the same rule
//! (`agenda::calendar`).

use std::time::Duration;

use centraid_api_proto::core_v1 as wire;
use serde_json::{Value, json};
use wire::screen_event::Kind as E;

use crate::catalog::act;
use crate::kit::act as kit_act;
use crate::screen::Ctx;
use crate::strings::{Locale, people as words};

/// The origin of a contact that names no account: this phone's own.
pub const DEFAULT_ORIGIN: &str = "local:this-phone";

/// The keychain key that says this device imported its contacts.
pub const IMPORTED_KEY: &str = "people_contacts_imported";
const IMPORTED_VALUE: &[u8] = b"1";

/// Triggers within this long of the first are one pass.
pub const SETTLE: Duration = Duration::from_secs(2);
/// A read that has not answered in two minutes is abandoned, so one stuck read
/// cannot hold the follow for good.
pub const READ_TIMEOUT: Duration = Duration::from_secs(120);
const SETTLE_TIMER: &str = "contacts-settle";
const READ_TIMER: &str = "contacts-read";

/// `person.save_contact_point`'s `value` ceiling.
const VALUE_MAX: usize = 500;

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/// An account as the member knows it: the origin and its label.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OriginRef {
    pub id: String,
    pub label: String,
}

/// Whitespace runs (and no-break spaces) become one space; the ends go.
#[must_use]
pub fn squash(value: &str) -> String {
    value
        .split(|c: char| c.is_whitespace() || c == '\u{a0}')
        .filter(|word| !word.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// An id the engine accepts: it names its kind and something after it.
#[must_use]
pub fn is_valid_id(id: &str) -> bool {
    kind_of(id).is_some()
        && id
            .split_once(':')
            .is_some_and(|(_, rest)| !rest.trim().is_empty())
}

/// An id that survives a new phone, so the same record is re-found there
/// without matching.
#[must_use]
pub fn is_portable_id(id: &str) -> bool {
    matches!(kind_of(id), Some("uid" | "lookup"))
}

fn kind_of(id: &str) -> Option<&str> {
    let (prefix, rest) = id.split_once(':')?;
    (!prefix.is_empty() && !rest.is_empty() && prefix.chars().all(|c| c.is_ascii_lowercase()))
        .then_some(prefix)
}

/// Is this a real `MM-DD`? A birthday is a day of the year; 29 February counts.
#[must_use]
pub fn is_month_day(text: &str) -> bool {
    let bytes = text.as_bytes();
    if bytes.len() != 5 || bytes[2] != b'-' {
        return false;
    }
    let (Some(month), Some(day)) = (
        text.get(..2).and_then(|m| m.parse::<u32>().ok()),
        text.get(3..).and_then(|d| d.parse::<u32>().ok()),
    ) else {
        return false;
    };
    let longest = match month {
        2 => 29,
        4 | 6 | 9 | 11 => 30,
        1..=12 => 31,
        _ => return false,
    };
    bytes.iter().all(|b| b.is_ascii_digit() || *b == b'-') && (1..=longest).contains(&day)
}

/// The origin a contact belongs to.
fn origin_of(contact: &wire::PhoneContact) -> String {
    if contact.container_key.is_empty() {
        DEFAULT_ORIGIN.to_owned()
    } else {
        format!("container:{}", contact.container_key)
    }
}

/// ONE CONTACT, as `follow-contacts` is told of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Record {
    pub phone_id: String,
    pub origin: String,
    pub name: String,
    pub phones: Vec<String>,
    pub emails: Vec<String>,
    pub birthday: String,
}

/// WHAT ONE READ OF THE ADDRESS BOOK SENDS: the contacts, one record each, in
/// the accounts they were read in, and every account present (even one with no
/// contact in it).
#[derive(Clone, Debug)]
pub struct Batch {
    /// False for a read that may have missed contacts: the vault then trashes
    /// nothing.
    pub complete: bool,
    pub origins: Vec<OriginRef>,
    pub records: Vec<Record>,
}

/// A READ OF THE ADDRESS BOOK AS A BATCH. Named, trimmed and one per phone id; a
/// contact with no name or no id is not a record.
///
/// ONE CONTACT, ONE ORIGIN. A shell that reads per container (iOS reads each
/// `CNContainer`) meets a unified contact once for every container it is in; it
/// is one person, so one record, and the origin it is kept under must not depend
/// on the order the containers were read in, or a person would hop between
/// accounts from one pass to the next. **The lowest origin id wins** (compared
/// as text), and a contact that names none counts as [`DEFAULT_ORIGIN`].
#[must_use]
pub fn batch(locale: Locale, snapshot: &wire::ContactsSnapshot) -> Batch {
    let mut chosen: Vec<&wire::PhoneContact> = Vec::new();
    for contact in &snapshot.contacts {
        if !is_valid_id(&contact.phone_id) {
            continue;
        }
        match chosen
            .iter_mut()
            .find(|held| held.phone_id == contact.phone_id)
        {
            Some(held) => {
                if origin_of(contact) < origin_of(held) {
                    *held = contact;
                }
            }
            None => chosen.push(contact),
        }
    }
    let records: Vec<Record> = chosen
        .into_iter()
        .filter_map(|contact| {
            let name = squash(&contact.name);
            if name.is_empty() {
                return None;
            }
            let trimmed = |values: &[String]| -> Vec<String> {
                values
                    .iter()
                    .map(|value| value.trim().to_owned())
                    .filter(|value| !value.is_empty())
                    .collect()
            };
            let mut phones = trimmed(&contact.phones);
            dedupe(&mut phones, |value| value.clone());
            let mut emails = trimmed(&contact.emails);
            dedupe(&mut emails, |value| value.to_lowercase());
            Some(Record {
                phone_id: contact.phone_id.clone(),
                origin: origin_of(contact),
                name,
                phones,
                emails,
                birthday: if is_month_day(&contact.birthday) {
                    contact.birthday.clone()
                } else {
                    String::new()
                },
            })
        })
        .collect();

    let named: Vec<OriginRef> = snapshot
        .containers
        .iter()
        .map(|container| OriginRef {
            id: format!("container:{}", container.key),
            label: Some(squash(&container.name))
                .filter(|name| !name.is_empty())
                .unwrap_or_else(|| words::import_origin_this_phone(locale)),
        })
        .collect();
    let mut present: Vec<OriginRef> = Vec::new();
    let ids = named
        .iter()
        .map(|origin| origin.id.clone())
        .chain(records.iter().map(|record| record.origin.clone()));
    for id in ids {
        if present.iter().any(|origin| origin.id == id) {
            continue;
        }
        let label = named
            .iter()
            .find(|origin| origin.id == id)
            .map(|origin| origin.label.clone())
            .unwrap_or_else(|| {
                if id == DEFAULT_ORIGIN {
                    words::import_origin_this_phone(locale)
                } else {
                    id.clone()
                }
            });
        present.push(OriginRef { id, label });
    }
    Batch {
        complete: snapshot.complete,
        origins: present,
        records,
    }
}

/// Keep the first of each value `key` calls the same.
fn dedupe(values: &mut Vec<String>, key: impl Fn(&String) -> String) {
    let mut seen: Vec<String> = Vec::new();
    values.retain(|value| {
        let k = key(value);
        if seen.contains(&k) {
            false
        } else {
            seen.push(k);
            true
        }
    });
}

/// The `follow-contacts` request for one account: its records, and whether the
/// read was complete.
#[must_use]
pub fn follow_request(
    origin: &OriginRef,
    records: &[&Record],
    complete: bool,
    device: &str,
) -> act::people::FollowContacts {
    let records: Vec<Value> = records
        .iter()
        .map(|record| {
            let points: Vec<Value> = record
                .phones
                .iter()
                .map(|value| ("phone", value))
                .chain(record.emails.iter().map(|value| ("email", value)))
                .map(|(kind, value)| {
                    json!({ "kind": kind, "value": value.chars().take(VALUE_MAX).collect::<String>() })
                })
                .collect();
            json!({
                "external_id": record.phone_id,
                // A phone id that means something on this phone only is kept under the phone (R-1127-10).
                "device_id": if is_portable_id(&record.phone_id) { Value::Null } else { json!(device) },
                "fields": {
                    "title": record.name,
                    "birthday": if record.birthday.is_empty() { Value::Null } else { json!(record.birthday) },
                    "points": points,
                },
            })
        })
        .collect();
    act::people::FollowContacts {
        origin: json!({ "ref": origin.id, "label": origin.label, "device_id": device }).to_string(),
        records: Value::Array(records).to_string(),
        complete: Some(complete),
        since: None,
    }
}

/// What one pass did. `add_account` is the R-1127-8 condition: the phone
/// returned no contacts at all.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    pub added: u32,
    pub refused: u32,
    pub updated: u32,
    pub trashed: u32,
    pub add_account: bool,
}

/// The one sentence an import ends on.
#[must_use]
pub fn sentence(locale: Locale, outcome: &Outcome) -> String {
    if outcome.add_account {
        words::import_contacts_add_account(locale)
    } else if outcome.added == 0 && outcome.refused == 0 {
        words::import_contacts_none(locale)
    } else if outcome.added == 0 {
        words::import_contacts_failed(locale)
    } else {
        words::import_contacts_done(locale, u64::from(outcome.added))
    }
}

/// A count of the command's output: `"added": 3`.
fn count(output: &Value, name: &str) -> u32 {
    output
        .get(name)
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Purpose {
    /// The member's tap: the OS may ask for permission, and a sentence says how it went.
    Import,
    /// A following pass: silent, and never asks.
    Follow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Waiting {
    Nothing,
    /// The keychain's answer to "did this device import?".
    Flag,
    Read(Purpose),
}

/// When a following pass runs. Pure: the timers are the runtime's.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Gate {
    Idle,
    /// A trigger armed the settle timer; later ones join it.
    Armed,
    /// A pass is out; `queued` is a trigger that arrived during it.
    Running {
        queued: bool,
    },
}

/// THE IMPORT AND THE FOLLOW, as one component a long-lived screen hosts. The
/// host sends it the events it does not know ([`Self::on_event`]), draws its
/// [`Self::status`] on the status line, and returns the effects it hands back.
pub struct ContactsFollow {
    waiting: Waiting,
    gate: Gate,
    /// This device imported its contacts: a pass may run.
    followed: bool,
    watching: bool,
    /// An Import tapped while a read was out.
    import_queued: bool,
    status: Option<wire::StatusLine>,
    outcome: Option<Outcome>,
}

impl Default for ContactsFollow {
    fn default() -> Self {
        Self::new()
    }
}

impl ContactsFollow {
    #[must_use]
    pub fn new() -> Self {
        Self {
            waiting: Waiting::Nothing,
            gate: Gate::Idle,
            followed: false,
            watching: false,
            import_queued: false,
            status: None,
            outcome: None,
        }
    }

    /// The host came up: learn whether this device follows. Asked once.
    pub fn attach(&mut self) -> Vec<wire::Effect> {
        if self.followed || self.waiting != Waiting::Nothing {
            return Vec::new();
        }
        self.waiting = Waiting::Flag;
        vec![keychain(wire::keychain_op::Op::Get, Vec::new())]
    }

    /// The member tapped Import. ONE IMPORT AT A TIME: a second tap while one
    /// runs would write every person twice, so it is nothing. A tap during a
    /// following pass (or before the device has said whether it follows) waits
    /// for it.
    pub fn import(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.waiting == Waiting::Read(Purpose::Import) {
            return Vec::new();
        }
        if self.waiting != Waiting::Nothing {
            self.import_queued = true;
            return Vec::new();
        }
        self.start_read(ctx, Purpose::Import)
    }

    /// The phone may have changed (or the app came forward): follow soon.
    pub fn request(&mut self, ctx: &Ctx) {
        if !self.followed {
            return;
        }
        match self.gate {
            Gate::Idle => {
                self.gate = Gate::Armed;
                ctx.start_timer(SETTLE_TIMER, SETTLE);
            }
            Gate::Armed => {}
            Gate::Running { .. } => self.gate = Gate::Running { queued: true },
        }
    }

    /// The status line this flow wants drawn: the running sentence, then the
    /// outcome's. A following pass says nothing.
    #[must_use]
    pub fn status(&self) -> Option<&wire::StatusLine> {
        self.status.as_ref()
    }

    /// How the last import ended.
    #[must_use]
    pub fn outcome(&self) -> Option<&Outcome> {
        self.outcome.as_ref()
    }

    /// Whether this device follows the address book.
    #[must_use]
    pub fn followed(&self) -> bool {
        self.followed
    }

    /// Offer the host's event. `Some(effects)` when it was this flow's (a timer
    /// it started, or the answer to an effect it asked); `None` otherwise.
    pub fn on_event(&mut self, event: &E, ctx: &Ctx) -> Option<Vec<wire::Effect>> {
        match event {
            E::TimerFired(fired) if fired.timer == SETTLE_TIMER => Some(self.settled(ctx)),
            E::TimerFired(fired) if fired.timer == READ_TIMER => Some(self.read_ended(ctx, None)),
            E::EffectResult(result) => self.on_result(result, ctx),
            _ => None,
        }
    }

    fn on_result(&mut self, result: &wire::EffectResult, ctx: &Ctx) -> Option<Vec<wire::Effect>> {
        use wire::effect_result::Outcome as O;
        match (&self.waiting, &result.outcome) {
            (_, Some(O::PhoneChanged(changed)))
                if changed.source == wire::ImportSource::Contacts as i32 =>
            {
                self.request(ctx);
                Some(Vec::new())
            }
            (Waiting::Flag, Some(O::Keychain(value))) => {
                self.waiting = Waiting::Nothing;
                self.followed = value.found && value.value == IMPORTED_VALUE;
                Some(self.begin_following(ctx))
            }
            (Waiting::Flag, Some(O::Failed(_))) => {
                self.waiting = Waiting::Nothing;
                Some(Vec::new())
            }
            (Waiting::Read(_), Some(O::Contacts(snapshot))) => {
                Some(self.read_ended(ctx, Some(snapshot)))
            }
            (Waiting::Read(_), Some(O::Failed(failed))) => {
                let denied = failed.denied;
                Some(self.read_failed(ctx, denied))
            }
            _ => None,
        }
    }

    /// Watch the store and follow once, now that this device follows.
    fn begin_following(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if !self.followed || self.watching {
            return Vec::new();
        }
        self.watching = true;
        self.request(ctx);
        vec![watch(true)]
    }

    /// The settle timer fired: start the pass.
    fn settled(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        if self.gate != Gate::Armed {
            return Vec::new();
        }
        if !self.followed {
            self.gate = Gate::Idle;
            return Vec::new();
        }
        if self.waiting != Waiting::Nothing {
            // An import is out: the pass waits the settle time again.
            ctx.start_timer(SETTLE_TIMER, SETTLE);
            return Vec::new();
        }
        self.gate = Gate::Running { queued: false };
        self.start_read(ctx, Purpose::Follow)
    }

    fn start_read(&mut self, ctx: &Ctx, purpose: Purpose) -> Vec<wire::Effect> {
        self.waiting = Waiting::Read(purpose);
        match purpose {
            Purpose::Import => {
                self.outcome = None;
                self.status = Some(plain(words::import_contacts_running(ctx.locale())));
            }
            // Only a read with no dialog can go unanswered.
            Purpose::Follow => ctx.start_timer(READ_TIMER, READ_TIMEOUT),
        }
        vec![wire::Effect {
            kind: Some(wire::effect::Kind::ContactsRead(wire::ContactsRead {
                ask_permission: purpose == Purpose::Import,
            })),
        }]
    }

    fn read_failed(&mut self, ctx: &Ctx, denied: bool) -> Vec<wire::Effect> {
        let Waiting::Read(purpose) = self.waiting else {
            return Vec::new();
        };
        if purpose == Purpose::Import {
            let locale = ctx.locale();
            self.status = Some(plain(if denied {
                words::import_contacts_denied(locale)
            } else {
                words::import_contacts_failed(locale)
            }));
        }
        self.finish(ctx)
    }

    /// A read came back (`Some`) or timed out (`None`).
    fn read_ended(
        &mut self,
        ctx: &Ctx,
        snapshot: Option<&wire::ContactsSnapshot>,
    ) -> Vec<wire::Effect> {
        let Waiting::Read(purpose) = self.waiting else {
            return Vec::new();
        };
        let Some(snapshot) = snapshot else {
            return self.read_failed(ctx, false);
        };
        let (outcome, told) = self.run(ctx, snapshot);
        let mut effects = Vec::new();
        if purpose == Purpose::Import {
            self.status = Some(plain(sentence(ctx.locale(), &outcome)));
            self.outcome = Some(outcome);
            // THIS DEVICE FOLLOWS FROM NOW ON, once the vault took an account.
            if told && !self.followed {
                self.followed = true;
                effects.push(keychain(
                    wire::keychain_op::Op::Set,
                    IMPORTED_VALUE.to_vec(),
                ));
            }
        }
        effects.extend(self.finish(ctx));
        if self.followed && !self.watching {
            effects.extend(self.begin_following(ctx));
        }
        effects
    }

    /// One `follow-contacts` per account. `told` is whether the vault took any.
    fn run(&mut self, ctx: &Ctx, snapshot: &wire::ContactsSnapshot) -> (Outcome, bool) {
        let batch = batch(ctx.locale(), snapshot);
        let mut outcome = Outcome {
            add_account: batch.complete && batch.records.is_empty() && batch.origins.is_empty(),
            ..Outcome::default()
        };
        let mut told = false;
        for origin in &batch.origins {
            let records: Vec<&Record> = batch
                .records
                .iter()
                .filter(|record| record.origin == origin.id)
                .collect();
            let request = follow_request(origin, &records, batch.complete, &snapshot.device_id);
            let key = kit_act::key(&["follow-contacts", &origin.id], kit_act::fresh());
            let settled = kit_act::act(ctx, request, &key);
            if !settled.committed {
                outcome.refused += u32::try_from(records.len()).unwrap_or(u32::MAX);
                continue;
            }
            told = true;
            let output: Value = serde_json::from_slice(&settled.output).unwrap_or(Value::Null);
            outcome.added += count(&output, "added") + count(&output, "matched");
            outcome.refused += count(&output, "refused");
            outcome.updated += count(&output, "updated");
            outcome.trashed += count(&output, "trashed");
        }
        (outcome, told)
    }

    /// A read is over, however it ended: the next thing waiting goes.
    fn finish(&mut self, ctx: &Ctx) -> Vec<wire::Effect> {
        ctx.cancel_timer(READ_TIMER);
        self.waiting = Waiting::Nothing;
        if self.import_queued {
            self.import_queued = false;
            return self.start_read(ctx, Purpose::Import);
        }
        match self.gate {
            // Triggers arrived during the pass: one more, at once.
            Gate::Running { queued: true } => {
                self.gate = Gate::Running { queued: false };
                self.start_read(ctx, Purpose::Follow)
            }
            Gate::Running { queued: false } => {
                self.gate = Gate::Idle;
                Vec::new()
            }
            _ => Vec::new(),
        }
    }
}

fn plain(sentence: String) -> wire::StatusLine {
    wire::StatusLine {
        sentence,
        action_label: String::new(),
        refused: false,
    }
}

fn keychain(op: wire::keychain_op::Op, value: Vec<u8>) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::Keychain(wire::KeychainOp {
            op: op as i32,
            key: IMPORTED_KEY.to_owned(),
            value,
        })),
    }
}

fn watch(on: bool) -> wire::Effect {
    wire::Effect {
        kind: Some(wire::effect::Kind::PhoneWatch(wire::PhoneWatch {
            source: wire::ImportSource::Contacts as i32,
            on,
        })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const EN: Locale = Locale::En;

    fn contact(name: &str, id: &str, container: &str) -> wire::PhoneContact {
        wire::PhoneContact {
            name: name.to_owned(),
            phone_id: id.to_owned(),
            container_key: container.to_owned(),
            ..wire::PhoneContact::default()
        }
    }

    fn snapshot(contacts: Vec<wire::PhoneContact>) -> wire::ContactsSnapshot {
        wire::ContactsSnapshot {
            complete: true,
            device_id: "device".to_owned(),
            containers: Vec::new(),
            contacts,
        }
    }

    #[test]
    fn a_contact_is_named_trimmed_and_one_per_phone_id() {
        let mut ada = contact("  Ada   Lovelace ", "lookup:ada", "");
        ada.phones = vec!["555 0100".into(), " 555 0100 ".into(), "".into()];
        ada.emails = vec!["Ada@x.example".into(), "ada@x.example".into()];
        ada.birthday = "12-10".into();
        let batch = batch(
            EN,
            &snapshot(vec![
                ada,
                contact("", "lookup:nameless", ""),
                contact("No Id", "", ""),
                contact("Bad Id", "nokind", ""),
                contact("Ada Again", "lookup:ada", ""),
            ]),
        );
        assert_eq!(batch.records.len(), 1);
        let record = &batch.records[0];
        assert_eq!(record.name, "Ada Lovelace");
        assert_eq!(record.phones, ["555 0100"]);
        assert_eq!(record.emails, ["Ada@x.example"]);
        assert_eq!(record.birthday, "12-10");
        assert_eq!(record.origin, DEFAULT_ORIGIN);
    }

    #[test]
    fn a_birthday_is_a_real_day_of_the_year_and_the_leap_day_counts() {
        for good in ["01-01", "02-29", "12-31", "04-30"] {
            assert!(is_month_day(good), "{good}");
        }
        for bad in [
            "13-01", "02-30", "00-10", "04-31", "1-1", "12/10", "ab-cd", "",
        ] {
            assert!(!is_month_day(bad), "{bad}");
        }
    }

    /// ONE CONTACT, ONE ORIGIN: met in two containers, kept under the lowest, whichever was read first.
    #[test]
    fn a_contact_in_two_accounts_is_kept_under_the_lowest_origin_whatever_the_read_order() {
        let a = contact("Sam", "local:sam", "b-account");
        let b = contact("Sam", "local:sam", "a-account");
        let one = batch(EN, &snapshot(vec![a.clone(), b.clone()]));
        let other = batch(EN, &snapshot(vec![b, a]));
        assert_eq!(one.records, other.records);
        assert_eq!(one.records[0].origin, "container:a-account");
    }

    #[test]
    fn every_account_present_is_told_even_one_with_nobody_in_it() {
        let mut snap = snapshot(vec![contact("Sam", "local:sam", "")]);
        snap.containers = vec![
            wire::PhoneContactContainer {
                key: "icloud".into(),
                name: " iCloud ".into(),
            },
            wire::PhoneContactContainer {
                key: "empty".into(),
                name: "".into(),
            },
        ];
        let batch = batch(EN, &snap);
        let labels: Vec<(&str, &str)> = batch
            .origins
            .iter()
            .map(|o| (o.id.as_str(), o.label.as_str()))
            .collect();
        assert_eq!(
            labels,
            [
                ("container:icloud", "iCloud"),
                ("container:empty", "This phone's contacts"),
                (DEFAULT_ORIGIN, "This phone's contacts"),
            ]
        );
    }

    #[test]
    fn a_local_id_is_kept_under_the_phone_and_a_portable_one_is_not() {
        assert!(is_portable_id("uid:abc") && is_portable_id("lookup:abc"));
        assert!(!is_portable_id("local:abc"));
        let origin = OriginRef {
            id: DEFAULT_ORIGIN.into(),
            label: "Phone".into(),
        };
        let mut local = contact("Sam", "local:sam", "");
        local.phones = vec!["1".into()];
        let portable = contact("Ada", "lookup:ada", "");
        let batch = batch(EN, &snapshot(vec![local, portable]));
        let all: Vec<&Record> = batch.records.iter().collect();
        let request = follow_request(&origin, &all, true, "device");
        let records: Value = serde_json::from_str(&request.records).unwrap();
        assert_eq!(records[0]["device_id"], json!("device"));
        assert_eq!(records[1]["device_id"], Value::Null);
        assert_eq!(
            records[0]["fields"]["points"],
            json!([{ "kind": "phone", "value": "1" }])
        );
        assert_eq!(records[0]["fields"]["birthday"], Value::Null);
    }

    #[test]
    fn the_sentence_an_import_ends_on() {
        let say = |added, refused, add_account| {
            sentence(
                EN,
                &Outcome {
                    added,
                    refused,
                    add_account,
                    ..Outcome::default()
                },
            )
        };
        assert!(say(0, 0, true).starts_with("No contacts found."));
        assert_eq!(say(0, 0, false), "No contacts to import");
        assert_eq!(say(0, 3, false), "Contacts did not import.");
        assert_eq!(say(1, 0, false), "1 person imported");
        assert_eq!(say(12, 0, false), "12 people imported");
    }
}
