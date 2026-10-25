package dev.centraid.shared

import java.io.File

/**
 * THE STORE WORDS RUST'S KIND TABLE NAMES (#1129, #1135): the left column of `TABLE` in
 * `crates/screens/src/health/kinds.rs`, read from the repository root [repo]. The shells' readers
 * send the store's word whole, so the words they name are held to these.
 */
internal fun kindWords(repo: File): Set<String> {
    val text = repo.resolve("crates/screens/src/health/kinds.rs").readText()
    val table = text.substringAfter("pub const TABLE").substringBefore("];")
    return Regex("""\("(\w+)",\s*[A-Z]+\)""").findAll(table).map { it.groupValues[1] }.toSet()
}
