package dev.centraid.shared

import centraid.screen.v1.BackupState
import centraid.screen.v1.MediaPermission
import centraid.screen.v1.PhotoCell
import centraid.screen.v1.PhotosGridData
import centraid.screen.v1.PhotosGridEvent
import centraid.screen.v1.PhotosImportBanner
import centraid.screen.v1.PhotosGridState
import dev.centraid.design.copy.PhotosCopy
import dev.centraid.shared.apps.photos.PhotosGridMachine
import dev.centraid.shared.apps.photos.PhotosTimeline
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.booleans.shouldBeFalse
import io.kotest.matchers.booleans.shouldBeTrue
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldNotContain
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe

/**
 * PHOTOS' ROOT CHROME IS THE MACHINE'S (R-CHROME-1…5): the band is places then
 * More with no Search tab, the filter is a chip row on the library only, the
 * tile size is a More choice, and every word comes off the state.
 */
class PhotosGridChromeSpec : StringSpec({

    fun reduce(state: PhotosGridState, event: PhotosGridEvent): PhotosGridState =
        PhotosGridMachine.reduce(state, event).state

    fun moved(to: PhotosGridState.Destination): PhotosGridState =
        reduce(PhotosGridMachine.initial(), PhotosGridEvent(destination = PhotosGridEvent.DestinationChanged(to)))

    "the band is Library, Collections, then More — no Search tab" {
        val band = PhotosGridMachine.initial().band
        band.map { it.key } shouldBe listOf("library", "collections", "more")
        band.map { it.label } shouldBe listOf(
            PhotosCopy.PHOTOS_BAND_LIBRARY,
            PhotosCopy.PHOTOS_BAND_COLLECTIONS,
            PhotosCopy.PHOTOS_BAND_MORE,
        )
        band.map { it.icon_key } shouldBe listOf("Image", "Layers", "MoreHoriz")
        band.map { it.key } shouldNotContain "search"
    }

    "the lit tab follows the destination, and More is lit while its sheet is up" {
        PhotosGridMachine.initial().band.single { it.current }.key shouldBe "library"
        moved(PhotosGridState.Destination.DESTINATION_COLLECTIONS).band.single { it.current }.key shouldBe "collections"
        val more = reduce(
            PhotosGridMachine.initial(),
            PhotosGridEvent(sheet = PhotosGridEvent.SheetChanged(PhotosGridState.Sheet.SHEET_MORE)),
        )
        more.band.single { it.current }.key shouldBe "more"
        val closed = reduce(more, PhotosGridEvent(sheet = PhotosGridEvent.SheetChanged(PhotosGridState.Sheet.SHEET_NONE)))
        closed.band.single { it.current }.key shouldBe "library"
    }

    "the filter is a chip row on the library, and its selection follows the filter" {
        val initial = PhotosGridMachine.initial()
        initial.chips.map { it.label } shouldBe listOf(PhotosCopy.PHOTOS_FILTER_ALL, PhotosCopy.PHOTOS_FILTER_FAVORITES)
        initial.chips.single { it.selected }.filter shouldBe PhotosGridState.Filter.FILTER_ALL

        val favorites = reduce(
            initial,
            PhotosGridEvent(filter = PhotosGridEvent.FilterChanged(PhotosGridState.Filter.FILTER_FAVORITES)),
        )
        favorites.chips.single { it.selected }.filter shouldBe PhotosGridState.Filter.FILTER_FAVORITES
    }

    "no chips off the library, on Search's page, or while selecting" {
        moved(PhotosGridState.Destination.DESTINATION_COLLECTIONS).chips.shouldBeEmpty()
        moved(PhotosGridState.Destination.DESTINATION_SEARCH).chips.shouldBeEmpty()
        reduce(
            PhotosGridMachine.initial(),
            PhotosGridEvent(selection_mode = PhotosGridEvent.SelectionModeChanged(selecting = true)),
        ).chips.shouldBeEmpty()
    }

    "the header's words are the copy table's" {
        val chrome = PhotosGridMachine.initial().chrome.shouldNotBeNull()
        chrome.title shouldBe PhotosCopy.PHOTOS_TITLE
        chrome.search_placeholder shouldBe PhotosCopy.PHOTOS_SEARCH_PLACEHOLDER
        chrome.select_label shouldBe PhotosCopy.PHOTOS_SELECT
        chrome.cancel_label shouldBe PhotosCopy.PHOTOS_GRID_CANCEL
        chrome.new_album_label shouldBe PhotosCopy.PHOTOS_NEW_ALBUM
        chrome.tile_sizes shouldBe PhotosTimeline.RUNG_LABELS
    }

    "tile size is offered in More only on the library at All" {
        PhotosGridMachine.initial().chrome.shouldNotBeNull().tile_size_offered.shouldBeTrue()
        reduce(
            PhotosGridMachine.initial(),
            PhotosGridEvent(grain = PhotosGridEvent.GrainChanged(grain = PhotosGridState.Grain.GRAIN_YEARS)),
        ).chrome.shouldNotBeNull().tile_size_offered.shouldBeFalse()
        moved(PhotosGridState.Destination.DESTINATION_COLLECTIONS).chrome.shouldNotBeNull().tile_size_offered.shouldBeFalse()
    }

    "picking a tile size closes the choice; a pinch under no sheet opens none" {
        val choosing = reduce(
            PhotosGridMachine.initial(),
            PhotosGridEvent(sheet = PhotosGridEvent.SheetChanged(PhotosGridState.Sheet.SHEET_TILE_SIZE)),
        )
        choosing.band.single { it.current }.key shouldBe "more"
        val picked = reduce(choosing, PhotosGridEvent(rung = PhotosGridEvent.RungChanged(rung = 0)))
        picked.rung shouldBe 0
        picked.sheet shouldBe PhotosGridState.Sheet.SHEET_NONE

        val pinched = reduce(PhotosGridMachine.initial(), PhotosGridEvent(rung = PhotosGridEvent.RungChanged(rung = 3)))
        pinched.rung shouldBe 3
        pinched.sheet shouldBe PhotosGridState.Sheet.SHEET_NONE
    }

    // --- the camera-roll banner: only when there is something to say or do ---

    fun library(
        permission: MediaPermission,
        phase: BackupState.Phase,
        photos: Int,
        reason: String = "",
    ): PhotosGridState = PhotosGridMachine.initial().copy(
        permission = permission,
        loading = null,
        data_ = PhotosGridData(
            cells = (1..photos).map { PhotoCell(asset_id = "ast-$it") },
            complete = true,
        ),
        backup = BackupState(phase = phase, paused_reason = reason),
    )

    "a done or idle import over a library with photographs draws no banner" {
        for (phase in listOf(BackupState.Phase.PHASE_DONE, BackupState.Phase.PHASE_IDLE)) {
            PhotosGridMachine.importBanner(
                library(MediaPermission.MEDIA_PERMISSION_GRANTED, phase, photos = 12),
            ).shouldBeNull()
        }
    }

    "Import now is offered over an empty library the grant can fill, and never over photographs" {
        val empty = PhotosGridMachine.importBanner(
            library(MediaPermission.MEDIA_PERMISSION_GRANTED, BackupState.Phase.PHASE_DONE, photos = 0),
        ).shouldNotBeNull()
        empty.import_now.shouldBeTrue()
        empty.import_now_label shouldBe PhotosCopy.PHOTOS_IMPORT_NOW

        // An empty library behind a refusal has nothing to import from.
        PhotosGridMachine.importBanner(
            library(MediaPermission.MEDIA_PERMISSION_DENIED, BackupState.Phase.PHASE_IDLE, photos = 0),
        ).shouldNotBeNull().import_now.shouldBeFalse()

        // A pass already running is not offered again.
        PhotosGridMachine.importBanner(
            library(MediaPermission.MEDIA_PERMISSION_GRANTED, BackupState.Phase.PHASE_ENUMERATING, photos = 0),
        ).shouldNotBeNull().import_now.shouldBeFalse()
    }

    "a library emptied by the Favorites filter is not an empty library" {
        PhotosGridMachine.importBanner(
            library(MediaPermission.MEDIA_PERMISSION_GRANTED, BackupState.Phase.PHASE_DONE, photos = 0)
                .copy(filter = PhotosGridState.Filter.FILTER_FAVORITES),
        ).shouldBeNull()
    }

    "a grant's remedy is shown over a full library, with the grant's own sentence" {
        val cases = mapOf(
            MediaPermission.MEDIA_PERMISSION_NOT_ASKED to PhotosImportBanner.Remedy.REMEDY_ASK,
            MediaPermission.MEDIA_PERMISSION_DENIED to PhotosImportBanner.Remedy.REMEDY_SETTINGS,
            MediaPermission.MEDIA_PERMISSION_LIMITED to PhotosImportBanner.Remedy.REMEDY_MANAGE_SELECTION,
        )
        for ((permission, remedy) in cases) {
            val banner = PhotosGridMachine.importBanner(
                library(permission, BackupState.Phase.PHASE_DONE, photos = 12),
            ).shouldNotBeNull()
            banner.remedy shouldBe remedy
            banner.import_now.shouldBeFalse()
            banner.reason.isNotEmpty().shouldBeTrue()
        }
        val labels = PhotosGridMachine.importBanner(
            library(MediaPermission.MEDIA_PERMISSION_DENIED, BackupState.Phase.PHASE_IDLE, photos = 3),
        ).shouldNotBeNull()
        labels.settings_label shouldBe PhotosCopy.PHOTOS_OPEN_SETTINGS
        labels.allow_label shouldBe PhotosCopy.PHOTOS_ALLOW_ACCESS
    }

    "an import moving, or waiting, says so over a full library — and no Import now" {
        val moving = PhotosGridMachine.importBanner(
            library(MediaPermission.MEDIA_PERMISSION_GRANTED, BackupState.Phase.PHASE_TRANSFERRING, photos = 12),
        ).shouldNotBeNull()
        moving.sentence.isNotEmpty().shouldBeTrue()
        moving.import_now.shouldBeFalse()

        val waiting = PhotosGridMachine.importBanner(
            library(
                MediaPermission.MEDIA_PERMISSION_GRANTED,
                BackupState.Phase.PHASE_WAITING_FOR_UNMETERED,
                photos = 12,
                reason = "Waiting for Wi-Fi, as you asked.",
            ),
        ).shouldNotBeNull()
        waiting.sentence shouldBe PhotosCopy.PHOTOS_IMPORT_WAIT_WIFI
        waiting.reason shouldBe "Waiting for Wi-Fi, as you asked."
    }

    "the banner rides the state on every step" {
        val done = reduce(
            library(MediaPermission.MEDIA_PERMISSION_GRANTED, BackupState.Phase.PHASE_TRANSFERRING, photos = 12),
            PhotosGridEvent(backup = PhotosGridEvent.BackupChanged(BackupState(phase = BackupState.Phase.PHASE_DONE))),
        )
        done.import_banner.shouldBeNull()
    }
})
