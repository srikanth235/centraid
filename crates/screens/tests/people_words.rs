//! The words People says: no sharing plane (#1029 amendment), so no People word
//! says gateway, linked or share. Ports `PeopleSpec`'s word law over the
//! source of every string, `copy/people.json`.

use std::path::Path;

fn strings(value: &serde_json::Value, out: &mut Vec<String>) {
    match value {
        serde_json::Value::String(s) => out.push(s.clone()),
        serde_json::Value::Array(items) => items.iter().for_each(|v| strings(v, out)),
        serde_json::Value::Object(map) => map.values().for_each(|v| strings(v, out)),
        _ => {}
    }
}

#[test]
fn no_people_word_says_gateway_linked_or_share() {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../copy/people.json");
    let json: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("copy/people.json"))
            .expect("people copy is JSON");
    let mut words = Vec::new();
    strings(&json["strings"], &mut words);
    assert!(words.len() > 50, "the copy was read");
    for word in words {
        let lower = word.to_lowercase();
        for banned in ["gateway", "linked", "share"] {
            assert!(!lower.contains(banned), "{word:?} says {banned}");
        }
    }
}
