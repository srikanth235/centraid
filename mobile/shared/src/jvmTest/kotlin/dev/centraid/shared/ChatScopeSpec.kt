package dev.centraid.shared

import dev.centraid.shared.chat.ChatMachine
import dev.centraid.shared.nav.AppHomes
import dev.centraid.shared.shell.SpringboardPolicy
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
 * in [ChatMachine.SCOPABLE_APPS], and this spec ties it to every place the core
 * states it. The core is Rust and this module cannot link it, so the check
 * reads its source, as `ShellCommandsExistSpec` does for the command registry.
 *
 * A CARD NAMES A DOMAIN; A CHAT IS SCOPED TO AN APP (#1128, R-1128-F2). The two
 * lists were one until Tasks folded into Agenda: a card still names `tasks`,
 * and the scopes are the card apps a member opens, so the card list is tied to
 * its own source and the scope list to the three that state it.
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

    "the scopes are the vault's card apps a member opens, and each card app opens in a scope" {
        val array = Regex("""const CARD_APPS: \[&str; \d+\] = \[(.*?)\];""", RegexOption.DOT_MATCHES_ALL)
            .find(source("crates/vault/src/chat.rs"))
            ?: error("CARD_APPS is gone from crates/vault/src/chat.rs; point this spec at its replacement")
        val cardApps = quoted(array.groupValues[1])
        cardApps.filter(AppHomes::isLaunchable) shouldBe ChatMachine.SCOPABLE_APPS
        // A card app that is no scope is a folded domain, read through the scope it opens in.
        cardApps.filterNot { it in ChatMachine.SCOPABLE_APPS } shouldBe listOf("tasks")
        cardApps.all { ChatMachine.scopeOf(it) == AppHomes.appOf(it) } shouldBe true
    }

    "and the apps chat.save_turn accepts as a thread's scope" {
        val schema = Regex(""""scope_app": \{\s*"enum": \[(.*?)\]""", RegexOption.DOT_MATCHES_ALL)
            .find(source("crates/vault/src/commands/chat.rs"))
            ?: error("scope_app's enum is gone from crates/vault/src/commands/chat.rs; point this spec at its replacement")
        // The enum also admits null, the unscoped chat; `quoted` sees only the names.
        quoted(schema.groupValues[1]) shouldBe ChatMachine.SCOPABLE_APPS
    }

    "and the chat_thread CHECK a vault holds at the ladder head" {
        // `contracts/schema/vault-ddl.sql` is the schema a founded vault holds, and
        // `crates/vault/tests/ladder_ddl.rs` diffs it against one on every run, so it
        // names the rung that states the CHECK today whatever that rung is numbered.
        val check = Regex("""scope_app IN \((.*?)\)""")
            .find(source("contracts/schema/vault-ddl.sql"))
            ?: error("chat_thread.scope_app's CHECK is gone from contracts/schema/vault-ddl.sql; point this spec at it")
        Regex("'([a-z]+)'").findAll(check.groupValues[1]).map { it.groupValues[1] }.toList() shouldBe
            ChatMachine.SCOPABLE_APPS
    }

    "and the scopes the assistant takes (App::SCOPES)" {
        val scopes = Regex("""pub const SCOPES: \[Self; \d+\] = \[(.*?)\];""", RegexOption.DOT_MATCHES_ALL)
            .find(source("crates/assist/src/app.rs"))
            ?: error("App::SCOPES is gone from crates/assist/src/app.rs; point this spec at its replacement")
        Regex("""Self::([A-Za-z]+)""").findAll(scopes.groupValues[1]).map { it.groupValues[1].lowercase() }.toList() shouldBe
            ChatMachine.SCOPABLE_APPS
    }

    "Locker is not among them, and the list is in the order the menu draws it" {
        ChatMachine.SCOPABLE_APPS.contains("locker") shouldBe false
        ChatMachine.SCOPABLE_APPS shouldBe ChatMachine.SCOPABLE_APPS.sorted()
    }

    "every scope is an app a member opens, and a visit to a folded domain scopes to its app (#1128)" {
        ChatMachine.SCOPABLE_APPS.all(AppHomes::isLaunchable) shouldBe true
        ChatMachine.SCOPABLE_APPS.all { SpringboardPolicy.SPRINGBOARD_ORDER.contains(it) } shouldBe true
        ChatMachine.scopeOf("tasks") shouldBe "agenda"
        ChatMachine.scopeOf("agenda") shouldBe "agenda"
        ChatMachine.scopeOf("locker") shouldBe ""
        ChatMachine.scopeOf("") shouldBe ""
    }
})
