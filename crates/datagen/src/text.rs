//! Name arithmetic shared by the generator (making a near twin) and the ambiguity measure
//! (finding one), so what one makes the other counts.

use crate::rng::Rng;

/// Lowercase letters and digits, words joined by one space.
#[must_use]
pub fn normalize(name: &str) -> String {
    name.split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect::<Vec<_>>()
        .join(" ")
}

#[must_use]
pub fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = (diagonal + usize::from(ca != cb))
                .min(above + 1)
                .min(row[j] + 1);
            diagonal = above;
        }
    }
    row[b.len()]
}

/// Whether `levenshtein(a, b) <= 2`, without filling the table when the answer is plain: the
/// common ends cost nothing, and a row whose every cell is past two ends the work.
fn within_two(a: &str, b: &str) -> bool {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let lead = a.iter().zip(&b).take_while(|(x, y)| x == y).count();
    let (a, b) = (&a[lead..], &b[lead..]);
    let tail = a
        .iter()
        .rev()
        .zip(b.iter().rev())
        .take_while(|(x, y)| x == y)
        .count();
    let (a, b) = (&a[..a.len() - tail], &b[..b.len() - tail]);
    if a.len().abs_diff(b.len()) > 2 {
        return false;
    }
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = (diagonal + usize::from(ca != cb))
                .min(above + 1)
                .min(row[j] + 1);
            diagonal = above;
        }
        // every later row is at least this row's smallest cell
        if row.iter().all(|&cell| cell > 2) {
            return false;
        }
    }
    row[b.len()] <= 2
}

/// Whether two names are different but one slip, one initial or one extra word apart: the pairs
/// a person would read as "the same thing, twice".
#[must_use]
pub fn near_duplicates(a: &str, b: &str) -> bool {
    near_duplicates_normalized(&normalize(a), &normalize(b))
}

/// [`near_duplicates`] of two names already passed through [`normalize`], for a caller that
/// compares one name against many and normalizes each once.
#[must_use]
pub fn near_duplicates_normalized(a: &str, b: &str) -> bool {
    if a == b || a.is_empty() || b.is_empty() {
        return false;
    }
    let (len_a, len_b) = (a.chars().count(), b.chars().count());
    // the distance is at least the difference in length, so a wider gap needs no table
    if len_a.min(len_b) >= 4 && len_a.abs_diff(len_b) <= 2 && within_two(a, b) {
        return true;
    }
    // words are single-space separated: the longer has exactly one more word, and the shorter's
    // words lead it
    let (short, long) = if a.split(' ').count() <= b.split(' ').count() {
        (a, b)
    } else {
        (b, a)
    };
    long.strip_prefix(short)
        .and_then(|rest| rest.strip_prefix(' '))
        .is_some_and(|extra| !extra.contains(' '))
}

/// A near twin of `name`: one deleted, doubled or swapped letter, a trailing number or word, or
/// a first name cut to its initial. Always different from `name` and always
/// [`near_duplicates`] of it.
pub fn twin(rng: &mut Rng, name: &str) -> String {
    for _ in 0..8 {
        let chars: Vec<char> = name.chars().collect();
        let letters: Vec<usize> = chars
            .iter()
            .enumerate()
            .filter(|(i, c)| c.is_alphabetic() && *i > 0)
            .map(|(i, _)| i)
            .collect();
        let candidate = match rng.below(5) {
            0 if chars.len() >= 5 && !letters.is_empty() => {
                let at = *rng.pick(&letters);
                chars
                    .iter()
                    .enumerate()
                    .filter(|(i, _)| *i != at)
                    .map(|(_, c)| *c)
                    .collect()
            }
            1 if !letters.is_empty() => {
                let at = *rng.pick(&letters);
                let mut out = chars.clone();
                out.insert(at, chars[at]);
                out.into_iter().collect()
            }
            2 if letters.len() >= 2 => {
                let at = *rng.pick(&letters);
                let mut out = chars.clone();
                if at + 1 < out.len() && out[at].is_alphabetic() && out[at + 1].is_alphabetic() {
                    out.swap(at, at + 1);
                }
                out.into_iter().collect()
            }
            3 => format!("{name} 2"),
            _ => format!("{name} {}", rng.pick(&["old", "new", "again", "copy"])),
        };
        if near_duplicates(name, &candidate) {
            return candidate;
        }
    }
    format!("{name} 2")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_twin_is_near_and_never_equal() {
        let mut rng = Rng::new(3);
        for name in ["Neha Rao", "Dentist", "Whole Foods", "Pasta sauce"] {
            for _ in 0..50 {
                let other = twin(&mut rng, name);
                assert_ne!(normalize(&other), normalize(name), "{other}");
                assert!(near_duplicates(name, &other), "{name} / {other}");
            }
        }
    }

    #[test]
    fn unrelated_names_are_not_near() {
        assert!(!near_duplicates("Dentist", "Passport"));
        assert!(!near_duplicates("Neha Rao", "Neha Kulkarni"));
        assert!(!near_duplicates("Lunch with Neha", "Lunch with Ravi Singh"));
    }
}
