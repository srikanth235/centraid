//! VALUES (SPEC §4.3): `count · sum · min · max`, one number per
//! currency, one number per group value when `group` is given.

use std::collections::BTreeMap;

use serde_json::{Value, json};

use crate::native::render;
use crate::native::world::{Row, Val, World, units};

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
