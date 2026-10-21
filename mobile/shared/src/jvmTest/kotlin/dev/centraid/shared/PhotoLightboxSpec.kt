package dev.centraid.shared

import centraid.core.v1.CommandStatus
import centraid.core.v1.Envelope
import centraid.core.v1.ErrorCode
import centraid.core.v1.FetchOriginalResponse
import centraid.core.v1.FetchOutcome
import centraid.core.v1.NullValue
import centraid.core.v1.Page
import centraid.core.v1.Request
import centraid.core.v1.Response
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotoDetail
import centraid.screen.v1.PhotoLabel
import centraid.screen.v1.PhotoLightboxEvent
import centraid.screen.v1.PhotoLightboxState
import dev.centraid.core.CentraidCore
import dev.centraid.design.copy.PhotosCopy
import dev.centraid.design.copy.SharedCopy
import dev.centraid.shared.apps.photos.PhotoEditorMachine
import dev.centraid.shared.apps.photos.PhotoLightboxLeg
import dev.centraid.shared.apps.photos.PhotoLightboxMachine
import dev.centraid.shared.apps.photos.PhotoLightboxReads
import dev.centraid.shared.apps.photos.SharePlacePrecision
import dev.centraid.shared.apps.photos.sharePlaceOptions
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.ScreenHost
import dev.centraid.shared.screen.ScreenMachine
import dev.centraid.shared.screen.Step
import dev.centraid.shared.sync.ContentHash
import dev.centraid.shared.sync.ScreenRuntime
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import okio.ByteString.Companion.toByteString
import java.util.concurrent.CopyOnWriteArrayList

/**
 * THE LIGHTBOX (#1029, photos port, lane 2).
 *
 * Every test here is `(state, event) -> (state, effects)` and a projection off
 * a `Row`, and nothing else: no dispatcher, no clock, no core. That is the
 * whole reason the screens are pure — it is what makes them provable on a
 * machine with no device — and it is why the two files this lane cared most
 * about, the refusal ladder and the toolbar's enabled/reason table, are DATA
 * rather than render-time decisions.
 */
class PhotoLightboxSpec : StringSpec({

    val asset = "asset-1"

    fun opened(neighbours: List<String> = listOf(asset)): Step<PhotoLightboxState> =
        PhotoLightboxMachine.reduce(
            PhotoLightboxMachine.initial(),
            PhotoLightboxEvent(
                opened = PhotoLightboxEvent.Opened(
                    asset_id = asset,
                    neighbour_asset_ids = neighbours,
                ),
            ),
        )

    /**
     * The asset read's own row: eight named columns, then the door's three.
     * The photograph's title, its trash and its flags are NOT on it: they are the
     * entity's and the edges', and arrive on the legs below.
     */
    fun assetRow(
        capturedAt: String = "2026-07-30T17:42:00.000Z",
        placeId: String = "place-1",
        kind: String = "photo",
    ) = Row(
        values = listOf(
            Value(text = asset),
            Value(text = kind),
            Value(text = capturedAt),
            Value(integer = 60L),
            Value(text = placeId),
            Value(integer = 4032L),
            Value(integer = 3024L),
            // `duration_s` IS `REAL` IN THE DDL and arrives on the real arm.
            Value(real = 24.5),
            // The door's three computed columns, appended in this order.
            Value(text = "/store/data/thumb.data"),
            Value(text = "a0b1"),
            Value(integer = 0L),
        ),
    )

    /** The entity leg's rows: `id, title, kind, deleted_at`. */
    fun entityRow(id: String, title: String, kind: String, deletedAt: String = "") = Row(
        values = listOf(
            Value(text = id),
            Value(text = title),
            Value(text = kind),
            if (deletedAt.isEmpty()) Value(null_ = NullValue()) else Value(text = deletedAt),
        ),
    )

    fun detailOf(row: Row = assetRow()): PhotoDetail =
        PhotoLightboxReads.arrived(listOf(row), null).data_.shouldNotBeNull()
            .detail.shouldNotBeNull()

    fun loaded(row: Row = assetRow()): Step<PhotoLightboxState> =
        PhotoLightboxMachine.reduce(
            opened().state,
            PhotoLightboxEvent(data_ = PhotoLightboxEvent.DataArrived(detail = detailOf(row))),
        )

    // --- The read law ------------------------------------------------------

    "the first Opened asks for the asset, and only the asset" {
        // THE SIX OTHER LEGS ARE NOT ASKED YET, and that is the sequencing:
        // each of them is bound to an id the asset's own row carries, so asking
        // before it lands would be asking with nothing to bind.
        val step = opened()
        step.state.loading.shouldNotBeNull().first_load shouldBe true
        step.effects shouldBe listOf(
            ScreenEffect.ReadPage(PhotoLightboxMachine.SCREEN_ID, null),
        )
    }

    "a refusal replaces the photograph, and emits no re-read" {
        // A RETRY IS A WAKE AND NEVER A REDUCER'S REFLEX. A reducer that
        // re-read on its own refusal is the loop the low-disk park exists to
        // stop — and a PARKED feed is exactly the case, so it is asserted with
        // the parked failure rather than a generic one.
        val step = PhotoLightboxMachine.reduce(
            loaded().state,
            PhotoLightboxEvent(
                refused = PhotoLightboxEvent.ReadRefused(failure = Reads.lowDiskParked()),
            ),
        )
        step.state.detail.shouldBeNull()
        step.state.loading.shouldBeNull()
        step.state.failure.shouldNotBeNull().sentence shouldNotBe ""
        withClue("a parked feed emits no re-read") { step.effects.shouldBeEmpty() }
    }

    "an asset that is not on this device is a sentence, not an empty lightbox" {
        // AN EMPTY PAGE IS NOT AN EMPTY PHOTOGRAPH. A black stage with a
        // disabled toolbar would invite a member to try verbs against something
        // that does not exist.
        val event = PhotoLightboxReads.arrived(emptyList(), null)
        event.data_.shouldBeNull()
        event.refused.shouldNotBeNull().failure.shouldNotBeNull().sentence shouldNotBe ""
    }

    "the asset statement binds the id and carries both order columns" {
        // THE DOOR HAS NO `key_of` CALLBACK, so the cursor is read off the row
        // by the two columns the ORDER BY names. A statement that ordered by a
        // column it did not project would be refused by the vault.
        PhotoLightboxReads.query(PhotoLightboxMachine.initial(), null).shouldBeNull()
        val query = PhotoLightboxReads.query(opened().state, null).shouldNotBeNull()
        query.from shouldBe PhotoLightboxReads.table
        query.bind.map { it.text } shouldBe listOf(asset)
        query.where_.shouldNotBeNull() shouldBe "id = ?"
        val order = query.order.shouldNotBeNull()
        query.select shouldContain order.sort_column
        query.select shouldContain order.pk_column
        query.with_held_thumbnail shouldBe true
    }

    "the lightbox does NOT filter the library's predicate out of its own" {
        // IT IS OPENED FROM THE TRASH AND FROM THE ARCHIVE. `PhotosReads` reads
        // `deleted_at IS NULL AND archived_at IS NULL` because a library must
        // not show what a member put away; a lightbox that inherited that
        // predicate would open the trash onto "could not find this photograph".
        val query = PhotoLightboxReads.query(opened().state, null).shouldNotBeNull()
        withClue(query.where_.orEmpty()) {
            query.where_.orEmpty().contains("deleted_at") shouldBe false
            query.where_.orEmpty().contains("archived_at") shouldBe false
        }
    }

    "the row is projected off the columns it selected" {
        val detail = detailOf()
        detail.asset_id shouldBe asset
        // THE TITLE IS THE ENTITY'S, NOT THE PHOTOGRAPH'S: it arrives on the
        // entity leg, and the asset read has none to give.
        detail.title shouldBe ""
        detail.captured_at shouldBe "2026-07-30T17:42:00.000Z"
        detail.captured_utc_offset_minutes shouldBe 60
        detail.kind shouldBe PhotoCell.Kind.KIND_PHOTO
        detail.width shouldBe 4032
        detail.height shouldBe 3024
        // A `REAL` COLUMN READ AS AN INTEGER IS ZERO, and every video in the
        // vault would be a still.
        detail.duration_seconds shouldBe 24
        detail.place_id shouldBe "place-1"
        detail.thumbnail_path shouldBe "/store/data/thumb.data"
        detail.original_hash shouldBe "a0b1"
        // THE HELD DERIVATION IS THE GRID'S, called and not restated: the
        // download arrow is the same affordance on both surfaces and a second
        // derivation would be a second answer.
        detail.held shouldBe PhotoCell.Held.HELD_THUMBNAIL_ONLY
    }

    "a photograph's trash and flags are read off the entity and the edges, and nothing else fills them" {
        detailOf().archived shouldBe false
        detailOf().trashed shouldBe false
        val entities = PhotoLightboxLeg(PhotoLightboxMachine.Leg.CONCEPTS)
        // The photograph's own entity row carries the title and the trash stamp.
        val live = entities.arrived(listOf(entityRow(asset, "Lyme Regis", "photo")), null)
            .data_.shouldNotBeNull().detail.shouldNotBeNull()
        live.title shouldBe "Lyme Regis"
        live.trashed shouldBe false
        entities.arrived(
            listOf(entityRow(asset, "Lyme Regis", "photo", deletedAt = "2026-08-01T00:00:00.000Z")),
            null,
        ).data_.shouldNotBeNull().detail.shouldNotBeNull().trashed shouldBe true
        // The star and the archive are `tagged` edges to the flag entities.
        val tags = PhotoLightboxLeg(PhotoLightboxMachine.Leg.TAGS)
        val flagged = tags.arrived(
            listOf(
                Row(values = listOf(Value(text = "flag:archived"), Value(text = asset))),
                Row(values = listOf(Value(text = "flag:starred"), Value(text = asset))),
            ),
            null,
        ).data_.shouldNotBeNull().detail.shouldNotBeNull()
        flagged.archived shouldBe true
        flagged.favorite shouldBe true
        flagged.labels.shouldBeEmpty()
    }

    "the asset read answers for neither the original's path nor its size" {
        // NOTHING ON THIS DOOR CAN. `with_held_thumbnail` resolves the DRAWABLE
        // hash to a path and `original_held` "hands out no path"; the byte door
        // is the only thing that knows, and no `ScreenEffect` carries a request
        // to it. Absent rather than fabricated — and asserted, so the day the
        // field can be filled this test is what says where.
        detailOf().original_path.shouldBeNull()
        detailOf().byte_size shouldBe 0L
        // AND NEITHER FOR THE CAMERA: no column names a camera model, and
        // `exif_json` is not a reducer's to parse.
        detailOf().camera shouldBe ""
    }

    "an unrecognised kind is unspecified, never a photograph" {
        detailOf(assetRow(kind = "hologram")).kind shouldBe PhotoCell.Kind.KIND_UNSPECIFIED
    }

    // --- The legs ----------------------------------------------------------

    "the asset's arrival asks the legs its own row makes possible" {
        val effects = loaded().effects
        effects shouldContain ScreenEffect.ReadPage(
            PhotoLightboxMachine.readId(PhotoLightboxMachine.Leg.TAGS),
            null,
        )
        effects shouldContain ScreenEffect.ReadPage(
            PhotoLightboxMachine.readId(PhotoLightboxMachine.Leg.PLACE),
            null,
        )
        effects shouldContain ScreenEffect.ReadPage(
            PhotoLightboxMachine.readId(PhotoLightboxMachine.Leg.CONTENT),
            null,
        )
    }

    "a photograph with no place asks for no place" {
        // A READ BOUND TO AN ID THAT IS NOT THERE IS NOT A READ OF EVERY PLACE.
        val effects = loaded(assetRow(placeId = "")).effects
        effects.filterIsInstance<ScreenEffect.ReadPage>()
            .map { it.screenId }
            .contains(PhotoLightboxMachine.readId(PhotoLightboxMachine.Leg.PLACE)) shouldBe false
    }

    "every leg reads a real table and binds what the photograph already knows" {
        val state = loaded().state.copy(
            detail = loaded().state.detail?.copy(
                labels = listOf(PhotoLabel(concept_id = "concept-1")),
            ),
        )
        PhotoLightboxMachine.Leg.entries.forEach { leg ->
            val reads = PhotoLightboxLeg(leg)
            val query = reads.query(state, null).shouldNotBeNull()
            withClue("$leg reads ${query.from}") {
                query.from shouldBe reads.table
                val order = query.order.shouldNotBeNull()
                // THE SAME RULE AS EVERY OTHER STATEMENT ON THIS DOOR: an order
                // column that is not projected produces a walk that is not a
                // walk. Every one of the four sorts by its own primary key, which
                // is `crates/apps/photos`' idiom for a set read by id and is what
                // keeps them off the nullable `captured_at`.
                query.select shouldContain order.sort_column
                query.select shouldContain order.pk_column
                // A PREDICATE NEVER CARRIES A VALUE. Every id rides a bind, so
                // the only thing that reaches the text is question marks.
                query.bind.forEach { value ->
                    query.where_.orEmpty() shouldNotBe value.text.orEmpty()
                }
            }
        }
    }

    "a leg will not read before the photograph has told it what to bind" {
        // Null, which `ScreenRuntime` turns into a sentence rather than into
        // silence — never an unbound read of every place in the vault.
        val fresh = PhotoLightboxMachine.initial()
        PhotoLightboxMachine.Leg.entries.forEach { leg ->
            withClue(leg.name) { PhotoLightboxLeg(leg).query(fresh, null).shouldBeNull() }
        }
    }

    "a refused leg keeps the photograph and names the part it could not read" {
        // A TAG READ THAT NEVER ANSWERS IS NOT A FAILURE OF THE PHOTOGRAPH —
        // and it is not silence either. It was, for one draft, so "no label is
        // on this photograph" and "the tag read was refused" drew the same
        // empty panel: the two-empty-cell-sentences defect one level up.
        val before = loaded().state
        val step = PhotoLightboxMachine.reduce(
            before,
            PhotoLightboxLeg(PhotoLightboxMachine.Leg.TAGS).refused(Reads.refused("nope")),
        )
        step.state.detail.shouldNotBeNull().asset_id shouldBe asset
        step.state.failure.shouldBeNull()
        step.state.loading.shouldBeNull()
        step.effects.shouldBeEmpty()
        step.state.detail.shouldNotBeNull().unread_parts shouldBe
            listOf(PhotoDetail.Part.PART_LABELS)
    }

    "four legs answer for three parts, because two of them are second hops" {
        // A MEMBER READING "could not read this photo's labels" does not need
        // to know which of the two reads it was, and a part per hop would be
        // the plumbing showing through.
        PhotoLightboxMachine.Leg.entries.map { PhotoLightboxLeg(it).part }.toSet() shouldBe
            setOf(
                PhotoDetail.Part.PART_PLACE,
                PhotoDetail.Part.PART_LABELS,
                PhotoDetail.Part.PART_CONTENT,
            )
        PhotoLightboxLeg(PhotoLightboxMachine.Leg.CONCEPTS).part shouldBe
            PhotoLightboxLeg(PhotoLightboxMachine.Leg.TAGS).part
    }

    "a part that a later leg answers for stops being unread" {
        // THE MARK COMES OFF when the evidence arrives. The opposite fold — a
        // union that never clears — would leave a refusal standing over an
        // answer that is on screen, which is a screen contradicting itself.
        val refused = PhotoLightboxMachine.reduce(
            loaded().state,
            PhotoLightboxLeg(PhotoLightboxMachine.Leg.PLACE).refused(Reads.refused("nope")),
        ).state
        refused.detail.shouldNotBeNull().unread_parts shouldBe
            listOf(PhotoDetail.Part.PART_PLACE)
        val named = PhotoLightboxMachine.reduce(
            refused,
            PhotoLightboxLeg(PhotoLightboxMachine.Leg.PLACE).arrived(
                listOf(
                    Row(values = listOf(Value(text = "place-1"), Value(real = 50.72), Value(real = -2.94))),
                ),
                null,
            ),
        ).state
        named.detail.shouldNotBeNull().place_has_coordinate shouldBe true
        named.detail.shouldNotBeNull().unread_parts.shouldBeEmpty()
        // The NAME is the entity's, on the entity leg.
        val worded = PhotoLightboxMachine.reduce(
            named,
            PhotoLightboxLeg(PhotoLightboxMachine.Leg.CONCEPTS).arrived(
                listOf(entityRow("place-1", "Lyme Regis", "place")),
                null,
            ),
        ).state
        worded.detail.shouldNotBeNull().place_name shouldBe "Lyme Regis"
    }

    "a photograph whose every part answered carries no unread marks" {
        // EMPTY IS THE ORDINARY CASE: everything that was asked, answered.
        loaded().state.detail.shouldNotBeNull().unread_parts.shouldBeEmpty()
    }

    /** A `tagged` edge as the tags leg selects it: `to_id, from_id`. */
    fun tagRow(to: String) = Row(values = listOf(Value(text = to), Value(text = asset)))

    "tags bring ids and the concept read brings words, in two hops that terminate" {
        val tags = PhotoLightboxLeg(PhotoLightboxMachine.Leg.TAGS).arrived(listOf(tagRow("concept-beach")), null)
        val withIds = PhotoLightboxMachine.reduce(loaded().state, tags)
        withIds.state.detail.shouldNotBeNull().labels.map { it.concept_id } shouldBe
            listOf("concept-beach")
        withIds.effects shouldContain ScreenEffect.ReadPage(
            PhotoLightboxMachine.readId(PhotoLightboxMachine.Leg.CONCEPTS),
            null,
        )

        val concepts = PhotoLightboxLeg(PhotoLightboxMachine.Leg.CONCEPTS).arrived(
            listOf(entityRow("concept-beach", "Beach", "tag")),
            null,
        )
        val worded = PhotoLightboxMachine.reduce(withIds.state, concepts)
        worded.state.detail.shouldNotBeNull().labels.single().label shouldBe "Beach"
        // AND IT STOPS. The follow-up fires only for ids the arrival
        // INTRODUCED, so an answer that words everything asks for nothing: a
        // rule of "read while anything is unworded" would ask for ever.
        worded.effects.shouldBeEmpty()
    }

    "a concept the read could not word asks again about nothing" {
        val tags = PhotoLightboxLeg(PhotoLightboxMachine.Leg.TAGS).arrived(listOf(tagRow("ghost")), null)
        val withIds = PhotoLightboxMachine.reduce(loaded().state, tags)
        // The tag was purged between the two reads: an empty page.
        val nothing = PhotoLightboxLeg(PhotoLightboxMachine.Leg.CONCEPTS).arrived(emptyList(), null)
        val after = PhotoLightboxMachine.reduce(withIds.state, nothing)
        after.effects.shouldBeEmpty()
        after.state.detail.shouldNotBeNull().labels.single().label shouldBe ""
    }

    "every tag is the member's: the model has no proposal to confirm" {
        // An edge carries no tagger and no derivation, so a label on this screen
        // is one a member put there (the wire field stays for the
        // day a proposal exists). The concept id and the tag id are the one id.
        val tags = PhotoLightboxLeg(PhotoLightboxMachine.Leg.TAGS).arrived(
            listOf(tagRow("concept-1"), tagRow("concept-2")),
            null,
        )
        val labels = tags.data_.shouldNotBeNull().detail.shouldNotBeNull().labels
        labels.map { it.concept_id } shouldBe listOf("concept-1", "concept-2")
        labels.all { it.confirmed && it.tag_id == it.concept_id } shouldBe true
    }

    "the star is a flag edge, and it never becomes a chip" {
        val tags = PhotoLightboxLeg(PhotoLightboxMachine.Leg.TAGS).arrived(
            listOf(tagRow("flag:starred"), tagRow("concept-beach")),
            null,
        )
        val tagged = PhotoLightboxMachine.reduce(loaded().state, tags)
        tagged.effects shouldContain ScreenEffect.ReadPage(
            PhotoLightboxMachine.readId(PhotoLightboxMachine.Leg.CONCEPTS),
            null,
        )
        val concepts = PhotoLightboxLeg(PhotoLightboxMachine.Leg.CONCEPTS).arrived(
            listOf(entityRow("concept-beach", "Beach", "tag")),
            null,
        )
        val detail = PhotoLightboxMachine.reduce(tagged.state, concepts).state.detail.shouldNotBeNull()
        detail.favorite shouldBe true
        // THE FLAG IS THE HEART, never a label beside the member's own words.
        detail.labels.map { it.label } shouldBe listOf("Beach")
        detail.labels.none { it.concept_id.startsWith("flag:") } shouldBe true
    }

    "the byte size arrives through the hash, because the detail carries no content id" {
        val content = PhotoLightboxLeg(PhotoLightboxMachine.Leg.CONTENT).arrived(
            listOf(Row(values = listOf(Value(text = "a0b1"), Value(integer = 4_200_000L)))),
            null,
        )
        val sized = PhotoLightboxMachine.reduce(loaded().state, content).state
        sized.detail.shouldNotBeNull().byte_size shouldBe 4_200_000L
        // `blob.hash` IS THE KEY, so the hash the thumbnail column already
        // handed this screen addresses exactly one blob.
        val query = PhotoLightboxLeg(PhotoLightboxMachine.Leg.CONTENT)
            .query(loaded().state, null).shouldNotBeNull()
        query.from shouldBe "blob"
        query.bind.map { it.text } shouldBe listOf("a0b1")
    }

    // --- Amendments and the photograph on screen ---------------------------

    "an amendment says so, and a leg that could carry an asset id would not fool it" {
        // `amendment` IS EXPLICIT. `core_tag` has the asset in a column, so the
        // day a leg projects it, the old inference — "a detail with no id is a
        // satellite" — would start REPLACING the photograph with a tag. Both
        // shapes typecheck, which is why this is asserted rather than trusted.
        PhotoLightboxMachine.Leg.entries.forEach { leg ->
            val reads = PhotoLightboxLeg(leg)
            withClue(leg.name) {
                reads.arrived(emptyList(), null).data_.shouldNotBeNull().amendment shouldBe true
                reads.refused(Reads.refused("x")).data_.shouldNotBeNull().amendment shouldBe true
            }
        }
        // AND THE ASSET LEG IS A REPLACEMENT, which is what makes a re-read
        // after a write honest.
        PhotoLightboxReads.arrived(listOf(assetRow()), null)
            .data_.shouldNotBeNull().amendment shouldBe false

        // A DETAIL CARRYING AN ASSET ID IS STILL MERGED when the flag says so:
        // the flag decides, not the field.
        val merged = PhotoLightboxMachine.reduce(
            loaded().state,
            PhotoLightboxEvent(
                data_ = PhotoLightboxEvent.DataArrived(
                    amendment = true,
                    detail = PhotoDetail(asset_id = "asset-9", place_name = "Lyme Regis"),
                ),
            ),
        ).state.detail.shouldNotBeNull()
        merged.asset_id shouldBe asset
        merged.place_name shouldBe "Lyme Regis"
    }

    "an amendment with nothing to amend is dropped, and that is what makes a swipe safe" {
        // A PLACE NAME STILL IN FLIGHT FOR THE PREVIOUS PHOTOGRAPH must not
        // land on the next one. `Moved` clears the detail, so a late amendment
        // reaches a screen holding none and belongs nowhere.
        val moved = PhotoLightboxMachine.reduce(
            loaded().state,
            PhotoLightboxEvent(moved = PhotoLightboxEvent.Moved(asset_id = "asset-2")),
        )
        moved.state.detail.shouldBeNull()
        moved.state.asset_id shouldBe "asset-2"
        val stale = PhotoLightboxLeg(PhotoLightboxMachine.Leg.PLACE)
            .arrived(listOf(Row(values = listOf(Value(text = "p"), Value(text = "Elsewhere")))), null)
        stale.data_.shouldNotBeNull().amendment shouldBe true
        PhotoLightboxMachine.reduce(moved.state, stale).state.detail.shouldBeNull()
    }

    "a read for a photograph the member has left is dropped" {
        val moved = PhotoLightboxMachine.reduce(
            loaded().state,
            PhotoLightboxEvent(moved = PhotoLightboxEvent.Moved(asset_id = "asset-2")),
        )
        val previous = PhotoLightboxEvent(
            data_ = PhotoLightboxEvent.DataArrived(detail = detailOf()),
        )
        PhotoLightboxMachine.reduce(moved.state, previous).state.detail.shouldBeNull()
    }

    "a moved event keeps the shelf's order and re-shows the chrome" {
        val hidden = PhotoLightboxMachine.reduce(
            opened(listOf("asset-1", "asset-2")).state,
            PhotoLightboxEvent(chrome = PhotoLightboxEvent.ChromeToggled(visible = false)),
        ).state
        hidden.chrome_visible shouldBe false
        val moved = PhotoLightboxMachine.reduce(
            hidden,
            PhotoLightboxEvent(moved = PhotoLightboxEvent.Moved(asset_id = "asset-2")),
        ).state
        // NAVIGATION RE-SHOWS THE CHROME, so a member is never carried further
        // into a bare screen.
        moved.chrome_visible shouldBe true
        moved.neighbour_asset_ids shouldBe listOf("asset-1", "asset-2")
    }

    "the asset leg replaces rather than merges, so an unstarred photograph unstars" {
        val starred = loaded().state.let { state ->
            state.copy(detail = state.detail?.copy(favorite = true, place_name = "Lyme Regis"))
        }
        val again = PhotoLightboxMachine.reduce(
            starred,
            PhotoLightboxEvent(data_ = PhotoLightboxEvent.DataArrived(detail = detailOf())),
        )
        again.state.detail.shouldNotBeNull().favorite shouldBe false
        // AND THE SATELLITES RE-FIRE, which is the cost of that correctness.
        again.effects.shouldNotBe(emptyList<ScreenEffect>())
    }

    // --- Chrome, sheets and the verbs --------------------------------------

    "the lightbox opens with its chrome drawn" {
        // A PHOTOGRAPH THAT ARRIVES BARE is a screen with no visible way back,
        // whatever the gesture can do.
        PhotoLightboxMachine.initial().chrome_visible shouldBe true
        opened().state.chrome_visible shouldBe true
    }

    "chrome and sheets are state, and neither emits a read" {
        val hidden = PhotoLightboxMachine.reduce(
            loaded().state,
            PhotoLightboxEvent(chrome = PhotoLightboxEvent.ChromeToggled(visible = false)),
        )
        hidden.state.chrome_visible shouldBe false
        hidden.effects.shouldBeEmpty()
        val sheet = PhotoLightboxMachine.reduce(
            hidden.state,
            PhotoLightboxEvent(
                sheet = PhotoLightboxEvent.SheetChanged(PhotoLightboxState.Sheet.SHEET_INFO),
            ),
        )
        sheet.state.sheet shouldBe PhotoLightboxState.Sheet.SHEET_INFO
        sheet.effects.shouldBeEmpty()
    }

    "no verb is enabled without being able to run, and none is disabled without a reason" {
        // THE CONTRACT v0 PULLED OUT OF ITS COMPONENT (#1015 B10), asserted
        // without a renderer — which is the whole reason it is data.
        listOf(PhotoLightboxMachine.initial(), loaded().state).forEach { state ->
            PhotoLightboxMachine.toolbar(state).forEach { (verb, row) ->
                withClue("$verb on ${if (state.detail == null) "no detail" else "a photograph"}") {
                    if (row.enabled) row.why shouldBe "" else row.why shouldNotBe ""
                }
            }
        }
    }

    "the refusal ladder says not-in-a-vault-yet, never a read-only vault" {
        // NO-VAULT-ROW BEATS READ-ONLY (#1014, R17). `canWrite` is a property
        // of a VAULT row, so for a photograph no vault holds yet it is false by
        // ABSENCE rather than by grant — and the member was told to "ask its
        // owner for write access" about their own vault.
        PhotoLightboxMachine.writeRefusal(PhotoLightboxMachine.initial()) shouldBe
            PhotoLightboxMachine.NOT_IN_A_VAULT_YET_REASON
        PhotoLightboxMachine.writeRefusal(loaded().state).shouldBeNull()
    }

    "info reads and is never refused; copy is refused, and edit is the editor's own table" {
        val table = PhotoLightboxMachine.toolbar(loaded().state)
        table[PhotoLightboxMachine.Verb.INFO].shouldNotBeNull().enabled shouldBe true
        table[PhotoLightboxMachine.Verb.FAVORITE].shouldNotBeNull().enabled shouldBe true
        table[PhotoLightboxMachine.Verb.TRASH].shouldNotBeNull().enabled shouldBe true
        // THE BAR STILL NAMES ALL FIVE. The phone rearranges the desktop
        // viewer; it does not water it down — so a verb with nothing behind it
        // is refused WITH A REASON rather than deleted.
        table.size shouldBe 5
        table[PhotoLightboxMachine.Verb.COPY].shouldNotBeNull().why shouldNotBe ""
        // EDIT IS `PhotoEditorMachine.editRefusal`, the table the lightbox's
        // `PhotoEditButton` draws from, so the bar and the button cannot say
        // two things. The fixture row holds a thumbnail and not the original,
        // and the editor renders from the original.
        table[PhotoLightboxMachine.Verb.EDIT].shouldNotBeNull().enabled shouldBe false
        table[PhotoLightboxMachine.Verb.EDIT].shouldNotBeNull().why shouldBe
            PhotoEditorMachine.editRefusal(loaded().state.detail).shouldNotBeNull()
        // WITH THE ORIGINAL ON THE PHONE, EDIT IS LIVE.
        val held = loaded().state.let { state ->
            state.copy(detail = state.detail.shouldNotBeNull().copy(held = PhotoCell.Held.HELD_ORIGINAL))
        }
        PhotoLightboxMachine.toolbar(held)[PhotoLightboxMachine.Verb.EDIT].shouldNotBeNull() shouldBe
            PhotoLightboxMachine.ToolbarState(true)
        // A VIDEO'S EDIT REFUSAL IS A DIFFERENT SENTENCE: crop and rotate are
        // raster on a still and there is no non-destructive editor for a movie.
        val video = loaded(assetRow(kind = "video")).state
        PhotoLightboxMachine.toolbar(video)[PhotoLightboxMachine.Verb.EDIT]
            .shouldNotBeNull().why shouldBe
            "Crop and rotate work on photos only."
    }

    // --- The writes --------------------------------------------------------

    "a write on a photograph that is not in a vault is withheld, never submitted" {
        // A VIEW THAT CAN COMPOSE A COMMAND CAN COMPOSE ONE THE VAULT WILL NOT
        // TAKE. The ladder is climbed in the reducer, so the refusal is an
        // effect a member can be told about rather than a command that fails.
        val step = PhotoLightboxMachine.reduce(
            PhotoLightboxMachine.initial(),
            PhotoLightboxEvent(favorite = PhotoLightboxEvent.FavoriteToggled(favorite = true)),
        )
        step.effects.filterIsInstance<ScreenEffect.SubmitWrite>().shouldBeEmpty()
        step.effects.single().shouldNotBeNull() shouldBe ScreenEffect.WithheldOffline(
            "favorite",
            PhotoLightboxMachine.NOT_IN_A_VAULT_YET_REASON,
        )
        // THE SAME LINE, whether the refusal was known in advance or came back
        // from the vault. A member does not care which end found out.
        step.state.write_failure.shouldNotBeNull().sentence shouldBe
            PhotoLightboxMachine.NOT_IN_A_VAULT_YET_REASON
    }

    "each verb names the command the vault actually registers, with a stable key" {
        val state = loaded().state
        fun writeOf(event: PhotoLightboxEvent): ScreenEffect.SubmitWrite =
            PhotoLightboxMachine.reduce(state, event).effects
                .filterIsInstance<ScreenEffect.SubmitWrite>().single()

        // A NEW ATTEMPT CLEARS THE OLD SENTENCE: a refusal left standing over a
        // write that is in flight is a screen saying no while it does the thing.
        PhotoLightboxMachine.reduce(
            state.copy(write_failure = Reads.refused("stale")),
            PhotoLightboxEvent(favorite = PhotoLightboxEvent.FavoriteToggled(favorite = true)),
        ).state.write_failure.shouldBeNull()

        val favorite = writeOf(
            PhotoLightboxEvent(favorite = PhotoLightboxEvent.FavoriteToggled(favorite = true)),
        )
        favorite.command shouldBe "flag.set"
        favorite.inputJson shouldBe """{"id":"asset-1","flag":"starred"}"""
        // THE KEY IS CONTENT-DERIVED AND NEVER AN ORDINAL: it is the
        // correlation key an answer is paired with, so it must name the same
        // write the same way. The set and the clear are two commands, so
        // favourite-then-unfavourite are two intents and not one.
        favorite.invokeKey shouldBe "flag.set:starred:asset-1"
        val unfavorite = writeOf(
            PhotoLightboxEvent(favorite = PhotoLightboxEvent.FavoriteToggled(favorite = false)),
        )
        unfavorite.command shouldBe "flag.clear"
        unfavorite.invokeKey shouldBe "flag.clear:starred:asset-1"

        val archive = writeOf(
            PhotoLightboxEvent(archive = PhotoLightboxEvent.ArchiveToggled(archived = true)),
        )
        archive.command shouldBe "flag.set"
        archive.inputJson shouldBe """{"id":"asset-1","flag":"archived"}"""

        // TWO COMMANDS, ONE TAP APART, AND ONLY ONE OF THEM IS REVERSIBLE.
        writeOf(
            PhotoLightboxEvent(delete = PhotoLightboxEvent.DeleteRequested(permanent = false)),
        ).command shouldBe "entity.trash"
        writeOf(
            PhotoLightboxEvent(delete = PhotoLightboxEvent.DeleteRequested(permanent = true)),
        ).command shouldBe "entity.purge"
    }

    "a committed write re-reads; a refused one leaves the photograph alone" {
        val state = loaded().state
        val committed = PhotoLightboxMachine.reduce(
            state,
            PhotoLightboxEvent(
                write_settled = PhotoLightboxEvent.WriteSettled(committed = true),
            ),
        )
        committed.effects shouldBe listOf(
            ScreenEffect.ReadPage(PhotoLightboxMachine.SCREEN_ID, null),
        )
        val refused = PhotoLightboxMachine.reduce(
            state,
            PhotoLightboxEvent(
                write_settled = PhotoLightboxEvent.WriteSettled(
                    committed = false,
                    sentence = "This vault has moved.",
                ),
            ),
        )
        // A FAILED WRITE DOES NOT REPLACE THE PHOTOGRAPH — the read law's
        // `failure` slot is not the write's, and a refused favourite that
        // landed there would swap a picture for an error message.
        refused.state.detail shouldBe state.detail
        refused.state.failure.shouldBeNull()
        refused.effects.shouldBeEmpty()
        // AND IT IS NOT SILENT. The sentence lands in its own slot, which is
        // the whole reason `write_failure` exists.
        refused.state.write_failure.shouldNotBeNull().sentence shouldBe "This vault has moved."
        // A COMMIT CLEARS IT: a refusal left standing over a write that then
        // succeeded is a screen saying no about something that happened.
        PhotoLightboxMachine.reduce(
            refused.state,
            PhotoLightboxEvent(
                write_settled = PhotoLightboxEvent.WriteSettled(committed = true),
            ),
        ).state.write_failure.shouldBeNull()
    }

    "a refusal that came back with no words still says something" {
        // A WRITE THAT FAILED SILENTLY is the one outcome a member cannot act
        // on, and an empty sentence under a control that looks armed reads as a
        // control that works.
        PhotoLightboxMachine.reduce(
            loaded().state,
            PhotoLightboxEvent(
                write_settled = PhotoLightboxEvent.WriteSettled(committed = false),
            ),
        ).state.write_failure.shouldNotBeNull().sentence shouldBe
            PhotoLightboxMachine.WRITE_REFUSED_WITHOUT_A_REASON
    }

    "a refusal is about the photograph it was tried on, and does not travel" {
        val refused = PhotoLightboxMachine.reduce(
            loaded().state,
            PhotoLightboxEvent(
                write_settled = PhotoLightboxEvent.WriteSettled(
                    committed = false,
                    sentence = "This vault has moved.",
                ),
            ),
        ).state
        // CARRYING IT TO THE NEXT PHOTOGRAPH would tell a member their swipe
        // had been refused.
        PhotoLightboxMachine.reduce(
            refused,
            PhotoLightboxEvent(moved = PhotoLightboxEvent.Moved(asset_id = "asset-2")),
        ).state.write_failure.shouldBeNull()
    }

    "only EXECUTED is a commit" {
        // QUEUED, IN_FLIGHT and PARKED all mean "somewhere durable, not yet
        // committed", and calling one of them a commit would be the shell
        // claiming a star that is not on the photograph.
        PhotoLightboxReads.settled(CommandStatus.COMMAND_STATUS_EXECUTED, "", "test.command:row-0001")
            .write_settled.shouldNotBeNull().committed shouldBe true
        listOf(
            CommandStatus.COMMAND_STATUS_QUEUED,
            CommandStatus.COMMAND_STATUS_IN_FLIGHT,
            CommandStatus.COMMAND_STATUS_PARKED,
            CommandStatus.COMMAND_STATUS_DENIED,
            CommandStatus.COMMAND_STATUS_FAILED,
        ).forEach { status ->
            withClue(status.name) {
                PhotoLightboxReads.settled(status, "no", "test.command:row-0001")
                    .write_settled.shouldNotBeNull().committed shouldBe false
            }
        }
    }

    // --- The fetch ---------------------------------------------------------

    "a tap paints the photograph fetching before the bytes move, and a failure stops it" {
        val tapped = PhotoLightboxMachine.reduce(
            loaded().state,
            PhotoLightboxEvent(
                fetch_original = PhotoLightboxEvent.OriginalRequested(
                    asset_id = asset,
                    content_hash = "a0b1",
                ),
            ),
        )
        tapped.state.detail.shouldNotBeNull().held shouldBe PhotoCell.Held.HELD_FETCHING
        tapped.effects shouldBe listOf(
            ScreenEffect.FetchOriginal(PhotoLightboxMachine.SCREEN_ID, asset, "a0b1"),
        )
        // A PHOTOGRAPH LEFT FETCHING because nobody said "it did not happen" is
        // the state this deletes. Back to what the read said — the rule is
        // holding it, which is still true and still carries the arrow.
        val settled = PhotoLightboxMachine.reduce(
            tapped.state,
            PhotoLightboxEvent(
                fetch_settled = PhotoLightboxEvent.FetchSettled(
                    asset_id = asset,
                    fetched = false,
                ),
            ),
        )
        settled.state.detail.shouldNotBeNull().held shouldBe
            PhotoCell.Held.HELD_WITHHELD_BY_RULE
    }

    "a fetch that succeeded re-reads this photograph, and another's success moves nothing (#1080)" {
        val tapped = PhotoLightboxMachine.reduce(
            loaded().state,
            PhotoLightboxEvent(fetch_original = PhotoLightboxEvent.OriginalRequested(asset_id = asset, content_hash = "a0b1")),
        )
        // THE BYTES ARE ON THIS PHONE NOW, so the read draws the original —
        // asked for here, because one the phone already held brings no change
        // event with it.
        PhotoLightboxMachine.reduce(
            tapped.state,
            PhotoLightboxEvent(fetch_settled = PhotoLightboxEvent.FetchSettled(asset_id = asset, fetched = true)),
        ).effects shouldBe listOf(ScreenEffect.ReadPage(PhotoLightboxMachine.SCREEN_ID, afterCursor = null))
        PhotoLightboxMachine.reduce(
            tapped.state,
            PhotoLightboxEvent(fetch_settled = PhotoLightboxEvent.FetchSettled(asset_id = "asset-2", fetched = true)),
        ).effects.shouldBeEmpty()
    }

    "the runtime takes a tapped original to the core's fetch_original, then re-reads or says why not (#1080)" {
        val raw = ByteArray(32) { 0xa0.toByte() }
        val hash = ContentHash.hex(raw.toByteString())
        // Each row: what the core answers (null is a refusal), and the line the
        // member reads (null is a success, which re-reads instead).
        val rows = listOf(
            FetchOutcome.FETCH_OUTCOME_LANDED to null,
            FetchOutcome.FETCH_OUTCOME_ALREADY_HELD to null,
            FetchOutcome.FETCH_OUTCOME_NOT_IN_BACKUP to SharedCopy.FETCH_NOT_IN_BACKUP,
            FetchOutcome.FETCH_OUTCOME_UNREACHABLE to SharedCopy.FETCH_UNREACHABLE,
            FetchOutcome.FETCH_OUTCOME_UNTRUSTED to SharedCopy.FETCH_UNTRUSTED,
            FetchOutcome.FETCH_OUTCOME_DAMAGED to SharedCopy.FETCH_DAMAGED,
            null to SharedCopy.FETCH_NO_ANSWER,
        )
        for ((outcome, line) in rows) {
            withClue("$outcome") {
                val seen = CopyOnWriteArrayList<Request>()
                val core = CentraidCore.answering(Dispatchers.Unconfined) { envelope ->
                    val request = envelope.request!!
                    seen += request
                    when {
                        request.fetch_original == null -> Envelope(response = Response(page = Page()))
                        outcome == null -> Envelope(
                            error = centraid.core.v1.Error(code = ErrorCode.ERROR_CODE_NOT_YET_AVAILABLE, detail = "logs only"),
                        )
                        else -> Envelope(response = Response(fetch_original = FetchOriginalResponse(outcome = outcome)))
                    }
                }
                val start = loaded().state
                val host = ScreenHost(
                    object : ScreenMachine<PhotoLightboxState, PhotoLightboxEvent> by PhotoLightboxMachine {
                        override fun initial(): PhotoLightboxState = start
                    },
                )
                val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
                try {
                    ScreenRuntime(core = { core }, host = host, reads = PhotoLightboxReads, scope = scope).start()
                    host.send(
                        PhotoLightboxEvent(
                            fetch_original = PhotoLightboxEvent.OriginalRequested(asset_id = asset, content_hash = hash),
                        ),
                    )
                    if (line == null) {
                        // A SUCCESS RE-READS: the detail's page follows the fetch.
                        withTimeout(5_000) { while (seen.none { it.page != null }) delay(5) }
                    } else {
                        val failed = withTimeout(5_000) { host.state.first { it.write_failure != null } }
                        failed.write_failure.shouldNotBeNull().sentence shouldBe line
                        failed.detail.shouldNotBeNull().held shouldBe PhotoCell.Held.HELD_WITHHELD_BY_RULE
                        seen.none { it.page != null } shouldBe true
                    }
                    // THE TAP CROSSED TO ARM 25, with the hash the cell named, raw.
                    seen.first().fetch_original.shouldNotBeNull().content_hash shouldBe raw.toByteString()
                } finally {
                    scope.cancel()
                }
            }
        }
    }

    // --- Sync --------------------------------------------------------------

    "this photograph's own row moves the screen and no other's does" {
        PhotoLightboxMachine.rowsChanged("photo", listOf(asset)).shouldNotBeNull()
        // THE TITLE AND THE TRASH ARE THE ENTITY'S AND THE STAR AND THE LABELS
        // ARE EDGES: a commit on any of the three can be this photograph's.
        PhotoLightboxMachine.rowsChanged("entity", listOf(asset)).shouldNotBeNull()
        PhotoLightboxMachine.rowsChanged("edge", emptyList()).shouldNotBeNull()
        PhotoLightboxMachine.rowsChanged("media_asset", listOf(asset)).shouldBeNull()
        PhotoLightboxMachine.rowsChanged("core_tag", listOf("tag-1")).shouldBeNull()
        PhotoLightboxMachine.rowsChanged("derivative", listOf(asset)).shouldBeNull()

        val mine = PhotoLightboxMachine.reduce(
            loaded().state,
            PhotoLightboxEvent(
                rows_changed = PhotoLightboxEvent.RowsChanged(asset_ids = listOf(asset)),
            ),
        )
        // THE PICTURE STAYS ON SCREEN WHILE THE READ RUNS. Clearing it first
        // would be the difference between a lightbox and a slideshow of
        // spinners.
        mine.state.detail.shouldNotBeNull()
        mine.effects shouldBe listOf(
            ScreenEffect.ReadPage(PhotoLightboxMachine.SCREEN_ID, null),
        )
        PhotoLightboxMachine.reduce(
            loaded().state,
            PhotoLightboxEvent(
                rows_changed = PhotoLightboxEvent.RowsChanged(asset_ids = listOf("asset-9")),
            ),
        ).effects.shouldBeEmpty()
    }

    "the machine reads the same table its reads declare" {
        // THE PAIRING, ASSERTED MECHANICALLY. When the two part company nothing
        // fails — the screen simply stops redrawing on sync, and the symptom is
        // a lightbox that is right only after a relaunch.
        val query = PhotoLightboxReads.query(opened().state, null).shouldNotBeNull()
        query.from shouldBe PhotoLightboxReads.table
        PhotoLightboxMachine.rowsChanged(PhotoLightboxReads.table, listOf("k")).shouldNotBeNull()
    }

    // --- The share choice --------------------------------------------------

    "the share sheet offers a place name only when there is one to send" {
        // A CHOICE THAT DOES NOTHING IS A PROMISE THE CODE CANNOT KEEP. "Place
        // name only" for a photograph with no place would be exactly that.
        sharePlaceOptions("").map { it.precision } shouldBe listOf(
            SharePlacePrecision.NONE,
            SharePlacePrecision.EXACT,
        )
        sharePlaceOptions("Lyme Regis").map { it.precision } shouldBe listOf(
            SharePlacePrecision.NONE,
            SharePlacePrecision.NAME,
            SharePlacePrecision.EXACT,
        )
        // THE DETAIL NAMES THE PLACE, because a row that says "place name only"
        // without saying WHICH name is a decision a member cannot make.
        sharePlaceOptions("Lyme Regis").single {
            it.precision == SharePlacePrecision.NAME
        }.detail.contains("Lyme Regis") shouldBe true
    }

    "every share receipt says what went, `none` included" {
        // SILENCE READS AS SAFETY. A member who was never told what travelled
        // has not been told anything.
        SharePlacePrecision.entries.forEach { precision ->
            withClue(precision.name) {
                dev.centraid.shared.apps.photos
                    .sharePlaceReceipt(precision, "Lyme Regis").isNotEmpty() shouldBe true
            }
        }
    }

    // --- The words ----------------------------------------------------------

    "a loaded photograph arrives with its words said, in the shutter's own zone" {
        // THE SHELLS HOLD NO RULE FOR THESE. 17:42 UTC at +01:00 is 18:42, and
        // the date and the clock are moved by the SAME offset, so they cannot
        // name two different evenings.
        val state = loaded().state
        state.stamp_date shouldBe "30 July 2026"
        state.stamp_line shouldBe "18:42"
        state.whereabouts shouldBe PhotosCopy.PHOTOS_SMALLER_COPY_ONLY
        state.facts.map { it.label to it.text } shouldBe listOf(
            PhotosCopy.PHOTOS_FACT_CAPTURED to "30 July 2026 18:42 · UTC+01:00",
            PhotosCopy.PHOTOS_FACT_SIZE to "4032 × 3024",
            PhotosCopy.PHOTOS_FACT_LENGTH to "0:24",
        )
    }

    "an evening that is the next morning in UTC is filed on the evening" {
        // LISBON: 23:30 UTC at +01:00 is 00:30 on the NEXT day there, and a
        // negative offset moves the other way. The stamp follows the grid.
        val late = loaded(assetRow(capturedAt = "2026-07-30T23:30:00.000Z")).state
        late.stamp_date shouldBe "31 July 2026"
        late.stamp_line shouldBe "00:30"
        val detail = detailOf(assetRow(capturedAt = "2026-01-01T02:05:00.000Z")).copy(captured_utc_offset_minutes = -330)
        val west = PhotoLightboxMachine.reduce(
            opened().state,
            PhotoLightboxEvent(data_ = PhotoLightboxEvent.DataArrived(detail = detail)),
        ).state
        west.stamp_date shouldBe "31 December 2025"
        west.stamp_line shouldBe "20:35"
        west.facts.first().text shouldBe "31 December 2025 20:35 · UTC-05:30"
    }

    "a row with no capture time says no date and no Captured fact, never a guess" {
        val state = loaded(assetRow(capturedAt = "")).state
        state.stamp_date shouldBe ""
        state.stamp_line shouldBe ""
        state.facts.map { it.label } shouldBe listOf(PhotosCopy.PHOTOS_FACT_SIZE, PhotosCopy.PHOTOS_FACT_LENGTH)
    }

    "no recorded offset is UTC, and the line says so" {
        val detail = detailOf().copy(captured_utc_offset_minutes = 0)
        val state = PhotoLightboxMachine.reduce(
            opened().state,
            PhotoLightboxEvent(data_ = PhotoLightboxEvent.DataArrived(detail = detail)),
        ).state
        state.facts.first().text shouldBe "30 July 2026 17:42 · UTC"
    }

    "the place joins the stamp line and the Captured fact when its leg lands" {
        val state = PhotoLightboxMachine.reduce(
            loaded().state,
            PhotoLightboxEvent(
                data_ = PhotoLightboxEvent.DataArrived(
                    detail = PhotoDetail(asset_id = asset, place_name = "Lyme Regis"),
                    amendment = true,
                ),
            ),
        ).state
        state.stamp_line shouldBe "18:42 · Lyme Regis"
        state.facts.first().text shouldBe "30 July 2026 18:42 · Lyme Regis · UTC+01:00"
    }

    "the file row is the size when known, and an unreadable row when the content leg refused" {
        val sized = PhotoLightboxMachine.reduce(
            loaded().state,
            PhotoLightboxEvent(
                data_ = PhotoLightboxEvent.DataArrived(
                    detail = PhotoDetail(asset_id = asset, byte_size = 1_250_000L),
                    amendment = true,
                ),
            ),
        ).state
        // A TIE GOES UP, as the core's formatter does it.
        sized.facts.single { it.label == PhotosCopy.PHOTOS_FACT_FILE }.text shouldBe "1.3 MB"
        val refused = PhotoLightboxMachine.reduce(
            loaded().state,
            PhotoLightboxEvent(
                data_ = PhotoLightboxEvent.DataArrived(
                    detail = PhotoDetail(asset_id = asset, unread_parts = listOf(PhotoDetail.Part.PART_CONTENT)),
                    amendment = true,
                ),
            ),
        ).state
        refused.facts.single { it.label == PhotosCopy.PHOTOS_FACT_FILE }.text shouldBe
            PhotosCopy.PHOTOS_FILE_SIZE_UNREADABLE
    }

    "a status line only when there is something to say, and a video's depends on its player alone" {
        fun with(held: PhotoCell.Held, kind: PhotoCell.Kind = PhotoCell.Kind.KIND_PHOTO, percent: Int = 0) =
            PhotoLightboxMachine.reduce(
                opened().state,
                PhotoLightboxEvent(
                    data_ = PhotoLightboxEvent.DataArrived(
                        detail = detailOf().copy(held = held, kind = kind, fetch_percent = percent),
                    ),
                ),
            ).state
        with(PhotoCell.Held.HELD_ORIGINAL).status_line shouldBe ""
        with(PhotoCell.Held.HELD_WITHHELD_BY_RULE).status_line shouldBe PhotosCopy.PHOTOS_ORIGINAL_HELD_BACK
        with(PhotoCell.Held.HELD_ABSENT).status_line shouldBe PhotosCopy.PHOTOS_NOTHING_ON_PHONE
        with(PhotoCell.Held.HELD_FETCHING).status_line shouldBe PhotosCopy.PHOTOS_ORIGINAL_DOWNLOADING
        with(PhotoCell.Held.HELD_FETCHING, percent = 40).status_line shouldBe
            "Downloading the original — 40%"
        // A VIDEO WITH NO PLAYER IS ONE WHOSE FILE IS NOT HERE; one with a player is not.
        val video = with(PhotoCell.Held.HELD_THUMBNAIL_ONLY, PhotoCell.Kind.KIND_VIDEO)
        video.status_line shouldBe PhotosCopy.PHOTOS_VIDEO_STILL_ONLY
        video.status_line_playing shouldBe ""
        // A BYTE STATUS BEATS THE PLAYER LINE, because an offer beats a lesson.
        with(PhotoCell.Held.HELD_WITHHELD_BY_RULE, PhotoCell.Kind.KIND_VIDEO).status_line_playing shouldBe
            PhotosCopy.PHOTOS_ORIGINAL_HELD_BACK
        loaded().state.status_line shouldBe ""
    }

    "the camera the header names becomes a fact, survives a re-read, and is keyed by asset" {
        val named = PhotoLightboxMachine.reduce(
            loaded().state,
            PhotoLightboxEvent(camera_read = PhotoLightboxEvent.CameraRead(asset_id = asset, camera = "Leica Q3")),
        ).state
        named.facts.last().label to named.facts.last().text shouldBe
            (PhotosCopy.PHOTOS_FACT_CAMERA to "Leica Q3")
        // A CAPTION EDIT RE-READS THE ASSET, which replaces the detail whole.
        val reread = PhotoLightboxMachine.reduce(
            named,
            PhotoLightboxEvent(data_ = PhotoLightboxEvent.DataArrived(detail = detailOf())),
        ).state
        reread.facts.last().text shouldBe "Leica Q3"
        // AN ANSWER FOR A PHOTOGRAPH THE MEMBER SWIPED PAST LANDS ON NOTHING.
        val stale = PhotoLightboxMachine.reduce(
            loaded().state,
            PhotoLightboxEvent(camera_read = PhotoLightboxEvent.CameraRead(asset_id = "asset-9", camera = "Nikon")),
        ).state
        stale.facts.none { it.label == PhotosCopy.PHOTOS_FACT_CAMERA } shouldBe true
    }

    "the refusals are said on the state, the same sentences that gate the verbs" {
        // BEFORE A PHOTOGRAPH LANDS there is nothing to write TO, and the
        // sentence is already there for a shell that draws a disabled control.
        PhotoLightboxMachine.initial().write_refusal shouldBe PhotoLightboxMachine.NOT_IN_A_VAULT_YET_REASON
        opened().state.write_refusal shouldBe PhotoLightboxMachine.NOT_IN_A_VAULT_YET_REASON
        val live = loaded().state
        live.write_refusal shouldBe ""
        live.edit_refusal shouldBe PhotoEditorMachine.editRefusal(live.detail).orEmpty()
        // THIS FIXTURE'S ORIGINAL IS NOT ON THIS PHONE, so Edit says which absence it is.
        live.edit_refusal shouldNotBe ""
        val video = PhotoLightboxMachine.reduce(
            opened().state,
            PhotoLightboxEvent(
                data_ = PhotoLightboxEvent.DataArrived(
                    detail = detailOf().copy(kind = PhotoCell.Kind.KIND_VIDEO),
                ),
            ),
        ).state
        video.edit_refusal shouldBe PhotoEditorMachine.editRefusal(video.detail).orEmpty()
    }

    "a swipe clears the words with the detail" {
        val moved = PhotoLightboxMachine.reduce(
            loaded().state,
            PhotoLightboxEvent(moved = PhotoLightboxEvent.Moved(asset_id = "asset-2")),
        ).state
        moved.facts.shouldBeEmpty()
        moved.stamp_date shouldBe ""
        moved.whereabouts shouldBe ""
    }

    "the slideshow meta is a field, and the strip's window reads the same from primitives" {
        val shelf = (1..100).map { "a$it" }
        val state = PhotoLightboxMachine.reduce(
            PhotoLightboxMachine.initial(),
            PhotoLightboxEvent(opened = PhotoLightboxEvent.Opened(asset_id = "a50", neighbour_asset_ids = shelf)),
        ).state
        state.slideshow_meta shouldBe "50 of 100, 4 seconds a photo"
        PhotoLightboxMachine.filmWindow(shelf, "a50") shouldBe PhotoLightboxMachine.filmWindow(state)
        PhotoLightboxMachine.filmWindow(shelf, "a50").size shouldBe 2 * PhotoLightboxMachine.FILM_REACH + 1
        PhotoLightboxMachine.filmOffset(shelf, "a50") shouldBe 49 - PhotoLightboxMachine.FILM_REACH
        PhotoLightboxMachine.filmWindow(shelf, "gone").shouldBeEmpty()
        PhotoLightboxMachine.filmOffset(shelf, "gone") shouldBe 0
    }
})
