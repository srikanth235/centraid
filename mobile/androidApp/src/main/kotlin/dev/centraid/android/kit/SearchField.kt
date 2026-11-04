package dev.centraid.android.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType

/**
 * THE SEARCH FIELD (K5; lifted from Agenda's, which lifted it from Photos').
 *
 * Search is not a destination: it opens on the current surface, under the
 * header, and closing it clears the term (the kit `SearchLaw`). The one local
 * value is the text while the IME holds it; it reports each change, and
 * follows the machine only when the machine says something that is not an echo
 * of the typing ([rememberFollowedText]) — a clear, never a late echo.
 */
@Composable
public fun CentraidSearchField(
    field: SearchField,
    placeholder: String,
    onTerm: (String) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    label: String = KitWords.SEARCH,
    closeLabel: String = KitWords.CLOSE_SEARCH,
    testTag: String = "kit-search",
    /** A quiet scope at the field's end ("All apps"), drawn while it is empty. */
    scope: String = "",
    /** Whether the field carries its own close key; a page with its own Cancel leaves it off. */
    closes: Boolean = true,
    /** The keyboard's search key, or null when the query is simply live. */
    onSubmit: (() -> Unit)? = null,
) {
    val editor = rememberFollowedText(field.term)
    val typed = editor.text.value
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    // THE LINE UNDER THE FIELD is where the correction is said (#1097): this
    // field is the one every app's search slot, Home's search
    // and every app's search page draw, so "Including results for ..." is drawn once, here.
    // The caller's modifier sits on the column: a `weight` beside a Cancel
    // belongs to the whole field, line included.
    Column(modifier) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
                .heightIn(min = KitGeometry.ROW_MIN)
                .clip(shape)
                .background(centraidColor("bgSunken"))
                .border(KitGeometry.HAIRLINE, centraidColor("line"), shape)
                .padding(start = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CentraidIcon(
                iconKey = "Search",
                tint = centraidColor("textFaint"),
                size = 16.dp,
                modifier = Modifier.clearAndSetSemantics { },
            )
            Box(Modifier.weight(1f).padding(horizontal = 8.dp)) {
                if (typed.isEmpty()) {
                    Text(
                        placeholder,
                        style = centraidType("body"),
                        color = centraidColor("textFaint"),
                        modifier = Modifier.clearAndSetSemantics { },
                    )
                }
                BasicTextField(
                    value = typed,
                    onValueChange = { next -> if (editor.edited(next)) onTerm(next) },
                    singleLine = true,
                    textStyle = centraidType("body").copy(color = centraidColor("text")),
                    cursorBrush = SolidColor(centraidColor("text")),
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Search,
                    ),
                    keyboardActions = KeyboardActions(onSearch = { onSubmit?.invoke() }),
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(focus)
                        .testTag("$testTag-field")
                        .semantics { contentDescription = label },
                )
            }
            if (scope.isNotEmpty() && typed.isEmpty()) {
                Text(
                    scope,
                    style = centraidType("small"),
                    color = centraidColor("textSoft"),
                    maxLines = 1,
                    modifier = Modifier.padding(end = 12.dp),
                )
            }
            if (closes) IconKey("X", closeLabel, "$testTag-close", bordered = false, onPress = onClose)
        }
        if (field.corrected.isNotEmpty()) {
            Text(
                // RUST'S SENTENCE WHERE THE STATE CARRIES IT (Chat's drawer, Docs); the other screens'
                // states carry the bare term (a Rust gap), so the generated words compose it for them.
                field.corrected_label.ifEmpty { KitWords.searchCorrected(field.corrected) },
                style = centraidType("small"),
                color = centraidColor("textSoft"),
                maxLines = 2,
                modifier = Modifier
                    .padding(start = KitGeometry.GUTTER + 12.dp, end = KitGeometry.GUTTER, bottom = 4.dp)
                    .testTag("search-corrected"),
            )
        }
    }
}

/**
 * THE SEARCH FIELD AT THE FOOT: an app place's open search, drawn in the band's place (the Compose
 * twin of iOS's `BandSearchField`).
 *
 * A 48 tonal field ([bandGround], the band's own pill) and, at its trailing end, a 48 tonal
 * close circle — the circle the band's search key was, so the key turns into the way out. While
 * the keyboard is up the row rides it, [BandPolicy.SEARCH_INSET] from the screen's sides and above
 * the keys (the screen's `safeDrawingPadding` already lifts the foot by the IME); with the keyboard
 * away it sits in the band's slot, on [bandFloor]. The correction line ("Including results for
 * ...", #1097) stands directly over the field, because the field is at the foot and the line is
 * read with it.
 *
 * Its state is the machine's `SearchField`, as [CentraidSearchField]'s is: the text a member types
 * lives here first and each difference from the state's term goes to [onTerm]. Close is its own
 * event, and Rust clears the term and its answer with it; this puts the keyboard away first unless
 * [keepsFocusOnClose] (a page whose close only clears the query, Money's search page).
 */
@Composable
public fun BandSearchField(
    field: SearchField,
    placeholder: String,
    onTerm: (String) -> Unit,
    onClose: () -> Unit,
    modifier: Modifier = Modifier,
    label: String = KitWords.SEARCH,
    closeLabel: String = KitWords.CLOSE_SEARCH,
    testTag: String = "kit-search",
    keepsFocusOnClose: Boolean = false,
) {
    val editor = rememberFollowedText(field.term)
    val typed = editor.text.value
    val focus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    // THE FIELD OPENS READY: a member who pressed the key wants to type.
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    val keyboardUp = WindowInsets.ime.getBottom(LocalDensity.current) > 0
    val height = BandPolicy.SEARCH_HEIGHT.dp
    Column(
        modifier
            .fillMaxWidth()
            .padding(
                start = (if (keyboardUp) BandPolicy.SEARCH_INSET else BandPolicy.BAND_INSET).dp,
                end = (if (keyboardUp) BandPolicy.SEARCH_INSET else BandPolicy.BAND_INSET).dp,
                top = BandPolicy.BAND_TOP_GAP.dp,
            )
            .then(if (keyboardUp) Modifier.padding(bottom = BandPolicy.SEARCH_INSET.dp) else Modifier.bandFloor()),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (field.corrected.isNotEmpty()) {
            Text(
                // RUST'S SENTENCE WHERE THE STATE CARRIES IT; the others carry the bare term (a Rust
                // gap), so the generated words compose it for them.
                field.corrected_label.ifEmpty { KitWords.searchCorrected(field.corrected) },
                style = centraidType("small"),
                color = centraidColor("textSoft"),
                maxLines = 2,
                modifier = Modifier
                    .padding(start = BandPolicy.SEARCH_GLYPH_LEAD.dp)
                    .bandGround(CircleShape)
                    .padding(horizontal = 12.dp, vertical = 4.dp)
                    .testTag("search-corrected"),
            )
        }
        Row(horizontalArrangement = Arrangement.spacedBy(BandPolicy.SEARCH_INSET.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(
                Modifier
                    .weight(1f)
                    .height(height)
                    .bandGround(CircleShape)
                    .clip(CircleShape)
                    .padding(start = BandPolicy.SEARCH_GLYPH_LEAD.dp, end = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                CentraidIcon(
                    iconKey = "Search",
                    tint = centraidColor("textSoft"),
                    size = BandPolicy.SEARCH_GLYPH.dp,
                    modifier = Modifier.clearAndSetSemantics { },
                )
                Box(Modifier.weight(1f).padding(horizontal = 9.dp)) {
                    if (typed.isEmpty()) {
                        Text(
                            placeholder,
                            style = centraidType("body"),
                            color = centraidColor("textFaint"),
                            maxLines = 1,
                            modifier = Modifier.clearAndSetSemantics { },
                        )
                    }
                    BasicTextField(
                        value = typed,
                        onValueChange = { next -> if (editor.edited(next)) onTerm(next) },
                        singleLine = true,
                        textStyle = centraidType("body").copy(color = centraidColor("text")),
                        cursorBrush = SolidColor(centraidColor("text")),
                        keyboardOptions = KeyboardOptions(
                            capitalization = KeyboardCapitalization.None,
                            autoCorrectEnabled = false,
                            imeAction = ImeAction.Search,
                        ),
                        // The search key only puts the keyboard away: the query is already live.
                        keyboardActions = KeyboardActions(onSearch = { focusManager.clearFocus() }),
                        modifier = Modifier
                            .fillMaxWidth()
                            .focusRequester(focus)
                            .testTag("$testTag-field")
                            .semantics { contentDescription = label },
                    )
                }
                if (typed.isNotEmpty()) {
                    IconKey("XCircle", "Clear search", "$testTag-clear", bordered = false) {
                        if (editor.edited("")) onTerm("")
                    }
                }
            }
            // THE WAY OUT: the key the band wore, as a close circle on the same tonal pill.
            Box(
                Modifier
                    .size(height)
                    .bandGround(CircleShape)
                    .clip(CircleShape)
                    .clickable {
                        if (!keepsFocusOnClose) focusManager.clearFocus()
                        onClose()
                    }
                    .testTag("$testTag-close")
                    .clearAndSetSemantics {
                        contentDescription = closeLabel
                        role = Role.Button
                    },
                contentAlignment = Alignment.Center,
            ) {
                CentraidIcon(iconKey = "X", tint = centraidColor("text"), size = 20.dp)
            }
        }
    }
}

/**
 * THE FOOT OF A PAGE THAT HAS SEARCH BUT NO BAND (Docs' folder page, Money's search page's
 * sibling): the search key alone at the trailing edge — the band's own circle, in the same place —
 * and, once opened, the field in its place. The Compose twin of iOS's `SearchFoot`.
 */
@Composable
public fun SearchFoot(search: RoomSearch, testTag: String) {
    if (search.field.open_) {
        BandSearchField(
            field = search.field,
            placeholder = search.placeholder,
            onTerm = search.onTerm,
            onClose = search.onClose,
            label = search.label,
            closeLabel = search.closeLabel,
            testTag = testTag,
        )
    } else {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(
                    start = BandPolicy.BAND_INSET.dp,
                    end = BandPolicy.BAND_INSET.dp,
                    top = BandPolicy.BAND_TOP_GAP.dp,
                )
                .bandFloor(),
            horizontalArrangement = Arrangement.End,
        ) {
            BandKey(
                iconKey = "Search",
                spoken = search.placeholder,
                testTag = "band-search",
                onPress = search.onOpen,
            )
        }
    }
}
