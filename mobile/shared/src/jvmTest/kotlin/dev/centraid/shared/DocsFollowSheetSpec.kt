package dev.centraid.shared

import centraid.screen.v1.DocsDriveEvent
import centraid.screen.v1.DocsDriveState
import centraid.screen.v1.DocsFollowed
import centraid.screen.v1.DocsSheet
import dev.centraid.design.copy.DocsCopy
import dev.centraid.shared.apps.docs.DocsDriveMachine
import dev.centraid.shared.apps.docs.DocsFollowBridge
import dev.centraid.shared.apps.docs.DocsWrites
import dev.centraid.shared.shell.PhoneFollowWords
import dev.centraid.shared.sync.phone.GoneReason
import dev.centraid.shared.sync.phone.OriginGone
import dev.centraid.shared.sync.phone.PhoneSource
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

/** DOCS' SURFACE FOR FOLLOWING A FOLDER (#1127, lane F): the Add row, More's row, the Followed sheet, and the question's words. */
class DocsFollowSheetSpec : StringSpec({
    fun drive(event: DocsDriveEvent, state: DocsDriveState) = DocsDriveMachine.reduce(state, event).state

    fun followed(vararg folders: DocsFollowed) =
        drive(DocsDriveEvent(followed_changed = DocsDriveEvent.FollowedChanged(followed = folders.toList())), DocsDriveMachine.initial())

    val taxes = DocsFollowed(origin_id = "folder:1", name = "Taxes", documents = 12)
    val receipts = DocsFollowed(origin_id = "folder:2", name = "Receipts", documents = 1)

    "the Add sheet offers Follow a folder, after Upload, in Docs' own words" {
        val s = drive(DocsDriveEvent(sheet_opened = DocsDriveEvent.SheetOpened(kind = DocsSheet.Kind.KIND_ADD)), followed())
        val row = s.sheet!!.actions!!.actions.single { it.key == DocsWrites.KEY_FOLLOW_FOLDER }
        row.label shouldBe "Follow a folder"
        row.enabled shouldBe true
        s.sheet.actions.actions.map { it.key }.take(2) shouldBe listOf(DocsWrites.KEY_UPLOAD, DocsWrites.KEY_FOLLOW_FOLDER)
    }

    "More lists Followed folders only once a folder is followed" {
        fun more(s: DocsDriveState) = drive(DocsDriveEvent(band = DocsDriveEvent.BandPicked(key = DocsDriveMachine.BAND_MORE)), s)
        more(followed()).sheet!!.actions!!.actions.map { it.key } shouldBe listOf(DocsWrites.KEY_RECENT, DocsWrites.KEY_TRASH_SHELF)
        more(followed(taxes)).sheet!!.actions!!.actions.map { it.key } shouldBe
            listOf(DocsWrites.KEY_RECENT, DocsWrites.KEY_FOLLOWED, DocsWrites.KEY_TRASH_SHELF)
    }

    "Followed folders is a sheet with a Stop following row per folder, and what stopping keeps" {
        var s = followed(taxes, receipts)
        s = drive(DocsDriveEvent(band = DocsDriveEvent.BandPicked(key = DocsDriveMachine.BAND_MORE)), s)
        s = drive(DocsDriveEvent(action = DocsDriveEvent.ActionPicked(key = DocsWrites.KEY_FOLLOWED)), s)
        s.sheet!!.kind shouldBe DocsSheet.Kind.KIND_FOLLOWED
        s.sheet.title shouldBe "Followed folders"
        val rows = s.sheet.actions!!.actions
        rows.map { it.key } shouldBe listOf("stop:folder:1", "stop:folder:2")
        rows.map { it.label } shouldBe listOf("Stop following Taxes", "Stop following Receipts")
        rows.map { it.detail } shouldBe listOf("12 documents stay in Docs", "1 document stays in Docs")
        rows.any { it.destructive } shouldBe false
        s.sheet.actions.footer shouldBe DocsCopy.FOLLOWED_FOOTER
    }

    "a row's key names the folder to stop, and any other key names none" {
        val bridge = DocsFollowBridge()
        bridge.stopTarget("stop:folder:1") shouldBe "folder:1"
        bridge.stopTarget("stop:") shouldBe null
        bridge.stopTarget(DocsWrites.KEY_FOLLOWED) shouldBe null
    }

    "the follow and stop intents put the sheet away, and a report replaces the list" {
        var s = drive(DocsDriveEvent(sheet_opened = DocsDriveEvent.SheetOpened(kind = DocsSheet.Kind.KIND_ADD)), followed(taxes))
        drive(DocsDriveEvent(follow_folder_requested = DocsDriveEvent.FollowFolderRequested()), s).sheet!!.kind shouldBe DocsSheet.Kind.KIND_NONE
        s = drive(DocsDriveEvent(sheet_opened = DocsDriveEvent.SheetOpened(kind = DocsSheet.Kind.KIND_FOLLOWED)), s)
        drive(
            DocsDriveEvent(stop_following_requested = DocsDriveEvent.StopFollowingRequested(origin_id = "folder:1")),
            s,
        ).sheet!!.kind shouldBe DocsSheet.Kind.KIND_NONE
        followed(taxes).followed.map { it.name } shouldBe listOf("Taxes")
        drive(DocsDriveEvent(followed_changed = DocsDriveEvent.FollowedChanged()), followed(taxes)).followed shouldBe emptyList()
    }

    "a folder that cannot be reached asks Keep its documents, in Docs' words, with Keep as the default" {
        val left = PhoneFollowWords.question(OriginGone(PhoneSource.FILES, "o1", "folder:1", "Taxes", 12))
        left.title shouldBe "Taxes can't be reached"
        left.body shouldBe "Keep its 12 documents in Docs?"
        left.keepLabel shouldBe "Keep"
        left.trashLabel shouldBe "Move to trash"
        PhoneFollowWords.question(OriginGone(PhoneSource.FILES, "o1", "folder:1", "Taxes", 1)).body shouldBe
            "Keep its 1 document in Docs?"
        val vanished = PhoneFollowWords.question(
            OriginGone(PhoneSource.FILES, "o1", "folder:1", "Taxes", 6, GoneReason.VANISHED),
        )
        vanished.title shouldBe "Most of Taxes is missing from this phone"
        vanished.body shouldBe "Keep the 6 documents missing from it in Docs?"
    }
})
