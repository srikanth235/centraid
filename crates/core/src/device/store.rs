//! WHERE THE CORE KEEPS ITS DEVICE STATE: one value per key, outside the vault. The shells keep
//! their own keys in the platform stores; the registry lists those too, and this module only
//! stores the core's.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::registry::{self, KeyError};

pub trait DeviceStore: Send + Sync {
    /// # Errors
    /// The store's own failure, in words.
    fn get(&self, key: &str) -> Result<Option<String>, String>;

    /// # Errors
    /// The store's own failure, in words.
    fn put(&self, key: &str, value: &str) -> Result<(), String>;

    /// # Errors
    /// The store's own failure, in words.
    fn delete(&self, key: &str) -> Result<(), String>;

    /// The keys that start with `prefix`.
    ///
    /// # Errors
    /// The store's own failure, in words.
    fn list(&self, prefix: &str) -> Result<Vec<String>, String>;
}

#[derive(Default)]
pub struct MemoryStore {
    map: Mutex<BTreeMap<String, String>>,
}

impl DeviceStore for MemoryStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self
            .map
            .lock()
            .map_err(|e| e.to_string())?
            .get(key)
            .cloned())
    }

    fn put(&self, key: &str, value: &str) -> Result<(), String> {
        self.map
            .lock()
            .map_err(|e| e.to_string())?
            .insert(key.to_owned(), value.to_owned());
        Ok(())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        self.map.lock().map_err(|e| e.to_string())?.remove(key);
        Ok(())
    }

    fn list(&self, prefix: &str) -> Result<Vec<String>, String> {
        Ok(self
            .map
            .lock()
            .map_err(|e| e.to_string())?
            .keys()
            .filter(|key| key.starts_with(prefix))
            .cloned()
            .collect())
    }
}

/// One file per key in a folder the platform backs up nowhere; a write goes through a temp file
/// and a rename, so a crash leaves the old value or the new one.
pub struct DirStore {
    root: PathBuf,
}

impl DirStore {
    /// # Errors
    /// The folder cannot be made.
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, String> {
        let root = root.into();
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        Ok(Self { root })
    }

    fn file(&self, key: &str) -> PathBuf {
        let mut name = String::with_capacity(key.len());
        for byte in key.bytes() {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_') {
                name.push(char::from(byte));
            } else {
                name.push_str(&format!("%{byte:02x}"));
            }
        }
        self.root.join(name)
    }

    fn key_of(name: &str) -> Option<String> {
        let bytes = name.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut at = 0;
        while at < bytes.len() {
            if bytes[at] == b'%' {
                let hex = std::str::from_utf8(bytes.get(at + 1..at + 3)?).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                at += 3;
            } else {
                out.push(bytes[at]);
                at += 1;
            }
        }
        String::from_utf8(out).ok()
    }

    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }
}

impl DeviceStore for DirStore {
    fn get(&self, key: &str) -> Result<Option<String>, String> {
        match std::fs::read_to_string(self.file(key)) {
            Ok(text) => Ok(Some(text)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.to_string()),
        }
    }

    fn put(&self, key: &str, value: &str) -> Result<(), String> {
        let file = self.file(key);
        let temp = file.with_extension("tmp");
        std::fs::write(&temp, value).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, &file).map_err(|e| e.to_string())
    }

    fn delete(&self, key: &str) -> Result<(), String> {
        match std::fs::remove_file(self.file(key)) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
        }
    }

    fn list(&self, prefix: &str) -> Result<Vec<String>, String> {
        let mut keys: Vec<String> = std::fs::read_dir(&self.root)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| Path::new(name).extension().is_none_or(|ext| ext != "tmp"))
            .filter_map(|name| Self::key_of(&name))
            .filter(|key| key.starts_with(prefix))
            .collect();
        keys.sort();
        Ok(keys)
    }
}

/// A store that writes only what the registry lists, and JSON only with its `"v"`.
pub struct Checked<S: DeviceStore> {
    inner: S,
}

impl<S: DeviceStore> Checked<S> {
    #[must_use]
    pub fn new(inner: S) -> Self {
        Self { inner }
    }

    /// # Errors
    /// The store's failure.
    pub fn get(&self, key: &str) -> Result<Option<String>, String> {
        self.inner.get(key)
    }

    /// # Errors
    /// The registry's refusal, or the store's failure.
    pub fn put(&self, key: &str, value: &str) -> Result<(), String> {
        registry::check(key, value).map_err(|error: KeyError| error.to_string())?;
        self.inner.put(key, value)
    }

    /// # Errors
    /// An unlisted key, or the store's failure.
    pub fn delete(&self, key: &str) -> Result<(), String> {
        registry::find(key).ok_or_else(|| KeyError::Unlisted(key.to_owned()).to_string())?;
        self.inner.delete(key)
    }

    /// # Errors
    /// The store's failure.
    pub fn list(&self, prefix: &str) -> Result<Vec<String>, String> {
        self.inner.list(prefix)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dir_store_round_trips_keys_with_dots_and_odd_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let store = DirStore::open(dir.path().join("device")).unwrap();
        store.put("draft.v1.note", "{\"v\":1}").unwrap();
        store.put("grant.a/b c", "x").unwrap();
        assert_eq!(
            store.get("draft.v1.note").unwrap().as_deref(),
            Some("{\"v\":1}")
        );
        assert_eq!(store.get("nothing").unwrap(), None);
        assert_eq!(store.list("grant.").unwrap(), ["grant.a/b c"]);
        store.delete("draft.v1.note").unwrap();
        store.delete("draft.v1.note").unwrap();
        assert!(store.list("").unwrap().len() == 1);
    }
}
