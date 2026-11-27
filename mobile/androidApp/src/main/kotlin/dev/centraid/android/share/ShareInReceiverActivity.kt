package dev.centraid.android.share

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import androidx.core.content.IntentCompat
import dev.centraid.android.MainActivity
import java.io.File
import java.util.concurrent.Executors

public class ShareInReceiverActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val incoming = intent
        val fromApp = referrer?.host.orEmpty()
        val appContext = applicationContext
        ioExecutor.execute {
            val count = runCatching { ingest(appContext, incoming, fromApp) }
                .onFailure { Log.w("Centraid", "share-in failed: ${it.message}") }
                .getOrDefault(0)
            runOnUiThread {
                if (count > 0 && !isFinishing) {
                    val launch = Intent(this, MainActivity::class.java)
                        .addFlags(
                            Intent.FLAG_ACTIVITY_NEW_TASK or
                                Intent.FLAG_ACTIVITY_SINGLE_TOP or
                                Intent.FLAG_ACTIVITY_CLEAR_TOP,
                        )
                    startActivity(launch)
                }
                finish()
            }
        }
    }

    internal companion object {
        private val ioExecutor = Executors.newSingleThreadExecutor { task ->
            Thread(task, "centraid-share-in").apply { isDaemon = true }
        }

        fun ingest(
            context: Context,
            intent: Intent?,
            fromApp: String = "",
            inboxDir: File = ShareInboxWriter.inboxDir(context),
        ): Int {
            if (intent == null) return 0
            return when (intent.action) {
                Intent.ACTION_SEND -> ingestSingle(context, intent, fromApp, inboxDir)
                Intent.ACTION_SEND_MULTIPLE -> ingestMultiple(context, intent, fromApp, inboxDir)
                else -> 0
            }
        }

        private fun ingestSingle(context: Context, intent: Intent, fromApp: String, inboxDir: File): Int {
            val stream = IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
            if (stream != null) {
                return if (writeStream(context, stream, intent.type.orEmpty(), fromApp, inboxDir)) 1 else 0
            }
            val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()
                ?: intent.getStringExtra(Intent.EXTRA_TEXT)
                ?: return 0
            if (text.isBlank()) return 0
            val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT).orEmpty()
            ShareInboxWriter.writeTextOrUrl(
                inboxDir = inboxDir,
                text = text,
                fromApp = fromApp,
                name = subject,
                mime = intent.type.orEmpty(),
            )
            return 1
        }

        private fun ingestMultiple(context: Context, intent: Intent, fromApp: String, inboxDir: File): Int {
            val streams = IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
            if (!streams.isNullOrEmpty()) {
                var written = 0
                for (uri in streams) {
                    if (writeStream(context, uri, intent.type.orEmpty(), fromApp, inboxDir)) {
                        written += 1
                    }
                }
                return written
            }
            val texts = intent.getStringArrayListExtra(Intent.EXTRA_TEXT)
                ?: intent.getCharSequenceArrayListExtra(Intent.EXTRA_TEXT)?.map(CharSequence::toString)
                ?: listOfNotNull(intent.getStringExtra(Intent.EXTRA_TEXT))
            val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT).orEmpty()
            var written = 0
            for (text in texts) {
                if (text.isBlank()) continue
                ShareInboxWriter.writeTextOrUrl(
                    inboxDir = inboxDir,
                    text = text,
                    fromApp = fromApp,
                    name = subject,
                    mime = intent.type.orEmpty(),
                )
                written += 1
            }
            return written
        }

        private fun writeStream(
            context: Context,
            uri: Uri,
            fallbackMime: String,
            fromApp: String,
            inboxDir: File,
        ): Boolean {
            val resolver = context.contentResolver
            val mime = resolver.getType(uri)?.takeIf { it.isNotBlank() } ?: fallbackMime
            val name = queryDisplayName(context, uri)
            val stream = resolver.openInputStream(uri) ?: return false
            stream.use { input ->
                ShareInboxWriter.writeFile(
                    inboxDir = inboxDir,
                    source = input,
                    mime = mime,
                    name = name,
                    fromApp = fromApp,
                )
            }
            return true
        }

        private fun queryDisplayName(context: Context, uri: Uri): String {
            runCatching {
                context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (column >= 0) {
                            val name = cursor.getString(column)
                            if (!name.isNullOrBlank()) return name
                        }
                    }
                }
            }
            return uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() } ?: "shared"
        }
    }
}
