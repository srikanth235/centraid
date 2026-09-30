package dev.centraid.shared

import centraid.core.v1.CommandStatus
import centraid.core.v1.NullValue
import centraid.core.v1.Row
import centraid.core.v1.Value
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotoDetail
import centraid.screen.v1.PhotoLabel
import centraid.screen.v1.PhotoLightboxEvent
import centraid.screen.v1.PhotoLightboxState
import centraid.screen.v1.PhotoPerson
import dev.centraid.shared.apps.photos.PhotoEditorMachine
import dev.centraid.shared.apps.photos.PhotoLightboxLeg
import dev.centraid.shared.apps.photos.PhotoLightboxMachine
import dev.centraid.shared.apps.photos.PhotoLightboxReads
import dev.centraid.shared.apps.photos.SharePlacePrecision
import dev.centraid.shared.apps.photos.sharePlaceOptions
import dev.centraid.shared.screen.Reads
import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.Step
import io.kotest.assertions.withClue
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe

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

    /** The asset leg's own row: eleven named columns, then the door's three. */
    fun assetRow(
        capturedAt: String = "2026-07-30T17:42:00.000Z",
        archivedAt: String = "",
        deletedAt: String = "",
        placeId: String = "place-1",
        kind: String = "photo",
    ) = Row(
        values = listOf(
            Value(text = asset),
            Value(text = kind),
            Value(text = "Lyme Regis"),
            Value(text = capturedAt),
            Value(integer = 60L),
            Value(text = placeId),
            Value(integer = 4032L),
            Value(integer = 3024L),
            // `duration_s` IS `REAL` IN THE DDL and arrives on the real arm.
            Value(real = 24.5),
            if (archivedAt.isEmpty()) Value(null_ = NullValue()) else Value(text = archivedAt),
            if (deletedAt.isEmpty()) Value(null_ = NullValue()) else Value(text = deletedAt),
            // The door's three computed columns, appended in this order.
            Value(text = "/store/data/thumb.data"),
            Value(text = "a0b1"),
            Value(integer = 0L),
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
        query.where_.shouldNotBeNull() shouldBe "asset_id = ?"
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
        detail.title shouldBe "Lyme Regis"
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

    "a timestamp column is a boolean to this screen, and nothing else fills it" {
        detailOf().archived shouldBe false
        detailOf().trashed shouldBe false
        detailOf(assetRow(archivedAt = "2026-08-01T00:00:00.000Z")).archived shouldBe true
        detailOf(assetRow(deletedAt = "2026-08-01T00:00:00.000Z")).trashed shouldBe true
    }

    "the asset read answers for neither the original's path nor its size" {
        // NOTHING ON THIS DOOR CAN. `with_held_thumbnail` resolves the DRAWABLE
        // hash to a path and `original_held` "hands out no path"; the byte door
        // is the only thing that knows, and no `ScreenEffect` carries a request
        // to it. Absent rather than fabricated — and asserted, so the day the
        // field can be filled this test is what says where.
        detailOf().original_path.shouldBeNull()
        detailOf().byte_size shouldBe 0L
        // AND NEITHER FOR THE CAMERA: `camera_device_id` is an access-plane id
        // and `exif_json` is not a reducer's to parse.
        detailOf().camera shouldBe ""
    }

    "an unrecognised kind is unspecified, never a photograph" {
        detailOf(assetRow(kind = "hologram")).kind shouldBe PhotoCell.Kind.KIND_UNSPECIFIED
    }

    // --- The legs ----------------------------------------------------------

    "the asset's arrival asks the legs its own row makes possible" {
        val effects = loaded().effects
        effects shouldContain ScreenEffect.ReadPage(
            PhotoLightboxMachine.readId(PhotoLightboxMachine.Leg.FACES),
            null,
        )
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
                people = listOf(PhotoPerson(party_id = "party-1")),
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
                // walk. Five of the six sort by their own primary key, which is
                // `crates/apps/photos`' idiom for a set read by id and is what
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
        // A FACE READ THAT NEVER ANSWERS IS NOT A FAILURE OF THE PHOTOGRAPH —
        // and it is not silence either. It was, for one draft, so "nobody is in
        // this photograph" and "the face read was refused" drew the same empty
        // panel: the two-empty-cell-sentences defect one level up.
        val before = loaded().state
        val step = PhotoLightboxMachine.reduce(
            before,
            PhotoLightboxLeg(PhotoLightboxMachine.Leg.FACES).refused(Reads.refused("nope")),
        )
        step.state.detail.shouldNotBeNull().asset_id shouldBe asset
        step.state.failure.shouldBeNull()
        step.state.loading.shouldBeNull()
        step.effects.shouldBeEmpty()
        step.state.detail.shouldNotBeNull().unread_parts shouldBe
            listOf(PhotoDetail.Part.PART_PEOPLE)
    }

    "six legs answer for four parts, because two of them are second hops" {
        // A MEMBER READING "could not read who is in this photograph" does not
        // need to know which of the two reads it was, and a part per hop would
        // be the plumbing showing through.
        PhotoLightboxMachine.Leg.entries.map { PhotoLightboxLeg(it).part }.toSet() shouldBe
            setOf(
                PhotoDetail.Part.PART_PLACE,
                PhotoDetail.Part.PART_PEOPLE,
                PhotoDetail.Part.PART_LABELS,
                PhotoDetail.Part.PART_CONTENT,
            )
        PhotoLightboxLeg(PhotoLightboxMachine.Leg.PEOPLE).part shouldBe
            PhotoLightboxLeg(PhotoLightboxMachine.Leg.FACES).part
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
                listOf(Row(values = listOf(Value(text = "place-1"), Value(text = "Lyme Regis")))),
                null,
            ),
        ).state
        named.detail.shouldNotBeNull().place_name shouldBe "Lyme Regis"
        named.detail.shouldNotBeNull().unread_parts.shouldBeEmpty()
    }

    "a photograph whose every part answered carries no unread marks" {
        // EMPTY IS THE ORDINARY CASE: everything that was asked, answered.
        loaded().state.detail.shouldNotBeNull().unread_parts.shouldBeEmpty()
    }

    "faces bring ids and the party read brings names, in two hops that terminate" {
        val faces = PhotoLightboxLeg(PhotoLightboxMachine.Leg.FACES).arrived(
            listOf(
                Row(values = listOf(Value(text = "region-1"), Value(text = "party-1"))),
                // A CONFIRMED REGION WITH NOBODY IN IT. `party_id` is
                // `ON DELETE SET NULL`, so a purged person leaves one behind.
                Row(values = listOf(Value(text = "region-2"), Value(null_ = NullValue()))),
            ),
            null,
        )
        val withIds = PhotoLightboxMachine.reduce(loaded().state, faces)
        withIds.state.detail.shouldNotBeNull().people.map { it.party_id } shouldBe
            listOf("party-1")
        withIds.effects shouldContain ScreenEffect.ReadPage(
            PhotoLightboxMachine.readId(PhotoLightboxMachine.Leg.PEOPLE),
            null,
        )

        val people = PhotoLightboxLeg(PhotoLightboxMachine.Leg.PEOPLE).arrived(
            listOf(Row(values = listOf(Value(text = "party-1"), Value(text = "Ada")))),
            null,
        )
        val named = PhotoLightboxMachine.reduce(withIds.state, people)
        named.state.detail.shouldNotBeNull().people.single().display_name shouldBe "Ada"
        // AND IT STOPS. The follow-up fires only for ids the arrival
        // INTRODUCED, so an answer that names everybody asks for nobody — and a
        // rule of "read while anything is unnamed" would ask for ever.
        named.effects.shouldBeEmpty()
    }

    "a party the read could not name asks again about nobody" {
        val faces = PhotoLightboxLeg(PhotoLightboxMachine.Leg.FACES).arrived(
            listOf(Row(values = listOf(Value(text = "region-1"), Value(text = "ghost")))),
            null,
        )
        val withIds = PhotoLightboxMachine.reduce(loaded().state, faces)
        // The party was purged between the two reads: an empty page.
        val nobody = PhotoLightboxLeg(PhotoLightboxMachine.Leg.PEOPLE).arrived(emptyList(), null)
        val after = PhotoLightboxMachine.reduce(withIds.state, nobody)
        after.effects.shouldBeEmpty()
        after.state.detail.shouldNotBeNull().people.single().display_name shouldBe ""
    }

    "a tag says who put it there, structurally" {
        // THE DDL'S OWN CHECK is `tagged_by_party_id IS NULL OR (derivation_id
        // IS NULL AND input_revision_id IS NULL)`, so a member's tag and a
        // derivation's proposal are mutually exclusive by construction and the
        // presence of a tagger IS the answer. `confidence` is deliberately not
        // consulted: a derivation at 0.99 is still a proposal.
        val tags = PhotoLightboxLeg(PhotoLightboxMachine.Leg.TAGS).arrived(
            listOf(
                Row(
                    values = listOf(
                        Value(text = "tag-1"),
                        Value(text = "concept-1"),
                        Value(text = "party-me"),
                    ),
                ),
                Row(
                    values = listOf(
                        Value(text = "tag-2"),
                        Value(text = "concept-2"),
                        Value(null_ = NullValue()),
                    ),
                ),
            ),
            null,
        )
        val labels = tags.data_.shouldNotBeNull().detail.shouldNotBeNull().labels
        labels.single { it.concept_id == "concept-1" }.confirmed shouldBe true
        labels.single { it.concept_id == "concept-2" }.confirmed shouldBe false
    }

    "the star is a tag, and the concepts read is where it stops being one" {
        val tags = PhotoLightboxLeg(PhotoLightboxMachine.Leg.TAGS).arrived(
            listOf(
                Row(
                    values = listOf(
                        Value(text = "tag-1"),
                        Value(text = "concept-star"),
                        Value(text = "party-me"),
                    ),
                ),
                Row(
                    values = listOf(
                        Value(text = "tag-2"),
                        Value(text = "concept-beach"),
                        Value(text = "party-me"),
                    ),
                ),
            ),
            null,
        )
        val tagged = PhotoLightboxMachine.reduce(loaded().state, tags)
        tagged.effects shouldContain ScreenEffect.ReadPage(
            PhotoLightboxMachine.readId(PhotoLightboxMachine.Leg.CONCEPTS),
            null,
        )
        val concepts = PhotoLightboxLeg(PhotoLightboxMachine.Leg.CONCEPTS).arrived(
            listOf(
                Row(
                    values = listOf(
                        Value(text = "concept-star"),
                        Value(text = "Starred"),
                        Value(text = "starred"),
                    ),
                ),
                Row(
                    values = listOf(
                        Value(text = "concept-beach"),
                        Value(text = "Beach"),
                        Value(text = "beach"),
                    ),
                ),
            ),
            null,
        )
        val worded = PhotoLightboxMachine.reduce(tagged.state, concepts).state
        val detail = worded.detail.shouldNotBeNull()
        detail.favorite shouldBe true
        // AND THE STAR IS NOT A CHIP. The flags scheme's concept is the heart,
        // never a label reading "Starred" beside the member's own words.
        detail.labels.single { it.concept_id == "concept-beach" }.label shouldBe "Beach"
        detail.labels.none { it.label == "Starred" } shouldBe true
    }

    "the byte size arrives through the hash, because the detail carries no content id" {
        val content = PhotoLightboxLeg(PhotoLightboxMachine.Leg.CONTENT).arrived(
            listOf(Row(values = listOf(Value(text = "content-1"), Value(integer = 4_200_000L)))),
            null,
        )
        val sized = PhotoLightboxMachine.reduce(loaded().state, content).state
        sized.detail.shouldNotBeNull().byte_size shouldBe 4_200_000L
        // `core_content_item.content_hash` IS `NOT NULL UNIQUE`, so the hash
        // the thumbnail column already handed this screen addresses exactly one
        // item — which is what makes the identity honest.
        val query = PhotoLightboxLeg(PhotoLightboxMachine.Leg.CONTENT)
            .query(loaded().state, null).shouldNotBeNull()
        query.bind.map { it.text } shouldBe listOf("a0b1")
    }

    // --- Amendments and the photograph on screen ---------------------------

    "an amendment says so, and a leg that could carry an asset id would not fool it" {
        // `amendment` IS EXPLICIT. `media_face_region` and `core_tag` both have
        // the asset in a column, so the day a leg projects one, the old
        // inference — "a detail with no id is a satellite" — would start
        // REPLACING the photograph with a face region. Both shapes typecheck,
        // which is why this is asserted rather than trusted.
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
            "Crop and rotate work on photographs, not on this kind of media"
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
        favorite.command shouldBe "media.set_favorite"
        favorite.inputJson shouldBe """{"asset_id":"asset-1","favorite":1}"""
        // THE KEY IS CONTENT-DERIVED AND NEVER AN ORDINAL: without a stable key
        // a replayed command re-executes one that already committed. It carries
        // the VALUE as well as the id, so favourite-then-unfavourite are two
        // intents and not one replayed.
        favorite.invokeKey shouldBe "media.set_favorite:asset-1:1"
        writeOf(
            PhotoLightboxEvent(favorite = PhotoLightboxEvent.FavoriteToggled(favorite = false)),
        ).invokeKey shouldBe "media.set_favorite:asset-1:0"

        val archive = writeOf(
            PhotoLightboxEvent(archive = PhotoLightboxEvent.ArchiveToggled(archived = true)),
        )
        archive.command shouldBe "media.update_asset"
        archive.inputJson shouldBe """{"asset_id":"asset-1","archived":1}"""

        // TWO COMMANDS, ONE TAP APART, AND ONLY ONE OF THEM IS REVERSIBLE.
        writeOf(
            PhotoLightboxEvent(delete = PhotoLightboxEvent.DeleteRequested(permanent = false)),
        ).command shouldBe "media.delete_asset"
        writeOf(
            PhotoLightboxEvent(delete = PhotoLightboxEvent.DeleteRequested(permanent = true)),
        ).command shouldBe "media.purge_asset"
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

    // --- Sync --------------------------------------------------------------

    "this photograph's own row moves the screen and no other's does" {
        PhotoLightboxMachine.rowsChanged("media_asset", listOf(asset)).shouldNotBeNull()
        // NOT `core_tag`, although a favourite IS a tag row: the change stream
        // would hand over TAG ids and `RowsChanged` carries `asset_ids`, so the
        // reducer would match them against its own id and never hit.
        PhotoLightboxMachine.rowsChanged("core_tag", listOf("tag-1")).shouldBeNull()
        PhotoLightboxMachine.rowsChanged("media_asset_other", listOf(asset)).shouldBeNull()

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
})
