package dev.centraid.shared.shell

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okio.FileSystem
import okio.Path.Companion.toPath
import okio.buffer
import okio.use

/**
 * STREAMING A PICKED FILE INTO THE CORE, for a shell that performs the `PickFile`
 * effect (#1135, #1047 R-1047-Q4): the platform's picker or scanner wrote what the member
 * chose to a file on this device, and this streams it through the stage frames
 * ([Staging], the camera roll's door) so a 900 MB scan never exists in memory at once. The
 * core names the bytes; the screen files them (`upload`).
 *
 * Nothing here is Docs': the effect is generic, and what the file becomes is the screen's.
 * Callbacks and no `suspend`, so SwiftUI calls it plainly; each is called on the main thread.
 */
public class StageFileBridge {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var session: HomeSession? = null

    public fun attach(session: HomeSession) {
        this.session = session
    }

    /**
     * Stream the file at [path] as [mediaType]. [progress] is told the bytes sent so far and the
     * file's size; then exactly one of [staged] (the core's hash and the bytes it counted) or
     * [refused] (a sentence for a log: what the member reads is the screen's).
     */
    public fun stage(
        path: String,
        mediaType: String,
        progress: (Long, Long) -> Unit,
        staged: (String, Long) -> Unit,
        refused: (String) -> Unit,
    ) {
        scope.launch {
            val live = session
            val core = live?.shelf?.core()
            if (live == null || core == null) return@launch refused("no vault is open")
            if (live.shelf.foregroundHolding()?.readOnly == true) return@launch refused(Shelf.MOVED_SENTENCE)
            val file = path.toPath()
            val size = runCatching { FileSystem.SYSTEM.metadata(file).size }.getOrNull()
                ?: return@launch refused("the file cannot be read")
            val outcome = try {
                FileSystem.SYSTEM.source(file).buffer().use { source ->
                    var sent = 0L
                    Staging.stage(core = core, mediaType = mediaType, byteSize = size) { max ->
                        withContext(Dispatchers.Default) {
                            if (source.exhausted()) {
                                ByteArray(0)
                            } else {
                                source.request(max.toLong())
                                source.readByteArray(minOf(source.buffer.size, max.toLong()))
                            }
                        }.also {
                            sent += it.size
                            progress(sent, size)
                        }
                    }
                }
            } catch (why: okio.IOException) {
                return@launch refused("the file cannot be read")
            }
            when (outcome) {
                is Staging.Outcome.No -> refused(outcome.refused.sentence)
                is Staging.Outcome.Ok -> staged(outcome.staged.contentHash, outcome.staged.byteSize)
            }
        }
    }
}
