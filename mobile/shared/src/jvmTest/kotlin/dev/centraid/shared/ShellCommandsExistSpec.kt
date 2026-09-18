package dev.centraid.shared

import dev.centraid.shared.apps.notes.NotesEditorMachine
import dev.centraid.shared.apps.tally.TallyListMachine
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.shouldBe
import java.io.File

/**
 * EVERY COMMAND A SCREEN NAMES IS A COMMAND THE VAULT HAS (#1025 S5).
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
 * ## Why the registry's own source is the oracle
 *
 * The first draft of this pointed at `contracts/apps/<app>/commands.json` and
 * was wrong in a useful way: those bundles are SCENARIOS — the cases a parity
 * test replays — not the registry, so `tally.materialize_recurring_expense`
 * (which is real, `crates/vault/src/commands/tally.rs`) is absent from them and
 * the gate failed a name that exists. An oracle that is a sample of the surface
 * will fail honest callers, which is worse than not having one.
 *
 * `crates/vault/src/commands` is where `CommandDefinition`s are declared and
 * listed, so it IS the surface. Scanning its source rather than running it is
 * the same shape as `crates/vault/tests/one_hash.rs`, and for the same reason:
 * the check has to work from a module that cannot link Rust.
 *
 * **The scan over-matches on purpose.** Any `"app.verb"` literal in those files
 * counts, so this cannot prove a command is REGISTERED — only that the name is
 * spelled somewhere in the registry's own source. That is exactly the class of
 * defect it exists for: `knowledge.save_note` appears nowhere in this
 * repository, and a typo never does.
 */
class ShellCommandsExistSpec : StringSpec({

    val repositoryRoot = File(
        System.getProperty("centraid.repositoryRoot")
            ?: error("centraid.repositoryRoot is unset; see mobile/shared/build.gradle.kts"),
    )

    /** Every `app.verb` name spelled in the command registry's own source. */
    fun declared(): Set<String> {
        val registry = repositoryRoot.resolve("crates/vault/src/commands")
        withClue("crates/vault/src/commands is where CommandDefinitions live") {
            registry.isDirectory.shouldBeTrue()
        }
        val name = Regex("\"([a-z_]+\\.[a-z_]+)\"")
        val sources = registry.walkTopDown().filter { it.isFile && it.extension == "rs" } +
            // The app layer declares a few of its own, beside the vault's.
            repositoryRoot.resolve("crates/apps").walkTopDown()
                .filter { it.isFile && it.name == "commands.rs" }
        return sources
            .flatMap { file -> name.findAll(file.readText()).map { it.groupValues[1] } }
            .toSet()
    }

    /** Every command this shell's screens can submit. */
    val shellCommands = mapOf(
        "NotesEditorMachine.SAVE_COMMAND" to NotesEditorMachine.SAVE_COMMAND,
        "TallyListMachine.WITHHELD_VERB" to TallyListMachine.WITHHELD_VERB,
    )

    "every command a screen can submit exists in the vault's declared surface" {
        val known = declared()
        val missing = shellCommands.filterValues { it !in known }
        // The failure message IS the finding: which constant, naming what, and
        // the nearest things that do exist.
        withClue(
            missing.entries.joinToString { (where, command) ->
                "$where names \"$command\", which no app declares; " +
                    "the closest are ${known.filter {
                        it.substringBefore('.') == command.substringBefore('.')
                    }.sorted()}"
            },
        ) { missing shouldBe emptyMap() }
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

    "the oracle is not empty — a check over nothing always passes" {
        // The failure mode this repository has met before, and the reason the
        // platform-free rule asserts its own scope: a source-scanning gate
        // pointed at a moved directory reports no findings for ever.
        val known = declared()
        withClue("${known.size} command names found in the registry's source") {
            (known.size >= 100).shouldBeTrue()
        }
        known.contains("knowledge.edit_note").shouldBeTrue()
        // And the name that was wrong is genuinely absent, so this spec would
        // have been red on the tree that shipped it.
        known.contains("knowledge.save_note") shouldBe false
    }
})
