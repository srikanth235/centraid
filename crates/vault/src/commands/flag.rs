//! `flag.set` and `flag.clear`: starred, pinned, archived.
//!
//! A flag is an instant on the row itself (`entity.starred_at`, `pinned_at`, `archived_at`, A14),
//! set to the injected clock's now and cleared to NULL, on every kind (a project is archived, so is
//! a category; a note is pinned). Setting one is **not an edit**: it stamps neither
//! `updated_at` nor a revision (the commit triggers skip these columns), so a starred note keeps
//! the "last edited" it had and the history of a pinned task does not grow. Setting a flag that is
//! set keeps its first instant.

use crate::commands::entity::lookup_live;
use crate::commands::{CommandCondition, CommandCtx, CommandDefinition, Idempotency};
use crate::error::{Result, VaultError};

/// The three flags, each a column of `entity`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flag {
    Starred,
    Pinned,
    Archived,
}

impl Flag {
    pub const ALL: [Self; 3] = [Self::Starred, Self::Pinned, Self::Archived];

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Starred => "starred",
            Self::Pinned => "pinned",
            Self::Archived => "archived",
        }
    }

    #[must_use]
    pub fn parse(word: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|flag| flag.as_str() == word)
    }

    /// The column of `entity` that holds this flag's instant.
    #[must_use]
    pub const fn column(self) -> &'static str {
        match self {
            Self::Starred => "starred_at",
            Self::Pinned => "pinned_at",
            Self::Archived => "archived_at",
        }
    }

    /// The statement that sets it (the first instant is kept) and the one that clears it. Fixed
    /// text per flag: no input is spelled into SQL.
    const fn statements(self) -> (&'static str, &'static str) {
        match self {
            Self::Starred => (
                "UPDATE entity SET starred_at = ?2 WHERE id = ?1 AND starred_at IS NULL",
                "UPDATE entity SET starred_at = NULL WHERE id = ?1 AND starred_at IS NOT NULL",
            ),
            Self::Pinned => (
                "UPDATE entity SET pinned_at = ?2 WHERE id = ?1 AND pinned_at IS NULL",
                "UPDATE entity SET pinned_at = NULL WHERE id = ?1 AND pinned_at IS NOT NULL",
            ),
            Self::Archived => (
                "UPDATE entity SET archived_at = ?2 WHERE id = ?1 AND archived_at IS NULL",
                "UPDATE entity SET archived_at = NULL WHERE id = ?1 AND archived_at IS NOT NULL",
            ),
        }
    }
}

#[derive(serde::Deserialize)]
struct FlagInput {
    flag: String,
}

fn flag_of(word: &str) -> Result<Flag> {
    Flag::parse(word).ok_or_else(|| VaultError::InvalidInput {
        name: "flag".to_owned(),
        detail: format!("`{word}` is not starred, pinned or archived"),
    })
}

fn set(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: FlagInput = ctx.parse_input()?;
    let (set, _) = flag_of(&input.flag)?.statements();
    let mut changed_ids = Vec::new();
    for id in ctx.target_ids() {
        let changed = ctx
            .connection()
            .execute(set, rusqlite::params![id, ctx.now])?;
        if changed > 0 {
            changed_ids.push(id);
        }
    }
    Ok(
        serde_json::json!({ "changed": !changed_ids.is_empty(), "count": changed_ids.len(), "changed_ids": changed_ids }),
    )
}

fn clear(ctx: &CommandCtx<'_, '_>) -> Result<serde_json::Value> {
    let input: FlagInput = ctx.parse_input()?;
    let (_, clear) = flag_of(&input.flag)?.statements();
    let mut changed_ids = Vec::new();
    for id in ctx.target_ids() {
        if ctx.connection().execute(clear, [id.as_str()])? > 0 {
            changed_ids.push(id);
        }
    }
    Ok(
        serde_json::json!({ "changed": !changed_ids.is_empty(), "count": changed_ids.len(), "changed_ids": changed_ids }),
    )
}

/// A sentence when this entity takes no flag: it is missing or is in the trash.
fn pre_flaggable(ctx: &CommandCtx<'_, '_>) -> Result<Option<String>> {
    ctx.check_each(|one| Ok(lookup_live(one.connection(), one.required_str("id")?)?.err()))
}

const SCHEMA: &str = r#"{
  "type": "object",
  "required": ["flag"],
  "anyOf": [{ "required": ["id"] }, { "required": ["ids"] }],
  "additionalProperties": false,
  "properties": {
    "id": { "type": "string", "minLength": 1 },
    "ids": { "type": "array", "minItems": 1, "maxItems": 500,
             "items": { "type": "string", "minLength": 1 } },
    "flag": { "type": "string", "enum": ["starred", "pinned", "archived"] }
  }
}"#;

#[must_use]
pub fn definitions() -> Vec<CommandDefinition> {
    const TAKES: &[CommandCondition] = &[CommandCondition {
        predicate: "entity_takes_a_flag",
        check: pre_flaggable,
    }];
    vec![
        CommandDefinition::plain(
            "flag.set",
            "flag",
            SCHEMA,
            Idempotency::Idempotent,
            TAKES,
            set,
        ),
        CommandDefinition::plain(
            "flag.clear",
            "flag",
            SCHEMA,
            Idempotency::Idempotent,
            TAKES,
            clear,
        ),
    ]
}
