package dev.centraid.android.screens.docs

import android.content.Context
import android.content.Intent
import androidx.core.content.FileProvider
import centraid.core.v1.EffectDone
import centraid.core.v1.EffectFailed
import centraid.core.v1.EffectResult
import centraid.core.v1.ShareFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * SHARE ONE DOCUMENT'S FILE (`ShareFile`): the store names a file by its digest, so the receiver
 * would see a hash. Copy it to `cacheDir/shared-copies/batch/<name>` (the folder Photos' hand-off
 * serves through the app's one `FileProvider`, `res/xml/shared_copies.xml`) and open the system
 * chooser on it. Each share clears the last one's copy: it is plaintext outside the vault.
 *
 * The SwiftUI twin is `DocsShare.swift`.
 */
internal suspend fun performShareFile(context: Context, share: ShareFile): EffectResult {
    val copy = withContext(Dispatchers.IO) {
        val folder = File(context.cacheDir, "shared-copies/batch")
        folder.deleteRecursively()
        folder.mkdirs()
        val target = File(folder, share.name.replace('/', '-').ifEmpty { "Document" })
        runCatching { File(share.path).copyTo(target, overwrite = true) }.getOrNull()
    } ?: return EffectResult(failed = EffectFailed(reason = "the file could not be read"))
    val uri = FileProvider.getUriForFile(context, context.packageName + ".photocopies", copy)
    val send = Intent(Intent.ACTION_SEND).apply {
        type = share.media_type.ifEmpty { "application/octet-stream" }
        putExtra(Intent.EXTRA_STREAM, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    context.startActivity(
        Intent.createChooser(send, share.chooser_title.ifEmpty { null }).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
    return EffectResult(done = EffectDone())
}
