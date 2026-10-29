//! The sealed scrub: a message that quotes a secret must not carry it out of the vault.

/// A sealed key is a top-level name (`password`) or a name inside every element of a top-level
/// array (`fields[].value`), which is how `locker.duplicate_item` carries the custom fields it
/// re-sealed.
fn nested(key: &str) -> Option<(&str, &str)> {
    key.split_once("[].")
}

/// Scrub sealed values out of a message before it reaches a response. A validation error quotes
/// the value that failed, which for a sealed field is the secret itself.
#[must_use]
pub fn scrub_sealed(message: &str, sealed_keys: &[&str], input: &serde_json::Value) -> String {
    let mut out = message.to_owned();
    let Some(map) = input.as_object() else {
        return out;
    };
    let mut scrub = |value: Option<&serde_json::Value>| {
        if let Some(serde_json::Value::String(secret)) = value
            && !secret.is_empty()
        {
            out = out.replace(secret.as_str(), "‹sealed›");
        }
    };
    for key in sealed_keys {
        if let Some((array, inner)) = nested(key) {
            if let Some(serde_json::Value::Array(items)) = map.get(array) {
                for item in items {
                    scrub(item.get(inner));
                }
            }
        } else {
            scrub(map.get(*key));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_validation_message_quoting_a_secret_is_scrubbed() {
        let input = serde_json::json!({"access_token": "hunter2"});
        let message = "\"hunter2\" is not of type integer";
        let scrubbed = scrub_sealed(message, &["access_token"], &input);
        assert!(!scrubbed.contains("hunter2"));
        assert!(scrubbed.contains("‹sealed›"));
    }

    #[test]
    fn a_secret_inside_an_array_element_is_scrubbed() {
        let input = serde_json::json!({"fields": [{"value": "s3cret"}, {"value": ""}]});
        let scrubbed = scrub_sealed("bad value s3cret", &["fields[].value"], &input);
        assert_eq!(scrubbed, "bad value ‹sealed›");
    }
}
