package dev.centraid.shared.chat

/**
 * THE TWO FILES CENTRAID CAN FETCH: the on-device chat's model, and — only
 * when a member first attaches a photo — its vision projector. The projector is
 * never fetched in the shipped build: the chat offers no attachment while
 * [ChatMachine.ATTACHMENTS_OFFERED] is off, because the model cannot describe a
 * file (R-1088-19).
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
 *
 * Each URL names a commit of its repository, never a branch: a release pins
 * the model it was built and checked against, so a file replaced upstream is
 * still the file this build downloads, and a newer model ships with the
 * release whose runtime it was trained for.
 */
public object ChatModelAsset {
    /**
     * S2, the native tool task's fine-tune of Qwen3.5 0.8B, 4-bit (`Q4_0`), as
     * a GGUF file: the model the native plane's prompt, think compiler and
     * decode step were trained for (R-1088-18). Published Apache-2.0 at a
     * commit of `srikanth235/centraid-native-gguf` (tag `s2-q4_0`), converted
     * by `experiments/toolchat/native/train/to_gguf.py` at the llama.cpp commit
     * the engine vendors, which rebuilds it byte for byte.
     */
    public const val URL: String =
        "https://huggingface.co/srikanth235/centraid-native-gguf/resolve/657a377d0204cc6cc14563fc9d0fe78ccc8fafd9/centraid-native-s2-Q4_0.gguf"

    /** What the file is called on the phone, and so what `modelPath` ends in. */
    public const val FILE_NAME: String = "centraid-native-s2-Q4_0.gguf"

    /** The file's SHA-256, lowercase hex. */
    public const val SHA256: String = "b1be1e45024c8e98f670d456edfdf261c786878dd8260117806e285af8e9f668"

    /** The file's size in bytes. */
    public const val BYTES: Long = 563_036_224L

    // ------------------------------------------------------------- vision --

    /**
     * THE VISION PROJECTOR (`mmproj`), fetched ONLY on a member's first photo
     * attach and never with the model: the 563 MB text download is unchanged.
     * Nothing triggers it while [ChatMachine.ATTACHMENTS_OFFERED] is off
     * (R-1088-19); the constants stay for the model that reads attachments.
     * Unsloth's F16 projector for Qwen3.5 0.8B. Fine-tuning left the vision
     * tower as it was, so the base model's projector is S2's; it pairs with the
     * base text weights converted at the engine's llama.cpp commit (checked by
     * loading both and describing a photograph —
     * `crates/assist-llama/tests/real_vision.rs`). Verified the same way as the
     * model: hashed on arrival, kept only when the digest is [VISION_SHA256].
     */
    public const val VISION_URL: String =
        "https://huggingface.co/unsloth/Qwen3.5-0.8B-GGUF/resolve/6ab461498e2023f6e3c1baea90a8f0fe38ab64d0/mmproj-F16.gguf"

    /** What the projector is called on the phone. */
    public const val VISION_FILE_NAME: String = "Qwen3.5-0.8B-mmproj-F16.gguf"

    /** The projector's SHA-256, lowercase hex. */
    public const val VISION_SHA256: String = "56e4c6cfe73b0c82e3e82bc518d7591997e61d81f723fc41a586f4fa69ea2453"

    /** The projector's size in bytes. */
    public const val VISION_BYTES: Long = 204_987_232L
}
