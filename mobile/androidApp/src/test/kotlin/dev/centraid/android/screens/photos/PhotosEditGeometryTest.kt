package dev.centraid.android.screens.photos

import centraid.core.v1.PhotosEditCrop
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * ONE EDITOR GEOMETRY, THIS SHELL'S HALF (#1185): the real [PhotosEditRender.framePixels] over every
 * case in `contracts/photos/editor-geometry.json`, which `crates/screens` generates from
 * `editor::crop_pixels`. A rectangle that differs from Rust's is a saved photograph cut differently
 * on this phone than on the other.
 */
class PhotosEditGeometryTest {
    private val fixture: String by lazy {
        // Gradle runs a module's unit tests from the module directory.
        generateSequence(File("").absoluteFile) { it.parentFile }
            .map { File(it, "contracts/photos/editor-geometry.json") }
            .first { it.exists() }
            .readText()
    }

    private val number = """(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)"""

    @Test
    fun everyFixtureCaseIsCutWhereRustCutsIt() {
        val cases = Regex(
            """"name": "([^"]+)".*?"crop": (null|\{"x": $number, "y": $number, "w": $number, "h": $number\}), """ +
                """"frame": \[(\d+), (\d+)\], "expected": \[(\d+), (\d+), (\d+), (\d+)\]""",
        ).findAll(fixture).toList()
        assertEquals(17, cases.size)
        cases.forEach { match ->
            val g = match.groupValues
            val crop = if (g[2] == "null") {
                null
            } else {
                PhotosEditCrop(x = g[3].toDouble(), y = g[4].toDouble(), w = g[5].toDouble(), h = g[6].toDouble())
            }
            val got = PhotosEditRender.framePixels(crop, g[7].toInt(), g[8].toInt())
            assertEquals(g[1], listOf(g[9].toInt(), g[10].toInt(), g[11].toInt(), g[12].toInt()), got)
        }
    }
}
