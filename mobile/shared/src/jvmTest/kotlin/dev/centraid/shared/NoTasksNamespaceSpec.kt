package dev.centraid.shared

import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldNotBeEmpty
import io.kotest.matchers.shouldBe
import java.io.File

/**
 * THERE IS NO `tasks` NAMESPACE ON THE PHONE (#1128, #1135).
 *
 * The tasks a member keeps are Agenda's: one app, one manifest, one set of
 * screens, all of them Rust's. A package or directory called `tasks`, an app id
 * `tasks`, or a `tasks.` screen or route prefix is the old split coming back,
 * and a persisted card or write that named it would route nowhere. The Rust
 * twin is `no_app_manifest_crate_or_query_namespace_is_called_tasks` in
 * `crates/core/src/catalog.rs`.
 *
 * It reads SOURCE under `mobile/<module>/src`: every directory name, and every
 * non-test source set's Kotlin outside comments. The core's own protobuf arms
 * (`tasks_board`…) are not a namespace and are not spelled as `"tasks"`.
 */
class NoTasksNamespaceSpec : StringSpec({
    val mobileRoot = File(
        System.getProperty("centraid.mobileRoot")
            ?: error("centraid.mobileRoot is unset; see mobile/shared/build.gradle.kts"),
    )
    val sources = mobileRoot.listFiles { module -> module.resolve("src").isDirectory }.orEmpty()
        .sortedBy { it.name }
        .map { it.resolve("src") }

    val directories = sources.flatMap { src -> src.walkTopDown().filter { it.isDirectory }.toList() }

    // Non-test source sets only: a test may assert the absence this spec polices.
    val kotlin = sources
        .flatMap { src -> src.listFiles { set -> set.isDirectory && !set.name.contains("test", ignoreCase = true) }.orEmpty().toList() }
        .flatMap { set -> set.walkTopDown().filter { it.isFile && it.extension == "kt" }.toList() }

    fun code(file: File): List<Pair<Int, String>> = file.readLines().mapIndexedNotNull { index, line ->
        val text = line.trim()
        if (text.startsWith("//") || text.startsWith("*") || text.startsWith("/*")) null else (index + 1) to text
    }

    val banned = listOf(
        Regex("""\bAppIds\.TASKS\b"""),
        Regex("""\bconst val TASKS\b"""),
        Regex(""""tasks[."]"""),
        Regex("""^(?:package|import) dev\.centraid\.[\w.]*\btasks\b"""),
    )

    "the scan sees the trees it polices" {
        sources.shouldNotBeEmpty()
        kotlin.shouldNotBeEmpty()
        kotlin.any { it.name == "AgendaEntry.kt" } shouldBe true
    }

    "no package or directory under mobile/*/src is called tasks" {
        val found = directories.filter { it.name.equals("tasks", ignoreCase = true) }.map { it.relativeTo(mobileRoot).path }
        withClue("the tasks are Agenda's; a `tasks` directory is the old app:\n${found.joinToString("\n")}") {
            found shouldBe emptyList()
        }
    }

    "no source names a tasks app id or a tasks. prefix" {
        val found = kotlin.flatMap { file ->
            code(file).filter { (_, text) -> banned.any { it.containsMatchIn(text) } }
                .map { (line, text) -> "${file.relativeTo(mobileRoot).path}:$line: $text" }
        }
        withClue("the tasks are Agenda's: say `agenda`, route to `agenda.<screen>`:\n${found.joinToString("\n")}") {
            found shouldBe emptyList()
        }
    }
})
