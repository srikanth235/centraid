package dev.centraid.shared

import centraid.screen.v1.PlaceRow
import centraid.screen.v1.PlacesData
import dev.centraid.shared.apps.photos.PlacesMachine
import io.kotest.core.spec.style.StringSpec
import io.kotest.matchers.shouldBe

/**
 * The library's layout rules (the justified packing, the rows, the cards, the
 * pinch table) are Rust's now and are pinned by `crates/screens/tests/photos_home.rs`.
 * What is left here is Places' pin plotting, which `photos.places` takes with it.
 */
class PhotosLibraryLayoutSpec : StringSpec({

    "a place's pin stands in the state, sized by the square root of its count" {
        val data = PlacesData(
            places = listOf(
                PlaceRow(place_id = "big", asset_count = 100, latitude = 40.0, longitude = -120.0, has_coordinate = true),
                PlaceRow(place_id = "small", asset_count = 25, latitude = 30.0, longitude = -110.0, has_coordinate = true),
                PlaceRow(place_id = "nowhere", asset_count = 9),
            ),
        )
        val plotted = PlacesMachine.withPlot(data).places.associateBy { it.place_id }
        plotted.getValue("big").pin_y shouldBe 0.0
        plotted.getValue("small").pin_y shouldBe 1.0
        plotted.getValue("big").pin_size shouldBe PlacesMachine.PIN_CEILING.toDouble()
        // sqrt(25) / sqrt(100) = half the way from the floor to the ceiling.
        plotted.getValue("small").pin_size shouldBe 52.0
        // A row with no pin is left as it was: it is not on the plate.
        plotted.getValue("nowhere").pin_size shouldBe 0.0
    }
})
