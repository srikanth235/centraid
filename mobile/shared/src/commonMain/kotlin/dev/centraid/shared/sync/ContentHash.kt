package dev.centraid.shared.sync

import okio.ByteString

/**
 * A CONTENT HASH IN THE TWO SPELLINGS THE CORE USES, CONVERTED HERE ONLY
 * (#1080, the wire contract).
 *
 * `StageHandle.content_hash` answers lowercase hex; every field the backup
 * plane added (`NeedBytes.content_hash`, `FetchOriginalRequest.content_hash`,
 * `StageBegin.for_hash`) carries the 32 raw bytes. The shell holds hex — a
 * readable, comparable string — and crosses to bytes at the door, through
 * these two functions and no others.
 */
public object ContentHash {
    /** BLAKE3 is 32 bytes. */
    public const val BYTES: Int = 32

    /** Lowercase hex of a raw hash; empty when the core sent the wrong length. */
    public fun hex(raw: ByteString): String = if (raw.size == BYTES) raw.hex() else ""

    /** The raw bytes for a hex hash, or null when it is not 64 hex characters. */
    public fun raw(hex: String): ByteString? = hexToBytes(hex, BYTES)
}
