//! PEOPLE AS vCARDS (#1173, item 20): the parse of a `.vcf` file (versions 2.1, 3.0 and 4.0 as
//! the phones and the big address books write them) and the file an export writes (3.0).
//!
//! Pure functions. `person.import_vcf` and `person.export_vcf` own what reaches the vault.
//!
//! A card becomes the fields People keeps: a name (FN, else N), a nickname, a role (TITLE,
//! else ORG), a birthday (BDAY, with or without a year) and contact points (TEL, EMAIL, ADR,
//! URL). Everything else a card carries (photos, notes, X- properties) is left where it was:
//! this is an import of people, not a copy of an address book.
//!
//! **Version 2.1's QUOTED-PRINTABLE is read** (#1202): the phones and old books that write
//! `FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E3=81=82` and wrap a long value with a trailing
//! `=`. A property so encoded is unfolded at its soft breaks, decoded to bytes, and read in the
//! charset it names (UTF-8 when it names none, windows-1252 when the bytes are not that).

use crate::decode;

/// The most contact points one card keeps: a card with a million `TEL` lines is not a person.
pub const MAX_POINTS: usize = 50;

/// One contact point of a card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Point {
    pub kind: &'static str,
    pub value: String,
    pub label: Option<String>,
}

/// One card, read.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Card {
    pub name: String,
    pub nickname: Option<String>,
    pub role: Option<String>,
    pub birthday: Option<String>,
    pub points: Vec<Point>,
}

/// Whether a line's property carries `ENCODING=QUOTED-PRINTABLE` (or the 2.1 bare form).
fn is_quoted_printable(line: &str) -> bool {
    line.split_once(':')
        .is_some_and(|(head, _)| head.to_ascii_uppercase().contains("QUOTED-PRINTABLE"))
}

/// Lines with their folds undone: a line that starts with a space or a tab continues the
/// one before it, and a quoted-printable line that ends in `=` continues on the next line, the
/// `=` dropped.
fn unfold(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut soft = false;
    for raw in text.replace("\r\n", "\n").replace('\r', "\n").split('\n') {
        if soft && let Some(last) = lines.last_mut() {
            last.push_str(raw);
        } else if let Some(rest) = raw.strip_prefix([' ', '\t'])
            && let Some(last) = lines.last_mut()
        {
            last.push_str(rest);
        } else {
            lines.push(raw.to_owned());
        }
        soft = false;
        if let Some(last) = lines.last_mut()
            && last.ends_with('=')
            && is_quoted_printable(last)
        {
            last.pop();
            soft = true;
        }
    }
    lines
}

/// A quoted-printable value as bytes: `=XX` is a byte, anything else stands for itself.
fn quoted_printable(value: &str) -> Vec<u8> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut at = 0;
    while at < bytes.len() {
        let hex = |byte: u8| {
            char::from(byte)
                .to_digit(16)
                .and_then(|d| u8::try_from(d).ok())
        };
        if bytes[at] == b'='
            && at + 2 < bytes.len()
            && let (Some(high), Some(low)) = (hex(bytes[at + 1]), hex(bytes[at + 2]))
        {
            out.push(high * 16 + low);
            at += 3;
        } else {
            out.push(bytes[at]);
            at += 1;
        }
    }
    out
}

/// The `CHARSET=` parameter of a property, if it names one.
fn charset_of(params: &[String]) -> Option<&str> {
    params.iter().find_map(|param| {
        let (name, value) = param.split_once('=')?;
        name.trim().eq_ignore_ascii_case("CHARSET").then_some(value)
    })
}

/// A property's value as text: quoted-printable decoded and read in its charset when the
/// property says so, else as it is.
fn value_of(params: &[String], value: &str) -> String {
    let encoded = params.iter().any(|param| {
        let upper = param.trim().to_ascii_uppercase();
        upper == "QUOTED-PRINTABLE" || upper == "ENCODING=QUOTED-PRINTABLE"
    });
    if encoded {
        decode::text_in(&quoted_printable(value), charset_of(params))
    } else {
        value.to_owned()
    }
}

fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n' | 'N') => out.push('\n'),
                Some(other) => out.push(other),
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// A value's components split at an unescaped `sep`.
fn split_unescaped(value: &str, sep: char) -> Vec<String> {
    let mut parts = vec![String::new()];
    let mut escaped = false;
    for c in value.chars() {
        if escaped {
            if let Some(part) = parts.last_mut() {
                part.push('\\');
                part.push(c);
            }
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == sep {
            parts.push(String::new());
        } else {
            if let Some(part) = parts.last_mut() {
                part.push(c);
            }
        }
    }
    parts.iter().map(|part| unescape(part)).collect()
}

/// `1990-05-17`, `19900517` and `--0517` / `--05-17` as the vault's `YYYY-MM-DD` and `MM-DD`.
#[must_use]
pub fn birthday_of(raw: &str) -> Option<String> {
    let raw = raw.trim();
    let digits: String = raw.chars().filter(char::is_ascii_digit).collect();
    let (year, month, day) = match (raw.starts_with("--"), digits.len()) {
        (true, 4) => (None, &digits[..2], &digits[2..4]),
        (false, n) if n >= 8 => (Some(&digits[..4]), &digits[4..6], &digits[6..8]),
        _ => return None,
    };
    let (m, d): (u32, u32) = (month.parse().ok()?, day.parse().ok()?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    // A year of 1604 is the placeholder some books write for "no year".
    match year {
        Some(year) if year != "1604" && year != "0000" => Some(format!("{year}-{month}-{day}")),
        _ => Some(format!("{month}-{day}")),
    }
}

fn label_of(params: &[String]) -> Option<String> {
    params
        .iter()
        // How the value is written is not what the point is (`CHARSET=UTF-8`, `ENCODING=...`).
        .filter(|param| {
            let name = param.split_once('=').map_or("", |(name, _)| name.trim());
            !["CHARSET", "ENCODING", "LANGUAGE", "VALUE"]
                .iter()
                .any(|skip| name.eq_ignore_ascii_case(skip))
        })
        .flat_map(|param| {
            let value = param.split_once('=').map_or(param.as_str(), |(_, v)| v);
            value.split(',').map(str::to_owned).collect::<Vec<_>>()
        })
        .map(|label| label.trim().to_lowercase())
        .find(|label| {
            !label.is_empty()
                && !matches!(
                    label.as_str(),
                    "pref"
                        | "internet"
                        | "voice"
                        | "type"
                        | "text"
                        | "quoted-printable"
                        | "base64"
                        | "8bit"
                )
        })
}

/// Every card in a file's text.
#[must_use]
pub fn parse(text: &str) -> Vec<Card> {
    let mut cards = Vec::new();
    let mut current: Option<Card> = None;
    let mut structured: Option<Vec<String>> = None;
    let mut title: Option<String> = None;
    let mut org: Option<String> = None;
    for line in unfold(text.strip_prefix('\u{feff}').unwrap_or(text)) {
        let upper = line.trim().to_ascii_uppercase();
        if upper == "BEGIN:VCARD" {
            current = Some(Card::default());
            structured = None;
            title = None;
            org = None;
            continue;
        }
        if upper == "END:VCARD" {
            if let Some(mut card) = current.take() {
                if card.name.trim().is_empty() {
                    // N is family;given;additional;prefix;suffix.
                    card.name = structured
                        .take()
                        .map(|n| {
                            [n.get(3), n.get(1), n.get(2), n.first(), n.get(4)]
                                .into_iter()
                                .flatten()
                                .map(|part| part.trim())
                                .filter(|part| !part.is_empty())
                                .collect::<Vec<_>>()
                                .join(" ")
                        })
                        .unwrap_or_default();
                }
                card.role = title.take().or(org.take()).filter(|r| !r.trim().is_empty());
                card.points.truncate(MAX_POINTS);
                if !card.name.trim().is_empty() {
                    cards.push(card);
                }
            }
            continue;
        }
        let Some(card) = current.as_mut() else {
            continue;
        };
        let Some((head, value)) = line.split_once(':') else {
            continue;
        };
        let mut head_parts = head.split(';');
        let property = head_parts
            .next()
            .unwrap_or_default()
            .rsplit('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        let params: Vec<String> = head_parts.map(str::to_owned).collect();
        let decoded = value_of(&params, value);
        let value = decoded.trim();
        if value.is_empty() {
            continue;
        }
        match property.as_str() {
            "FN" => card.name = unescape(value).trim().to_owned(),
            "N" => structured = Some(split_unescaped(value, ';')),
            "NICKNAME" => {
                card.nickname = Some(unescape(value).trim().to_owned()).filter(|n| !n.is_empty());
            }
            "TITLE" => title = Some(unescape(value).trim().to_owned()),
            "ORG" => {
                org = Some(
                    split_unescaped(value, ';')
                        .into_iter()
                        .find(|part| !part.trim().is_empty())
                        .unwrap_or_default()
                        .trim()
                        .to_owned(),
                );
            }
            "BDAY" => card.birthday = birthday_of(value),
            "TEL" => card.points.push(Point {
                kind: "phone",
                value: unescape(value.strip_prefix("tel:").unwrap_or(value))
                    .trim()
                    .to_owned(),
                label: label_of(&params),
            }),
            "EMAIL" => card.points.push(Point {
                kind: "email",
                value: unescape(value).trim().to_owned(),
                label: label_of(&params),
            }),
            "URL" => card.points.push(Point {
                kind: "url",
                value: unescape(value).trim().to_owned(),
                label: label_of(&params),
            }),
            "ADR" => {
                let joined = split_unescaped(value, ';')
                    .into_iter()
                    .map(|part| part.trim().to_owned())
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join(", ");
                if !joined.is_empty() {
                    card.points.push(Point {
                        kind: "address",
                        value: joined,
                        label: label_of(&params),
                    });
                }
            }
            _ => {}
        }
    }
    cards
}

// ---------------------------------------------------------------------------
// The file an export writes
// ---------------------------------------------------------------------------

fn escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace(';', "\\;")
        .replace(',', "\\,")
        .replace('\r', "")
        .replace('\n', "\\n")
}

/// One property line, folded at 75 octets as the format asks.
fn fold(line: &str) -> String {
    let mut out = String::new();
    let mut width = 0;
    for c in line.chars() {
        let size = c.len_utf8();
        if width + size > 75 {
            out.push_str("\r\n ");
            width = 1;
        }
        out.push(c);
        width += size;
    }
    out.push_str("\r\n");
    out
}

/// One card of an export, version 3.0.
#[must_use]
pub fn write(card: &Card) -> String {
    let mut out = String::from("BEGIN:VCARD\r\nVERSION:3.0\r\n");
    out.push_str(&fold(&format!("FN:{}", escape(&card.name))));
    out.push_str(&fold(&format!("N:{};;;;", escape(&card.name))));
    if let Some(nick) = &card.nickname {
        out.push_str(&fold(&format!("NICKNAME:{}", escape(nick))));
    }
    if let Some(role) = &card.role {
        out.push_str(&fold(&format!("TITLE:{}", escape(role))));
    }
    if let Some(birthday) = &card.birthday {
        out.push_str(&fold(&format!(
            "BDAY:{}",
            if birthday.len() == 5 {
                format!("--{birthday}")
            } else {
                birthday.clone()
            }
        )));
    }
    for point in &card.points {
        let property = match point.kind {
            "phone" => "TEL",
            "email" => "EMAIL",
            "address" => "ADR",
            "url" => "URL",
            _ => continue,
        };
        let params = point
            .label
            .as_ref()
            .map(|label| format!(";TYPE={}", label.replace([';', ':', ',', '"'], "")))
            .unwrap_or_default();
        let value = if point.kind == "address" {
            format!(";;{}", escape(&point.value))
        } else {
            escape(&point.value)
        };
        out.push_str(&fold(&format!("{property}{params}:{value}")));
    }
    out.push_str("END:VCARD\r\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Maya Rao\r\nN:Rao;Maya;;;\r\nNICKNAME:May\r\nORG:Acme;Sales\r\nTITLE:Designer\r\nBDAY:1990-05-17\r\nTEL;TYPE=CELL,VOICE:+1 (555) 010-0100\r\nEMAIL;TYPE=INTERNET,WORK:maya@example.com\r\nADR;TYPE=HOME:;;1 Main St;Springfield;;12345;US\r\nNOTE:long note that\r\n  continues\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:2.1\r\nN:Doe;Jo;;Dr.;\r\nBDAY:--0301\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD\r\n";

    #[test]
    fn two_cards_are_read_and_a_nameless_one_is_not() {
        let cards = parse(SAMPLE);
        assert_eq!(cards.len(), 2);
        let maya = &cards[0];
        assert_eq!(maya.name, "Maya Rao");
        assert_eq!(maya.nickname.as_deref(), Some("May"));
        assert_eq!(maya.role.as_deref(), Some("Designer"));
        assert_eq!(maya.birthday.as_deref(), Some("1990-05-17"));
        assert_eq!(
            maya.points
                .iter()
                .map(|p| (p.kind, p.value.as_str(), p.label.as_deref()))
                .collect::<Vec<_>>(),
            [
                ("phone", "+1 (555) 010-0100", Some("cell")),
                ("email", "maya@example.com", Some("work")),
                ("address", "1 Main St, Springfield, 12345, US", Some("home")),
            ]
        );
        assert_eq!(cards[1].name, "Dr. Jo Doe");
        assert_eq!(cards[1].birthday.as_deref(), Some("03-01"));
    }

    #[test]
    fn what_is_written_is_read_back() {
        let cards = parse(SAMPLE);
        let text: String = cards.iter().map(write).collect();
        assert_eq!(parse(&text), cards);
        assert!(text.contains("BDAY:--03-01"), "{text}");
    }

    #[test]
    fn birthdays_with_and_without_a_year() {
        assert_eq!(birthday_of("19900517").as_deref(), Some("1990-05-17"));
        assert_eq!(birthday_of("1604-05-17").as_deref(), Some("05-17"));
        assert_eq!(birthday_of("--0517").as_deref(), Some("05-17"));
        assert_eq!(birthday_of("1990-13-01"), None);
        assert_eq!(birthday_of("soon"), None);
    }

    #[test]
    fn long_lines_fold_and_unfold() {
        let long = Card {
            name: "A".repeat(200),
            ..Card::default()
        };
        let text = write(&long);
        assert!(text.lines().all(|line| line.len() <= 76));
        assert_eq!(parse(&text)[0].name, long.name);
    }

    #[test]
    fn a_2_1_card_in_quoted_printable_is_decoded() {
        let text = "BEGIN:VCARD\r\nVERSION:2.1\r\nN;ENCODING=QUOTED-PRINTABLE:=C3=89milie;Dupont;;;\r\nFN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E3=81=82=E3=81=84=\r\n=E3=81=86\r\nTEL;CELL:+33 6 12 34 56 78\r\nADR;HOME;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:;;3 rue de l'=C9glise;Lyon;;69001;France\r\nEND:VCARD\r\nBEGIN:VCARD\r\nVERSION:2.1\r\nN;ENCODING=QUOTED-PRINTABLE:Dupont;=C9milie;;;\r\nEND:VCARD\r\n";
        let cards = parse(text);
        assert_eq!(cards.len(), 2);
        assert_eq!(
            cards[0].name, "あいう",
            "FN wins over N, and its soft break is joined"
        );
        assert_eq!(cards[0].points[0].label.as_deref(), Some("cell"));
        assert_eq!(
            cards[0].points[1].value,
            "3 rue de l'Église, Lyon, 69001, France"
        );
        assert_eq!(
            cards[0].points[1].label.as_deref(),
            Some("home"),
            "CHARSET and ENCODING are not the point's label"
        );
        assert_eq!(
            cards[1].name, "Émilie Dupont",
            "invalid UTF-8 falls back to windows-1252"
        );
    }

    #[test]
    fn a_card_with_more_points_than_a_person_has_keeps_the_first_fifty() {
        let mut text = String::from("BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Many\r\n");
        for n in 0..500 {
            text.push_str(&format!("TEL:+1 555 {n:04}\r\n"));
        }
        text.push_str("END:VCARD\r\n");
        assert_eq!(parse(&text)[0].points.len(), MAX_POINTS);
    }
}
