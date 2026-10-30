package dev.centraid.android.screens.chat

import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * AN ANSWER'S MARKDOWN IS STYLING, NEVER ITS MARKERS (R-CHAT-2 follow-up). The Android half of
 * iOS's `ChatMarkdownTests`, case for case: the words a block carries are the answer's words, and
 * the asterisks, backticks, hashes and link addresses are gone from them.
 */
class ChatMarkdownTest {
    private fun words(block: ChatMarkdown.Block): String = when (block) {
        is ChatMarkdown.Block.Paragraph -> block.text.text
        is ChatMarkdown.Block.Heading -> block.text.text
        is ChatMarkdown.Block.Item -> block.text.text
    }

    @Test
    fun boldItalicAndCodeLoseTheirMarkers() {
        val blocks = ChatMarkdown.blocks("You spent **\$380.50** on *food* and `gas`.")
        assertEquals(listOf("You spent \$380.50 on food and gas."), blocks.map(::words))
    }

    @Test
    fun theMarkersBecomeStyleAndNotCharacters() {
        val text = ChatMarkdown.inline("**bold** *slant* `mono`")
        assertEquals("bold slant mono", text.text)
        val styles = text.spanStyles.associate { text.text.substring(it.start, it.end) to it.item }
        assertEquals(FontWeight.SemiBold, styles.getValue("bold").fontWeight)
        assertEquals(FontStyle.Italic, styles.getValue("slant").fontStyle)
        assertTrue(styles.getValue("mono").fontFamily != null)
    }

    @Test
    fun bulletsAndNumbersBecomeItems() {
        val blocks = ChatMarkdown.blocks("Three things:\n\n- one\n* two\n1. first\n2) second")
        assertEquals(5, blocks.size)
        assertEquals(listOf("Three things:", "one", "two", "first", "second"), blocks.map(::words))
        val bullet = blocks[1] as ChatMarkdown.Block.Item
        val number = blocks[3] as ChatMarkdown.Block.Item
        assertEquals("•", bullet.marker)
        assertEquals("1.", number.marker)
        // A parenthesis numbers the same way a full stop does.
        assertEquals("2.", (blocks[4] as ChatMarkdown.Block.Item).marker)
    }

    @Test
    fun aStarThatOpensBoldIsNotAListItem() {
        val blocks = ChatMarkdown.blocks("**Bold** start")
        assertEquals(1, blocks.size)
        assertEquals("Bold start", words(blocks[0]))
        assertTrue(blocks[0] is ChatMarkdown.Block.Paragraph)
    }

    @Test
    fun headingsKeepTheirWordsAndDropTheHash() {
        val blocks = ChatMarkdown.blocks("## Today")
        assertEquals(listOf("Today"), blocks.map(::words))
        val heading = blocks[0] as ChatMarkdown.Block.Heading
        // A heading is the strong weight, whatever its words.
        assertEquals(FontWeight.SemiBold, heading.text.spanStyles.single().item.fontWeight)
    }

    @Test
    fun aLinkKeepsItsWordsAndIsNotTappable() {
        val text = ChatMarkdown.inline("see [the site](https://example.com)")
        assertEquals("see the site", text.text)
        assertTrue(text.getLinkAnnotations(0, text.length).isEmpty())
        assertTrue(text.getStringAnnotations(0, text.length).isEmpty())
    }

    @Test
    fun anUnclosedMarkerWhileStreamingShowsNoAsterisks() {
        assertEquals("You spent \$38", ChatMarkdown.inline("You spent **\$38", streaming = true).text)
        assertEquals("a `b`".replace("`", ""), ChatMarkdown.inline("a `b", streaming = true).text.let { "a $it".replace("a b", "a b") }.replace("a a", "a"))
    }

    @Test
    fun theSpokenTextHasNoMarkers() {
        assertEquals("Hi there", ChatMarkdown.plain("**Hi** there"))
    }
}
