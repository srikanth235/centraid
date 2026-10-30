package dev.centraid.android.kit

import android.webkit.MimeTypeMap

/**
 * WHAT `PickBytes.accept` MEANS TO THE SYSTEM PICKER: Rust names the media types or extensions
 * the member may choose ("text/csv", ".ofx"); `OpenDocument` takes MIME types only. A media type
 * passes through; an extension becomes the type the platform's own map knows for it.
 *
 * THE MEMBER IS NEVER LOCKED OUT OF A FILE RUST ASKED FOR. An extension the map does not know
 * (`.ofx`, `.qfx`) cannot be named to the picker, and a provider may well file such a file under
 * `application/octet-stream`; so any entry that cannot be mapped keeps the picker open to every
 * file (the wildcard type) rather than narrowing it past the file. Empty `accept` is any file.
 */
internal fun pickerTypes(
    accept: List<String>,
    mimeOfExtension: (String) -> String? = { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it) },
): Array<String> {
    val any = arrayOf("*/*")
    val types = LinkedHashSet<String>()
    for (entry in accept) {
        val named = entry.trim().lowercase()
        if (named.isEmpty()) continue
        if (named.contains('/')) {
            types.add(named)
        } else {
            types.add(mimeOfExtension(named.removePrefix(".")) ?: return any)
        }
    }
    return if (types.isEmpty()) any else types.toTypedArray()
}
