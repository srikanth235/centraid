//! WHAT ONLY THE MEMBER COMPLETES (#1135): a secret action offered on a card.
//!
//! The assistant and the member have the same functionality; the one rule is that a sealed value's
//! plaintext never reaches the model, an event, the stored thread or the index. So a
//! call that would show or set a secret does not run and does not decline: it ends the turn with a
//! [`MemberAction`], the chat draws it as a card, and the member's tap completes it: a `reveal` or
//! `code` is shown on the card itself after the owner check (the core reads it through Locker's
//! reveal, stamp first; the model never does), an `edit_secret` opens Locker's editor. The model's observation names what was
//! offered and never a value.
//!
//! The action rides a chat card of the Locker item (`app` locker, `entity` `locker_item`) with the
//! action in the card's `qualifier`, `<action>:<column>`, so a shell parses one grammar. A stored
//! thread keeps it as the closed code `<action>_<column>` of a `message_card` row, with no value
//! ([`MemberAction::code`], [`qualifier_of_code`]). The shape carries `export` (no item, no column)
//! without a change.

use centraid_vault::commands::locker::{SEALED_PLACEHOLDER, secret_keys};
use serde_json::{Value, json};

/// What the member does on the card.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActionKind {
    /// Show one sealed value of an item (Locker's reveal).
    Reveal,
    /// Show the one-time code the item's seed makes, never the seed (Locker's code).
    Code,
    /// Type a sealed value into Locker's editor, on that field.
    EditSecret,
    /// Export the vault's Locker.
    Export,
}

impl ActionKind {
    /// The word in the qualifier and in the effect.
    #[must_use]
    pub const fn word(self) -> &'static str {
        match self {
            Self::Reveal => "reveal",
            Self::Code => "code",
            Self::EditSecret => "edit_secret",
            Self::Export => "export",
        }
    }

    /// The action a word names.
    #[must_use]
    pub fn parse(word: &str) -> Option<Self> {
        [Self::Reveal, Self::Code, Self::EditSecret, Self::Export]
            .into_iter()
            .find(|kind| kind.word() == word)
    }
}

/// One action offered to the member: the item and the sealed column it is about.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemberAction {
    pub kind: ActionKind,
    /// The Locker item's id; empty for an `export`.
    pub item_id: String,
    /// The sealed column (`password`, `otp_seed`, `card_number`, `cvv`, `content`); empty for an
    /// `export`.
    pub column: String,
}

impl MemberAction {
    /// The card qualifier: `reveal:password`.
    #[must_use]
    pub fn qualifier(&self) -> String {
        format!("{}:{}", self.kind.word(), self.column)
    }

    /// The closed code a stored card keeps for the action: `reveal_password`, or `export`.
    #[must_use]
    pub fn code(&self) -> String {
        if self.column.is_empty() {
            self.kind.word().to_owned()
        } else {
            format!("{}_{}", self.kind.word(), self.column)
        }
    }

    /// The action a card qualifier names, with the item the card is of. `None` for a plain card.
    #[must_use]
    pub fn from_card(item_id: &str, qualifier: &str) -> Option<Self> {
        let (word, column) = qualifier.split_once(':')?;
        Some(Self {
            kind: ActionKind::parse(word)?,
            item_id: item_id.to_owned(),
            column: column.to_owned(),
        })
    }

    /// The action as the turn's effect carries it.
    #[must_use]
    pub fn to_json(&self) -> Value {
        json!({"action": self.kind.word(), "item_id": self.item_id, "field": self.column})
    }

    /// The action an effect carries.
    #[must_use]
    pub fn of_json(value: &Value) -> Option<Self> {
        Some(Self {
            kind: ActionKind::parse(value["action"].as_str()?)?,
            item_id: value["item_id"].as_str()?.to_owned(),
            column: value["field"].as_str()?.to_owned(),
        })
    }
}

/// The qualifier a stored code reads back as (`reveal_password` is `reveal:password`), or `None`
/// for a code that is not a member action's.
#[must_use]
pub fn qualifier_of_code(code: &str) -> Option<String> {
    [
        ActionKind::Reveal,
        ActionKind::Code,
        ActionKind::EditSecret,
        ActionKind::Export,
    ]
    .into_iter()
    .find_map(|kind| {
        let rest = code.strip_prefix(kind.word())?;
        match rest.strip_prefix('_') {
            Some(column) if !column.is_empty() => Some(format!("{}:{column}", kind.word())),
            None if rest.is_empty() => Some(format!("{}:", kind.word())),
            _ => None,
        }
    })
}

// ---------------------------------------------------------------------------
// A secret the member typed in chat
// ---------------------------------------------------------------------------

/// The sealed values a command's input carries as the member typed them: a sealed cell that is
/// neither empty nor the vault's placeholder. The door seals them when the write runs; until then
/// the runtime holds them only in the parked step, and everything that outlives the turn (the
/// log, the stored question, the card) holds [`SEALED_PLACEHOLDER`] in their place.
#[must_use]
pub fn typed_secrets(input: &Value) -> Vec<String> {
    secret_keys()
        .into_iter()
        .filter_map(|column| input.get(column)?.as_str())
        .filter(|text| !text.is_empty() && *text != SEALED_PLACEHOLDER)
        .map(str::to_owned)
        .collect()
}

/// The input with each typed secret replaced by the placeholder.
#[must_use]
pub fn masked(input: &Value) -> Value {
    let mut out = input.clone();
    for column in secret_keys() {
        if let Some(cell) = out.get_mut(column)
            && cell.as_str().is_some_and(|text| !text.is_empty())
        {
            *cell = json!(SEALED_PLACEHOLDER);
        }
    }
    out
}

/// `text` with every whole-token occurrence of a secret replaced by [`SEALED_PLACEHOLDER`]. A token
/// is bounded by anything that is not a letter or a digit, so `4471` in `code 4471.` goes and the
/// `44` of `4471` does not take a longer word with it.
#[must_use]
pub fn redact(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_owned();
    for secret in secrets.iter().filter(|secret| !secret.is_empty()) {
        let mut next = String::with_capacity(out.len());
        let mut rest = out.as_str();
        while let Some(at) = rest.find(secret.as_str()) {
            let before = rest[..at].chars().next_back();
            let after = rest[at + secret.len()..].chars().next();
            let bounded = |c: Option<char>| c.is_none_or(|c| !c.is_alphanumeric());
            next.push_str(&rest[..at]);
            if bounded(before) && bounded(after) {
                next.push_str(SEALED_PLACEHOLDER);
            } else {
                next.push_str(secret);
            }
            rest = &rest[at + secret.len()..];
        }
        next.push_str(rest);
        out = next;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stored_code_is_a_closed_word_and_reads_back_as_the_qualifier() {
        for (kind, column) in [
            (ActionKind::Reveal, "password"),
            (ActionKind::Code, "otp_seed"),
            (ActionKind::EditSecret, "card_number"),
            (ActionKind::Export, ""),
        ] {
            let action = MemberAction {
                kind,
                item_id: "i1".to_owned(),
                column: column.to_owned(),
            };
            let code = action.code();
            assert!(
                code.len() <= 24
                    && code.starts_with(|c: char| c.is_ascii_lowercase())
                    && code.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "{code}"
            );
            assert_eq!(qualifier_of_code(&code), Some(action.qualifier()));
        }
        for plain in ["", "due", "update", "reveal_", "peek_password"] {
            assert_eq!(qualifier_of_code(plain), None, "{plain}");
        }
    }

    #[test]
    fn a_qualifier_round_trips_and_a_plain_card_has_none() {
        for kind in [
            ActionKind::Reveal,
            ActionKind::Code,
            ActionKind::EditSecret,
            ActionKind::Export,
        ] {
            let action = MemberAction {
                kind,
                item_id: "i1".to_owned(),
                column: "password".to_owned(),
            };
            assert_eq!(
                MemberAction::from_card("i1", &action.qualifier()),
                Some(action.clone())
            );
            assert_eq!(MemberAction::of_json(&action.to_json()), Some(action));
        }
        assert_eq!(MemberAction::from_card("i1", ""), None);
        assert_eq!(MemberAction::from_card("i1", "2026-10-08"), None);
        assert_eq!(MemberAction::from_card("i1", "peek:password"), None);
    }

    #[test]
    fn a_typed_secret_is_masked_and_redacted_by_whole_token() {
        let input = json!({"item_id": "i", "password": "4471", "cvv": "«sealed»", "notes": "x"});
        assert_eq!(typed_secrets(&input), vec!["4471".to_owned()]);
        assert_eq!(masked(&input)["password"], json!("«sealed»"));
        assert_eq!(masked(&input)["notes"], json!("x"));
        assert_eq!(
            redact(
                "save my gym code 4471, not 44712 or a4471.",
                &["4471".to_owned()]
            ),
            "save my gym code «sealed», not 44712 or a4471."
        );
    }
}
