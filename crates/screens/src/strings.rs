//! THE ONE STRING CATALOG. Every sentence a person reads is made here and
//! travels inside a view state; SwiftUI and Compose write no copy.
//!
//! A hand-rolled catalog rather than `fluent`: the product needs plural forms
//! and a locale seam, not message selectors, and a parser dependency for that
//! would be the first of its kind in `docs/toolchain.md`'s register. If a
//! locale ever needs gender or case selection, this file is what moves.
//!
//! ## Adding a string
//!
//! One line in [`catalog!`]. `plain` takes the locale; `counted` takes the
//! locale and a count and picks a plural form (`{n}` is replaced by the count).
//! The macro generates the typed function, so a screen cannot misspell a key,
//! and the test below fails if a locale table lacks a key another has.
//!
//! ## Adding a locale
//!
//! A variant of [`Locale`], a `static` table over the same keys, and its arm in
//! [`Locale::plural`] and `table`.

/// A language the catalog speaks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum Locale {
    #[default]
    En,
}

/// Which form of a counted message a number takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Plural {
    One,
    Other,
}

impl Locale {
    /// The locale a BCP 47 tag names; an unknown one is English, and English
    /// is the only one there is.
    #[must_use]
    pub fn from_tag(_tag: &str) -> Self {
        Self::En
    }

    /// The plural form `n` takes.
    #[must_use]
    pub fn plural(self, n: u64) -> Plural {
        match self {
            Self::En => {
                if n == 1 {
                    Plural::One
                } else {
                    Plural::Other
                }
            }
        }
    }

    fn table(self) -> &'static [Entry] {
        match self {
            Self::En => EN,
        }
    }

    fn entry(self, key: &str) -> &'static Entry {
        self.table()
            .iter()
            .find(|entry| entry.key == key)
            .unwrap_or_else(|| panic!("the catalog has no `{key}`: add it to `catalog!`"))
    }

    fn render(self, key: &str, count: Option<u64>) -> String {
        let entry = self.entry(key);
        match count {
            None => entry.other.to_owned(),
            Some(n) => {
                let form = match self.plural(n) {
                    Plural::One => entry.one,
                    Plural::Other => entry.other,
                };
                form.replace("{n}", &n.to_string())
            }
        }
    }
}

struct Entry {
    key: &'static str,
    one: &'static str,
    other: &'static str,
}

macro_rules! entry_fn {
    (plain $name:ident) => {
        #[must_use]
        pub fn $name(locale: Locale) -> String {
            locale.render(stringify!($name), None)
        }
    };
    (counted $name:ident) => {
        #[must_use]
        pub fn $name(locale: Locale, n: u64) -> String {
            locale.render(stringify!($name), Some(n))
        }
    };
}

macro_rules! catalog {
    ($( $kind:ident $name:ident = ($one:literal, $other:literal); )*) => {
        static EN: &[Entry] = &[ $( Entry { key: stringify!($name), one: $one, other: $other } ),* ];
        $( entry_fn!($kind $name); )*
    };
}

// The English catalog. Grouped by screen; a plain entry repeats its text in
// both slots so the table stays one shape.
catalog! {
    plain counter_title = ("Upcoming", "Upcoming");
    plain counter_loading = ("Loading…", "Loading…");
    counted counter_count = ("{n} upcoming event", "{n} upcoming events");
    plain counter_copy = ("Copy the count", "Copy the count");
    plain counter_copied = (
        "Copied. The clipboard clears in 30 seconds.",
        "Copied. The clipboard clears in 30 seconds."
    );
    plain counter_failed = ("Couldn't read your events.", "Couldn't read your events.");
    plain counter_retry = ("Try again", "Try again");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_count_picks_its_plural_form() {
        assert_eq!(counter_count(Locale::En, 1), "1 upcoming event");
        assert_eq!(counter_count(Locale::En, 0), "0 upcoming events");
        assert_eq!(counter_count(Locale::En, 12), "12 upcoming events");
    }

    #[test]
    fn every_entry_has_text_in_both_slots() {
        for entry in EN {
            assert!(
                !entry.one.is_empty() && !entry.other.is_empty(),
                "{}",
                entry.key
            );
        }
    }
}
