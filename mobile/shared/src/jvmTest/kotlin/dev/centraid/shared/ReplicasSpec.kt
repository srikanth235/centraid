package dev.centraid.shared

import dev.centraid.shared.shell.MountKey
import dev.centraid.shared.shell.Replicas
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import okio.FileSystem
import okio.Path.Companion.toPath

/**
 * A REPLICA AND ITS BYTES MOVE TOGETHER (#1025 S5, D-1025-S5-2).
 *
 * These exist because the simulator run found the defect and reading did not.
 * The byte store is `replica.with_extension("bytes")` in `crates/seat-link` —
 * the last extension REPLACED — and the first draft of [Replicas] appended
 * instead, so a settled replica left the pairing file's store behind and opened
 * a fresh empty store beside itself.
 *
 * **Nothing failed.** The rows were all there; every photograph the bootstrap
 * had just downloaded was simply not, and a library of rows pointing at nothing
 * renders as placeholders rather than as an error (D-1025-S3-1). A defect whose
 * only symptom is a cell that stays grey is one no assertion elsewhere would
 * have caught, so the naming rule is pinned here by name.
 */
class ReplicasSpec : StringSpec({

    val fs = FileSystem.SYSTEM

    fun scratch(): String {
        val dir = FileSystem.SYSTEM_TEMPORARY_DIRECTORY
            .resolve("centraid-replicas-${kotlin.random.Random.nextLong()}")
        fs.createDirectories(dir)
        return dir.toString()
    }

    "a settle carries the byte store, and the store's name replaces the extension" {
        val dir = scratch()
        val root = dir.toPath()
        fs.write(root.resolve(Replicas.PAIRING_FILE)) { writeUtf8("rows") }
        // The name `crates/seat-link` actually uses: `with_extension("bytes")`
        // on the replica, which REPLACES the last extension and does not append
        // to it.
        fs.createDirectories(root.resolve("centraid-pairing.bytes"))
        fs.write(root.resolve("centraid-pairing.bytes/blob")) { writeUtf8("a photograph") }

        val settled = Replicas.settle(dir, "vlt-1")
        settled shouldBe root.resolve(MountKey("vlt-1").fileName).toString()
        fs.exists(root.resolve(MountKey("vlt-1").fileName)).shouldBeTrue()
        // THE ASSERTION THAT WOULD HAVE CAUGHT IT: the bytes are under the new
        // name, and nothing is left behind under the old one.
        fs.exists(root.resolve(MountKey("vlt-1").fileName.substringBeforeLast('.') + ".bytes/blob")).shouldBeTrue()
        fs.exists(root.resolve("centraid-pairing.bytes")).shouldBeFalse()
        fs.exists(root.resolve(Replicas.PAIRING_FILE)).shouldBeFalse()
    }

    "the roster is the directory, and it is only replicas" {
        val dir = scratch()
        val root = dir.toPath()
        listOf(
            MountKey("vlt-2").fileName,
            MountKey("vlt-1").fileName,
            // A pairing file is not a vault the member can switch to: it has no
            // id to switch BY.
            Replicas.PAIRING_FILE,
            // SQLite's sidecars, and a stray file. Opening either as a vault
            // fails at the door, so neither may be offered as one.
            MountKey("vlt-1").fileName + "-wal",
            "notes.txt",
        ).forEach { fs.write(root.resolve(it)) { writeUtf8("x") } }

        Replicas.list(dir) shouldContainExactly listOf(
            root.resolve(MountKey("vlt-1").fileName).toString(),
            root.resolve(MountKey("vlt-2").fileName).toString(),
        )
    }

    "a directory that does not exist is an empty roster, not a throw" {
        // The ordinary first run: the shell's Documents has no replicas in it
        // and the member has not paired. An exception here would be an app that
        // will not start on its very first launch.
        Replicas.list("/no/such/directory/anywhere").shouldBeEmpty()
    }

    "settling onto a vault this device already holds keeps the one it has" {
        val dir = scratch()
        val root = dir.toPath()
        fs.write(root.resolve(Replicas.PAIRING_FILE)) { writeUtf8("the new copy") }
        fs.write(root.resolve(MountKey("vlt-1").fileName)) { writeUtf8("the one with the outbox") }

        Replicas.settle(dir, "vlt-1") shouldBe root.resolve(MountKey("vlt-1").fileName).toString()
        // A SECOND PAIRING MUST NOT TAKE THE OUTBOX. The existing replica is
        // carrying the member's unsent writes; replacing it with a fresh copy
        // from the gateway would discard them with nothing said.
        fs.read(root.resolve(MountKey("vlt-1").fileName)) { readUtf8() } shouldBe "the one with the outbox"
    }

    "settling when there is nothing to settle is a null and not a file" {
        Replicas.settle(scratch(), "vlt-1").shouldBeNull()
    }
})

private fun List<String>.shouldBeEmpty() = this shouldBe emptyList()
