//! VALUES (SPEC §4.3): `count · sum · min · max · balance`, one number per
//! currency, one number per group value when `group` is given.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::meta::Kind;
use crate::render;
use crate::session::Session;
use crate::world::{Key, Row, Val, World, units};

type Bucket = BTreeMap<Option<String>, i64>;

fn machine_values(bucket: &Bucket) -> Value {
    Value::Array(
        bucket
            .iter()
            .map(|(currency, value)| match currency {
                Some(currency) => json!({"amount": units(*value, currency), "unit": currency}),
                None => json!({"amount": value, "unit": null}),
            })
            .collect(),
    )
}

fn text_values(bucket: &Bucket) -> String {
    let values: Vec<(i64, Option<String>)> = bucket
        .iter()
        .map(|(currency, value)| (*value, currency.clone()))
        .collect();
    render::amounts(&values)
}

fn number_of(row: &Row, field: &str) -> Option<(i64, Option<String>)> {
    match row.field(field)? {
        Val::Num(value) => Some((*value, None)),
        Val::Money(minor, currency) => Some((*minor, Some(currency.clone()))),
        _ => None,
    }
}

fn fold_rows(op: &str, field: Option<&str>, rows: &[&Row]) -> Bucket {
    let mut bucket: Bucket = BTreeMap::new();
    if op == "count" {
        bucket.insert(None, i64::try_from(rows.len()).unwrap_or(i64::MAX));
        return bucket;
    }
    let Some(field) = field else {
        return bucket;
    };
    for row in rows {
        let Some((value, currency)) = number_of(row, field) else {
            continue;
        };
        let slot = bucket.entry(currency).or_insert(match op {
            "min" => i64::MAX,
            "max" => i64::MIN,
            _ => 0,
        });
        *slot = match op {
            "min" => (*slot).min(value),
            "max" => (*slot).max(value),
            _ => *slot + value,
        };
    }
    if op == "sum" && bucket.is_empty() {
        bucket.insert(None, 0);
    }
    bucket
}

fn group_label(row: &Row, group: &str) -> String {
    match row.field(group) {
        None => "none".to_owned(),
        Some(Val::Text(text)) => text.clone(),
        Some(other) => other.show(row.kind.spec().field(group)),
    }
}

/// `count`, `sum`, `min`, `max`, optionally one per group value.
#[must_use]
pub fn fold(
    op: &str,
    field: Option<&str>,
    group: Option<&str>,
    rows: &[Row],
    _world: &World,
) -> ((String, String), Value) {
    let refs: Vec<&Row> = rows.iter().collect();
    match group {
        None => {
            let bucket = fold_rows(op, field, &refs);
            (
                (text_values(&bucket), String::new()),
                json!({"op": op, "field": field, "values": machine_values(&bucket)}),
            )
        }
        Some(group) => {
            let mut groups: BTreeMap<String, Vec<&Row>> = BTreeMap::new();
            for row in &refs {
                groups.entry(group_label(row, group)).or_default().push(row);
            }
            let mut texts = Vec::new();
            let mut machine = Vec::new();
            for (label, members) in &groups {
                let bucket = fold_rows(op, field, members);
                texts.push(format!("{label} {}", text_values(&bucket)));
                machine.push(json!({"key": label, "values": machine_values(&bucket)}));
            }
            (
                (texts.join(" · "), String::new()),
                json!({"op": op, "field": field, "group": group, "groups": machine}),
            )
        }
    }
}

fn one_of(session: &mut Session, keys: &[Key], kind: Kind, what: &str) -> Result<Key, String> {
    let matching: Vec<&Key> = keys.iter().filter(|key| key.0 == kind).collect();
    match matching.len() {
        1 => Ok(matching[0].clone()),
        0 => Err(format!(
            "error: balance needs one {}; the selection holds none.{what}",
            kind.name()
        )),
        _ => {
            let names: Vec<String> = matching
                .iter()
                .map(|key| {
                    let n = session.number(key);
                    render::named(&session.world, n, key)
                })
                .collect();
            Err(format!(
                "error: balance is for one {}; the selection holds {}: {}.",
                kind.name(),
                matching.len(),
                names.join(", ")
            ))
        }
    }
}

/// `balance` for a person (me versus them, positive = they owe me) or for a
/// group with a person linked (their net there, positive = the group owes
/// them). The folds are the Tally app's own.
pub fn balance(
    session: &mut Session,
    kind: Kind,
    keys: &[Key],
    linked: &[Key],
) -> Result<((String, String), Value), String> {
    let data = session.world.tally.balance_data();
    let me = session.world.me.clone();
    match kind {
        Kind::Person => {
            let person = one_of(session, keys, Kind::Person, "")?;
            if person.1 == me {
                return Err("error: that is you; balance is you versus someone else.".to_owned());
            }
            let mut bucket: Bucket = BTreeMap::new();
            for row in session.world.of_kind(Kind::Debt) {
                if row.trashed || row.field("status") != Some(&Val::Enum("open")) {
                    continue;
                }
                if !session.world.linked(&row.key(), &person) {
                    continue;
                }
                if let Some(Val::Money(minor, currency)) = row.field("amount") {
                    let sign = if row.field("direction") == Some(&Val::Enum("owes_me")) {
                        1
                    } else {
                        -1
                    };
                    *bucket.entry(Some(currency.clone())).or_insert(0) += sign * minor;
                }
            }
            for group in &session.world.tally.groups {
                let pair = centraid_apps_tally::balance::group_pair_nets(&data, &group.group_id);
                let owes = pair
                    .get(&person.1)
                    .and_then(|row| row.get(&me))
                    .copied()
                    .unwrap_or(0);
                if owes != 0 {
                    *bucket.entry(Some(group.currency.clone())).or_insert(0) += owes;
                }
            }
            if bucket.is_empty() {
                bucket.insert(Some(session.world.currency.clone()), 0);
            }
            let n = session.number(&person);
            let what = format!(
                "balance of {}; positive = they owe you",
                render::named(&session.world, n, &person)
            );
            Ok((
                (text_values(&bucket), what),
                json!({"op": "balance", "of": {"kind": "person", "id": person.1},
                       "values": machine_values(&bucket)}),
            ))
        }
        Kind::Group => {
            let group = one_of(session, keys, Kind::Group, "")?;
            let net = centraid_apps_tally::balance::group_net(&data, &group.1);
            let me_row = session.world.row(&session.world.me_key()).is_some();
            let person = match linked.iter().filter(|key| key.0 == Kind::Person).count() {
                1 => linked
                    .iter()
                    .find(|key| key.0 == Kind::Person)
                    .cloned()
                    .unwrap_or_default_key(),
                // no person named: a group's balance is the person's own, unless the message is
                // about someone else (a name, a pronoun for them, a person in focus): the model
                // left that person out and the error says to add them
                0 if me_row && !session.names_someone_else() => {
                    your_balance_note(session);
                    session.world.me_key()
                }
                // nt14 (owner ruling 2026-10-06): the message names no one and says no pronoun
                // for them, so a person only in focus does not make it theirs; the user's own
                // balance, when the user is in the group. Off under `--no-normalize`.
                0 if me_row
                    && session.flags.normalize
                    && !session.names_a_person_or_pronoun()
                    && net.contains_key(&session.world.me_key().1) =>
                {
                    your_balance_note(session);
                    session.world.me_key()
                }
                _ => {
                    return Err(
                        "error: a group's balance is one person's: kind=group linked_to=#n (the person) op=balance."
                            .to_owned(),
                    );
                }
            };
            let value = net.get(&person.1).copied().unwrap_or(0);
            let currency = session
                .world
                .row(&group)
                .and_then(|row| row.extra.get("currency").cloned())
                .unwrap_or_else(|| session.world.currency.clone());
            let mut bucket: Bucket = BTreeMap::new();
            bucket.insert(Some(currency), value);
            let g = session.number(&group);
            let p = session.number(&person);
            let what = format!(
                "net of {} in {}; positive = the group owes them",
                render::named(&session.world, p, &person),
                render::named(&session.world, g, &group)
            );
            Ok((
                (text_values(&bucket), what),
                json!({"op": "balance", "of": {"kind": "group", "id": group.1},
                       "person": person.1, "values": machine_values(&bucket)}),
            ))
        }
        // nt14 N2 and N3 (`--no-normalize` keeps the error): a debt's open amount, and a row linked
        // to exactly one group (a group's rows hold the user's money there) is the user's balance
        // in that group
        other if session.flags.normalize && other == Kind::Debt => debt_balance(session, keys),
        other => match group_of_row(session, other, keys) {
            Some((row, group)) => {
                let me = session.world.me_key();
                let held = centraid_apps_tally::balance::group_net(&data, &group.1);
                if !held.contains_key(&me.1) {
                    return Err(not_defined(other));
                }
                let (r, g) = (session.number(&row), session.number(&group));
                let said = format!(
                    "note: {} is in {}; used your balance there",
                    render::named(&session.world, r, &row),
                    render::named(&session.world, g, &group)
                );
                let result = balance(session, Kind::Group, &[group], &[me])?;
                session.pending_notes.push(said);
                Ok(result)
            }
            None => Err(not_defined(other)),
        },
    }
}

fn not_defined(kind: Kind) -> String {
    format!(
        "error: balance is defined for person and for group (with linked_to a person), not for {}.",
        kind.plural()
    )
}

/// nt14 N2: the open amount of one debt (what is still owed on it: zero once it is settled) in
/// its own currency, the direction in the words that say it.
fn debt_balance(session: &mut Session, keys: &[Key]) -> Result<((String, String), Value), String> {
    let debt = one_of(session, keys, Kind::Debt, "")?;
    let Some(row) = session.world.row(&debt).cloned() else {
        return Err(not_defined(Kind::Debt));
    };
    let (minor, currency) = match row.field("amount") {
        Some(Val::Money(minor, currency)) => (*minor, currency.clone()),
        _ => (0, session.world.currency.clone()),
    };
    let open = row.field("status") == Some(&Val::Enum("open"));
    let mut bucket: Bucket = BTreeMap::new();
    bucket.insert(Some(currency), if open { minor } else { 0 });
    let who = if row.field("direction") == Some(&Val::Enum("owes_me")) {
        "they owe you"
    } else {
        "you owe them"
    };
    let n = session.number(&debt);
    let what = format!(
        "open amount of {}; {}",
        render::named(&session.world, n, &debt),
        if open { who } else { "settled" }
    );
    Ok((
        (text_values(&bucket), what),
        json!({"op": "balance", "of": {"kind": "debt", "id": debt.1},
               "values": machine_values(&bucket)}),
    ))
}

/// nt14 N3: the one row selected and the one live group it is linked to, when there is exactly
/// one of each; `None` for none or several of either (the error it was).
fn group_of_row(session: &Session, kind: Kind, keys: &[Key]) -> Option<(Key, Key)> {
    if !session.flags.normalize {
        return None;
    }
    let [row] = keys else {
        return None;
    };
    if row.0 != kind {
        return None;
    }
    let groups: Vec<Key> = session
        .world
        .neighbours(row)
        .remove(&Kind::Group)
        .unwrap_or_default()
        .into_iter()
        .filter(|group| session.world.row(group).is_some_and(|g| !g.trashed))
        .collect();
    match groups.as_slice() {
        [group] => Some((row.clone(), group.clone())),
        _ => None,
    }
}

/// The default's own line: the balance is the user's because no person was named (nt14).
fn your_balance_note(session: &mut Session) {
    if session.flags.normalize {
        session
            .pending_notes
            .push("note: your balance (no person named)".to_owned());
    }
}

trait OrDefaultKey {
    fn unwrap_or_default_key(self) -> Key;
}

impl OrDefaultKey for Option<Key> {
    fn unwrap_or_default_key(self) -> Key {
        self.unwrap_or((Kind::Person, String::new()))
    }
}
