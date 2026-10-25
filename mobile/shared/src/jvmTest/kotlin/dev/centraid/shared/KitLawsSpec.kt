package dev.centraid.shared

import centraid.core.v1.CommandStatus
import centraid.screen.v1.SearchAsk
import centraid.screen.v1.SearchField
import centraid.screen.v1.WriteSettled
import centraid.screen.v1.WriteState
import dev.centraid.shared.kit.SearchLaw
import dev.centraid.shared.kit.SearchLens
import dev.centraid.shared.kit.WriteLaw
import dev.centraid.shared.kit.WriteLens
import dev.centraid.shared.screen.ScreenEffect
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe

/**
 * THE KIT'S LAWS THAT THE KMP CHAT STILL RUNS (the five-app kit, K2–K4; #1135):
 * search and the write. The paged list, the band and the trash screen they were
 * once pinned through are Rust's (`crates/screens/src/kit/{trash,search,act}.rs`
 * and each app's tests); their KMP twins left with their last caller.
 */
class KitLawsSpec : StringSpec({

    // --- Search -----------------------------------------------------------

    "search: a term reads, a blank term does not, and close clears the term and its answer" {
        var field = SearchField()
        val lens = object : SearchLens<SearchField> {
            override val screenId: String = "probe.search"
            override val askScope: String = "notes"
            override fun field(state: SearchField): SearchField = state
            override fun with(state: SearchField, field: SearchField): SearchField = field
        }
        field = SearchLaw.opened(lens, field).state
        field.open_ shouldBe true
        SearchLaw.term(lens, field, "  ").effects.shouldBeEmpty()
        val typed = SearchLaw.term(lens, field, "dinner")
        typed.effects shouldBe listOf(ScreenEffect.ReadPage("probe.search", null))
        field = SearchLaw.answered(lens, typed.state, "dinner")
        field.answered_term shouldBe "dinner"
        SearchLaw.closed(lens, field).state shouldBe SearchField()
    }

    "search: an answer for a term the member has since changed is stale" {
        val lens = object : SearchLens<SearchField> {
            override val screenId: String = "probe.search"
            override val askScope: String = "notes"
            override fun field(state: SearchField): SearchField = state
            override fun with(state: SearchField, field: SearchField): SearchField = field
        }
        val field = SearchLaw.term(lens, SearchLaw.term(lens, SearchField(), "din").state, "dinner").state
        SearchLaw.answerIsCurrent(lens, field, "din") shouldBe false
        SearchLaw.answerIsCurrent(lens, field, "dinner") shouldBe true
        SearchLaw.answerIsCurrent(lens, SearchLaw.closed(lens, field).state, "dinner") shouldBe false
    }

    "search: the words corrected are kept for the current answer, cleared by a new term or a close, and never set for a stale or blank one (#1097)" {
        val lens = object : SearchLens<SearchField> {
            override val screenId: String = "probe.search"
            override val askScope: String = "notes"
            override fun field(state: SearchField): SearchField = state
            override fun with(state: SearchField, field: SearchField): SearchField = field
        }
        val typed = SearchLaw.term(lens, SearchLaw.opened(lens, SearchField()).state, "dinnre").state
        val fixed = SearchLaw.answered(lens, typed, "dinnre", "dinner")
        fixed.corrected shouldBe "dinner"
        fixed.answered_term shouldBe "dinnre"
        // The default is an exact answer, which also clears an earlier correction.
        SearchLaw.answered(lens, fixed, "dinnre").corrected shouldBe ""
        // A new term and a close clear it.
        SearchLaw.term(lens, fixed, "dinn").state.corrected shouldBe ""
        SearchLaw.closed(lens, fixed).state.corrected shouldBe ""
        // An answer for another term, a closed field or a blank term sets none.
        SearchLaw.answered(lens, typed, "din", "dinner").corrected shouldBe ""
        SearchLaw.answered(lens, SearchLaw.closed(lens, fixed).state, "dinnre", "dinner").corrected shouldBe ""
        SearchLaw.answered(lens, SearchLaw.term(lens, typed, " ").state, " ", "dinner").corrected shouldBe ""
        // Spaces at the ends are not another term.
        SearchLaw.answered(lens, SearchLaw.term(lens, typed, "dinnre ").state, "dinnre", "dinner").corrected shouldBe "dinner"
    }

    "search: Ask is one row, with its label, question and scope, on every current answer of a lens that asks, matched or not (#1097, #1135)" {
        fun lens(scope: String?) = object : SearchLens<SearchField> {
            override val screenId: String = "probe.search"
            override val askScope: String? = scope
            override fun field(state: SearchField): SearchField = state
            override fun with(state: SearchField, field: SearchField): SearchField = field
        }
        val lens = lens("notes")
        val typed = SearchLaw.term(lens, SearchLaw.opened(lens, SearchField()).state, "zzqx ").state
        val found = centraid.screen.v1.SearchContainer(entity = "core.collection", id = "c", kind_label = "Notebook")
        val asking = SearchLaw.answered(lens, typed, "zzqx")
        asking.ask_row shouldBe SearchAsk(label = "Ask about “zzqx”", question = "Find zzqx", scope = "notes")
        // Something found is still an answer the member may ask the assistant about.
        SearchLaw.answered(lens, typed, "zzqx", containers = listOf(found)).ask_row shouldBe asking.ask_row
        // Home's is unscoped.
        SearchLaw.answered(lens(""), typed, "zzqx").ask_row?.scope shouldBe ""
        // A stale answer, a closed field and a blank term set none.
        SearchLaw.answered(lens, typed, "zzq").ask_row shouldBe null
        SearchLaw.answered(lens, SearchLaw.closed(lens, asking).state, "zzqx").ask_row shouldBe null
        SearchLaw.answered(lens, SearchLaw.term(lens, typed, " ").state, " ").ask_row shouldBe null
        // A lens that does not ask never sets it.
        SearchLaw.answered(lens(null), typed, "zzqx").ask_row shouldBe null
        // A new term, a close and a denial clear it.
        SearchLaw.term(lens, asking, "zzq").state.ask_row shouldBe null
        SearchLaw.closed(lens, asking).state.ask_row shouldBe null
        SearchLaw.unasked(lens, asking).ask_row shouldBe null
        SearchLaw.unasked(lens, SearchField()) shouldBe SearchField()
    }

    // --- Writes -----------------------------------------------------------

    "write law: the same key in flight is one write; a settle under another key is ignored" {
        val lens = object : WriteLens<WriteState> {
            override fun write(state: WriteState): WriteState = state
            override fun with(state: WriteState, write: WriteState): WriteState = write
        }
        val sent = WriteLaw.submit(lens, WriteState(), "agenda.complete_task", "{}", "k1")
        sent.state.phase shouldBe WriteState.Phase.PHASE_IN_FLIGHT
        WriteLaw.submit(lens, sent.state, "agenda.complete_task", "{}", "k1").effects.shouldBeEmpty()
        WriteLaw.settled(lens, sent.state, WriteSettled(invoke_key = "k0", committed = true)).state shouldBe sent.state
        val refused = WriteLaw.settled(
            lens,
            sent.state,
            WriteLaw.settledOf(CommandStatus.COMMAND_STATUS_DENIED, "No.", "k1"),
        ).state
        refused.phase shouldBe WriteState.Phase.PHASE_REFUSED
        refused.failure.shouldNotBeNull().sentence shouldBe "No."
        // THE SENTENCE A SHELL DRAWS IS SAID ONCE, HERE: refused is its words, a
        // silent refusal is nothing to draw, and anything else is empty.
        refused.refusal shouldBe "No."
        WriteLaw.settled(
            lens,
            sent.state,
            WriteLaw.settledOf(CommandStatus.COMMAND_STATUS_DENIED, "", "k1"),
        ).state.refusal shouldBe ""
        sent.state.refusal shouldBe ""
        WriteLaw.settled(lens, refused, WriteSettled(invoke_key = "k1", committed = true)).state.refusal shouldBe ""
        // A NEW ATTEMPT CLEARS THE OLD SENTENCE.
        WriteLaw.submit(lens, refused, "agenda.complete_task", "{}", "k2").state.refusal shouldBe ""
        // AND "REFUSED" IS SAID ONCE TOO — a silent refusal is still one, so the
        // sentence cannot say it alone; nothing else is.
        refused.refused shouldBe true
        WriteLaw.settled(
            lens,
            sent.state,
            WriteLaw.settledOf(CommandStatus.COMMAND_STATUS_DENIED, "", "k1"),
        ).state.refused shouldBe true
        sent.state.refused shouldBe false
        WriteLaw.settled(lens, refused, WriteSettled(invoke_key = "k1", committed = true)).state.refused shouldBe false
        WriteLaw.submit(lens, refused, "agenda.complete_task", "{}", "k2").state.refused shouldBe false
    }
})
