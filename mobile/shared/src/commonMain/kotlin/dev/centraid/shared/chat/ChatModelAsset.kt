package dev.centraid.shared.chat

/**
 * THE TWO FILES CENTRAID EVER FETCHES: the on-device chat's model, and — only
 * when a member first attaches a photo — its vision projector.
 *
 * Both shells own the transfer and neither may carry a second copy of these
 * facts, so they live here, once. A shell downloads [URL] into its own
 * application-support `models/` directory under [FILE_NAME], hashes what
 * arrived, and keeps it only when the digest is [SHA256]; a file that hashes
 * to anything else is deleted and reported as a failed download
 * (`ChatEvent.DownloadFinished{ok: false}`).
 *
 * [BYTES] is the size the download step quotes before a byte has moved
 * (`ChatEvent.Opened.model_bytes`); the transfer's own `Content-Length` takes
 * over once it reports progress.
 */
public object ChatModelAsset {
    /** Qwen3.5 0.8B, 4-bit (`Q4_0`), as a GGUF file. */
    public const val URL: String =
        "https://huggingface.co/ggml-org/Qwen3.5-0.8B-GGUF/resolve/main/Qwen3.5-0.8B-Q4_0.gguf"

    /** What the file is called on the phone, and so what `modelPath` ends in. */
    public const val FILE_NAME: String = "Qwen3.5-0.8B-Q4_0.gguf"

    /** The file's SHA-256, lowercase hex. */
    public const val SHA256: String = "57d1997790d1744fba5b40a7317df71ea5e2acee28c47e78f0cce39c0703f8cf"

    /** The file's size in bytes. */
    public const val BYTES: Long = 563_036_064L

    // ------------------------------------------------------------- vision --

    /**
     * THE VISION PROJECTOR (`mmproj`), fetched ONLY on a member's first photo
     * attach and never with the model: the 563 MB text download is unchanged.
     * Unsloth's F16 projector for Qwen3.5 0.8B; it pairs with the ggml-org text
     * weights above (checked by loading both and describing a photograph —
     * `crates/assist-llama/tests/real_vision.rs`). Verified the same way as the
     * model: hashed on arrival, kept only when the digest is [VISION_SHA256].
     */
    public const val VISION_URL: String =
        "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/main/mmproj-F16.gguf"

    /** What the projector is called on the phone. */
    public const val VISION_FILE_NAME: String = "Qwen3.5-0.8B-mmproj-F16.gguf"

    /** The projector's SHA-256, lowercase hex. */
    public const val VISION_SHA256: String = "56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453"

    /** The projector's size in bytes. */
    public const val VISION_BYTES: Long = 204_987_232L
}
