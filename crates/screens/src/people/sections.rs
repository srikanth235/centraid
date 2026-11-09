//! A TO Z (#1173): the roster's rows in letter sections, and the index beside them. Pure.
//!
//! The core hands the rows over in name order (case-insensitive, ties by id), which puts a
//! name that starts with a digit before "A" and an accented or non-Latin one after "Z".
//! Cutting that stream where the first letter changes would give two "#" sections and a second
//! "E" for "Émile". So the rows are BUCKETED by letter, then the buckets are put in order: A
//! to Z, then "#". Inside a bucket the core's order stays.
//!
//! A name's letter is its first character, Latin letters with their accents folded to the
//! base letter (a small table: no Unicode dependency). A name that starts with anything else
//! (a digit, a symbol, a non-Latin script) or with nothing at all is "#".

use std::collections::BTreeMap;

use centraid_api_proto::core_v1 as wire;

use crate::strings::{Locale, fill, people as words};

/// The bucket of names that start with no Latin letter.
pub const OTHER: &str = "#";

/// A TO Z, then the other bucket: the index's letters, in the order they are drawn.
const LETTERS: [char; 26] = [
    'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S',
    'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
];

/// The base letter of an accented Latin capital, for the Latin-1 and Latin Extended-A
/// letters; none for anything else.
fn base_of(upper: char) -> Option<char> {
    Some(match upper {
        'A'..='Z' => upper,
        'À'..='Å' | 'Ā' | 'Ă' | 'Ą' | 'Æ' => 'A',
        'Ç' | 'Ć' | 'Ĉ' | 'Ċ' | 'Č' => 'C',
        'Ď' | 'Đ' | 'Ð' => 'D',
        'È'..='Ë' | 'Ē' | 'Ĕ' | 'Ė' | 'Ę' | 'Ě' => 'E',
        'Ĝ' | 'Ğ' | 'Ġ' | 'Ģ' => 'G',
        'Ĥ' | 'Ħ' => 'H',
        'Ì'..='Ï' | 'Ĩ' | 'Ī' | 'Ĭ' | 'Į' | 'İ' => 'I',
        'Ĵ' => 'J',
        'Ķ' => 'K',
        'Ĺ' | 'Ļ' | 'Ľ' | 'Ŀ' | 'Ł' => 'L',
        'Ñ' | 'Ń' | 'Ņ' | 'Ň' => 'N',
        'Ò'..='Ö' | 'Ø' | 'Ō' | 'Ŏ' | 'Ő' | 'Œ' => 'O',
        'Ŕ' | 'Ŗ' | 'Ř' => 'R',
        'Ś' | 'Ŝ' | 'Ş' | 'Š' => 'S',
        'Ţ' | 'Ť' | 'Ŧ' | 'Þ' => 'T',
        'Ù'..='Ü' | 'Ũ' | 'Ū' | 'Ŭ' | 'Ů' | 'Ű' | 'Ų' => 'U',
        'Ŵ' => 'W',
        'Ý' | 'Ŷ' | 'Ÿ' => 'Y',
        'Ź' | 'Ż' | 'Ž' => 'Z',
        _ => return None,
    })
}

/// A name's section key: "A" to "Z", or "#".
#[must_use]
pub fn key_of(name: &str) -> String {
    name.trim()
        .chars()
        .next()
        // `to_uppercase` of "ß" is "SS": its first letter is the one that files it.
        .and_then(|first| first.to_uppercase().next())
        .and_then(base_of)
        .map_or_else(|| OTHER.to_owned(), |letter| letter.to_string())
}

fn title_of(locale: Locale, key: &str) -> String {
    if key == OTHER {
        words::index_other(locale)
    } else {
        key.to_owned()
    }
}

/// The rows in sections, and the index. Both are empty for no rows (there is nothing to
/// jump to); otherwise the index holds every letter, "#" last.
#[must_use]
pub fn sectioned(
    locale: Locale,
    rows: Vec<wire::PeopleRow>,
) -> (Vec<wire::PeopleSection>, Vec<wire::PeopleIndexLetter>) {
    if rows.is_empty() {
        return (Vec::new(), Vec::new());
    }
    let mut buckets: BTreeMap<String, Vec<wire::PeopleRow>> = BTreeMap::new();
    for row in rows {
        buckets.entry(key_of(&row.name)).or_default().push(row);
    }
    // A to Z sort as text; "#" sorts before "A", so it is moved to the end.
    let mut keys: Vec<String> = buckets.keys().cloned().collect();
    if let Some(at) = keys.iter().position(|key| key == OTHER) {
        let other = keys.remove(at);
        keys.push(other);
    }
    let index = index(locale, &keys);
    let sections = keys
        .into_iter()
        .filter_map(|key| {
            Some(wire::PeopleSection {
                title: title_of(locale, &key),
                rows: buckets.remove(&key)?,
                key,
            })
        })
        .collect();
    (sections, index)
}

/// The index over the sections' keys (in section order): every letter A to Z and "#", each
/// jumping to its own section, or to the next one that has people (the last for a letter
/// past the end). "#" jumps to its own section, or to the last.
fn index(locale: Locale, keys: &[String]) -> Vec<wire::PeopleIndexLetter> {
    let last = keys.last().cloned().unwrap_or_default();
    let jump = |letter: &str| -> (String, bool) {
        if keys.iter().any(|key| key == letter) {
            return (letter.to_owned(), true);
        }
        let next = keys
            .iter()
            .find(|key| key.as_str() != OTHER && key.as_str() > letter);
        (next.cloned().unwrap_or_else(|| last.clone()), false)
    };
    LETTERS
        .iter()
        .map(|letter| letter.to_string())
        .map(|letter| {
            let (section_key, has_rows) = jump(&letter);
            wire::PeopleIndexLetter {
                accessibility_label: fill(&words::index_a11y(locale), &[("letter", &letter)]),
                letter,
                section_key,
                has_rows,
            }
        })
        .chain(std::iter::once({
            let has_rows = keys.iter().any(|key| key == OTHER);
            wire::PeopleIndexLetter {
                letter: words::index_other(locale),
                section_key: if has_rows {
                    OTHER.to_owned()
                } else {
                    last.clone()
                },
                has_rows,
                accessibility_label: words::index_other_a11y(locale),
            }
        }))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const EN: Locale = Locale::En;

    fn row(name: &str) -> wire::PeopleRow {
        wire::PeopleRow {
            party_id: format!("id-{name}"),
            name: name.to_owned(),
            ..wire::PeopleRow::default()
        }
    }

    fn names(section: &wire::PeopleSection) -> Vec<&str> {
        section.rows.iter().map(|row| row.name.as_str()).collect()
    }

    #[test]
    fn a_letter_is_the_first_character_with_its_accent_folded() {
        for (name, key) in [
            ("Ada", "A"),
            ("ada", "A"),
            ("  bea", "B"),
            ("Émile", "E"),
            ("élodie", "E"),
            ("Ana Díaz", "A"),
            ("Øystein", "O"),
            ("Łukasz", "L"),
            ("Çağla", "C"),
            ("Šárka", "S"),
            ("ßeta", "S"),
            ("Ünal", "U"),
        ] {
            assert_eq!(key_of(name), key, "{name}");
        }
    }

    #[test]
    fn a_name_with_no_latin_letter_first_is_other() {
        for name in [
            "",
            "   ",
            "1st Aid",
            "007",
            "(work)",
            "Дана",
            "田中",
            "محمد",
            "अनु",
            "😀 Joy",
            "-",
        ] {
            assert_eq!(key_of(name), OTHER, "{name:?}");
        }
    }

    #[test]
    fn the_core_s_order_is_bucketed_not_split() {
        // The core's name order: digits first, then A to Z, then accented and non-Latin.
        let stream = [
            "1st Aid", "Ada", "Ed", "Eve", "Zed", "Émile", "Дана", "", "Bea", "Alan",
        ]
        .map(row)
        .to_vec();
        let (sections, _) = sectioned(EN, stream);
        let keys: Vec<&str> = sections.iter().map(|s| s.key.as_str()).collect();
        assert_eq!(
            keys,
            ["A", "B", "E", "Z", "#"],
            "one section per letter, # last"
        );
        assert_eq!(
            names(&sections[0]),
            ["Ada", "Alan"],
            "the core's order inside a bucket"
        );
        assert_eq!(
            names(&sections[2]),
            ["Ed", "Eve", "Émile"],
            "an accent joins its letter"
        );
        assert_eq!(names(&sections[4]), ["1st Aid", "Дана", ""]);
        assert_eq!(
            sections.iter().map(|s| s.rows.len()).sum::<usize>(),
            10,
            "every row is in exactly one section"
        );
        assert_eq!(sections[4].title, "#");
    }

    #[test]
    fn the_index_has_every_letter_and_jumps_to_the_next_section() {
        let (sections, index) = sectioned(EN, ["Ada", "Dana", "Mum", "9 lives"].map(row).to_vec());
        let letters: Vec<&str> = index.iter().map(|l| l.letter.as_str()).collect();
        assert_eq!(letters.len(), 27);
        assert_eq!(letters[0], "A");
        assert_eq!(letters[25], "Z");
        assert_eq!(letters[26], "#", "# is last");
        let of = |letter: &str| index.iter().find(|l| l.letter == letter).unwrap();
        // A letter with people jumps to its own section.
        for letter in ["A", "D", "M", "#"] {
            assert!(of(letter).has_rows, "{letter}");
            assert_eq!(of(letter).section_key, letter);
        }
        // One with none is dim, and jumps to the next section that has people.
        for (letter, to) in [("B", "D"), ("C", "D"), ("E", "M"), ("L", "M")] {
            assert!(!of(letter).has_rows, "{letter}");
            assert_eq!(of(letter).section_key, to, "{letter}");
        }
        // Past the last letter with people, to the last section; never to the # section's
        // place before A.
        assert_eq!(of("Z").section_key, "#");
        assert!(!of("Z").has_rows);
        assert_eq!(sections.last().unwrap().key, "#");
        assert_eq!(of("A").accessibility_label, "Jump to A");
    }

    #[test]
    fn no_other_bucket_means_a_dim_hash_that_goes_to_the_last_section() {
        let (_, index) = sectioned(EN, ["Ada", "Mum"].map(row).to_vec());
        let hash = index.last().unwrap();
        assert!((hash.letter.as_str(), hash.has_rows) == ("#", false));
        assert_eq!(hash.section_key, "M");
        assert_eq!(
            index.iter().find(|l| l.letter == "Z").unwrap().section_key,
            "M"
        );
    }

    #[test]
    fn nobody_is_no_sections_and_no_index() {
        let (sections, index) = sectioned(EN, Vec::new());
        assert!(sections.is_empty() && index.is_empty());
    }

    #[test]
    fn only_other_names_is_one_hash_section() {
        let (sections, index) = sectioned(EN, ["Дана", "田中"].map(row).to_vec());
        assert_eq!(sections.len(), 1);
        assert_eq!(sections[0].key, "#");
        assert_eq!(index.iter().filter(|l| l.has_rows).count(), 1);
        // Every letter jumps to the only section there is.
        assert!(index.iter().all(|l| l.section_key == "#"));
    }
}
