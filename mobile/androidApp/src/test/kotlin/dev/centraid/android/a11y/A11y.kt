package dev.centraid.android.a11y

import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.SemanticsNodeInteractionCollection
import androidx.compose.ui.platform.ViewRootForTest
import androidx.core.view.drawToBitmap
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.unit.Density
import kotlin.math.max
import kotlin.math.min

/**
 * THE ACCESSIBILITY CHECKS OF THE SUITE (#1202, S4), over the Compose semantics tree and the drawn pixels.
 *
 * WHY NOT THE ACCESSIBILITY TEST FRAMEWORK: `enableAccessibilityChecks` hands the framework the view hierarchy,
 * and under Robolectric the framework cannot see inside a Compose view (every check on it comes back
 * `NOT_RUN` with "Composable content is not evaluated in this environment" and the one virtual node
 * "This item is not visible"); a suite that can only pass proves nothing. These are the same questions, asked
 * of the semantics tree, so they run on the JVM, and [A11yCanaryTest] proves each can fail.
 *
 * THE RULES (design/behaviour.md § Accessibility): a control is 48dp or more in both directions (the platform
 * floor, which is wider than the 44 the iOS shell holds); an icon-only control carries a label; no two
 * controls on a screen say the same thing; text is 4.5:1 or more and a control 3:1 or more against what it
 * lands on, in light and dark.
 */
internal object A11y {
    /** One failed rule on one screen. */
    data class Finding(val check: String, val where: String, val detail: String) {
        override fun toString() = "[$check] $where: $detail"
    }

    /** The floor of a touch target, in dp: the platform's, wider than the design's 44. */
    const val TARGET_DP = 48f
    const val TEXT_CONTRAST = 4.5
    const val CONTROL_CONTRAST = 3.0

    class Node(
        val node: SemanticsNode,
        val label: String,
        val text: String,
        val description: String,
        val clickable: Boolean,
        val role: Role?,
    )

    private fun SemanticsNode.isControl(): Boolean {
        val c = config
        return c.contains(SemanticsActions.OnClick) || c.contains(SemanticsProperties.ToggleableState) ||
            c.contains(SemanticsProperties.Role) && c.contains(SemanticsActions.OnClick) ||
            c.contains(SemanticsActions.SetText)
    }

    private fun SemanticsNode.hidden(): Boolean = config.contains(SemanticsProperties.InvisibleToUser)

    /** Every node under this one that a reader can reach: what hangs under a hidden node is hidden with it. */
    private fun SemanticsNode.walk(into: MutableList<SemanticsNode>) {
        if (hidden()) return
        into += this
        children.forEach { it.walk(into) }
    }

    /** The roots of every window the screen drew (a sheet is its own). */
    fun roots(rule: ComposeContentTestRule): SemanticsNodeInteractionCollection = rule.onAllNodes(isRoot())

    private fun nodes(rule: ComposeContentTestRule, merged: Boolean): List<SemanticsNode> {
        val out = mutableListOf<SemanticsNode>()
        rule.onAllNodes(isRoot(), useUnmergedTree = !merged).fetchSemanticsNodes().forEach { it.walk(out) }
        return out
    }

    private fun describe(n: SemanticsNode): Node {
        val c = n.config
        val text = (c.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text }.orEmpty() +
            c.getOrNull(SemanticsProperties.EditableText)?.text.orEmpty()).trim()
        val description = c.getOrNull(SemanticsProperties.ContentDescription)?.joinToString(" ").orEmpty().trim()
        val label = listOf(description, text).filter { it.isNotEmpty() }.joinToString(", ")
        return Node(n, label, text, description, n.isControl(), c.getOrNull(SemanticsProperties.Role))
    }

    private fun name(n: Node): String =
        "'${n.label.ifEmpty { "<no label>" }}'" + (n.node.config.getOrNull(SemanticsProperties.TestTag)?.let { " #$it" } ?: "")

    /** The controls of the screen, in the order a reader meets them. */
    fun controls(rule: ComposeContentTestRule): List<Node> =
        nodes(rule, merged = true).filter { !it.hidden() && it.isControl() }.map(::describe)

    /** What a screen reader says, node by node, in tree order: the traversal of the flow. */
    fun reading(rule: ComposeContentTestRule): List<String> =
        nodes(rule, merged = true).filter { !it.hidden() }.map(::describe).map { it.label }.filter { it.isNotEmpty() }

    /** Every rule, over what is on screen now. */
    fun check(rule: ComposeContentTestRule, density: Density): List<Finding> {
        rule.waitForIdle()
        val found = mutableListOf<Finding>()
        val controls = controls(rule)
        for (c in controls) found += targetAndLabel(c, density)
        found += duplicates(controls)
        found += contrast(rule, density)
        return found
    }

    fun targetAndLabel(c: Node, density: Density): List<Finding> {
        val out = mutableListOf<Finding>()
        if (c.node.config.contains(SemanticsProperties.Disabled)) return out
        // THE LAID-OUT SIZE, NOT `touchBoundsInRoot`: Compose widens the hit area of a small `clickable` to 48dp at
        // run time, which would pass a 30dp key; the size is what the member sees and a scanner reports. (Not
        // `boundsInRoot` either: that is clipped to the viewport, so a row half scrolled off would read short.)
        val w = c.node.size.width / density.density
        val h = c.node.size.height / density.density
        if ((w + 0.5f < TARGET_DP || h + 0.5f < TARGET_DP)) {
            out += Finding("target", name(c), "${"%.1f".format(w)} x ${"%.1f".format(h)} dp, under $TARGET_DP")
        }
        if (c.label.isEmpty()) out += Finding("label", name(c), "a control with no text and no content description")
        return out
    }

    fun duplicates(controls: List<Node>): List<Finding> {
        val out = mutableListOf<Finding>()
        controls.filter { it.label.isNotEmpty() && !it.node.config.contains(SemanticsActions.SetText) }
            .groupBy { it.label }
            .filterValues { it.size > 1 }
            .forEach { (label, same) ->
                out += Finding("duplicate", "'$label'", "${same.size} controls say the same thing")
            }
        return out
    }

    // --- contrast --------------------------------------------------------------------------------------------

    fun luminance(argb: Int): Double {
        fun channel(v: Int): Double {
            val s = v / 255.0
            return if (s <= 0.03928) s / 12.92 else Math.pow((s + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * channel((argb shr 16) and 0xFF) + 0.7152 * channel((argb shr 8) and 0xFF) + 0.0722 * channel(argb and 0xFF)
    }

    fun ratio(a: Int, b: Int): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    /**
     * TEXT AGAINST ITS GROUND: the colour the style asked for, over the commonest colour in the text's own box
     * (the ground it landed on); a control without text, against the colour in its box furthest from the ground.
     * A box whose ground is not one colour (a photograph) is left to the eye and counted in [unverified].
     */
    fun contrast(rule: ComposeContentTestRule, density: Density): List<Finding> {
        val out = mutableListOf<Finding>()
        val roots = rule.onAllNodes(isRoot())
        val count = roots.fetchSemanticsNodes().size
        for (i in 0 until count) {
            // THE WINDOW'S OWN VIEW DRAWN INTO A BITMAP (a sheet is a window of its own, with its own view).
            val view = (roots.fetchSemanticsNodes()[i].root as ViewRootForTest).view
            check(view.width > 0 && view.height > 0) { "window $i has no size: it was not laid out" }
            val shot = view.drawToBitmap()
            val w = shot.width
            val h = shot.height
            val pixels = IntArray(w * h)
            shot.getPixels(pixels, 0, w, 0, 0, w, h)
            val all = mutableListOf<SemanticsNode>()
            roots.fetchSemanticsNodes()[i].walk(all)
            // The unmerged tree has the text nodes; the merged one the controls.
            val unmerged = mutableListOf<SemanticsNode>()
            rule.onAllNodes(isRoot(), useUnmergedTree = true).fetchSemanticsNodes()[i].walk(unmerged)
            for (n in unmerged) {
                if (n.hidden() || n.config.contains(SemanticsProperties.Disabled)) continue
                val text = n.config.getOrNull(SemanticsProperties.Text)?.joinToString(" ") { it.text }.orEmpty().trim()
                val editable = n.config.getOrNull(SemanticsProperties.EditableText)?.text.orEmpty()
                if (text.isEmpty() && editable.isEmpty()) continue
                val box = clip(n.boundsInRoot, w, h) ?: continue
                val ground = ground(pixels, w, box) ?: run { unverified++; continue }
                // THE GLYPH AS DRAWN (a span can recolour part of a line, so the style's own colour is not the answer).
                val fg = extreme(pixels, w, box, ground)
                val r = ratio(fg, ground)
                if (r + 0.01 < TEXT_CONTRAST) {
                    out += Finding("contrast", "'$text'", "%.2f:1, under $TEXT_CONTRAST (text ${hex(fg)} on ${hex(ground)})".format(r))
                }
            }
            for (n in all) {
                if (n.hidden() || !n.isControl() || n.config.contains(SemanticsProperties.Disabled)) continue
                val d = describe(n)
                if (d.text.isNotEmpty()) continue // its text is judged above
                val box = clip(n.boundsInRoot, w, h) ?: continue
                val ground = ground(pixels, w, box) ?: run { unverified++; continue }
                val fg = extreme(pixels, w, box, ground)
                val r = ratio(fg, ground)
                if (r + 0.01 < CONTROL_CONTRAST) {
                    out += Finding("contrast", name(d), "%.2f:1, under $CONTROL_CONTRAST (glyph ${hex(fg)} on ${hex(ground)})".format(r))
                }
            }
        }
        return out
    }

    /** Boxes whose ground was not a single colour. */
    var unverified: Int = 0

    private fun hex(c: Int) = "#%06X".format(c and 0xFFFFFF)

    private fun clip(r: Rect, w: Int, h: Int): android.graphics.Rect? {
        val l = r.left.toInt().coerceIn(0, w)
        val t = r.top.toInt().coerceIn(0, h)
        val rt = r.right.toInt().coerceIn(0, w)
        val b = r.bottom.toInt().coerceIn(0, h)
        return if (rt - l < 2 || b - t < 2) null else android.graphics.Rect(l, t, rt, b)
    }

    /** The commonest colour in the box, when it holds at least a third of it. */
    private fun ground(pixels: IntArray, w: Int, box: android.graphics.Rect): Int? {
        val counts = HashMap<Int, Int>()
        var total = 0
        for (y in box.top until box.bottom) for (x in box.left until box.right) {
            counts.merge(pixels[y * w + x] or (0xFF shl 24), 1, Int::plus)
            total++
        }
        val top = counts.maxByOrNull { it.value } ?: return null
        return if (top.value * 3 >= total) top.key else null
    }

    /** The pixel in the box furthest in luminance from the ground: the glyph, as the framework reads it. */
    private fun extreme(pixels: IntArray, w: Int, box: android.graphics.Rect, ground: Int): Int {
        var best = ground
        var bestRatio = 1.0
        for (y in box.top until box.bottom) for (x in box.left until box.right) {
            val p = pixels[y * w + x] or (0xFF shl 24)
            val r = ratio(p, ground)
            if (r > bestRatio) { bestRatio = r; best = p }
        }
        return best
    }
}
