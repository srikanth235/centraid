//! DRAFTS (app-plane §10, D1): one record per `(vault_id, kind)`, kept until the member saves,
//! confirms a discard, or leaves the vault. Never Locker: an unsealed value never reaches disk.

use serde_json::{Map, Value, json};

use super::store::{Checked, DeviceStore};

const PREFIX: &str = "draft.";

/// What a draft's refusal says.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DraftError {
    /// A Locker item's form is never drafted.
    Locker,
    /// The store failed.
    Store(String),
}

impl std::fmt::Display for DraftError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Locker => f.write_str("a Locker item is never drafted"),
            Self::Store(why) => write!(f, "the draft could not be kept: {why}"),
        }
    }
}

impl std::error::Error for DraftError {}

/// A kept draft.
#[derive(Debug, Clone, PartialEq)]
pub struct Draft {
    pub kind: String,
    pub fields: Map<String, Value>,
    pub saved_at: i64,
}

pub struct Drafts<'a, S: DeviceStore> {
    store: &'a Checked<S>,
    vault_id: &'a str,
}

impl<'a, S: DeviceStore> Drafts<'a, S> {
    #[must_use]
    pub fn new(store: &'a Checked<S>, vault_id: &'a str) -> Self {
        Self { store, vault_id }
    }

    fn key(&self, kind: &str) -> String {
        format!("{PREFIX}{}.{kind}", self.vault_id)
    }

    fn is_locker(kind: &str) -> bool {
        kind == "locker" || kind.starts_with("locker_")
    }

    /// Keep `fields` as the one draft of `kind`, replacing any.
    ///
    /// # Errors
    /// [`DraftError::Locker`] for a Locker kind; the store's failure.
    pub fn keep(
        &self,
        kind: &str,
        fields: Map<String, Value>,
        saved_at: i64,
    ) -> Result<(), DraftError> {
        if Self::is_locker(kind) {
            return Err(DraftError::Locker);
        }
        let record = json!({ "v": 1, "kind": kind, "fields": fields, "saved_at": saved_at });
        self.store
            .put(&self.key(kind), &record.to_string())
            .map_err(DraftError::Store)
    }

    /// The draft of `kind`, when one is kept and reads as a draft.
    ///
    /// # Errors
    /// The store's failure.
    pub fn load(&self, kind: &str) -> Result<Option<Draft>, DraftError> {
        let Some(text) = self.store.get(&self.key(kind)).map_err(DraftError::Store)? else {
            return Ok(None);
        };
        let Ok(Value::Object(mut record)) = serde_json::from_str::<Value>(&text) else {
            return Ok(None);
        };
        let Some(Value::Object(fields)) = record.remove("fields") else {
            return Ok(None);
        };
        Ok(Some(Draft {
            kind: kind.to_owned(),
            fields,
            saved_at: record
                .get("saved_at")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
        }))
    }

    /// The member saved: the draft is the item now.
    ///
    /// # Errors
    /// The store's failure.
    pub fn saved(&self, kind: &str) -> Result<(), DraftError> {
        self.store
            .delete(&self.key(kind))
            .map_err(DraftError::Store)
    }

    /// The member confirmed "Discard changes?".
    ///
    /// # Errors
    /// The store's failure.
    pub fn discarded(&self, kind: &str) -> Result<(), DraftError> {
        self.saved(kind)
    }

    /// The member left this vault: every draft of it goes.
    ///
    /// # Errors
    /// The store's failure.
    pub fn left_vault(&self) -> Result<usize, DraftError> {
        let own = format!("{PREFIX}{}.", self.vault_id);
        let keys = self.store.list(&own).map_err(DraftError::Store)?;
        for key in &keys {
            self.store.delete(key).map_err(DraftError::Store)?;
        }
        Ok(keys.len())
    }
}
