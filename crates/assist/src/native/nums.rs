//! THE `nums:` LINE (#1166, CONTRACT_V3 §10): the numbers of the user's message, read by the runtime so the model names them
//! (`nums[i]`) instead of writing digits, as it names a date with `dates[i]`.
//!
//! The line has the shape of the `dates:` line: `nums: fifty = 50 · 23.50 = 23.5`, a phrase of the message, ` = `, the value,
//! entries joined by ` · `, in the order the message says them. It is in the user block only for a model on the regrouped tools
//! (`Flags::tools` is not S2) and only when the message has a number.
//!
//! An entry is the number and nothing else: the unit stays in the trace (`amount > nums[0] BRL`, `effort = nums[1]`). What is
//! no number here: digits inside a date phrase of the same message (they are a `dates[i]`), a clock time (`9:30`, `9pm`), an
//! ordinal (`2nd`), a handle (`#12`, `@3`), an ISO date, digits that touch a letter (`A4`), and the pronoun `one`.

/// A number the message says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Num {
    /// The words of the message that say it.
    pub phrase: String,
    /// Its value, without separators or trailing zeros.
    pub value: String,
}

const UNITS: [(&str, u64); 19] = [
    ("two", 2),
    ("three", 3),
    ("four", 4),
    ("five", 5),
    ("six", 6),
    ("seven", 7),
    ("eight", 8),
    ("nine", 9),
    ("ten", 10),
    ("eleven", 11),
    ("twelve", 12),
    ("thirteen", 13),
    ("fourteen", 14),
    ("fifteen", 15),
    ("sixteen", 16),
    ("seventeen", 17),
    ("eighteen", 18),
    ("nineteen", 19),
    ("zero", 0),
];
const TENS: [(&str, u64); 8] = [
    ("twenty", 20),
    ("thirty", 30),
    ("forty", 40),
    ("fifty", 50),
    ("sixty", 60),
    ("seventy", 70),
    ("eighty", 80),
    ("ninety", 90),
];

fn small_word(word: &str) -> Option<u64> {
    UNITS
        .iter()
        .find(|(name, _)| *name == word)
        .map(|(_, value)| *value)
}

fn tens_word(word: &str) -> Option<u64> {
    TENS.iter()
        .find(|(name, _)| *name == word)
        .map(|(_, value)| *value)
}

/// `1,200.50` as `1200.5`; `None` when the text is no number.
fn canonical(text: &str) -> Option<String> {
    let plain: String = text.chars().filter(|letter| *letter != ',').collect();
    if plain.is_empty() || plain.starts_with('.') || plain.ends_with('.') {
        return None;
    }
    let (whole, fraction) = plain.split_once('.').unwrap_or((&plain, ""));
    if whole.is_empty()
        || !whole.chars().all(|d| d.is_ascii_digit())
        || !fraction.chars().all(|d| d.is_ascii_digit())
        || whole.len() > 12
    {
        return None;
    }
    let whole = whole.trim_start_matches('0');
    let whole = if whole.is_empty() { "0" } else { whole };
    let fraction = fraction.trim_end_matches('0');
    Some(if fraction.is_empty() {
        whole.to_owned()
    } else {
        format!("{whole}.{fraction}")
    })
}

/// `message` with each of the `date_phrases` (case-insensitive) blanked out.
fn without(message: &str, date_phrases: &[&str]) -> Vec<char> {
    let mut chars: Vec<char> = message.chars().collect();
    let lower: Vec<char> = message.to_lowercase().chars().collect();
    if lower.len() != chars.len() {
        return chars; // a case change moved the offsets: leave the message whole
    }
    for phrase in date_phrases {
        let phrase: Vec<char> = phrase.to_lowercase().chars().collect();
        if phrase.is_empty() {
            continue;
        }
        let mut at = 0;
        while at + phrase.len() <= lower.len() {
            if lower[at..at + phrase.len()] == phrase[..] {
                for letter in &mut chars[at..at + phrase.len()] {
                    *letter = ' ';
                }
                at += phrase.len();
            } else {
                at += 1;
            }
        }
    }
    chars
}

fn is_word_char(letter: char) -> bool {
    letter.is_alphanumeric() || letter == '_'
}

/// The numbers of `message`, in order, outside its `date_phrases`.
#[must_use]
pub fn read_nums(message: &str, date_phrases: &[&str]) -> Vec<Num> {
    let chars = without(message, date_phrases);
    let mut out = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        let letter = chars[at];
        let before = at.checked_sub(1).map(|i| chars[i]);
        if letter.is_ascii_digit()
            && !before.is_some_and(|b| is_word_char(b) || b == '#' || b == '@')
        {
            let start = at;
            let mut end = at;
            while end < chars.len()
                && (chars[end].is_ascii_digit()
                    || chars[end] == ','
                        && chars.get(end + 1).is_some_and(char::is_ascii_digit)
                        && end > start
                    || chars[end] == '.'
                        && chars.get(end + 1).is_some_and(char::is_ascii_digit)
                        && end > start)
            {
                end += 1;
            }
            let text: String = chars[start..end].iter().collect();
            let after = chars.get(end).copied();
            let rest: String = chars[end..]
                .iter()
                .take(3)
                .collect::<String>()
                .to_lowercase();
            let clock = after == Some(':') && chars.get(end + 1).is_some_and(char::is_ascii_digit);
            let meridiem = {
                let trimmed = rest.trim_start();
                trimmed.starts_with("am") || trimmed.starts_with("pm")
            } && !rest
                .trim_start()
                .chars()
                .nth(2)
                .is_some_and(char::is_alphabetic);
            let ordinal = ["st", "nd", "rd", "th"]
                .iter()
                .any(|suffix| rest.starts_with(suffix))
                && !chars.get(end + 2).is_some_and(|c| c.is_alphabetic());
            let iso = matches!(after, Some('-' | '/'))
                && chars.get(end + 1).is_some_and(char::is_ascii_digit);
            let glued = after.is_some_and(|a| a.is_alphabetic() && !matches!(a, 'k' | 'K'))
                || (matches!(after, Some('k' | 'K'))
                    && chars.get(end + 1).is_some_and(|c| is_word_char(*c)));
            if clock || meridiem || ordinal || iso || glued {
                // a clock's minutes, an ISO date's other parts and the like are skipped with their first digits
                let mut skip = end.max(at + 1);
                while skip < chars.len()
                    && (chars[skip].is_ascii_digit() || matches!(chars[skip], ':' | '-' | '/'))
                    && (clock || iso)
                {
                    skip += 1;
                }
                at = skip;
                continue;
            }
            let (phrase, value) = if matches!(after, Some('k' | 'K')) {
                let base = canonical(&text);
                end += 1;
                (
                    chars[start..end].iter().collect::<String>(),
                    base.and_then(|base| times_thousand(&base)),
                )
            } else {
                (text.clone(), canonical(&text))
            };
            if let Some(value) = value {
                out.push(Num { phrase, value });
            }
            at = end;
            continue;
        }
        if letter.is_alphabetic() && !before.is_some_and(is_word_char) {
            let (num, end) = word_number(&chars, at);
            if let Some(num) = num {
                out.push(num);
                at = end;
                continue;
            }
            // skip the word
            while at < chars.len() && is_word_char(chars[at]) {
                at += 1;
            }
            continue;
        }
        at += 1;
    }
    out
}

fn times_thousand(base: &str) -> Option<String> {
    let (whole, fraction) = base.split_once('.').unwrap_or((base, ""));
    if fraction.len() > 3 {
        return None;
    }
    let padded = format!("{fraction:0<3}");
    let joined = format!("{whole}{padded}");
    canonical(&joined)
}

/// The word number that starts at `at`: `fifty`, `twenty-five`, `twenty five`, `two hundred`, `hundred`.
fn word_number(chars: &[char], at: usize) -> (Option<Num>, usize) {
    let mut end = at;
    while end < chars.len() && chars[end].is_alphabetic() {
        end += 1;
    }
    let first: String = chars[at..end].iter().collect::<String>().to_lowercase();
    let mut value;
    if let Some(tens) = tens_word(&first) {
        value = tens;
        // `twenty-five`, `twenty five`
        if matches!(chars.get(end), Some('-' | ' ')) {
            let mut next = end + 1;
            while next < chars.len() && chars[next].is_alphabetic() {
                next += 1;
            }
            let word: String = chars[end + 1..next]
                .iter()
                .collect::<String>()
                .to_lowercase();
            let unit = if word == "one" {
                Some(1)
            } else {
                small_word(&word)
            };
            if let Some(unit) = unit.filter(|unit| *unit < 10 && *unit > 0) {
                value += unit;
                end = next;
            }
        }
    } else if let Some(small) = small_word(&first) {
        value = small;
    } else if first == "hundred" || first == "thousand" {
        let phrase = first.clone();
        let value = if first == "hundred" { 100 } else { 1000 };
        return (
            Some(Num {
                phrase,
                value: value.to_string(),
            }),
            end,
        );
    } else {
        return (None, end);
    }
    // `two hundred`, `five thousand`
    if chars.get(end) == Some(&' ') {
        let mut next = end + 1;
        while next < chars.len() && chars[next].is_alphabetic() {
            next += 1;
        }
        let word: String = chars[end + 1..next]
            .iter()
            .collect::<String>()
            .to_lowercase();
        let factor = match word.as_str() {
            "hundred" => Some(100),
            "thousand" => Some(1000),
            _ => None,
        };
        if let Some(factor) = factor {
            value *= factor;
            end = next;
        }
    }
    let phrase: String = chars[at..end].iter().collect();
    (
        Some(Num {
            phrase,
            value: value.to_string(),
        }),
        end,
    )
}

/// The `nums:` line of a message, `None` when it says no number.
#[must_use]
pub fn nums_line(message: &str, date_phrases: &[&str]) -> Option<String> {
    let nums = read_nums(message, date_phrases);
    if nums.is_empty() {
        return None;
    }
    let parts: Vec<String> = nums
        .iter()
        .map(|num| format!("{} = {}", num.phrase, num.value))
        .collect();
    Some(format!("nums: {}", parts.join(" · ")))
}

/// The values of a `nums:` line, in order.
#[must_use]
pub fn values(line: &str) -> Vec<String> {
    line.strip_prefix("nums:")
        .unwrap_or(line)
        .split(" · ")
        .filter_map(|part| {
            part.rsplit_once(" = ")
                .map(|(_, value)| value.trim().to_owned())
        })
        .collect()
}

/// `text` with each `nums[i]` replaced by the value of entry `i` of `line`.
///
/// # Errors
/// The words of a refusal when an index names no entry (the line is absent, or shorter).
pub fn fill(text: &str, line: Option<&str>) -> Result<String, String> {
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find("nums[") {
        out.push_str(&rest[..at]);
        let after = &rest[at + 5..];
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        if digits.is_empty() || !after[digits.len()..].starts_with(']') {
            out.push_str("nums[");
            rest = after;
            continue;
        }
        let index: usize = digits
            .parse()
            .map_err(|_| format!("nums[{digits}]: no such entry"))?;
        let value = line
            .map(values)
            .and_then(|all| all.get(index).cloned())
            .ok_or_else(|| match line {
                Some(_) => format!("nums[{index}]: the nums line has no entry {index}"),
                None => format!("nums[{index}] needs the nums line"),
            })?;
        out.push_str(&value);
        rest = &after[digits.len() + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(message: &str) -> Option<String> {
        nums_line(message, &[])
    }

    #[test]
    fn a_number_is_its_digits_or_its_words() {
        assert_eq!(
            line("paid 23.50 for lunch, then fifty on the taxi").as_deref(),
            Some("nums: 23.50 = 23.5 · fifty = 50")
        );
        assert_eq!(
            line("1,200 for rent").as_deref(),
            Some("nums: 1,200 = 1200")
        );
        assert_eq!(
            line("twenty-five and twenty five and two hundred").as_deref(),
            Some("nums: twenty-five = 25 · twenty five = 25 · two hundred = 200")
        );
        assert_eq!(line("5k budget").as_deref(), Some("nums: 5k = 5000"));
        assert_eq!(line("$35 for the cab").as_deref(), Some("nums: 35 = 35"));
        assert_eq!(line("move it to the next week"), None);
    }

    #[test]
    fn what_is_no_number_is_left_out() {
        for message in [
            "see me at 9:30",
            "dinner at 9pm",
            "the 2nd of may",
            "task #12 and @3",
            "on 2026-03-20",
            "the A4 form",
            "the one with the cat",
            "no numbers at all",
        ] {
            assert_eq!(line(message), None, "{message}");
        }
    }

    #[test]
    fn digits_inside_a_date_phrase_belong_to_the_dates_line() {
        let message = "lunch on march 5 cost 40";
        assert_eq!(
            nums_line(message, &["march 5"]).as_deref(),
            Some("nums: 40 = 40")
        );
        assert_eq!(
            nums_line(message, &[]).as_deref(),
            Some("nums: 5 = 5 · 40 = 40")
        );
    }

    #[test]
    fn a_nums_reference_is_filled_from_the_line() {
        let line = Some("nums: 23.50 = 23.5 · fifty = 50");
        assert_eq!(
            fill("amount > nums[1] USD", line).unwrap(),
            "amount > 50 USD"
        );
        assert_eq!(
            fill("effort = nums[0] · name = x", line).unwrap(),
            "effort = 23.5 · name = x"
        );
        assert_eq!(fill("no reference", None).unwrap(), "no reference");
        assert!(fill("amount > nums[2]", line).is_err());
        assert!(fill("amount > nums[0]", None).is_err());
        assert_eq!(fill("a nums[x] b", line).unwrap(), "a nums[x] b");
    }
}
