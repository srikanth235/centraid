//! THE SHARED TEXT FIELD'S STATE (app-plane §5.3). The shell owns caret, selection and
//! composition and sends a change only for a committed edit, with `seq` rising per field. Rust
//! keeps the value and a `rev` that rises whenever the value it holds changes, and answers with
//! both; the shell adopts Rust's value only when it differs and no edit above its last `seq` is
//! unsent, so the caret never jumps.

use std::collections::BTreeMap;
use zeroize::Zeroizing;

/// What became of one change.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Taken {
    /// The edit is the field's value now.
    Applied,
    /// A `seq` the field has already passed: a reordered or repeated send. Nothing changed.
    Stale,
}

/// One field's value, `rev` and the last `seq` taken.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct TextField {
    value: Zeroizing<String>,
    rev: u64,
    seq: u64,
}

impl TextField {
    #[must_use]
    pub fn new(value: impl Into<String>) -> Self {
        Self {
            value: Zeroizing::new(value.into()),
            rev: 0,
            seq: 0,
        }
    }

    #[must_use]
    pub fn value(&self) -> &str {
        &self.value
    }

    #[must_use]
    pub fn rev(&self) -> u64 {
        self.rev
    }

    #[must_use]
    pub fn seq(&self) -> u64 {
        self.seq
    }

    /// The shell's committed edit. `max_chars` of 0 means no limit; text past it is cut, so the
    /// value Rust answers with differs from what the shell sent and the shell adopts it.
    pub fn change(&mut self, seq: u64, text: &str, max_chars: usize) -> Taken {
        if seq <= self.seq {
            return Taken::Stale;
        }
        self.seq = seq;
        let kept = Zeroizing::new(if max_chars == 0 {
            text.to_owned()
        } else {
            text.chars().take(max_chars).collect()
        });
        if kept != self.value {
            self.value = kept;
            self.rev += 1;
        }
        Taken::Applied
    }

    /// Rust's own change (a chip made from a typed date, a cleared form): the shell adopts it.
    /// Returns whether the value changed.
    pub fn set(&mut self, value: impl Into<String>) -> bool {
        let value = Zeroizing::new(value.into());
        if value == self.value {
            return false;
        }
        self.value = value;
        self.rev += 1;
        true
    }
}

impl std::fmt::Debug for TextField {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TextField")
            .field("value", &"[redacted]")
            .field("rev", &self.rev)
            .field("seq", &self.seq)
            .finish()
    }
}

/// The fields of one room, by the name the builder gave them.
#[derive(Debug, Default, Clone)]
pub struct Fields {
    by_name: BTreeMap<String, TextField>,
    limits: BTreeMap<String, usize>,
}

impl Fields {
    /// The field `name`, started at `initial` the first time a room asks for it.
    pub fn get_or(&mut self, name: &str, initial: &str) -> &TextField {
        self.by_name
            .entry(name.to_owned())
            .or_insert_with(|| TextField::new(initial))
    }

    /// The most characters field `name` keeps (0 for no limit), as its builder declared.
    pub fn limit(&mut self, name: &str, max_chars: usize) {
        self.limits.insert(name.to_owned(), max_chars);
    }

    /// The shell's committed edit of field `name`, under the limit its builder declared.
    pub fn change(&mut self, name: &str, seq: u64, text: &str) -> Taken {
        let max = self.limits.get(name).copied().unwrap_or(0);
        self.by_name
            .entry(name.to_owned())
            .or_default()
            .change(seq, text, max)
    }

    #[must_use]
    pub fn get(&self, name: &str) -> Option<&TextField> {
        self.by_name.get(name)
    }

    pub fn get_mut(&mut self, name: &str) -> Option<&mut TextField> {
        self.by_name.get_mut(name)
    }

    /// Replaces a field's zeroizing value and sequence state, for a new input identity.
    pub fn reset(&mut self, name: &str, initial: impl Into<String>) {
        self.by_name
            .insert(name.to_owned(), TextField::new(initial));
    }

    #[must_use]
    pub fn value(&self, name: &str) -> Option<&str> {
        self.by_name.get(name).map(TextField::value)
    }

    pub fn clear(&mut self) {
        self.by_name.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rising_seq_is_taken_and_a_value_change_raises_rev() {
        let mut field = TextField::new("");
        assert_eq!(field.change(1, "a", 0), Taken::Applied);
        assert_eq!((field.value(), field.rev(), field.seq()), ("a", 1, 1));
        assert_eq!(field.change(2, "ab", 0), Taken::Applied);
        assert_eq!((field.value(), field.rev(), field.seq()), ("ab", 2, 2));
    }

    #[test]
    fn a_seq_at_or_below_the_last_is_stale_and_changes_nothing() {
        let mut field = TextField::new("");
        field.change(5, "five", 0);
        assert_eq!(field.change(5, "again", 0), Taken::Stale);
        assert_eq!(field.change(3, "older", 0), Taken::Stale);
        assert_eq!((field.value(), field.rev(), field.seq()), ("five", 1, 5));
    }

    #[test]
    fn the_same_value_under_a_new_seq_keeps_rev() {
        let mut field = TextField::new("x");
        assert_eq!(field.change(1, "x", 0), Taken::Applied);
        assert_eq!((field.rev(), field.seq()), (0, 1));
    }

    #[test]
    fn text_past_the_limit_is_cut_so_the_answer_differs_from_the_send() {
        let mut field = TextField::new("");
        field.change(1, "abcdef", 3);
        assert_eq!(field.value(), "abc");
        assert_eq!(field.rev(), 1);
    }

    #[test]
    fn a_field_cuts_to_the_limit_its_builder_declared() {
        let mut fields = Fields::default();
        fields.limit("title", 3);
        assert_eq!(fields.change("title", 1, "abcdef"), Taken::Applied);
        assert_eq!(fields.value("title"), Some("abc"));
        assert_eq!(fields.change("title", 1, "again"), Taken::Stale);
    }

    #[test]
    fn a_change_of_rusts_own_raises_rev_once() {
        let mut field = TextField::new("tomorrow");
        assert!(field.set(""));
        assert!(!field.set(""));
        assert_eq!((field.value(), field.rev()), ("", 1));
    }

    #[test]
    fn a_field_keeps_its_value_across_asks() {
        let mut fields = Fields::default();
        fields.get_or("title", "first");
        fields.change("title", 1, "typed");
        assert_eq!(fields.get_or("title", "first").value(), "typed");
    }

    #[test]
    fn debug_output_redacts_typed_field_contents() {
        let mut fields = Fields::default();
        fields.change("password", 1, "synthetic-private-value");
        let debug = format!("{fields:?}");
        assert!(!debug.contains("synthetic-private-value"));
        assert!(debug.contains("[redacted]"));
    }

    #[test]
    fn reset_drops_the_prior_value_and_starts_a_new_input_sequence() {
        let mut fields = Fields::default();
        fields.change("value", 1, "synthetic-private-value");
        fields.reset("value", "");
        assert_eq!(fields.value("value"), Some(""));
        assert_eq!(fields.change("value", 1, "new value"), Taken::Applied);
        assert_eq!(fields.value("value"), Some("new value"));
    }
}
