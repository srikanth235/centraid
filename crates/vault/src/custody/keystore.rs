//! Named gateway/vault key custody — layer one of three (#1020, D-1020-R2).
//!
//! A key file is **never** a bare secret. Every backend writes the same
//! self-describing envelope, so custody can move between a host wrapper and an
//! OS wrapper without changing a caller or a filename:
//!
//! ```text
//! CENTRAID-KEY-V1\n{"scheme":"…","payload":"<base64>"}\n
//! ```
//!
//! Two schemes, and the difference is the whole point of the envelope:
//! `file-0600-v1` is the unprotected form, kept for **adoption only**, and
//! `aes-256-gcm-v1` is `nonce(12) ‖ tag(16) ‖ ciphertext` under a wrapping key
//! the host custodies. A pre-envelope raw 32-byte file is adopted and rewritten
//! *before* the read returns, so a successful open never leaves live raw
//! material behind.
//!
//! Faithful to `packages/vault/src/schema/key-store.ts` (#555, #1014 X16),
//! including the parts that look like rough edges and are not:
//!
//! - An unprotected envelope found on a host that **has** custody is adopted,
//!   rewrapped and **warned about** rather than refused. A `keys/` file is
//!   writable by anything running as the gateway user, so refusing outright
//!   needs an operator-visible switch and a release note; until then the
//!   adoption is a line in the log, not an invisible success.
//! - Permissions are **repaired** to 600 with a warning, not refused.
//! - `rotate` writes `<name>.next` and renames over the live name, so an
//!   interrupted rotation leaves a sidecar the seal plane can promote.
//!
//! `atomic_write` is the one durability rule: a temp file created with
//! `O_EXCL` at mode 0600, a `before_commit` fault seam, `rename`, `chmod 600`,
//! and the temp removed on any failure. A half-written key file is the one
//! outcome that is unrecoverable, so it is the one outcome that cannot happen.

use std::fs;
use std::io;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

/// Every named secret is exactly this wide. A key of another length is a
/// corrupt file, not a short key.
pub const KEY_STORE_SECRET_BYTES: usize = 32;

/// The envelope's first line. Its trailing newline is part of the magic.
pub const KEY_STORE_ENVELOPE_MAGIC: &str = "CENTRAID-KEY-V1\n";

/// The unprotected scheme. Legacy adoption only — never minted on a host that
/// has a protector.
pub const FILE_SCHEME: &str = "file-0600-v1";

/// The wrapped scheme: `nonce(12) ‖ tag(16) ‖ ciphertext`.
pub const AES_GCM_SCHEME: &str = "aes-256-gcm-v1";

/// A custody failure a caller must distinguish, never a bare error string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyStoreErrorCode {
    /// The file exists and cannot be believed.
    Corrupt,
    /// The envelope names a scheme this host has no custody for.
    UnsupportedScheme,
    /// The key name is not a legal file name for `keys/`.
    InvalidName,
}

impl KeyStoreErrorCode {
    #[must_use]
    pub const fn as_wire(self) -> &'static str {
        match self {
            Self::Corrupt => "corrupt",
            Self::UnsupportedScheme => "unsupported_scheme",
            Self::InvalidName => "invalid_name",
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum KeyStoreError {
    #[error("{code}: {message}", code = code.as_wire())]
    Custody {
        code: KeyStoreErrorCode,
        message: String,
    },
    #[error("key store io at {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

impl KeyStoreError {
    fn custody(code: KeyStoreErrorCode, message: impl Into<String>) -> Self {
        Self::Custody {
            code,
            message: message.into(),
        }
    }

    /// The code, for a caller that switches on it. `None` for an io failure —
    /// a disk that is gone is not a custody verdict.
    #[must_use]
    pub const fn code(&self) -> Option<KeyStoreErrorCode> {
        match self {
            Self::Custody { code, .. } => Some(*code),
            Self::Io { .. } => None,
        }
    }
}

type Result<T> = std::result::Result<T, KeyStoreError>;

fn io_at(path: &Path) -> impl FnOnce(io::Error) -> KeyStoreError + '_ {
    move |source| KeyStoreError::Io {
        path: path.to_path_buf(),
        source,
    }
}

/// How a host wraps key material. The trait is the seam custody moves through:
/// callers and filenames never change when the wrapper does.
pub trait KeyProtector: Send + Sync {
    /// The scheme string written into the envelope.
    fn scheme(&self) -> &'static str;
    fn protect(&self, secret: &[u8]) -> Result<Vec<u8>>;
    fn unprotect(&self, payload: &[u8]) -> Result<Vec<u8>>;
}

/// AES-256-GCM wrapping under a device-custodied key.
///
/// Layout is v0's `nonce ‖ tag ‖ ciphertext` — note the tag is in the
/// **middle**, not appended as `aes-gcm` crates do, because Node's
/// `getAuthTag()` surface made that the natural spelling and the files exist.
pub struct AesGcmKeyProtector {
    master: [u8; KEY_STORE_SECRET_BYTES],
}

impl AesGcmKeyProtector {
    pub fn new(master: &[u8]) -> Result<Self> {
        let master: [u8; KEY_STORE_SECRET_BYTES] = master.try_into().map_err(|_| {
            KeyStoreError::custody(
                KeyStoreErrorCode::Corrupt,
                format!(
                    "KeyStore wrapping key is {} bytes, expected {KEY_STORE_SECRET_BYTES}",
                    master.len()
                ),
            )
        })?;
        Ok(Self { master })
    }
}

impl KeyProtector for AesGcmKeyProtector {
    fn scheme(&self) -> &'static str {
        AES_GCM_SCHEME
    }

    fn protect(&self, secret: &[u8]) -> Result<Vec<u8>> {
        use aes_gcm::aead::{Aead, Payload};
        use aes_gcm::{Aes256Gcm, KeyInit};
        let nonce = super::random_bytes::<12>();
        let cipher = Aes256Gcm::new_from_slice(&self.master)
            .map_err(|_| KeyStoreError::custody(KeyStoreErrorCode::Corrupt, "invalid AES key"))?;
        let body = cipher
            .encrypt(
                (&nonce).into(),
                Payload {
                    msg: secret,
                    aad: &[],
                },
            )
            .map_err(|_| {
                KeyStoreError::custody(KeyStoreErrorCode::Corrupt, "KeyStore AES-GCM seal failed")
            })?;
        // `nonce ‖ tag ‖ ciphertext`, v0's order.
        let (ct, tag) = body.split_at(body.len() - 16);
        let mut out = Vec::with_capacity(12 + body.len());
        out.extend_from_slice(&nonce);
        out.extend_from_slice(tag);
        out.extend_from_slice(ct);
        Ok(out)
    }

    fn unprotect(&self, payload: &[u8]) -> Result<Vec<u8>> {
        use aes_gcm::aead::{Aead, Payload};
        use aes_gcm::{Aes256Gcm, KeyInit};
        if payload.len() < 28 {
            return Err(KeyStoreError::custody(
                KeyStoreErrorCode::Corrupt,
                "KeyStore AES-GCM payload is truncated",
            ));
        }
        let nonce: [u8; 12] = payload[..12].try_into().expect("checked length");
        let mut body = Vec::with_capacity(payload.len() - 12);
        body.extend_from_slice(&payload[28..]);
        body.extend_from_slice(&payload[12..28]);
        let cipher = Aes256Gcm::new_from_slice(&self.master)
            .map_err(|_| KeyStoreError::custody(KeyStoreErrorCode::Corrupt, "invalid AES key"))?;
        cipher
            .decrypt(
                (&nonce).into(),
                Payload {
                    msg: &body,
                    aad: &[],
                },
            )
            .map_err(|_| {
                KeyStoreError::custody(
                    KeyStoreErrorCode::Corrupt,
                    "KeyStore AES-GCM authentication failed",
                )
            })
    }
}

/// Fault-injection seam: called after the temp file is written and before the
/// rename. Returning an error reproduces a crash mid-mint.
pub type BeforeCommitFn = dyn Fn(&Path, &Path) -> io::Result<()> + Send + Sync;

/// An owned [`BeforeCommitFn`], as [`KeyStore::with_before_commit`] takes it.
pub type BeforeCommit = Box<BeforeCommitFn>;

/// A persistent named-secret store over one directory.
///
/// Construction is **side-effect free**: a vaultless gateway creates `keys/`
/// only when a key is actually requested.
pub struct KeyStore {
    dir: PathBuf,
    protector: Option<Box<dyn KeyProtector>>,
    warnings: Mutex<Vec<String>>,
    before_commit: Option<BeforeCommit>,
}

impl std::fmt::Debug for KeyStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("KeyStore")
            .field("dir", &self.dir)
            .field("scheme", &self.scheme())
            .finish_non_exhaustive()
    }
}

impl KeyStore {
    #[must_use]
    pub fn new(dir: impl AsRef<Path>) -> Self {
        Self {
            dir: absolutize(dir.as_ref()),
            protector: None,
            warnings: Mutex::new(Vec::new()),
            before_commit: None,
        }
    }

    /// Attach a host wrapper. Every subsequent write uses it, and a legacy
    /// envelope read through this store is adopted into it.
    #[must_use]
    pub fn with_protector(mut self, protector: Box<dyn KeyProtector>) -> Self {
        self.protector = Some(protector);
        self
    }

    #[must_use]
    pub fn with_before_commit(mut self, hook: BeforeCommit) -> Self {
        self.before_commit = Some(hook);
        self
    }

    #[must_use]
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// The scheme this store writes today.
    #[must_use]
    pub fn scheme(&self) -> &'static str {
        self.protector.as_ref().map_or(FILE_SCHEME, |p| p.scheme())
    }

    /// Everything this store said out loud — adoptions and permission repairs.
    /// Drained, so a caller that logs them cannot log one twice.
    pub fn take_warnings(&self) -> Vec<String> {
        std::mem::take(&mut *self.warnings.lock().expect("warnings lock"))
    }

    fn warn(&self, message: String) {
        tracing::warn!(target: "centraid::custody", "{message}");
        self.warnings.lock().expect("warnings lock").push(message);
    }

    /// The path a name resolves to. Errors on an illegal name rather than
    /// building a path that escapes `keys/`.
    pub fn file(&self, name: &str) -> Result<PathBuf> {
        assert_key_name(name)?;
        Ok(self.dir.join(name))
    }

    /// Load a named secret, or `None` when the file does not exist.
    pub fn load(&self, name: &str) -> Result<Option<Vec<u8>>> {
        let Some(secret) = self.read(name)? else {
            return Ok(None);
        };
        let file = self.file(name)?;
        assert_secret_length(&file, &secret)?;
        Ok(Some(secret))
    }

    /// `load`, without the 32-byte assertion — the export path, which carries
    /// whatever was imported.
    pub fn export(&self, name: &str) -> Result<Option<Vec<u8>>> {
        self.read(name)
    }

    pub fn load_or_create(&self, name: &str) -> Result<Vec<u8>> {
        match self.load(name)? {
            Some(secret) => Ok(secret),
            None => self.create(name),
        }
    }

    /// Mint a fresh 32-byte secret under this name.
    pub fn create(&self, name: &str) -> Result<Vec<u8>> {
        let secret = super::random_bytes::<KEY_STORE_SECRET_BYTES>().to_vec();
        self.store(name, &secret)?;
        Ok(secret)
    }

    pub fn store(&self, name: &str, secret: &[u8]) -> Result<()> {
        let file = self.file(name)?;
        assert_secret_length(&file, secret)?;
        self.write(name, secret)
    }

    /// Import material of any non-zero length — the `key restore` path.
    pub fn import(&self, name: &str, secret: &[u8]) -> Result<()> {
        if secret.is_empty() {
            let file = self.file(name)?;
            return Err(KeyStoreError::custody(
                KeyStoreErrorCode::Corrupt,
                format!("key at {} cannot be empty", file.display()),
            ));
        }
        self.write(name, secret)
    }

    /// Rotate through a `<name>.next` sidecar, then rename over the live name.
    ///
    /// The sidecar is what makes an interrupted rotation recoverable: a reader
    /// that finds a stamp it cannot match checks `<file>.next` and promotes it.
    pub fn rotate(&self, name: &str) -> Result<Vec<u8>> {
        let next = super::random_bytes::<KEY_STORE_SECRET_BYTES>().to_vec();
        let sidecar = format!("{name}.next");
        self.store(&sidecar, &next)?;
        let from = self.file(&sidecar)?;
        let to = self.file(name)?;
        fs::rename(&from, &to).map_err(io_at(&to))?;
        set_mode_600(&to)?;
        Ok(next)
    }

    /// Remove a key file and, unless the name *is* a sidecar, its sidecar.
    /// Reports whether anything was removed.
    pub fn destroy(&self, name: &str) -> Result<bool> {
        let mut destroyed = remove_if_present(&self.file(name)?)?;
        if !name.ends_with(".next") {
            destroyed |= remove_if_present(&self.file(&format!("{name}.next"))?)?;
        }
        Ok(destroyed)
    }

    /// The directory listing, sorted, or empty when `keys/` does not exist.
    pub fn names(&self) -> Result<Vec<String>> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(io_at(&self.dir)(error)),
        };
        let mut names = Vec::new();
        for entry in entries {
            let entry = entry.map_err(io_at(&self.dir))?;
            if let Some(name) = entry.file_name().to_str() {
                names.push(name.to_owned());
            }
        }
        names.sort();
        Ok(names)
    }

    fn read(&self, name: &str) -> Result<Option<Vec<u8>>> {
        let file = self.file(name)?;
        let raw = match fs::read(&file) {
            Ok(raw) => raw,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_at(&file)(error)),
        };
        self.repair_mode(&file)?;

        // One-time adoption of the pre-envelope raw 32-byte files. Rewrite
        // BEFORE returning, so a successful open never leaves live raw
        // material behind.
        if raw.len() == KEY_STORE_SECRET_BYTES
            && !raw.starts_with(KEY_STORE_ENVELOPE_MAGIC.as_bytes())
        {
            self.note_adoption(&file, "a pre-envelope raw key file");
            self.store(name, &raw)?;
            return Ok(Some(raw));
        }

        let envelope = parse_envelope(&file, &raw)?;
        let payload = decode_payload(&file, &envelope.payload)?;
        if envelope.scheme == FILE_SCHEME {
            // Desktop adoption: once an OS-custodied protector is available, a
            // successfully-read unprotected envelope is immediately rewrapped.
            if self.protector.is_some() {
                self.note_adoption(&file, &format!("the unprotected \"{FILE_SCHEME}\" scheme"));
                self.write(name, &payload)?;
            }
            return Ok(Some(payload));
        }
        match &self.protector {
            Some(protector) if protector.scheme() == envelope.scheme => {
                Ok(Some(protector.unprotect(&payload)?))
            }
            _ => Err(KeyStoreError::custody(
                KeyStoreErrorCode::UnsupportedScheme,
                format!(
                    "key {} uses unavailable custody scheme \"{}\"",
                    file.display(),
                    envelope.scheme
                ),
            )),
        }
    }

    fn write(&self, name: &str, secret: &[u8]) -> Result<()> {
        let file = self.file(name)?;
        let payload = match &self.protector {
            Some(protector) => protector.protect(secret)?,
            None => secret.to_vec(),
        };
        let envelope = serde_json::json!({
            "scheme": self.scheme(),
            "payload": STANDARD.encode(&payload),
        });
        let mut bytes = KEY_STORE_ENVELOPE_MAGIC.as_bytes().to_vec();
        bytes.extend_from_slice(
            serde_json::to_string(&envelope)
                .expect("envelope serialization")
                .as_bytes(),
        );
        bytes.push(b'\n');
        atomic_write(&file, &bytes, self.before_commit.as_deref())
    }

    /// Say so when a key arrives UNPROTECTED on a host that has custody
    /// (#1014, X16). Adoption is the supported headless → OS-custody upgrade;
    /// what it must not be is invisible.
    fn note_adoption(&self, file: &Path, what: &str) {
        let Some(protector) = &self.protector else {
            return;
        };
        self.warn(format!(
            "adopted {} from {what} into {} custody; a key that arrives unprotected on a host \
             with custody is expected only during a one-time upgrade",
            file.display(),
            protector.scheme()
        ));
    }

    fn repair_mode(&self, file: &Path) -> Result<()> {
        let mode = fs::metadata(file)
            .map_err(io_at(file))?
            .permissions()
            .mode()
            & 0o777;
        if mode == 0o600 {
            return Ok(());
        }
        set_mode_600(file)?;
        self.warn(format!(
            "repaired key permissions on {} from {mode:o} to 600",
            file.display()
        ));
        Ok(())
    }
}

struct Envelope {
    scheme: String,
    payload: String,
}

fn assert_key_name(name: &str) -> Result<()> {
    // `^[A-Za-z0-9][A-Za-z0-9._-]*$`, hand-rolled so `keys/` needs no regex
    // engine — and so a `..` or a `/` can never reach a path join.
    let mut chars = name.chars();
    let legal = match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {
            chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        }
        _ => false,
    };
    if legal {
        Ok(())
    } else {
        Err(KeyStoreError::custody(
            KeyStoreErrorCode::InvalidName,
            format!("invalid key name \"{name}\""),
        ))
    }
}

fn assert_secret_length(file: &Path, secret: &[u8]) -> Result<()> {
    if secret.len() == KEY_STORE_SECRET_BYTES {
        Ok(())
    } else {
        Err(KeyStoreError::custody(
            KeyStoreErrorCode::Corrupt,
            format!(
                "key at {} is {} bytes, expected {KEY_STORE_SECRET_BYTES}",
                file.display(),
                secret.len()
            ),
        ))
    }
}

fn parse_envelope(file: &Path, raw: &[u8]) -> Result<Envelope> {
    let text = std::str::from_utf8(raw).map_err(|_| {
        KeyStoreError::custody(
            KeyStoreErrorCode::Corrupt,
            format!("key at {} has no KeyStore envelope", file.display()),
        )
    })?;
    let Some(body) = text.strip_prefix(KEY_STORE_ENVELOPE_MAGIC) else {
        return Err(KeyStoreError::custody(
            KeyStoreErrorCode::Corrupt,
            format!("key at {} has no KeyStore envelope", file.display()),
        ));
    };
    let corrupt = |what: &str| {
        KeyStoreError::custody(
            KeyStoreErrorCode::Corrupt,
            format!(
                "key at {} has a corrupt KeyStore envelope: {what}",
                file.display()
            ),
        )
    };
    let parsed: serde_json::Value = serde_json::from_str(body.trim_end_matches('\n'))
        .map_err(|error| corrupt(&error.to_string()))?;
    let scheme = parsed
        .get("scheme")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| corrupt("missing scheme or payload"))?;
    let payload = parsed
        .get("payload")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| corrupt("missing scheme or payload"))?;
    Ok(Envelope {
        scheme: scheme.to_owned(),
        payload: payload.to_owned(),
    })
}

fn decode_payload(file: &Path, payload: &str) -> Result<Vec<u8>> {
    STANDARD.decode(payload).map_err(|_| {
        KeyStoreError::custody(
            KeyStoreErrorCode::Corrupt,
            format!("key at {} has invalid base64 payload", file.display()),
        )
    })
}

fn remove_if_present(file: &Path) -> Result<bool> {
    match fs::remove_file(file) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_at(file)(error)),
    }
}

fn set_mode_600(file: &Path) -> Result<()> {
    fs::set_permissions(file, fs::Permissions::from_mode(0o600)).map_err(io_at(file))
}

/// A key file is written whole or not at all.
///
/// `O_EXCL` at mode 0600 means the temp never exists readable; the rename is
/// the commit; the `chmod` afterwards repairs an inherited mode; and the temp
/// is removed on every failure path, including the injected one.
fn atomic_write(file: &Path, bytes: &[u8], before_commit: Option<&BeforeCommitFn>) -> Result<()> {
    let parent = file.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(io_at(parent))?;
    let _ = fs::set_permissions(parent, fs::Permissions::from_mode(0o700));
    let temp = parent.join(format!(
        "{}.{}.{}.tmp",
        file.file_name().and_then(|n| n.to_str()).unwrap_or("key"),
        std::process::id(),
        hex::encode(super::random_bytes::<6>())
    ));
    {
        use std::io::Write as _;
        let mut handle = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temp)
            .map_err(io_at(&temp))?;
        handle.write_all(bytes).map_err(io_at(&temp))?;
        handle.sync_all().map_err(io_at(&temp))?;
    }
    let commit = || -> Result<()> {
        if let Some(hook) = before_commit {
            hook(file, &temp).map_err(io_at(&temp))?;
        }
        fs::rename(&temp, file).map_err(io_at(file))?;
        set_mode_600(file)
    };
    match commit() {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&temp);
            Err(error)
        }
    }
}

/// `path::absolutize` without touching the filesystem — `canonicalize` refuses
/// a directory that does not exist yet, and construction here is side-effect
/// free by design.
fn absolutize(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> tempfile::TempDir {
        tempfile::tempdir().expect("scratch dir")
    }

    #[test]
    fn a_minted_key_round_trips_through_the_envelope_at_mode_600() {
        let dir = scratch();
        let store = KeyStore::new(dir.path().join("keys"));
        let secret = store.create("seal.key").unwrap();
        assert_eq!(secret.len(), KEY_STORE_SECRET_BYTES);
        assert_eq!(
            store.load("seal.key").unwrap().as_deref(),
            Some(&secret[..])
        );

        let file = store.file("seal.key").unwrap();
        let raw = fs::read_to_string(&file).unwrap();
        assert!(raw.starts_with(KEY_STORE_ENVELOPE_MAGIC));
        assert!(raw.contains(FILE_SCHEME));
        assert!(raw.ends_with('\n'));
        let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "a key file is never group- or world-readable");
    }

    #[test]
    fn a_missing_key_is_none_and_never_a_mint() {
        let dir = scratch();
        let store = KeyStore::new(dir.path().join("keys"));
        assert_eq!(store.load("seal.key").unwrap(), None);
        assert!(
            !dir.path().join("keys").exists(),
            "construction and a miss are both side-effect free"
        );
    }

    #[test]
    fn a_wrapped_key_is_unreadable_without_the_wrapping_key() {
        let dir = scratch();
        let master = [3_u8; 32];
        let wrapped = KeyStore::new(dir.path().join("keys"))
            .with_protector(Box::new(AesGcmKeyProtector::new(&master).unwrap()));
        let secret = wrapped.create("locker.key").unwrap();
        assert_eq!(
            wrapped.load("locker.key").unwrap().as_deref(),
            Some(&secret[..])
        );

        let raw = fs::read(wrapped.file("locker.key").unwrap()).unwrap();
        assert!(
            !raw.windows(secret.len()).any(|w| w == &secret[..]),
            "the wrapped envelope must not carry the plaintext key"
        );

        // A host with no custody sees a scheme it cannot serve — and says so
        // as `unsupported_scheme`, not as a corrupt file.
        let bare = KeyStore::new(dir.path().join("keys"));
        assert_eq!(
            bare.load("locker.key").unwrap_err().code(),
            Some(KeyStoreErrorCode::UnsupportedScheme)
        );
        // A different wrapping key authenticates as corrupt, never as a key.
        let wrong = KeyStore::new(dir.path().join("keys"))
            .with_protector(Box::new(AesGcmKeyProtector::new(&[4_u8; 32]).unwrap()));
        assert_eq!(
            wrong.load("locker.key").unwrap_err().code(),
            Some(KeyStoreErrorCode::Corrupt)
        );
    }

    #[test]
    fn a_raw_pre_envelope_file_is_adopted_and_rewritten_before_the_read_returns() {
        let dir = scratch();
        let keys = dir.path().join("keys");
        fs::create_dir_all(&keys).unwrap();
        let raw = [9_u8; 32];
        fs::write(keys.join("seal.key"), raw).unwrap();
        let store = KeyStore::new(&keys);
        assert_eq!(store.load("seal.key").unwrap().as_deref(), Some(&raw[..]));
        let after = fs::read(keys.join("seal.key")).unwrap();
        assert!(
            after.starts_with(KEY_STORE_ENVELOPE_MAGIC.as_bytes()),
            "a successful open never leaves live raw material behind"
        );
    }

    #[test]
    fn an_unprotected_envelope_on_a_host_with_custody_is_adopted_and_warned_about() {
        let dir = scratch();
        let keys = dir.path().join("keys");
        let bare = KeyStore::new(&keys);
        let secret = bare.create("seal.key").unwrap();

        let store = KeyStore::new(&keys)
            .with_protector(Box::new(AesGcmKeyProtector::new(&[5_u8; 32]).unwrap()));
        assert_eq!(
            store.load("seal.key").unwrap().as_deref(),
            Some(&secret[..])
        );
        let warnings = store.take_warnings();
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(warnings[0].contains("adopted"), "{warnings:?}");
        let raw = fs::read_to_string(keys.join("seal.key")).unwrap();
        assert!(
            raw.contains(AES_GCM_SCHEME),
            "the file is rewrapped, not just read"
        );
    }

    #[test]
    fn loose_permissions_are_repaired_with_a_warning_rather_than_refused() {
        let dir = scratch();
        let keys = dir.path().join("keys");
        let store = KeyStore::new(&keys);
        store.create("seal.key").unwrap();
        let file = store.file("seal.key").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        let _ = store.take_warnings();
        assert!(store.load("seal.key").unwrap().is_some());
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        let warnings = store.take_warnings();
        assert!(
            warnings.iter().any(|w| w.contains("repaired")),
            "{warnings:?}"
        );
    }

    #[test]
    fn a_failed_commit_leaves_no_temp_file_and_no_key_file() {
        let dir = scratch();
        let keys = dir.path().join("keys");
        let store = KeyStore::new(&keys).with_before_commit(Box::new(|_, _| {
            Err(io::Error::other("power cut between write and rename"))
        }));
        assert!(store.create("seal.key").is_err());
        let leftovers = fs::read_dir(&keys).unwrap().count();
        assert_eq!(
            leftovers, 0,
            "a half-written key file is the one unrecoverable outcome"
        );
    }

    #[test]
    fn rotate_writes_a_sidecar_then_renames_over_the_live_name() {
        let dir = scratch();
        let store = KeyStore::new(dir.path().join("keys"));
        let first = store.create("seal.key").unwrap();
        let next = store.rotate("seal.key").unwrap();
        assert_ne!(first, next);
        assert_eq!(store.load("seal.key").unwrap().as_deref(), Some(&next[..]));
        assert_eq!(store.load("seal.key.next").unwrap(), None);
    }

    #[test]
    fn destroy_removes_the_key_and_its_sidecar() {
        let dir = scratch();
        let store = KeyStore::new(dir.path().join("keys"));
        store.create("seal.key").unwrap();
        store.create("seal.key.next").unwrap();
        assert!(store.destroy("seal.key").unwrap());
        assert_eq!(store.load("seal.key").unwrap(), None);
        assert_eq!(store.load("seal.key.next").unwrap(), None);
        assert!(
            !store.destroy("seal.key").unwrap(),
            "a second destroy removed nothing"
        );
    }

    #[test]
    fn an_illegal_key_name_is_refused_before_it_reaches_a_path_join() {
        let dir = scratch();
        let store = KeyStore::new(dir.path().join("keys"));
        for name in ["", "../escape", ".hidden", "a/b", "-leading"] {
            assert_eq!(
                store.file(name).unwrap_err().code(),
                Some(KeyStoreErrorCode::InvalidName),
                "{name}"
            );
        }
    }

    #[test]
    fn a_corrupt_envelope_and_a_short_key_are_both_corrupt_not_missing() {
        let dir = scratch();
        let keys = dir.path().join("keys");
        fs::create_dir_all(&keys).unwrap();
        fs::write(keys.join("a.key"), b"not an envelope at all").unwrap();
        fs::write(
            keys.join("b.key"),
            format!("{KEY_STORE_ENVELOPE_MAGIC}{{\"scheme\":\"file-0600-v1\"}}\n"),
        )
        .unwrap();
        fs::write(
            keys.join("c.key"),
            format!(
                "{KEY_STORE_ENVELOPE_MAGIC}{{\"scheme\":\"file-0600-v1\",\"payload\":\"AAAA\"}}\n"
            ),
        )
        .unwrap();
        let store = KeyStore::new(&keys);
        for name in ["a.key", "b.key", "c.key"] {
            assert_eq!(
                store.load(name).unwrap_err().code(),
                Some(KeyStoreErrorCode::Corrupt),
                "{name}"
            );
        }
    }
}
