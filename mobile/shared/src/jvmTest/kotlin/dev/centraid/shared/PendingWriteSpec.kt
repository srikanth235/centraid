package dev.centraid.shared

import centraid.screen.v1.PhotosGridEvent
import dev.centraid.shared.apps.photos.PhotosGridMachine
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe

/**
 * FILES LANDING MOVE THE GRID (#1025 S7).
 *
 * ## What this spec used to hold, and where the other two went
 *
 * It carried three joins #1025 S7 added to this shell. Two of them were halves
 * of a PAIRING and left with it in #1029 §1:
 *
 * * *"an enrolment is kept before there is a replica to write it into"* —
 *   `Enrolments` held one record per vault: this device's endpoint secret, the
 *   public half a gateway said it had enrolled, where that gateway was reached
 *   and whether it had relays. There is no gateway to enrol with. The object is
 *   deleted, and `grep -rn 'Enrolments|PairingRecord' mobile/ --include=*.kt`
 *   finds nothing.
 * * *"a pass that is still copying the vault says so"* — `SyncOutcome.copying`
 *   narrated a bootstrap's progress as a percentage, and a bootstrap is a copy
 *   taken from a gateway. `SyncOutcome` is deleted with `GatewayLink`.
 *
 * Both are tests whose SUBJECT is gone, not tests removed to go green.
 *
 * ## The one that stays, and why it earns its place
 *
 * Nineteen photographs arrived on a device and nothing on the screen moved: the
 * byte plane named `core_content_item` and carried content ids, which matched
 * nothing the grid was showing, so the only honest reduction was "re-read
 * everything" and the member read "not on this device yet" over a device that
 * had them. The fix was that a landed byte is a ROW on `media_asset`
 * (D-1025-S7-20), and that is still how a photograph reaches this screen —
 * whatever puts the bytes there.
 */
class PendingWriteSpec : StringSpec({

    "files landing are a row change on the assets that own them" {
        // A LANDED BYTE IS A ROW (D-1025-S7-20). The core names `media_asset`
        // and carries ASSET ids, because the join from hash back to row happens
        // before the event — so this is the grid's ordinary `RowsChanged` and
        // there is no second event kind. It used to name `core_content_item`
        // and carry content ids, which matched nothing the grid was showing;
        // the only honest reduction was "re-read everything", and that is what
        // the deleted `BytesArrived` case was.
        val event: PhotosGridEvent? = PhotosGridMachine.rowsChanged(
            table = "media_asset",
            keys = listOf("a-1", "a-2"),
        )
        event.shouldNotBeNull()
        event.rows_changed.shouldNotBeNull()
        event.rows_changed!!.asset_ids shouldBe listOf("a-1", "a-2")
        // AND A TABLE THIS SCREEN DOES NOT READ IS NOT ITS EVENT — including
        // the one the byte plane used to name.
        PhotosGridMachine.rowsChanged("core_content_item", listOf("c-1")).shouldBeNull()
        PhotosGridMachine.rowsChanged("knowledge_note", listOf("n-1")).shouldBeNull()
    }
})
