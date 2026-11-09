//! PEOPLE AS vCARDS (#1173, item 20): the parse of a `.vcf` file (versions 2.1, 3.0 and 4.0 as
//! the phones and the big address books write them) and the file an export writes (3.0).
//!
//! Pure functions. `person.import_vcf` and `person.export_vcf` own what reaches the vault.
//!
//! A card becomes the fields People keeps: a name (FN, else N), a nickname, a role (TITLE,
//! else ORG), a birthday (BDAY, with or without a year) and contact points (TEL, EMAIL, ADR,
//! URL). Everything else a card carries (photos, notes, X- properties) is left where it was:
//! this is an import of people, not a copy of an address book.

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

/// Lines with their folds undone: a line that starts with a space or a tab continues the
/// one before it.
fn unfold(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.replace("\r\n", "\n").replace('\r', "\n").split('\n') {
        if let Some(rest) = raw.strip_prefix([' ', '\t'])
            && let Some(last) = lines.last_mut()
        {
            last.push_str(rest);
        } else {
            lines.push(raw.to_owned());
        }
    }
    lines
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
            parts.last_mut().map(|p| {
                p.push('\\');
                p.push(c);
            });
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == sep {
            parts.push(String::new());
        } else {
            parts.last_mut().map(|p| p.push(c));
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
        .flat_map(|param| {
            let value = param.split_once('=').map_or(param.as_str(), |(_, v)| v);
            value.split(',').map(str::to_owned).collect::<Vec<_>>()
        })
        .map(|label| label.trim().to_lowercase())
        .find(|label| {
            !label.is_empty()
                && !matches!(
                    label.as_str(),
                    "pref" | "internet" | "voice" | "type" | "text"
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
        let value = value.trim();
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
}
