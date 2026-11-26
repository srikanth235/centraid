#![allow(
    dead_code,
    reason = "each test crate that includes this module uses its own part"
)]

use std::cell::RefCell;
use std::collections::BTreeMap;

thread_local! {
    static LABELS: RefCell<BTreeMap<String, String>> = const { RefCell::new(BTreeMap::new()) };
}

pub fn reg(kind: &str, label: &str) -> String {
    let id = format!("{kind}:{label}");
    LABELS.with(|labels| labels.borrow_mut().insert(label.to_owned(), id.clone()));
    id
}

pub fn reg_uuid(kind: &str, label: &str) -> String {
    let _ = kind;
    let mut tail = String::new();
    for index in 0..6 {
        tail.push_str(&format!(
            "{:02x}",
            label.as_bytes().get(index).copied().unwrap_or(0)
        ));
    }
    let id = format!("01900000-0000-7000-8000-{tail}");
    LABELS.with(|labels| labels.borrow_mut().insert(label.to_owned(), id.clone()));
    id
}

pub fn map(label: &str) -> String {
    LABELS.with(|labels| {
        labels
            .borrow()
            .get(label)
            .cloned()
            .unwrap_or_else(|| label.to_owned())
    })
}

pub fn strip(id: &str) -> &str {
    let label = LABELS.with(|labels| {
        labels
            .borrow()
            .iter()
            .find(|(_, held)| held.as_str() == id)
            .map(|(label, _)| label.clone())
    });
    match label {
        Some(label) => Box::leak(label.into_boxed_str()),
        None => id.split_once(':').map_or(id, |(_, rest)| rest),
    }
}

pub fn mapped(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::String(text) => serde_json::Value::String(map(text)),
        serde_json::Value::Array(items) => items.iter().map(mapped).collect(),
        serde_json::Value::Object(fields) => fields
            .iter()
            .map(|(key, item)| (key.clone(), mapped(item)))
            .collect(),
        other => other.clone(),
    }
}
