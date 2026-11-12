//! THE TWO FILES CENTRAID EVER FETCHES: the on-device chat's model, and, only when a member
//! first attaches a photo, its vision projector.
//!
//! The shell owns the transfer and neither shell may carry a second copy of these facts, so they
//! live here, once, and ride the `ModelDownload` effect. Each URL names a commit of its
//! repository, never a branch: a release pins the model it was built and checked against, so a
//! file replaced upstream is still the file this build downloads, and a newer model ships with
//! the release whose runtime it was trained for.

/// One file the chat fetches.
#[derive(Clone, Copy)]
pub struct Asset {
    pub url: &'static str,
    /// What the file is called on the phone.
    pub file_name: &'static str,
    /// The file's SHA-256, lowercase hex.
    pub sha256: &'static str,
    /// The file's size in bytes, quoted before a byte has moved.
    pub bytes: u64,
}

/// THE MODEL THIS RELEASE SHIPS, read from the model record (`crates/assist/model.json`,
/// #1188 C1): the URL (a Hugging Face file at a commit), the SHA-256 and the size the record pins.
/// Nothing here is typed by hand; `cargo xtask model-pin` writes the record and the gate's
/// `model-record` step ties it to the runtime's tool catalogue and prompt.
#[must_use]
pub fn model() -> Asset {
    of(&centraid_assist::record::record().current)
}

/// THE MODEL BEFORE IT, while the release still supports it (the two-model window): a phone that
/// holds it keeps chatting with it and is offered the current one.
#[must_use]
pub fn previous() -> Option<Asset> {
    centraid_assist::record::record().previous.as_ref().map(of)
}

/// THE ADAPTER THAT RIDES WITH THE CURRENT MODEL, when the release ships one made for it: fetched
/// after the model by the same transfer rules, under its local name (which carries the start of its
/// SHA-256, so a newer adapter is a different file). It is part of "the assistant": the member
/// reads one download and one size.
#[must_use]
pub fn adapter() -> Option<Asset> {
    use std::collections::HashMap;
    use std::sync::Mutex;
    static SEEN: std::sync::OnceLock<Mutex<HashMap<String, Asset>>> = std::sync::OnceLock::new();
    let record = centraid_assist::record::record();
    let adapter = record
        .adapter
        .filter(|adapter| adapter.base_sha256 == record.current.sha256)?;
    let mut seen = SEEN
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    Some(
        *seen.entry(adapter.sha256.clone()).or_insert_with(|| Asset {
            url: Box::leak(adapter.url.clone().into_boxed_str()),
            file_name: Box::leak(adapter.local_name().into_boxed_str()),
            sha256: Box::leak(adapter.sha256.clone().into_boxed_str()),
            bytes: adapter.bytes,
        }),
    )
}

/// What fetching the assistant takes: the model, and its adapter when there is one.
#[must_use]
pub fn assistant_bytes() -> u64 {
    model().bytes + adapter().map_or(0, |adapter| adapter.bytes)
}

/// An entry as an asset. The strings are leaked once per distinct entry, so asking again costs
/// nothing and a record is read for every question about the files.
fn of(entry: &centraid_assist::record::Entry) -> Asset {
    use std::collections::HashMap;
    use std::sync::Mutex;
    static SEEN: std::sync::OnceLock<Mutex<HashMap<String, Asset>>> = std::sync::OnceLock::new();
    let mut seen = SEEN
        .get_or_init(Mutex::default)
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *seen.entry(entry.sha256.clone()).or_insert_with(|| Asset {
        url: Box::leak(entry.url.clone().into_boxed_str()),
        file_name: Box::leak(entry.file_name.clone().into_boxed_str()),
        sha256: Box::leak(entry.sha256.clone().into_boxed_str()),
        bytes: entry.bytes,
    })
}

/// THE VISION PROJECTOR (`mmproj`): Unsloth's F16 projector for Qwen3.5 0.8B, which pairs with
/// the text weights above (checked by loading both and describing a photograph,
/// `crates/assist-llama/tests/real_vision.rs`).
pub const VISION: Asset = Asset {
    url: "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/mmproj-F16.gguf",
    file_name: "Qwen3.5-0.8B-mmproj-F16.gguf",
    sha256: "56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453",
    bytes: 204_987_232,
};

/// Where `asset` lives in `models_dir`.
#[must_use]
pub fn path(models_dir: &str, asset: &Asset) -> String {
    if models_dir.is_empty() {
        return asset.file_name.to_owned();
    }
    format!("{}/{}", models_dir.trim_end_matches('/'), asset.file_name)
}
