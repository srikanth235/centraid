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
 * ONE APP IS ONE WORD (#1128): the tasks a member keeps are Agenda's, so the roster
 * lists the apps a card may name and each is a scope. `thread.save_turn`'s schema,
 * the assistant's `App` and this list all read that one constant, and no app word
 * is in the vault's DDL (principle 6 of the model).
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

    /** The roster's app ids, in the order the core states them. */
    fun roster(): List<String> {
        val array = Regex("""pub const APPS: \[RosterApp; \d+\] = \[(.*?)\];""", RegexOption.DOT_MATCHES_ALL)
            .find(source("crates/vault/src/roster.rs"))
            ?: error("APPS is gone from crates/vault/src/roster.rs; point this spec at its replacement")
        return Regex("""RosterApp \{ id: "([a-z]+)" \}""").findAll(array.groupValues[1]).map { it.groupValues[1] }.toList()
    }

    "the scopes are the roster's apps: every app a card may name is a scope" {
        roster() shouldBe ChatMachine.SCOPABLE_APPS
        roster().all { ChatMachine.scopeOf(it) == it } shouldBe true
    }

    "and the vault's DDL holds no app word: the roster is the commands' schema, never a CHECK" {
        // `thread.scope` is a bare column; the command holds it to the roster.
        val ddl = source("contracts/schema/vault-ddl.sql")
        val thread = Regex("""CREATE TABLE thread \((.*?)\) STRICT;""", RegexOption.DOT_MATCHES_ALL).find(ddl)
            ?: error("thread is gone from contracts/schema/vault-ddl.sql; point this spec at its replacement")
        thread.groupValues[1].contains("scope TEXT,") shouldBe true
        thread.groupValues[1].contains("CHECK") shouldBe false
        // `health` is also the word of a phone store a followed origin names (`follow.system`); it
        // is the one roster word the DDL spells, as a store and never as an app.
        val outsideStores = ddl.lines().filterNot { it.contains("system IN (") }.joinToString("\n")
        roster().none { outsideStores.contains("'$it'") } shouldBe true
    }

    "and the scopes the assistant takes (App::ALL: every app is a scope)" {
        val scopes = Regex("""pub const ALL: \[Self; \d+\] = \[(.*?)\];""", RegexOption.DOT_MATCHES_ALL)
            .find(source("crates/assist/src/app.rs"))
            ?: error("App::ALL is gone from crates/assist/src/app.rs; point this spec at its replacement")
        Regex("""Self::([A-Za-z]+)""").findAll(scopes.groupValues[1]).map { it.groupValues[1].lowercase() }.toList() shouldBe
            ChatMachine.SCOPABLE_APPS
    }

    "health is a chat scope like every other app (the owner's ruling of 2026-10-24, #1135)" {
        // R-1129-11 ("Chat does not read Health") is superseded: its daily figures and workouts
        // are live kinds, so the shells' menu, the roster every command schema reads and the
        // assistant's app set all name Health.
        ChatMachine.SCOPABLE_APPS.contains("health") shouldBe true
        roster().contains("health") shouldBe true
        source("crates/assist/src/app.rs").contains("Health,") shouldBe true
        ChatMachine.scopeOf("health") shouldBe "health"
    }

    "Locker is among them, and the list is in the order the menu draws it" {
        ChatMachine.SCOPABLE_APPS.contains("locker") shouldBe true
        ChatMachine.SCOPABLE_APPS shouldBe ChatMachine.SCOPABLE_APPS.sorted()
    }

    "every scope is an app a member opens, and an id that is no app scopes to every app" {
        ChatMachine.SCOPABLE_APPS.all(AppHomes::isLaunchable) shouldBe true
        ChatMachine.SCOPABLE_APPS.all { SpringboardPolicy.SPRINGBOARD_ORDER.contains(it) } shouldBe true
        ChatMachine.scopeOf("tasks") shouldBe ""
        ChatMachine.scopeOf("agenda") shouldBe "agenda"
        ChatMachine.scopeOf("locker") shouldBe "locker"
        ChatMachine.scopeOf("") shouldBe ""
    }
})
