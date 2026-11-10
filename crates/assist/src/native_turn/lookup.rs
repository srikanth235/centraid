//! An explicit, exact-title Find has no ambiguity for a model to judge. Run the ordinary
//! read tools in two bounded steps. Anything ambiguous or qualified stays with the model.

use crate::native::Session;

pub(super) fn calls(session: &Session, message: &str) -> Vec<String> {
    let Some((verb, name)) = message.trim().split_once(' ') else {
        return Vec::new();
    };
    if !verb.eq_ignore_ascii_case("find") {
        return Vec::new();
    }
    let name = name.trim();
    let name = name.strip_prefix("the ").unwrap_or(name);
    if name.contains(['<', '>', '\n', '\r']) {
        return Vec::new();
    }
    let mut matches =
        session.world.rows.values().filter(|row| {
            !row.trashed && !row.name.is_empty() && row.name.eq_ignore_ascii_case(name)
        });
    let Some(row) = matches.next() else {
        return Vec::new();
    };
    if matches.next().is_some() {
        return Vec::new();
    }
    vec![
        format!(
            "<tool_call>\n<function=find>\n<parameter=kind>\n{}\n</parameter>\n<parameter=name>\n{}\n</parameter>\n</function>\n</tool_call>",
            row.kind.name(),
            row.name
        ),
        format!(
            "<tool_call>\n<function=answer>\n<parameter=rows>\n@{}\n</parameter>\n</function>\n</tool_call>",
            session.results.len() + 1
        ),
    ]
}
