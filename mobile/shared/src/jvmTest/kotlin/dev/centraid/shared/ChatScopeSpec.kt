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
 * takes, so a member could never scope a chat to it. The list now lives once in
 * Kotlin, in [ChatMachine.SCOPABLE_APPS], and once in the core, as the vault's
 * one roster (`centraid_vault::roster::APPS`, R-1135-7-1); this spec ties the
 * two together. The core is Rust and this module cannot link it, so the check
 * reads its source, as `ShellCommandsExistSpec` does for the command registry.
 *
 * A CARD NAMES A DOMAIN; A CHAT IS SCOPED TO AN APP (#1128, R-1128-F2). The roster
 * lists every domain a card may name and the app a member opens it in; a scope is
 * a roster entry that opens in itself. `thread.save_turn`'s schema, the
 * assistant's `App` and this list all read that one constant, and no app word is
 * in the vault's DDL (principle 6 of the model).
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

    /** The roster's entries, `(id, opens_in)`, in the order the core states them. */
    fun roster(): List<Pair<String, String>> {
        val array = Regex("""pub const APPS: \[RosterApp; \d+\] = \[(.*?)\];""", RegexOption.DOT_MATCHES_ALL)
            .find(source("crates/vault/src/roster.rs"))
            ?: error("APPS is gone from crates/vault/src/roster.rs; point this spec at its replacement")
        return Regex("""app\("([a-z]+)", "([a-z]+)"\)""").findAll(array.groupValues[1])
            .map { it.groupValues[1] to it.groupValues[2] }
            .toList()
    }

    "the scopes are the roster's apps that open in themselves, and each card app opens in a scope" {
        val cardApps = roster().map { it.first }
        cardApps.filter(AppHomes::isLaunchable) shouldBe ChatMachine.SCOPABLE_APPS
        roster().filter { it.first == it.second }.map { it.first } shouldBe ChatMachine.SCOPABLE_APPS
        // A card app that is no scope is a folded domain, read through the scope it opens in.
        cardApps.filterNot { it in ChatMachine.SCOPABLE_APPS } shouldBe listOf("tasks")
        cardApps.all { ChatMachine.scopeOf(it) == AppHomes.appOf(it) } shouldBe true
        roster().all { (id, opensIn) -> AppHomes.appOf(id) == opensIn } shouldBe true
    }

    "and the vault's DDL holds no app word: the roster is the commands' schema, never a CHECK" {
        // `thread.scope` is a bare column; the command holds it to the roster.
        val ddl = source("contracts/schema/vault-ddl.sql")
        val thread = Regex("""CREATE TABLE thread \((.*?)\) STRICT;""", RegexOption.DOT_MATCHES_ALL).find(ddl)
            ?: error("thread is gone from contracts/schema/vault-ddl.sql; point this spec at its replacement")
        thread.groupValues[1].contains("scope TEXT,") shouldBe true
        thread.groupValues[1].contains("CHECK") shouldBe false
        roster().map { it.first }.none { ddl.contains("'$it'") } shouldBe true
    }

    "and the scopes the assistant takes (App::SCOPES)" {
        val scopes = Regex("""pub const SCOPES: \[Self; \d+\] = \[(.*?)\];""", RegexOption.DOT_MATCHES_ALL)
            .find(source("crates/assist/src/app.rs"))
            ?: error("App::SCOPES is gone from crates/assist/src/app.rs; point this spec at its replacement")
        Regex("""Self::([A-Za-z]+)""").findAll(scopes.groupValues[1]).map { it.groupValues[1].lowercase() }.toList() shouldBe
            ChatMachine.SCOPABLE_APPS
    }

    "health is in no chat scope: Chat does not read Health (R-1129-11)" {
        // Off by default in "What Chat may read" (owner answer 1): until that screen grants it,
        // no scope list names Health — the shells' menu, the roster every command schema reads
        // and the assistant's app set (its ids are the roster's).
        ChatMachine.SCOPABLE_APPS.contains("health") shouldBe false
        roster().map { it.first }.contains("health") shouldBe false
        source("crates/assist/src/app.rs").contains("Health") shouldBe false
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
