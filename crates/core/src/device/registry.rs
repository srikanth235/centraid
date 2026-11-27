//! THE DEVICE-KEY REGISTRY (app-plane §10, D5): every key a shell or the core writes outside the
//! vault, listed once with its owner, where it lives and its version. A JSON value carries
//! `"v"`; a key that is not listed here is refused by [`super::store::Checked`] and fails the
//! registry test.

/// Who writes the key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    Core,
    Shell,
    /// The backup plane's own state, out of the app plane's changes.
    Backup,
}

/// Where the value lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Place {
    /// The core's own device store (files beside the vault, never inside it).
    Device,
    /// The platform's secure store.
    Keychain,
    /// The platform's preferences.
    Settings,
    /// A folder or file the platform owns (an inbox, a bookmark, a state file).
    Files,
}

/// What the value is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    /// A JSON object whose `"v"` is this number.
    Json(u32),
    /// A value that is not JSON: a secret, a marker, a platform bookmark.
    Opaque,
}

/// One key, or a family of keys under a prefix.
#[derive(Debug, Clone, Copy)]
pub struct KeyDecl {
    /// The exact key, or the prefix a family's keys start with.
    pub name: &'static str,
    pub prefix: bool,
    /// Which of D1–D13 it belongs to.
    pub d: &'static str,
    pub owner: Owner,
    pub place: Place,
    pub shape: Shape,
}

const fn key(
    name: &'static str,
    d: &'static str,
    owner: Owner,
    place: Place,
    shape: Shape,
) -> KeyDecl {
    KeyDecl {
        name,
        prefix: false,
        d,
        owner,
        place,
        shape,
    }
}

const fn family(
    name: &'static str,
    d: &'static str,
    owner: Owner,
    place: Place,
    shape: Shape,
) -> KeyDecl {
    KeyDecl {
        name,
        prefix: true,
        d,
        owner,
        place,
        shape,
    }
}

use Owner::{Backup, Core, Shell};
use Place::{Device, Files, Keychain, Settings};
use Shape::{Json, Opaque};

pub const DEVICE_KEYS: &[KeyDecl] = &[
    family("draft.", "D1", Core, Device, Json(1)),
    key("share-in", "D2", Shell, Files, Opaque),
    family("view.", "D3", Core, Device, Json(1)),
    key("notify.applied", "D7", Core, Device, Json(1)),
    key("settings.appearance", "D8", Core, Device, Json(1)),
    key("settings.units", "D8", Core, Device, Json(1)),
    key("settings.details", "D8", Core, Device, Json(1)),
    key("widget.today", "D6", Core, Device, Json(1)),
    key("widget.health", "D6", Core, Device, Json(1)),
    key("centraid.notify.outbox", "D7", Shell, Settings, Json(1)),
    key("centraid.notify", "D7", Shell, Settings, Json(1)),
    key(
        "centraid.notification.immediates",
        "D7",
        Shell,
        Settings,
        Opaque,
    ),
    key("centraid.store-asked", "D8", Shell, Settings, Opaque),
    key("centraid.clipboard", "D10", Shell, Settings, Opaque),
    key("recovery-seed", "D8", Shell, Keychain, Opaque),
    key("recovery-seed.this-device", "D8", Shell, Keychain, Opaque),
    key("recovery-words.this-device", "D8", Shell, Keychain, Opaque),
    key("recovery-words-saved", "D8", Shell, Keychain, Opaque),
    key("seed-settled", "D8", Shell, Keychain, Opaque),
    key("vault-index-high-water", "D8", Shell, Keychain, Opaque),
    key("vault-seeds", "D8", Shell, Keychain, Opaque),
    key("vault-seeds.this-device", "D8", Shell, Keychain, Opaque),
    key("vault-seeds.to-file", "D8", Shell, Keychain, Opaque),
    family("vault-index.", "D8", Shell, Keychain, Opaque),
    family("vault-seed.", "D8", Shell, Keychain, Opaque),
    family("vault-words.this-device.", "D8", Shell, Keychain, Opaque),
    family("vault-own.", "D8", Shell, Keychain, Opaque),
    family("gateway-token.", "D8", Shell, Keychain, Opaque),
    key("appearance", "D8", Shell, Settings, Opaque),
    key("units", "D8", Shell, Settings, Opaque),
    key("alert_details", "D8", Shell, Settings, Opaque),
    key("transfer-rule", "D8", Core, Settings, Opaque),
    key("transfer-rule.include-videos", "D8", Core, Settings, Opaque),
    key("backup.key-prompt", "D8", Core, Settings, Opaque),
    key("backup.notify-ask", "D8", Core, Settings, Opaque),
    key("backup.check", "D8", Core, Settings, Opaque),
    key("welcome.seen", "D8", Core, Settings, Opaque),
    key("gw", "D8", Core, Settings, Opaque),
    key("install-id", "D8", Shell, Settings, Opaque),
    family("follower-device.", "D8", Shell, Settings, Opaque),
    family("follow.", "D13", Core, Device, Json(1)),
    family("grant.", "D9", Shell, Files, Opaque),
    key("backup.state", "D11", Backup, Files, Opaque),
    key("export", "D12", Core, Files, Json(1)),
];

/// The declaration that governs `key`, an exact name before a prefix.
#[must_use]
pub fn find(key: &str) -> Option<&'static KeyDecl> {
    DEVICE_KEYS
        .iter()
        .find(|decl| !decl.prefix && decl.name == key)
        .or_else(|| {
            DEVICE_KEYS
                .iter()
                .find(|decl| decl.prefix && key.starts_with(decl.name))
        })
}

/// Why a write was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyError {
    /// The key is not in the registry.
    Unlisted(String),
    /// A JSON key's value is not a JSON object.
    NotJson(String),
    /// A JSON key's value has no `"v"`, or one other than the registry's.
    Version(String),
}

impl std::fmt::Display for KeyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unlisted(key) => write!(f, "device key `{key}` is not in the registry"),
            Self::NotJson(key) => write!(f, "device key `{key}` holds a JSON object"),
            Self::Version(key) => write!(f, "device key `{key}` carries the wrong `\"v\"`"),
        }
    }
}

impl std::error::Error for KeyError {}

/// Whether `value` may be written under `key`.
///
/// # Errors
/// An unlisted key, or a JSON key whose value is not an object with the registry's `"v"`.
pub fn check(key: &str, value: &str) -> Result<(), KeyError> {
    let decl = find(key).ok_or_else(|| KeyError::Unlisted(key.to_owned()))?;
    let Shape::Json(version) = decl.shape else {
        return Ok(());
    };
    let parsed: serde_json::Value =
        serde_json::from_str(value).map_err(|_| KeyError::NotJson(key.to_owned()))?;
    let object = parsed
        .as_object()
        .ok_or_else(|| KeyError::NotJson(key.to_owned()))?;
    match object.get("v").and_then(serde_json::Value::as_u64) {
        Some(v) if v == u64::from(version) => Ok(()),
        _ => Err(KeyError::Version(key.to_owned())),
    }
}
