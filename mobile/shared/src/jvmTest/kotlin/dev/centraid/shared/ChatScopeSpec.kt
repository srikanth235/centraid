package dev.centraid.shared

import dev.centraid.shared.chat.ChatMachine
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.shouldBe
import java.io.File

/**
 * THE APPS A CHAT CAN BE SCOPED TO ARE THE APPS THE CORE ACCEPTS.
 *
 * The iOS shell hand-listed six of them and left Money out, which the core
 * takes, so a member could never scope a chat to it. The list now lives once,
 * in [ChatMachine.SCOPABLE_APPS], and this spec ties it to the two places the
 * core states it. The core is Rust and this module cannot link it, so the
 * check reads its source, as `ShellCommandsExistSpec` does for the command
 * registry.
 */
class ChatScopeSpec : StringSpec({

    val repositoryRoot = File(
        System.getProperty("centraid.repositoryRoot")
            ?: error("centraid.repositoryRoot is unset; see mobile/shared/build.gradle.kts"),
    )

    fun source(path: String): String {
        val file = repositoryRoot.resolve(path)
        withClue("$path is where the core states the apps a chat may name") { file.isFile.shouldBeTrue() }
        return file.readText()
    }

    fun quoted(text: String): List<String> = Regex("\"([a-z]+)\"").findAll(text).map { it.groupValues[1] }.toList()

    "the shells' scope menu lists exactly the apps the vault's card list names" {
        val array = Regex("""const CARD_APPS: \[&str; \d+\] = \[(.*?)\];""", RegexOption.DOT_MATCHES_ALL)
            .find(source("crates/vault/src/chat.rs"))
            ?: error("CARD_APPS is gone from crates/vault/src/chat.rs; point this spec at its replacement")
        quoted(array.groupValues[1]) shouldBe ChatMachine.SCOPABLE_APPS
    }

    "and the apps chat.save_turn accepts as a thread's scope" {
        val schema = Regex(""""scope_app": \{\s*"enum": \[(.*?)\]""", RegexOption.DOT_MATCHES_ALL)
            .find(source("crates/vault/src/commands/chat.rs"))
            ?: error("scope_app's enum is gone from crates/vault/src/commands/chat.rs; point this spec at its replacement")
        // The enum also admits null, the unscoped chat; `quoted` sees only the names.
        quoted(schema.groupValues[1]) shouldBe ChatMachine.SCOPABLE_APPS
    }

    "Locker is not among them, and the list is in the order the menu draws it" {
        ChatMachine.SCOPABLE_APPS.contains("locker") shouldBe false
        ChatMachine.SCOPABLE_APPS shouldBe ChatMachine.SCOPABLE_APPS.sorted()
    }
})
