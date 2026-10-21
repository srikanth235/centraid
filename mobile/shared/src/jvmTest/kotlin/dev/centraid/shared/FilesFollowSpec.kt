package dev.centraid.shared

import dev.centraid.shared.apps.docs.FileStager
import dev.centraid.shared.apps.docs.FilesFollow
import dev.centraid.shared.apps.docs.FilesRead
import dev.centraid.shared.apps.docs.FilesReader
import dev.centraid.shared.apps.docs.FilesImport
import dev.centraid.shared.apps.docs.FilesStore
import dev.centraid.shared.apps.docs.PhoneFile
import dev.centraid.shared.sync.phone.GoneChoice
import dev.centraid.shared.sync.phone.GoneReason
import dev.centraid.shared.sync.phone.PhoneOriginRef
import dev.centraid.shared.sync.phone.PhoneSync
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe

/** A vault that keeps the commands' own rules for the Docs side of a folder pass (#1127, lane F). */
private class FilesBench {
    class Doc(var title: String, var hash: String, var trashed: Boolean = false, var revisions: Int = 1)

    class Link(val id: String, var phoneId: String, var origin: String, var entity: String?, var fingerprint: String, var detachedAt: String?) {
        /** The device a `local:` link was made on (F-K-1); null for a portable id. */
        var device: String? = null
    }

    /** The device each origin was last read on. */
    val originDevice = mutableMapOf<String, String>()

    val script = ScriptedCore()
    val docs = linkedMapOf<String, Doc>()
    val origins = linkedMapOf<String, Pair<String, String>>()
    val links = linkedMapOf<String, Link>()

    /** The bytes of each file, by `folder/path`; a file with no entry cannot be read. */
    val contents = mutableMapOf<String, String>()
    val staged = mutableListOf<String>()
    private var next = 0

    val stager = FileStager { file ->
        val key = "${file.origin}/${file.path}"
        staged += key
        contents[key]?.let { "h:$it" }
    }

    /** Every command that wrote to the vault, in order. */
    val writes: List<String> get() = script.commands.map { it.first }.filter { it != "phone.touch" }

    init {
        script.pages = { name, bound ->
            when (name) {
                "phone.links" -> links.values.map {
                    listOf(it.id, it.phoneId, it.origin, it.entity.orEmpty(), it.fingerprint, it.detachedAt.orEmpty(), SIGHTED, it.device.orEmpty())
                }
                "phone.origins" -> origins.map { (id, o) -> listOf(id, o.first, o.second, originDevice[id].orEmpty()) }
                "phone.follow.imported" -> origins.keys.take(1).map { listOf(it) }
                "phone.files.documents" -> docs.filter { bound.isEmpty() || it.key == bound.single() }.map { (id, d) ->
                    listOf(id, d.title, "c:${d.hash}", if (d.trashed) "t" else "")
                }
                "phone.files.hashes" -> docs.filter { bound.isEmpty() || it.key == bound.single() }.map { (_, d) ->
                    listOf("c:${d.hash}", d.hash)
                }
                else -> emptyList()
            }
        }
        script.answers = { name, input -> execute(name, input) }
    }

    private fun field(input: String, key: String): String =
        Regex("\"$key\"\\s*:\\s*\"([^\"]*)\"").find(input)?.groupValues?.get(1).orEmpty()

    private fun execute(name: String, input: String): String? {
        when (name) {
            "phone.origin" -> {
                val phone = field(input, "phone_origin")
                val id = origins.entries.firstOrNull { it.value.first == phone }?.key ?: "o${++next}"
                origins[id] = phone to field(input, "label")
                originDevice[id] = field(input, "device_id")
                return "{\"origin_id\":\"$id\"}"
            }
            "phone.relink" -> {
                val phone = field(input, "phone_id")
                val on = field(input, "device_id").ifEmpty { null }
                val link = links[field(input, "link_id")] ?: return null
                if (links.values.any { it !== link && it.phoneId == phone && it.device == on }) return null
                link.phoneId = phone
                link.device = on
                link.origin = field(input, "origin_id")
                return "{\"link_id\":\"${link.id}\"}"
            }
            "phone.link" -> {
                val phone = field(input, "phone_id")
                val on = field(input, "device_id").ifEmpty { null }
                val link = links.values.firstOrNull { it.phoneId == phone && it.device == on }
                    ?: Link("l${++next}", phone, "", null, "", null).also { it.device = on; links[it.id] = it }
                link.origin = field(input, "origin_id")
                link.entity = field(input, "entity_id")
                link.fingerprint = field(input, "fingerprint")
                return "{\"link_id\":\"${link.id}\"}"
            }
            "phone.detach" -> links[field(input, "link_id")]?.let { it.detachedAt = it.detachedAt ?: SIGHTED }
            "phone.forget" -> links.remove(field(input, "link_id"))
            "phone.retire_origin" -> {
                val id = field(input, "origin_id")
                check(links.values.none { it.origin == id }) { "the origin still has links" }
                origins.remove(id)
            }
            "core.add_document" -> docs[field(input, "document_id")] =
                Doc(field(input, "title"), field(input, "staged_sha"))
            "core.replace_document_content" -> docs.getValue(field(input, "document_id")).let {
                it.hash = field(input, "staged_sha")
                it.revisions += 1
            }
            "core.trash_document" -> docs.getValue(field(input, "document_id")).trashed = true
        }
        return null
    }

    /** The phone the passes run on; a spec moves it to restore the vault onto a new phone. */
    var device: String = kotlinx.coroutines.runBlocking { dev.centraid.shared.sync.phone.PhoneDevice.id() }

    fun store() = FilesStore(script.core(), device, stager) { "doc${++next}" }

    val folder = FilesImport.origin("11111111")
    val photos = FilesImport.origin("22222222")

    fun file(path: String, content: String, mtime: Long = 1, origin: String = folder): PhoneFile {
        contents["$origin/$path"] = content
        return PhoneFile(origin, path, content.length.toLong(), mtime, "", { null })
    }

    fun origin(origin: String = folder, name: String = "Taxes") = FilesImport.folder(origin, name)

    private var pass = 0

    /** One pass; `readAt` moves on by a minute each time, as the clock does. */
    suspend fun run(
        files: List<PhoneFile>,
        origins: List<PhoneOriginRef> = listOf(origin()),
        complete: Boolean = true,
    ): FilesImport.Outcome {
        pass += 1
        val at = "2026-10-20T10:${pass.toString().padStart(2, '0')}:00.000Z"
        script.commands.clear()
        staged.clear()
        return FilesImport.sync(store(), FilesImport.snapshot(files, origins, complete, at))
    }

    fun docOf(path: String, origin: String = folder): Doc? =
        links.values.firstOrNull { it.phoneId == FilesImport.phoneId(origin, path) }?.entity?.let { docs[it] }

    companion object {
        /** Later than any `readAt` of a spec: the vault stamps its own clock. */
        const val SIGHTED = "2026-10-20T23:59:59.000Z"
    }
}

/**
 * FILES → DOCS (#1127, lane F, R-1127-7): every branch of a folder pass, run for real over a
 * vault that keeps the commands' rules.
 */
class FilesFollowSpec : StringSpec({
    "a new file becomes a document under its name, and the link names the folder and the path" {
        val bench = FilesBench()
        val outcome = bench.run(listOf(bench.file("2025/return.pdf", "bytes-1")))
        outcome.added shouldBe 1
        bench.docs.values.map { it.title } shouldContainExactly listOf("return.pdf")
        bench.docs.values.single().hash shouldBe "h:bytes-1"
        bench.links.values.single().phoneId shouldBe "local:11111111/2025/return.pdf"
        bench.origins.values.single() shouldBe ("folder:11111111" to "Taxes")
    }

    "the same path in two followed folders is two documents, not one" {
        val bench = FilesBench()
        bench.run(
            listOf(bench.file("a.pdf", "one"), bench.file("a.pdf", "two", origin = bench.photos)),
            listOf(bench.origin(), bench.origin(bench.photos, "Photos")),
        ).added shouldBe 2
        bench.docs.size shouldBe 2
        bench.links.values.map { it.phoneId }.toSet().size shouldBe 2
    }

    "a changed file is a NEW REVISION of the same document, never a second document" {
        val bench = FilesBench()
        bench.run(listOf(bench.file("a.txt", "one", mtime = 1)))
        val id = bench.docs.keys.single()
        val outcome = bench.run(listOf(bench.file("a.txt", "two!", mtime = 2)))
        outcome.updated shouldBe 1
        outcome.added shouldBe 0
        bench.docs.keys.single() shouldBe id
        bench.docs.getValue(id).hash shouldBe "h:two!"
        bench.docs.getValue(id).revisions shouldBe 2
        bench.writes shouldContainExactly listOf("core.replace_document_content", "phone.link")
    }

    "a rescan of an unchanged folder reads and hashes nothing, and writes nothing" {
        val bench = FilesBench()
        val files = { listOf(bench.file("a.txt", "one"), bench.file("b.txt", "two")) }
        bench.run(files())
        val outcome = bench.run(files())
        bench.staged.shouldBeEmpty()
        bench.writes.shouldBeEmpty()
        outcome.added + outcome.updated + outcome.trashed shouldBe 0
    }

    "a file touched without changing its bytes is read once, makes no revision, and is then settled" {
        val bench = FilesBench()
        bench.run(listOf(bench.file("a.txt", "one", mtime = 1)))
        val id = bench.docs.keys.single()
        bench.run(listOf(bench.file("a.txt", "one", mtime = 9))).updated shouldBe 1
        bench.staged.size shouldBe 1
        bench.docs.getValue(id).revisions shouldBe 1
        bench.writes shouldContainExactly listOf("phone.link")
        bench.run(listOf(bench.file("a.txt", "one", mtime = 9)))
        bench.staged.shouldBeEmpty()
        bench.writes.shouldBeEmpty()
    }

    "a document edited in Centraid detaches and is never overwritten, however the file changes" {
        val bench = FilesBench()
        bench.run(listOf(bench.file("a.txt", "one", mtime = 1), bench.file("b.txt", "bee", mtime = 1)))
        // The member renames one and saves a new revision of the other, in Docs.
        bench.docOf("a.txt")!!.title = "My taxes"
        bench.docOf("b.txt")!!.hash = "h:edited in docs"
        val outcome = bench.run(listOf(bench.file("a.txt", "one more", mtime = 2), bench.file("b.txt", "bee two", mtime = 2)))
        outcome.updated shouldBe 0
        bench.links.values.all { it.detachedAt != null } shouldBe true
        bench.docOf("a.txt")!!.hash shouldBe "h:one"
        bench.docOf("b.txt")!!.hash shouldBe "h:edited in docs"
        bench.writes.none { it == "core.replace_document_content" } shouldBe true
    }

    "a file removed from the folder sends its document to the trash and forgets the link" {
        val bench = FilesBench()
        bench.run(listOf(bench.file("a.txt", "one"), bench.file("b.txt", "two")))
        val outcome = bench.run(listOf(bench.file("a.txt", "one")))
        outcome.trashed shouldBe 1
        bench.docs.values.map { it.title to it.trashed } shouldContainExactly listOf("a.txt" to false, "b.txt" to true)
        bench.links.values.map { it.phoneId } shouldContainExactly listOf("local:11111111/a.txt")
    }

    "an incomplete read never trashes" {
        val bench = FilesBench()
        bench.run(listOf(bench.file("a.txt", "one"), bench.file("b.txt", "two")))
        val outcome = bench.run(listOf(bench.file("a.txt", "one")), complete = false)
        outcome.trashed shouldBe 0
        bench.docs.values.none { it.trashed } shouldBe true
        bench.links.size shouldBe 2
    }

    "a document the member already trashed is never brought back by the folder" {
        val bench = FilesBench()
        bench.run(listOf(bench.file("a.txt", "one", mtime = 1)))
        bench.docOf("a.txt")!!.trashed = true
        bench.run(listOf(bench.file("a.txt", "one more", mtime = 2)))
        bench.docOf("a.txt")!!.trashed shouldBe true
        bench.docOf("a.txt")!!.hash shouldBe "h:one"
        (bench.links.values.single().detachedAt != null) shouldBe true
    }

    "a folder that is gone is held and asked about; nothing is written to its documents" {
        val bench = FilesBench()
        bench.run(listOf(bench.file("a.txt", "one"), bench.file("b.txt", "two")))
        val outcome = bench.run(emptyList(), origins = emptyList())
        outcome.gone.single().let {
            it.count shouldBe 2
            it.label shouldBe "Taxes"
            it.reason shouldBe GoneReason.LEFT
        }
        outcome.trashed shouldBe 0
        bench.docs.values.none { it.trashed } shouldBe true
        bench.links.size shouldBe 2
        bench.links.values.all { it.detachedAt == null } shouldBe true
        // And it is asked about again until answered, with the same count.
        bench.run(emptyList(), origins = emptyList()).gone.single().count shouldBe 2
    }

    "Keep (the default) keeps the documents as ordinary ones and the folder's origin with them" {
        val bench = FilesBench()
        bench.run(listOf(bench.file("a.txt", "one")))
        val gone = bench.run(emptyList(), origins = emptyList()).gone.single()
        PhoneSync.resolveGone(bench.store(), gone.originId, GoneChoice.KEEP)
        bench.docs.values.none { it.trashed } shouldBe true
        (bench.links.values.single().detachedAt != null) shouldBe true
        // The folder reappears under the same id: the kept document is not followed again, nor filed twice.
        bench.run(listOf(bench.file("a.txt", "one more", mtime = 3))).added shouldBe 0
        bench.docs.size shouldBe 1
        bench.docOf("a.txt")!!.hash shouldBe "h:one"
    }

    "Move to trash trashes the unedited documents and spares the edited one" {
        val bench = FilesBench()
        bench.run(listOf(bench.file("a.txt", "one"), bench.file("b.txt", "two")))
        bench.docOf("b.txt")!!.title = "Renamed in Docs"
        val gone = bench.run(emptyList(), origins = emptyList()).gone.single()
        PhoneSync.resolveGone(bench.store(), gone.originId, GoneChoice.TRASH)
        bench.docOf("b.txt")!!.trashed shouldBe false
        bench.docs.values.count { it.trashed } shouldBe 1
    }

    "most of a folder lost in one complete read is held as VANISHED, not trashed" {
        val bench = FilesBench()
        val all = (1..8).map { bench.file("f$it.txt", "c$it") }
        bench.run(all)
        val outcome = bench.run(all.take(2))
        outcome.gone.single().let {
            it.reason shouldBe GoneReason.VANISHED
            it.count shouldBe 6
        }
        outcome.trashed shouldBe 0
        bench.docs.values.none { it.trashed } shouldBe true
    }

    "stop following forgets the links and the folder and keeps every document live" {
        val bench = FilesBench()
        bench.run(listOf(bench.file("a.txt", "one"), bench.file("b.txt", "two")))
        FilesImport.followed(bench.script.core())!!.single().let {
            it.name shouldBe "Taxes"
            it.documents shouldBe 2
            it.phoneOrigin shouldBe bench.folder
        }
        FilesImport.stop(bench.script.core(), bench.origins.keys.single()) shouldBe true
        bench.links.size shouldBe 0
        bench.origins.size shouldBe 0
        bench.docs.size shouldBe 2
        bench.docs.values.none { it.trashed } shouldBe true
        // Followed again from scratch, the same files adopt their documents rather than filing them twice.
        bench.run(listOf(bench.file("a.txt", "one"), bench.file("b.txt", "two"))).added shouldBe 2
        bench.docs.size shouldBe 2
    }

    "a document the member already has under the file's name and bytes is linked, not filed twice" {
        val bench = FilesBench()
        bench.docs["mine"] = FilesBench.Doc("a.txt", "h:one")
        bench.docs["trashed"] = FilesBench.Doc("b.txt", "h:two", trashed = true)
        bench.docs["other"] = FilesBench.Doc("c.txt", "h:different")
        bench.run(listOf(bench.file("a.txt", "one"), bench.file("b.txt", "two"), bench.file("c.txt", "three")))
        bench.script.commands.none { it.first == "core.add_document" && it.second.contains("a.txt") } shouldBe true
        bench.links.values.first { it.phoneId.endsWith("a.txt") }.entity shouldBe "mine"
        // A trashed document is not adopted, and the same name with other bytes is another file.
        bench.docs.size shouldBe 5
    }

    "a file that cannot be read is refused and not linked; the next pass tries it again" {
        val bench = FilesBench()
        val readable = bench.file("a.txt", "one")
        val unreadable = PhoneFile(bench.folder, "b.txt", 3, 1, "", { null })
        val outcome = bench.run(listOf(readable, unreadable))
        outcome.added shouldBe 1
        outcome.refused shouldBe 1
        bench.docs.size shouldBe 1
        bench.links.size shouldBe 1
        bench.contents["${bench.folder}/b.txt"] = "bee"
        bench.run(listOf(readable, unreadable)).added shouldBe 1
        bench.docs.size shouldBe 2
    }

    "hidden files and folders, empty files and a folder not in the read are not records" {
        val bench = FilesBench()
        val files = listOf(
            bench.file(".DS_Store", "x"),
            bench.file("notes/.cache/a.txt", "x"),
            bench.file("empty.txt", ""),
            bench.file("kept.txt", "y"),
            bench.file("lost.txt", "z", origin = bench.photos),
        )
        bench.run(files).added shouldBe 1
        bench.docs.values.single().title shouldBe "kept.txt"
    }

    "the vault's fingerprint is the content hash and the title, so a rename and a new revision are both edits" {
        FilesImport.vaultFields("h", "a.txt").digest() shouldBe FilesImport.vaultFields("h", "a.txt").digest()
        (FilesImport.vaultFields("h", "a.txt").digest() == FilesImport.vaultFields("h2", "a.txt").digest()) shouldBe false
        (FilesImport.vaultFields("h", "a.txt").digest() == FilesImport.vaultFields("h", "b.txt").digest()) shouldBe false
        // The phone's half is the cheap pre-check: size, modification time, title.
        (FilesImport.fields(3, 1, "a.txt").digest() == FilesImport.fields(3, 2, "a.txt").digest()) shouldBe false
    }

    "the follower asks the shell's reader for exactly the folders the vault follows, and hands the pass its read" {
        val bench = FilesBench()
        bench.run(listOf(bench.file("a.txt", "one")))
        var asked: List<String>? = null
        val pass = FilesFollow(object : FilesReader {
            override fun read(followed: List<String>, deliver: (FilesRead?) -> Unit) {
                asked = followed
                // The folder is gone: the shell lists no origin for it.
                deliver(FilesRead(emptyList(), emptyList(), complete = true))
            }
        }).bind(bench.script.core())
        pass.imported() shouldBe true
        val gone = pass.run()!!
        asked shouldBe listOf(bench.folder)
        gone.single().count shouldBe 1
        bench.docs.values.none { it.trashed } shouldBe true
    }

    "a shell that cannot read at all leaves the vault alone" {
        val bench = FilesBench()
        bench.run(listOf(bench.file("a.txt", "one")))
        bench.script.commands.clear()
        val pass = FilesFollow(object : FilesReader {
            override fun read(followed: List<String>, deliver: (FilesRead?) -> Unit) = deliver(null)
        }).bind(bench.script.core())
        pass.run() shouldBe null
        bench.script.commands.shouldBeEmpty()
    }

    "a vault restored onto a new phone whose shell still reaches the folder re-finds every file: no add, no trash, no question (F-K-1)" {
        val bench = FilesBench()
        val files = { listOf(bench.file("a.pdf", "one"), bench.file("b.pdf", "two"), bench.file("2025/c.pdf", "three")) }
        bench.run(files())
        val documents = bench.docs.keys.toSet()
        bench.device = "device-b"
        val outcome = bench.run(files())
        outcome.added shouldBe 0
        outcome.trashed shouldBe 0
        outcome.gone.shouldBeEmpty()
        bench.docs.keys shouldBe documents
        bench.docs.values.none { it.trashed } shouldBe true
        bench.links.values.map { it.device }.toSet() shouldBe setOf("device-b")
        bench.writes.filter { it != "phone.origin" } shouldContainExactly List(3) { "phone.relink" }
        bench.staged.shouldBeEmpty()
        // B's now: the next pass is quiet.
        bench.run(files())
        bench.writes.shouldBeEmpty()
    }

    "on the new phone a file the old one followed and this one does not list is forgotten and kept, never trashed or asked" {
        val bench = FilesBench()
        bench.run(listOf(bench.file("a.pdf", "one"), bench.file("b.pdf", "two")))
        val b = bench.docOf("b.pdf")!!
        bench.device = "device-b"
        val outcome = bench.run(listOf(bench.file("a.pdf", "one")))
        outcome.trashed shouldBe 0
        outcome.gone.shouldBeEmpty()
        b.trashed shouldBe false
        bench.writes.count { it == "phone.forget" } shouldBe 1
        bench.writes.none { it == "core.trash_document" } shouldBe true
    }

    "on a new phone that cannot reach the old phone's folder, its links are forgotten, its documents kept and the folder retired" {
        val bench = FilesBench()
        bench.run(listOf(bench.file("a.pdf", "one"), bench.file("b.pdf", "two")))
        bench.device = "device-b"
        val outcome = bench.run(emptyList(), origins = emptyList())
        outcome.gone.shouldBeEmpty()
        outcome.trashed shouldBe 0
        bench.docs.size shouldBe 2
        bench.docs.values.none { it.trashed } shouldBe true
        bench.links.size shouldBe 0
        bench.origins.size shouldBe 0
        // Picked again on this phone (a new folder id), the same bytes are adopted, not filed twice.
        val again = FilesImport.origin("33333333")
        bench.run(
            listOf(bench.file("a.pdf", "one", origin = again), bench.file("b.pdf", "two", origin = again)),
            origins = listOf(bench.origin(again, "Taxes")),
        )
        bench.docs.size shouldBe 2
        bench.links.size shouldBe 2
    }
})
