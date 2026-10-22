package dev.centraid.shared

import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.shouldBe
import java.io.File

/**
 * EVERY COMMAND THE SHARED CODE NAMES IS A COMMAND THE VAULT HAS (#1025 S5).
 *
 * ## The defect this is a gate against
 *
 * `NotesEditorMachine.SAVE_COMMAND` was `"knowledge.save_note"` and **there is
 * no such command.** The registry has `create_note`, `edit_note`, `move_note`,
 * `delete_note`, `restore_note` and the notebook verbs. `Vault::execute`
 * answered `UnknownCommand`, `crates/core` mapped that to
 * `ERROR_CODE_INVALID_REQUEST`, and a member on a real device read *"That
 * request does not make sense to this build, and nothing was changed"* — on
 * every window, for ever, because the seat kept retrying a write that could
 * never succeed.
 *
 * **Nothing caught it because nothing in the product had ever submitted a
 * write.** The machine's only exercise was a unit test asserting the effect it
 * emitted, and an effect naming a command nobody runs looks exactly like one
 * naming a command that exists. It took a phone, a real gateway, and a field on
 * `SyncOutcome` that did not exist that morning.
 *
 * ## ONE SPEC, EVERY ID — NOT A LIST SOMEONE MUST REMEMBER TO EXTEND
 *
 * This spec used to hold a hand-written map of four constants, and three app
 * specs each carried a private copy of its scan beside their own constants: a
 * screen added without an entry in the map was a screen outside the gate, and
 * the copies could disagree about what a "declared" command was. It now reads
 * the SHARED SOURCE the way it reads the registry: every `"app.verb"` literal in
 * a `shared/src/<set>Main` directory that is not recognisably something else is
 * a command id, and must be one the vault declares. A command added next month
 * is checked the day it is typed, by nobody having done anything.
 *
 * A dotted literal is NOT a command when it is one of three things, each
 * recognised by what the source says rather than by a list of names:
 *
 * 1. **A vault object type**: `ns.thing` where `ns_thing` is a table in
 *    `contracts/schema/vault-ddl.sql` (`locker.item`, `knowledge.note`) — the
 *    names a search hit or a link target carries.
 * 2. **A screen id or page-read name**: bound to `screenId`, `SCREEN_ID`, a
 *    machine's constructor name or a `PageQuery`'s `name`, or a constant that a
 *    `screenId =` in the same file reads (`LOCKER_IMPORT`), or a constant that
 *    some machine's `SCREEN_ID`/`screenId` reads through `ScreenIds.X` — the
 *    registry the cross-app routes open screens by (`nav/ScreenIds.kt`).
 * 3. **A named exception** in [notCommands] or [notCommandNamespaces] below,
 *    each with the reason it is not one. They are three entries long between
 *    them; a fourth needs a sentence.
 *
 * Anything else is a finding, and the failure names the file, the line and the
 * nearest commands that do exist. Those are real findings, not an allowlist to
 * extend.
 *
 * ## Why the registry's own source is the oracle
 *
 * The first draft of this pointed at `contracts/apps/<app>/commands.json` and
 * was wrong in a useful way: those bundles are SCENARIOS — the cases a parity
 * test replays — not the registry, so a command that is real and has no scenario
 * is absent from them and the gate failed a name that exists. An oracle that is
 * a sample of the surface will fail honest callers, which is worse than not
 * having one.
 *
 * `crates/vault/src/commands` is where `CommandDefinition`s are declared, so it
 * IS the surface. Scanning its source rather than running it is the same shape
 * as `crates/vault/tests/one_hash.rs`, and for the same reason: the check has to
 * work from a module that cannot link Rust.
 *
 * **The oracle reads DECLARATIONS, not mentions.** An earlier version accepted
 * any `"app.verb"` literal in those files, which also spelled table names and
 * the `core.merge_entity` its own comments say is not registered; a typo that
 * happened to be a table name passed. A declaration is a `name: "app.verb"`
 * field of a `CommandDefinition` (it is followed by `owner_schema:`) or the
 * first argument of a schema's `definition("app.verb", …)` helper. The two
 * forms are the only ones; [declaredCommands] counts each file's
 * `owner_schema:` fields against what it parsed and fails if a third form ever
 * appears, rather than quietly parsing fewer commands.
 */
class ShellCommandsExistSpec : StringSpec({

    val repositoryRoot = File(
        System.getProperty("centraid.repositoryRoot")
            ?: error("centraid.repositoryRoot is unset; see mobile/shared/build.gradle.kts"),
    )
    val mobileRoot = File(
        System.getProperty("centraid.mobileRoot")
            ?: error("centraid.mobileRoot is unset; see mobile/shared/build.gradle.kts"),
    )

    "every command the shared code names exists in the vault's declared surface" {
        val known = declaredCommands(repositoryRoot)
        val tables = vaultTables(repositoryRoot)
        val sources = sharedSources(mobileRoot)
        withClue("${sources.size} shared Kotlin files scanned") { (sources.size >= 150).shouldBeTrue() }
        val screens = registeredScreenIds(sources)
        val findings = sources.flatMap { (name, text) -> unknownIds(name, text, known, tables, screens) }
        // The failure message IS the finding: where, naming what, and the nearest
        // things that do exist.
        withClue(
            findings.joinToString("\n", prefix = "\n") { finding ->
                "${finding.where} names \"${finding.id}\", which no schema declares as a command " +
                    "and which is not a vault object type or a screen id; " +
                    "the closest commands are ${known.filter {
                        it.substringBefore('.') == finding.id.substringBefore('.')
                    }.sorted()}"
            },
        ) { findings shouldBe emptyList() }
    }

    "the scan reaches every kind of place a command is written" {
        // A check over nothing always passes, and a regex that quietly stopped
        // matching `const val`s would read green with half the surface gone.
        // These are one of each shape the shared code uses, and each must be
        // SEEN (counted as a command) by the same function the case above runs.
        val known = declaredCommands(repositoryRoot)
        val tables = vaultTables(repositoryRoot)
        val seen = sharedSources(mobileRoot)
            .flatMap { (_, text) -> commandLiterals(text, tables, registeredScreenIds(sharedSources(mobileRoot))) }
            .map { it.second }
            .toSet()
        listOf(
            "note.edit", // a `const val SAVE_COMMAND`
            "task.complete", // a bare `const val STATUS`
            "entity.purge", // an argument to a trash spec
            "locker.edit_item", // an `if` branch
            "thread.clear", // an argument to a helper
            "document.restore_version", // a `when` arm
        ).forEach { command ->
            withClue(command) {
                (command in seen).shouldBeTrue()
                (command in known).shouldBeTrue()
            }
        }
        withClue("${seen.size} distinct command ids found in shared code") { (seen.size >= 90).shouldBeTrue() }
    }

    "a typo is a finding, and a screen id or an object type is not" {
        val known = declaredCommands(repositoryRoot)
        val tables = vaultTables(repositoryRoot)
        val source = """
            public const val SAVE_COMMAND: String = "knowledge.save_note"
            public const val SCREEN_ID: String = "people.home"
            private const val LOCKER_IMPORT: String = "locker.import"
            screenId = LOCKER_IMPORT,
            kind = "locker.item"
            // "people.sing_a_song" in a comment is nobody's command
        """.trimIndent()
        unknownIds("Synthetic.kt", source, known, tables).map { it.id } shouldBe listOf("knowledge.save_note")
    }

    "the oracle is not empty — a check over nothing always passes" {
        // The failure mode this repository has met before, and the reason the
        // platform-free rule asserts its own scope: a source-scanning gate
        // pointed at a moved directory reports no findings for ever.
        val known = declaredCommands(repositoryRoot)
        withClue("${known.size} command names found in the registry's source") {
            (known.size >= 100).shouldBeTrue()
        }
        known.contains("note.edit").shouldBeTrue()
        // And the name that was wrong is genuinely absent, so this spec would
        // have been red on the tree that shipped it.
        known.contains("knowledge.save_note") shouldBe false
        // Declarations, not mentions: these are spelled in the registry's source
        // (a table, and a command its own comment says is not registered).
        known.contains("core.merge_entity") shouldBe false
        known.contains("core.party") shouldBe false
    }

    // THE SEAT'S THREE COMMAND NAMES ARE NOT CHECKED HERE ANY MORE, because
    // there are none (#1029 §1). This spec's second case asserted that
    // `SEAT_SYNC_COMMAND`, `SEAT_TAIL_STOP_COMMAND` and
    // `SEAT_BYTES_FETCH_COMMAND` were spelled the same in `crates/core`'s
    // `handle.rs` as in `GatewayLink.kt`, for the same reason the case above
    // exists: they are not vault commands, so the registry oracle cannot see
    // them, and a typo in one reads to a member as "that request does not make
    // sense to this build".
    //
    // `grep -rn 'seat.sync|seat.tail.stop|seat.bytes.fetch' crates/ mobile/`
    // now finds one line, and it is a sentence in a doc comment. Both the
    // constants and the `pub const`s they mirrored are deleted, so this is a
    // case whose SUBJECT is gone rather than a check removed to go green.
})

/** One dotted literal that is neither a command nor anything this spec can name. */
private data class Finding(val where: String, val id: String)

/**
 * DOTTED STRINGS THAT ARE NOT COMMANDS AND ARE NOT ANY OF THE RECOGNISED KINDS.
 * Each says what it is. A new entry is a claim that a string is not a command,
 * so it carries its reason; a string that IS a command never goes here.
 */
private val notCommands: Map<String, String> = mapOf(
    "shelf.foreground" to "a secure-store key (`Shelf.FOREGROUND_KEY`), not a request",
    "vault.db" to "a file name (`Shelf.VAULT_FILE`)",
)

/**
 * WHOLE NAMESPACES THAT ARE NOT THE VAULT'S, each with what they are.
 * `public.heic` and its siblings are Apple Uniform Type Identifiers, which the
 * iOS media walker matches a resource against; no vault schema is called
 * `public`, so nothing here can shadow a command.
 */
private val notCommandNamespaces: Map<String, String> = mapOf(
    "public" to "Apple Uniform Type Identifiers (`public.heic`, `public.jpeg`)",
)

/** A quoted `app.verb`: two lower-case snake segments, which is every command's shape. */
private val dotted = Regex("\"([a-z][a-z_]*\\.[a-z][a-z_]*)\"")

/** `name: "app.verb"` as the registry's `CommandDefinition` literal spells it. */
private val declaredByName =
    Regex("name:\\s*\"([a-z_]+\\.[a-z_]+)\",\\s*(?://[^\\n]*\\s*)*owner_schema:")

/** `definition("app.verb", …)`, the helper `locker`, `money` and `schedule` declare through. */
private val declaredByHelper = Regex("\\bdefinition\\(\\s*\"([a-z_]+\\.[a-z_]+)\"")

/** `CommandDefinition::plain("app.verb", …)`, the constructor every shared verb and every per-kind verb (#1135) declares through. */
private val declaredByPlain = Regex("\\bCommandDefinition::plain\\(\\s*\"([a-z_]+\\.[a-z_]+)\"")

/**
 * A followed system's command: `follow.rs` declares the five `follow.<system>` commands from one table
 * (`SystemMap`), each carrying its own name as `command: "follow.<system>"`, and registers them in a loop.
 */
private val declaredBySystem = Regex("\\bcommand: \"(follow\\.[a-z_]+)\"")

/** A definition's own `owner_schema:` field, which is not a doc comment's mention of one. */
private val ownerSchemaField = Regex("(?m)^\\s*owner_schema:")

/**
 * EVERY COMMAND THE VAULT DECLARES, read from `crates/vault/src/commands`.
 *
 * Fails when a file has more `owner_schema:` fields than it declared names for:
 * a third way of declaring a command would otherwise shrink this set silently,
 * and a check against a smaller set fails honest callers.
 */
private fun declaredCommands(repositoryRoot: File): Set<String> {
    val registry = repositoryRoot.resolve("crates/vault/src/commands")
    withClue("crates/vault/src/commands is where CommandDefinitions live") { registry.isDirectory.shouldBeTrue() }
    return registry.walkTopDown().filter { it.isFile && it.extension == "rs" }.flatMap { file ->
        val text = file.readText()
        val byName = declaredByName.findAll(text).map { it.groupValues[1] }.toList()
        val byHelper = declaredByHelper.findAll(text).map { it.groupValues[1] }.toList()
        val byPlain = declaredByPlain.findAll(text).map { it.groupValues[1] }.toList() +
            declaredBySystem.findAll(text).map { it.groupValues[1] }.toList()
        val fields = ownerSchemaField.findAll(text).count()
        // A file with the helper has one `owner_schema:` (the helper's own body)
        // and many calls; every other file has one field per `name:`.
        val helper = "fn definition(" in text
        // The registry's own `plain` constructor names `owner_schema:` once, as a parameter.
        val constructor = if ("const fn plain(" in text) 1 else 0
        withClue("${file.name}: $fields `owner_schema:` fields, ${byName.size} by name, ${byHelper.size} by helper") {
            fields shouldBe (if (helper) 1 else byName.size) + constructor
            if (helper) byHelper.isNotEmpty().shouldBeTrue() else byHelper shouldBe emptyList()
        }
        byName + byHelper + byPlain
    }.toSet()
}

/** The vault's tables, from the DDL the vault is built from. */
private fun vaultTables(repositoryRoot: File): Set<String> =
    Regex("(?m)^CREATE TABLE (\\w+) \\(")
        .findAll(repositoryRoot.resolve("contracts/schema/vault-ddl.sql").readText())
        .map { it.groupValues[1] }
        .toSet()

/** Every Kotlin file of every `:shared` source set, as (name, text). Generated copy is build output, not here. */
private fun sharedSources(mobileRoot: File): List<Pair<String, String>> {
    val src = mobileRoot.resolve("shared/src")
    withClue("mobile/shared/src") { src.isDirectory.shouldBeTrue() }
    return src.listFiles { dir -> dir.isDirectory && dir.name.endsWith("Main") }!!.sorted().flatMap { set ->
        set.walkTopDown().filter { it.isFile && it.extension == "kt" }.map { it.relativeTo(src).path to it.readText() }.toList()
    }
}

/**
 * Every dotted literal in [text] that is a command candidate: not in a comment,
 * not a vault object type, not bound as a screen id, not a [notCommands] entry.
 * Pairs of (line number, id).
 */
private fun commandLiterals(
    text: String,
    tables: Set<String>,
    registered: Set<String> = emptySet(),
): List<Pair<Int, String>> {
    // A constant a `screenId = NAME` in this file reads is a screen id by use,
    // and so is one a machine anywhere binds as `SCREEN_ID = ScreenIds.NAME`.
    val screenConstants = Regex("\\bscreenId\\s*=\\s*([A-Z][A-Z_]*)").findAll(text).map { it.groupValues[1] }.toSet() + registered
    // What precedes a literal that makes it a screen id or a page-read name.
    val screenBinding = Regex(
        "(?:\\bscreenId\\s*(?::\\s*String)?\\s*=\\s*|\\bSCREEN_ID\\s*(?::\\s*String)?\\s*=\\s*|" +
            "Machine<[^()]*>\\(\\s*|\\bname\\s*=\\s*)$",
    )
    val constBinding = Regex("\\bconst val ([A-Z][A-Z_]*)\\s*(?::\\s*String)?\\s*=\\s*$")
    val out = mutableListOf<Pair<Int, String>>()
    text.lineSequence().forEachIndexed { index, line ->
        val trimmed = line.trim()
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return@forEachIndexed
        dotted.findAll(line).forEach { match ->
            val id = match.groupValues[1]
            val before = line.substring(0, match.range.first)
            val isScreen = screenBinding.containsMatchIn(before) ||
                constBinding.find(before)?.groupValues?.get(1)?.let { it in screenConstants } == true
            val isObjectType = id.replace('.', '_') in tables
            val isForeign = id in notCommands || id.substringBefore('.') in notCommandNamespaces
            if (!isScreen && !isObjectType && !isForeign) out += (index + 1) to id
        }
    }
    return out
}

/** Every candidate in one file that the vault does not declare. */
private fun unknownIds(
    name: String,
    text: String,
    known: Set<String>,
    tables: Set<String>,
    registered: Set<String> = emptySet(),
): List<Finding> =
    commandLiterals(text, tables, registered).filter { it.second !in known }.map { (line, id) -> Finding("$name:$line", id) }

/**
 * THE `ScreenIds` CONSTANTS SOME SCREEN IS BOUND TO. `nav/ScreenIds.kt` states
 * the ids cross-app routes open screens by, and each machine aliases its own
 * (`SCREEN_ID = ScreenIds.AGENDA_HOME`) or `ScreenOpenings` opens it
 * (`screen(ScreenIds.TASKS_TRASH, …)`); a constant no binding reads is NOT
 * exempt, so a command parked in that file is still a finding.
 */
private fun registeredScreenIds(sources: List<Pair<String, String>>): Set<String> =
    sources.flatMap { (_, text) ->
        Regex(
            "(?:\\b[A-Z_]*SCREEN_ID|\\bscreenId)\\s*(?::\\s*String)?\\s*=\\s*ScreenIds\\.([A-Z][A-Z0-9_]*)|" +
                "\\bscreen\\(\\s*ScreenIds\\.([A-Z][A-Z0-9_]*)",
        )
            .findAll(text).map { it.groupValues[1].ifEmpty { it.groupValues[2] } }.toList()
    }.toSet()
