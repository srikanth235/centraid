package dev.centraid.shared

import centraid.core.v1.Envelope
import centraid.core.v1.Error
import centraid.core.v1.ErrorCode
import centraid.core.v1.FoundResponse
import centraid.core.v1.Response
import dev.centraid.core.CentraidCore
import dev.centraid.shared.shell.Shelf
import dev.centraid.shared.shell.VaultRoster
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest

/**
 * THE DOOR THE PHONE WAS MISSING (#1029 W5, hand-off 1).
 *
 * `Core::open` with `create` lays the migrations down and stops there. The two
 * rows that make those tables a vault — `core_vault` and the owner's
 * `core_party` — are `centraid_vault::Vault::found`'s, and until W5 nothing
 * over the C ABI could reach it: there was no `Request` arm in
 * `envelope.proto`. `Shelf.found` was written correct against a door that did
 * not exist and deleted the file it made, every time, honestly.
 *
 * What is proved HERE is the envelope the shelf sends and what it makes of the
 * answer. What is proved in Rust — the row is written, a second found is
 * refused, the file names itself afterwards — is
 * `crates/core/src/api.rs::founding_turns_a_created_file_into_a_vault_that_can_name_itself`
 * and `crates/core/src/handle.rs::a_found_request_over_the_envelope_makes_the_file_a_vault`.
 * The JVM cannot load the real core in `:shared` (no `jna.library.path` here;
 * `:core`'s suite is the one that dlopens the cdylib), so this half drives a
 * responding stub.
 */
class FoundDoorSpec : StringSpec({

    /**
     * A core that records what it was asked and answers what it is told to.
     */
    fun core(asked: MutableList<Envelope>, answer: (Envelope) -> Envelope) =
        CentraidCore.answering(Dispatchers.Unconfined) { request ->
            asked += request
            answer(request)
        }

    "the found the shelf sends carries the name and the owner, and nothing else" {
        runTest {
            val asked = mutableListOf<Envelope>()
            val open = core(asked) {
                Envelope(response = Response(found = FoundResponse(vault_id = "v-7")))
            }
            VaultRoster.found(open, displayName = "Tahoe", ownerName = "Me").shouldBeTrue()

            asked.size shouldBe 1
            val request = asked.single().request.shouldNotBeNull()
            val found = request.found.shouldNotBeNull()
            found.display_name shouldBe "Tahoe"
            found.owner_name shouldBe "Me"
            // AND IT IS A FOUND AND NOT A COMMAND. Founding cannot be a
            // registered command: the registry's gate order evaluates a
            // principal against `core_vault.self_party_id` and writes a receipt
            // naming the vault — both of them rows this act is what WRITES.
            request.command shouldBe null
            request.page shouldBe null
        }
    }

    "a refusal is false, and the shelf deletes the file rather than keeping a nameless one" {
        runTest {
            val asked = mutableListOf<Envelope>()
            // `ERROR_CODE_VAULT_ALREADY_HELD` is what `api::found` answers for a
            // file that already holds a vault. A shell that treated it as a
            // success would put a second holding on the shelf under an id it
            // read off somebody else's row.
            val open = core(asked) {
                Envelope(
                    error = Error(
                        code = ErrorCode.ERROR_CODE_VAULT_ALREADY_HELD,
                        sentence = "There is already a vault in that file, so it was left alone.",
                    ),
                )
            }
            VaultRoster.found(open, displayName = "Tahoe", ownerName = "Me").shouldBeFalse()
        }
    }

    "an answer with an empty vault id is not a founding" {
        runTest {
            val asked = mutableListOf<Envelope>()
            // A `Response` with a default `FoundResponse` in it decodes fine and
            // says nothing. Taking it for a success is how a shelf ends up with
            // a holding whose id is the empty string — which `Shelf.found` then
            // matches against every other unidentified file.
            val open = core(asked) { Envelope(response = Response(found = FoundResponse())) }
            VaultRoster.found(open, displayName = "", ownerName = "").shouldBeFalse()
        }
    }

    "the defaults a shell founds with are a name a member could live with" {
        // The make-vault sheet on both shells is a button and no text field, so
        // the found has to carry a string. It is written to
        // `core_vault.display_name` — the one place a vault's name lives — and
        // a member who never renames it reads it on the header every day.
        Shelf.DEFAULT_VAULT_NAME shouldBe "My vault"
        Shelf.DEFAULT_OWNER_NAME shouldBe "Me"
    }
})
