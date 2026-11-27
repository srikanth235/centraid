//! WHAT A ROOM MAY ASK OF THE CORE: run one catalogue action, take it back, and the time. A room
//! never opens the vault itself; the core hands the runtime this door.

use super::selector::Act;

/// An action that ran.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Done {
    /// The status line's sentence ("Note moved to trash").
    pub sentence: String,
    /// Whether the status line offers Undo.
    pub undo: bool,
}

/// An action the core refused, in the core's own sentence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused(pub String);

pub trait Door {
    /// Run `act` as one commit.
    ///
    /// # Errors
    /// The core's sentence for a refusal.
    fn act(&self, act: &Act) -> Result<Done, Refused>;

    /// Take back the last action the status line offered Undo for.
    ///
    /// # Errors
    /// The core's sentence, when the record changed again.
    fn undo(&self) -> Result<Done, Refused>;

    fn now_ms(&self) -> i64;

    /// One request of the core's own (the backup status, a drain).
    ///
    /// # Errors
    /// The core's sentence.
    fn call(
        &self,
        request: &centraid_api_proto::core_v1::Request,
    ) -> Result<centraid_api_proto::core_v1::Response, Refused> {
        let _ = request;
        Err(Refused("this door carries no core".to_owned()))
    }

    /// A device-store key's value.
    fn device_get(&self, key: &str) -> Option<String> {
        let _ = key;
        None
    }

    /// Write a device-store key, through the registry.
    ///
    /// # Errors
    /// The registry's or the store's sentence.
    fn device_put(&self, key: &str, value: &str) -> Result<(), Refused> {
        let _ = (key, value);
        Err(Refused("this door keeps no device store".to_owned()))
    }

    /// Remove a device-store key, through the registry.
    ///
    /// # Errors
    /// The registry's or the store's sentence.
    fn device_delete(&self, key: &str) -> Result<(), Refused> {
        let _ = key;
        Err(Refused("this door keeps no device store".to_owned()))
    }

    /// A read-only door onto the vault file, guarded by the SQLite authorizer.
    ///
    /// # Errors
    /// The core's sentence.
    fn reader(&self) -> Result<centraid_domain::read::Reader, Refused> {
        Err(Refused("this door carries no reader".to_owned()))
    }

    /// Whether the member refused the OS permission a store's import needs (`photos`, `calendar`,
    /// `reminders`, `people`). A door that follows no store says no.
    fn permission_refused(&self, store: &str) -> bool {
        let _ = store;
        false
    }

    /// Follow or import a phone store (`photos`, `calendar`, `reminders`, `people`, `health`):
    /// the one enrolment the Home widgets and every first-open card send.
    ///
    /// # Errors
    /// The core's sentence, or that this door follows no store.
    fn enrol_store(&self, store: &str) -> Result<Done, Refused> {
        let _ = store;
        Err(Refused("this door follows no phone store".to_owned()))
    }

    /// Open the OS settings page for a store whose permission was refused.
    ///
    /// # Errors
    /// That this door has no settings page to open.
    fn open_settings(&self, store: &str) -> Result<Done, Refused> {
        let _ = store;
        Err(Refused("this door opens no settings page".to_owned()))
    }

    /// Whether this phone has a Reminders store to import from (iOS does, Android has none).
    fn reminders_source(&self) -> bool {
        true
    }

    /// What a draft is kept under for the vault in front.
    fn vault_id(&self) -> String {
        String::new()
    }
}
