//! Locker fixtures: a vault with a content store, the registry, the key `K` the core would hold
//! (a test constant, written nowhere) and helpers that seal the way the core does.
#![allow(dead_code)]

use centraid_vault::custody::locker_key::encrypt_under_locker_key;
use serde_json::{Value, json};

use super::world::World;

pub const K: [u8; 32] = [0x5a; 32];

pub fn world(seed: &str) -> World {
    World {
        scratch: super::Scratch::founded_with_blobs(seed).expect("a vault"),
        registry: centraid_vault::commands::Registry::with_system_commands().expect("a registry"),
    }
}

/// The live key generation, named the way the core names it.
pub fn key_id(w: &World) -> String {
    w.vault().locker_generation().expect("a generation")
}

/// What the core sends for a secret: ciphertext bound to the row id and the generation.
pub fn seal(w: &World, row_id: &str, plaintext: &str) -> String {
    encrypt_under_locker_key(&K, &key_id(w), row_id, plaintext).expect("the core seals")
}

/// `<item>:<key>`, the id of a single-instance built-in field.
pub fn id_of(item: &str, key: &str) -> String {
    centraid_vault::commands::locker::field_id_of(item, key)
}

/// A built-in plain field.
pub fn plain(key: &str, value: &str) -> Value {
    json!({ "field_key": key, "value": value })
}

/// A built-in single secret, sealed against its derived id.
pub fn secret(w: &World, item: &str, key: &str, plaintext: &str) -> Value {
    json!({
        "field_key": key,
        "value": seal(w, &id_of(item, key), plaintext),
        "key_id": key_id(w),
    })
}

pub fn item_id(w: &World) -> String {
    w.mint()
}

/// A new item of `item_type`, with `fields`.
pub fn add(w: &World, item_id: &str, item_type: &str, title: &str, fields: Vec<Value>) -> Value {
    w.ok(
        "locker.add_item",
        json!({ "item_id": item_id, "type": item_type, "title": title, "fields": fields }),
    )
}
