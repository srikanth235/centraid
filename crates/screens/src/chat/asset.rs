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
    static MODEL: std::sync::OnceLock<Asset> = std::sync::OnceLock::new();
    *MODEL.get_or_init(|| {
        let entry = centraid_assist::record::record().current;
        Asset {
            url: Box::leak(entry.url.into_boxed_str()),
            file_name: Box::leak(entry.file_name.into_boxed_str()),
            sha256: Box::leak(entry.sha256.into_boxed_str()),
            bytes: entry.bytes,
        }
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
