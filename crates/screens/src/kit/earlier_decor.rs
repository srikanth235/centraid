//! WHAT DECORATES A RECORD, IN AN EARLIER VERSION'S LINE (#1185): its tags, its star, pin and
//! archive, the lists and albums that hold it, the links a member made by hand, what it is about
//! and who it shows. The vault keeps these as part of the record's state (`history::TABLES`) and
//! names a change to one `tag[<id>]`, `flag[<id>]`, `membership[<list>]`, `link[<item>]`,
//! `about[<item>]` or `depicts[<item>]`, so every app's earlier versions word them the same way
//! from this one place, and a version that moved only a tag reads "Not tagged #errand", not "Other
//! details". An id is named by the page's own names (the titles the read carries).

use serde_json::Value;

use super::earlier::{Field, Look};
use crate::strings::{Locale, fill, history as words};

/// The field names this module words.
const ALIASES: [&str; 6] = ["tag", "flag", "membership", "link", "about", "depicts"];

/// One decorating field: which kind, the id it names, and whether this side held it.
struct Held<'a> {
    alias: &'a str,
    id: &'a str,
    held: bool,
}

fn held_of(field: &Field) -> Option<Held<'_>> {
    let (alias, rest) = field.name.split_once('[')?;
    let (id, tail) = rest.split_once(']')?;
    // A column of a row both sides held (`tag[x].position`) says nothing a member reads.
    if !tail.is_empty() || !ALIASES.contains(&alias) {
        return None;
    }
    Some(Held {
        alias,
        id,
        held: !matches!(field.value, Value::Null),
    })
}

fn name(look: &Look, id: &str) -> String {
    look.names
        .get(id)
        .map(|title| title.trim())
        .filter(|title| !title.is_empty())
        .map_or_else(|| words::item_gone(look.locale), str::to_owned)
}

fn flag(locale: Locale, id: &str, held: bool) -> Option<String> {
    Some(match (id.strip_prefix("flag:")?, held) {
        ("starred", true) => words::flag_starred(locale),
        ("pinned", true) => words::flag_pinned(locale),
        ("archived", true) => words::flag_archived(locale),
        ("starred", false) => words::flag_not_starred(locale),
        ("pinned", false) => words::flag_not_pinned(locale),
        ("archived", false) => words::flag_not_archived(locale),
        _ => return None,
    })
}

/// The decorating fields of one side of a version as one line, empty when it holds none.
#[must_use]
pub fn line(look: &Look, fields: &[Field]) -> String {
    let locale = look.locale;
    let all: Vec<Held> = fields.iter().filter_map(held_of).collect();
    let of = |alias: &str, held: bool| -> Vec<&Held> {
        all.iter()
            .filter(|field| field.alias == alias && field.held == held)
            .collect()
    };
    let joined = |fields: Vec<&Held>, word: &dyn Fn(&Held) -> String| -> String {
        fields.into_iter().map(word).collect::<Vec<_>>().join(", ")
    };
    // A tag reads as the member typed it (`#Travel`) when the page names it, else by its key.
    let tag = |field: &Held| {
        let key = field.id.strip_prefix("tag:").unwrap_or(field.id);
        let label = look
            .names
            .get(field.id)
            .map(|title| title.trim())
            .filter(|title| !title.is_empty())
            .unwrap_or(key);
        format!("#{label}")
    };
    let title = |field: &Held| name(look, field.id);
    let mut parts: Vec<String> = Vec::new();
    let held = joined(of("tag", true), &tag);
    if !held.is_empty() {
        parts.push(held);
    }
    let lacked = joined(of("tag", false), &tag);
    if !lacked.is_empty() {
        parts.push(fill(&words::not_tagged(locale), &[("tags", &lacked)]));
    }
    for field in all.iter().filter(|field| field.alias == "flag") {
        parts.extend(flag(locale, field.id, field.held));
    }
    for (alias, held_word, lacking_word, key) in [
        (
            "membership",
            words::in_list as fn(Locale) -> String,
            words::not_in_list as fn(Locale) -> String,
            "names",
        ),
        ("link", words::linked_to, words::not_linked_to, "names"),
        ("about", words::about_names, words::not_about_names, "names"),
        (
            "depicts",
            words::shows_names,
            words::not_shows_names,
            "names",
        ),
    ] {
        for (held, word) in [(true, held_word), (false, lacking_word)] {
            let names = joined(of(alias, held), &title);
            if !names.is_empty() {
                parts.push(fill(&word(locale), &[(key, &names)]));
            }
        }
    }
    parts.join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kit::civil::HourCycle;
    use crate::kit::earlier::Names;
    use crate::kit::quantity::UnitsPref;
    use serde_json::json;

    fn field(name: &str, held: bool) -> Field {
        Field {
            name: name.to_owned(),
            value: if held {
                json!({"rel": "x"})
            } else {
                Value::Null
            },
        }
    }

    fn worded(fields: &[Field], names: &Names) -> String {
        line(
            &Look {
                locale: Locale::En,
                cycle: HourCycle::H24,
                zone: "UTC",
                units: UnitsPref::of_region("GB"),
                names,
            },
            fields,
        )
    }

    #[test]
    fn a_side_holding_tags_a_star_a_list_and_links_reads_each_in_words() {
        let mut names = Names::new();
        names.insert("l1".into(), "Family".into());
        names.insert("tag:home".into(), "Home".into());
        names.insert("n1".into(), "Lisbon trip".into());
        let fields = [
            field("tag[tag:errand]", true),
            field("tag[tag:home]", true),
            field("flag[flag:starred]", true),
            field("membership[l1]", true),
            field("link[n1]", true),
        ];
        assert_eq!(
            worded(&fields, &names),
            "#errand, #Home · Starred · In Family · Linked to Lisbon trip"
        );
    }

    #[test]
    fn a_side_lacking_them_says_so_and_a_gone_item_is_named_as_gone() {
        let fields = [
            field("tag[tag:errand]", false),
            field("flag[flag:pinned]", false),
            field("link[gone]", false),
            field("about[p1].position", true),
            field("entity.title", true),
        ];
        assert_eq!(
            worded(&fields, &Names::new()),
            "Without #errand · Not pinned · Not linked to an item that is gone"
        );
    }

    #[test]
    fn a_version_with_no_decoration_has_no_words() {
        assert_eq!(worded(&[field("person.role", true)], &Names::new()), "");
    }
}
