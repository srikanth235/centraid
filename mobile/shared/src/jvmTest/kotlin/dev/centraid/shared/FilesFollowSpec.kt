package dev.centraid.shared

import dev.centraid.shared.apps.docs.FileStager
import dev.centraid.shared.apps.docs.FilesFollow
import dev.centraid.shared.apps.docs.FilesImport
import dev.centraid.shared.apps.docs.FilesRead
import dev.centraid.shared.apps.docs.FilesReader
import dev.centraid.shared.apps.docs.PhoneFile
import dev.centraid.shared.apps.docs.StagedFile
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain

/**
 * THE FILES FOLLOWER SENDS RECORDS AND THE VAULT MERGES (#1135, R-1127-7): one `follow.files` per
 * folder, the bytes of a new or moved file staged and claimed first, and the vault's own word
 * (`source.stated`) deciding which files are read at all. The merge itself (a changed file is a
 * new revision, a file the member edited stands, a file gone from a complete read)
 * is `crates/vault/tests/docs_photos.rs`.
 */
class FilesFollowSpec : StringSpec({
    val folder = FilesImport.origin("11111111")
    val other = FilesImport.origin("22222222")
    val device = "device-a"

    class Bench {
        val script = ScriptedCore()
        val staged = mutableListOf<String>()
        val unreadable = mutableSetOf<String>()

        /** What the vault holds as last stated: `folder ref` to (`path` to `stat`). */
        val stated = mutableMapOf<String, MutableMap<String, String>>()
        val origins = mutableListOf<Pair<String, String>>()

        val stager = FileStager { file ->
            staged += "${file.origin}/${file.path}"
            if (file.path in unreadable) null else StagedFile("h-${file.path}", file.size)
        }

        init {
            script.pages = { name, _ ->
                when (name) {
                    "files.origins", "files.followed" -> origins.mapIndexed { at, (ref, label) -> listOf("o$at", ref, label) }
                    "files.sources" -> stated.flatMap { (ref, files) ->
                        val at = origins.indexOfFirst { it.first == ref }
                        files.map { (path, stat) -> listOf("s-$ref-$path", "o$at", path, "{\"stat\":\"$stat\",\"title\":\"x\"}") }
                    }
                    "files.followed.documents" -> stated.flatMap { (ref, files) ->
                        val at = origins.indexOfFirst { it.first == ref }
                        files.keys.map { path -> listOf("s-$ref-$path", "o$at", "doc-$path") }
                    }
                    else -> emptyList()
                }
            }
        }

        fun file(path: String, size: Long = 10, mtime: Long = 1, origin: String = folder, mediaType: String = "") =
            PhoneFile(origin, path, size, mtime, mediaType, { null })

        suspend fun run(files: List<PhoneFile>, complete: Boolean = true, folders: List<String> = listOf(folder)) =
            FilesImport.run(
                script.core(),
                files,
                folders.map { FilesImport.folder(it, if (it == folder) "Taxes" else "Photos") },
                complete,
                device,
                stager,
            )

        val follows get() = script.commands.filter { it.first == "follow.files" }.map { it.second }
    }

    "a new file is staged, claimed at the size the core counted, and sent as one record under its path" {
        val bench = Bench()
        bench.script.answers = { name, _ -> if (name == "follow.files") "{\"added\":1,\"matched\":1,\"updated\":2,\"trashed\":3}" else null }
        val outcome = bench.run(listOf(bench.file("2025/return.pdf", size = 2048, mtime = 7)))
        bench.script.commands.map { it.first } shouldContainExactly listOf("blob.stage", "follow.files")
        bench.script.commands[0].second shouldBe """{"hash":"h-2025/return.pdf","size":2048}"""
        val sent = bench.follows.single()
        sent shouldContain """"ref":"folder:11111111""""
        sent shouldContain """"label":"Taxes""""
        sent shouldContain """"device_id":"device-a""""
        sent shouldContain """"external_id":"2025/return.pdf""""
        sent shouldContain """"title":"return.pdf""""
        sent shouldContain """"blob":"h-2025/return.pdf""""
        sent shouldContain """"media_type":"application/pdf""""
        sent shouldContain """"stat":"2048:7""""
        sent shouldContain """"complete":true"""
        (outcome.added to outcome.updated) shouldBe (2 to 2)
        outcome.trashed shouldBe 3
    }

    "a rescan of an unchanged folder stages nothing, claims nothing, and sends the stat alone" {
        val bench = Bench()
        bench.origins += folder to "Taxes"
        bench.stated[folder] = mutableMapOf("a.txt" to "10:1", "b.txt" to "10:1")
        bench.run(listOf(bench.file("a.txt"), bench.file("b.txt")))
        bench.staged.shouldBeEmpty()
        bench.script.commands.map { it.first } shouldContainExactly listOf("follow.files")
        bench.follows.single() shouldNotContain "\"blob\""
        bench.follows.single() shouldContain """"stat":"10:1""""
        bench.follows.single() shouldContain """"complete":true"""
    }

    "a file whose size or time moved is read again, and only that file" {
        val bench = Bench()
        bench.origins += folder to "Taxes"
        bench.stated[folder] = mutableMapOf("a.txt" to "10:1", "b.txt" to "10:1")
        bench.run(listOf(bench.file("a.txt"), bench.file("b.txt", mtime = 2)))
        bench.staged shouldContainExactly listOf("$folder/b.txt")
        bench.follows.single() shouldContain """"stat":"10:2""""
    }

    "a file that would not read is not sent and not missed: nothing is trashed on that read" {
        val bench = Bench()
        bench.unreadable += "bad.pdf"
        val outcome = bench.run(listOf(bench.file("good.pdf"), bench.file("bad.pdf")))
        outcome.refused shouldBe 1
        bench.follows.single() shouldContain """"external_id":"good.pdf""""
        bench.follows.single() shouldNotContain "bad.pdf"
        bench.follows.single() shouldContain """"complete":false"""
    }

    "a read the shell says is partial is sent as partial" {
        val bench = Bench()
        bench.run(listOf(bench.file("a.pdf")), complete = false)
        bench.follows.single() shouldContain """"complete":false"""
    }

    "hidden files, empty files and a path met twice are not records" {
        val bench = Bench()
        bench.run(
            listOf(
                bench.file("a.pdf"),
                bench.file("a.pdf"),
                bench.file(".trash/old.pdf"),
                bench.file("dir/.hidden"),
                bench.file("empty.txt", size = 0),
            ),
        )
        Regex("\"external_id\"").findAll(bench.follows.single()).count() shouldBe 1
    }

    "two folders are two commands, each with its own files, and the same path is not one file" {
        val bench = Bench()
        bench.run(
            listOf(bench.file("a.pdf"), bench.file("a.pdf", origin = other)),
            folders = listOf(folder, other),
        )
        bench.follows.size shouldBe 2
        bench.follows[0] shouldContain """"ref":"folder:11111111""""
        bench.follows[1] shouldContain """"ref":"folder:22222222""""
    }

    "a folder the shell could not reach is not told: no command, so nothing is trashed for it" {
        val bench = Bench()
        bench.origins += folder to "Taxes"
        bench.origins += other to "Photos"
        bench.run(listOf(bench.file("a.pdf")), folders = listOf(folder))
        bench.follows.size shouldBe 1
        bench.follows.single() shouldNotContain "folder:22222222"
    }

    "the vault refusing a folder counts its records as refused, and the next folder still goes" {
        val bench = Bench()
        var told = 0
        bench.script.refuses = { it == "follow.files" && told++ == 0 }
        val outcome = bench.run(
            listOf(bench.file("a.pdf"), bench.file("a.pdf", origin = other)),
            folders = listOf(folder, other),
        )
        bench.follows.size shouldBe 2
        outcome.refused shouldBe 1
    }

    "following a folder makes its Docs folder, then the origin that fills it" {
        val bench = Bench()
        bench.script.answers = { name, _ -> if (name == "container.create") "{\"id\":\"f-1\"}" else null }
        FilesImport.follow(bench.script.core(), FilesImport.folder(folder, "Taxes"), device) shouldBe true
        bench.script.commands.map { it.first } shouldContainExactly listOf("container.create", "follow.files")
        bench.script.commands[0].second shouldBe """{"kind":"folder","title":"Taxes"}"""
        bench.script.commands[1].second shouldContain """"fills":"f-1""""
        bench.script.commands[1].second shouldContain """"records":[]"""
        bench.script.commands[1].second shouldContain """"complete":false"""
    }

    "following a folder already followed makes no second Docs folder" {
        val bench = Bench()
        bench.origins += folder to "Taxes"
        FilesImport.follow(bench.script.core(), FilesImport.folder(folder, "Taxes (renamed)"), device) shouldBe true
        bench.script.commands.map { it.first } shouldContainExactly listOf("follow.files")
        bench.script.commands.single().second shouldNotContain "fills"
    }

    "stopping a folder is the vault's `follow.stop`, and nothing else" {
        val bench = Bench()
        FilesImport.stop(bench.script.core(), folder) shouldBe true
        bench.script.commands.single() shouldBe ("follow.stop" to """{"system":"files","ref":"folder:11111111"}""")
        bench.script.refuses = { true }
        FilesImport.stop(bench.script.core(), folder) shouldBe false
    }

    "the followed list is the vault's origins with the documents each holds, by name" {
        val bench = Bench()
        bench.origins += folder to "Taxes"
        bench.origins += other to "Archive"
        bench.stated[folder] = mutableMapOf("a" to "1:1", "b" to "1:1")
        val followed = FilesImport.followed(bench.script.core())!!
        followed.map { Triple(it.phoneOrigin, it.name, it.documents) } shouldContainExactly
            listOf(Triple(other, "Archive", 0), Triple(folder, "Taxes", 2))
    }

    "a pass through the follower reads the followed folders and answers none held for a question" {
        val bench = Bench()
        bench.origins += folder to "Taxes"
        var asked: List<String>? = null
        val reader = object : FilesReader {
            override fun read(followed: List<String>, deliver: (FilesRead?) -> Unit) {
                asked = followed
                deliver(FilesRead(emptyList(), listOf(FilesImport.folder(folder, "Taxes")), complete = true))
            }
        }
        val pass = FilesFollow(reader).bind(bench.script.core())
        pass.run() shouldBe emptyList()
        asked shouldBe listOf(folder)
        bench.script.commands.single().first shouldBe "follow.files"
    }
})
