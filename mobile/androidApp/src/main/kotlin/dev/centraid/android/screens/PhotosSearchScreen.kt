package dev.centraid.android.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import centraid.screen.v1.PhotoShelf
import centraid.screen.v1.PhotoStateView
import centraid.screen.v1.PhotosSearchEvent
import centraid.screen.v1.PhotosSearchState
import centraid.screen.v1.SearchMatch
import centraid.screen.v1.SearchResting
import centraid.screen.v1.SearchTopHit
import dev.centraid.android.kit.CentraidIcon
import dev.centraid.android.kit.PhotoCellsGrid
import dev.centraid.android.kit.ScreenFailure
import dev.centraid.android.kit.bandFloor
import dev.centraid.android.theme.centraidColor
import dev.centraid.android.theme.centraidType
import dev.centraid.design.CentraidGeometry
import dev.centraid.shared.shell.BandPolicy

/**
 * SEARCH (#1029, the photos port).
 *
 * Three states behind one destination, and the distinction the whole screen
 * exists to keep: **a member who has typed nothing and a member whose query
 * matched nothing must not read the same words.** v0 had two components and two
 * sentences for those and a third for the hits; they are one screen with a
 * oneof, and this is the oneof drawn.
 *
 * **THE FIELD IS NOT HERE.** It is [PhotosSearchBar], at the foot of the
 * screen where the band would be — the system Photos app's search. This screen
 * is only what the query found.
 *
 * The SwiftUI twin is `mobile/iosApp/Sources/PhotosSearchView.swift`.
 */
@Composable
public fun PhotosSearchScreen(
    state: PhotosSearchState,
    @Suppress("UNUSED_PARAMETER") onEvent: (PhotosSearchEvent) -> Unit,
    /** A cell was tapped. Where that GOES is the navigator's business. */
    onOpenAsset: (String) -> Unit = {},
    /**
     * A person, place or album was tapped — above the grid or on the resting
     * page. The shelf arrives WHOLE, built by the read with its name in it, so
     * nothing here composes one.
     */
    onOpenShelf: (PhotoShelf) -> Unit = {},
) {
    Column(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // A WIRE PROPERTY IS CROSS-MODULE PUBLIC API, so Kotlin will not
        // smart-cast it after a null check. Each arm is bound to a local first.
        //
        // FOUR ARMS, NOT THREE. Resting is a real fourth place a member can be
        // and not a variant of loading or of an empty result, which is why this
        // screen's state has a oneof the other screens' three-case law does not
        // cover.
        val resting = state.resting
        val loading = state.loading
        val failure = state.failure
        val hits = state.hits
        when {
            resting != null -> RestingPanel(resting, onOpenShelf)

            loading != null -> Box(Modifier.fillMaxWidth().padding(top = 40.dp), Alignment.Center) {
                CircularProgressIndicator()
            }

            failure != null -> ScreenFailure(failure.sentence, failure.remedy)

            hits != null -> {
                val cells = hits.cells
                if (cells.isEmpty() && hits.top_hits.isEmpty()) {
                    // NOTHING MATCHED IS NOT NOTHING TYPED. The query is quoted
                    // back, because the first thing a member wants to check is
                    // whether the words they see are the words they meant — and
                    // the line under it says everywhere search looked (v0's
                    // `SEARCH_COPY.miss`). Centred, as the system draws "No
                    // Results".
                    Column(
                        Modifier.fillMaxWidth().padding(top = 160.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text("No results", style = centraidType("title"), color = centraidColor("text"))
                        Text(
                            "Nothing matches “${state.query}”.",
                            style = centraidType("small"),
                            color = centraidColor("textSoft"),
                            textAlign = TextAlign.Center,
                        )
                        Text(
                            MISS_BODY,
                            style = centraidType("small"),
                            color = centraidColor("textFaint"),
                            textAlign = TextAlign.Center,
                        )
                    }
                } else {
                    PhotoCellsGrid(
                        cells = cells,
                        packAbsent = hits.thumbnail_pack_absent,
                        // `onTap` BY NAME: this composable's last parameter is
                        // `header`, and a trailing lambda would wire the tap to
                        // the wrong thing entirely.
                        onTap = { assetId -> onOpenAsset(assetId) },
                        // THE DOORS AND THE REASONS SCROLL WITH THE GRID, in
                        // its own scroller: a head that stayed put over a grid
                        // of hits would eat the screen the hits need.
                        header = {
                            item(span = { GridItemSpan(maxLineSpan) }) {
                                HitsHead(hits.top_hits, hits.matches, onOpenShelf)
                            }
                        },
                    )
                }
            }
        }
    }
}

/**
 * THE PEOPLE, PLACES AND ALBUMS THE QUERY NAMED, AND WHY THE GRID MATCHED.
 *
 * The doors come first (v0 §9: "each one tap from the surface that owns it"),
 * then the reason line. HOW MANY REASONS FIT IS THE VIEW'S DECISION: the read
 * hands over every distinct one and does not cap them, so the clamp is here,
 * where the line is.
 */
@Composable
private fun HitsHead(
    topHits: List<SearchTopHit>,
    matches: List<SearchMatch>,
    onOpenShelf: (PhotoShelf) -> Unit,
) {
    Column(Modifier.padding(bottom = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        topHits.forEach { hit -> TopHitRow(hit, onOpenShelf) }
        if (matches.isNotEmpty()) {
            Text(
                text = reason(matches),
                maxLines = 2,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}

/** One door: the kind's mark, the vault's name for it, what it holds. */
@Composable
private fun TopHitRow(hit: SearchTopHit, onOpenShelf: (PhotoShelf) -> Unit) {
    val shelf = hit.shelf ?: return
    val sub = topHitSub(hit)
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
            .clickable { onOpenShelf(shelf) }
            .semantics(mergeDescendants = true) {
                contentDescription = "Open ${hit.label}, $sub"
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        CentraidIcon(iconKey = kindIcon(hit.kind), tint = centraidColor("textSoft"), size = 20.dp)
        Column(Modifier.weight(1f)) {
            Text(hit.label, style = centraidType("body"), color = centraidColor("text"), maxLines = 1)
            Text(sub, style = centraidType("small"), color = centraidColor("textSoft"), maxLines = 1)
        }
        CentraidIcon(iconKey = "ChevronRight", tint = centraidColor("textFaint"))
    }
}

/**
 * "Person · 12 photographs", or "Album · at least 500 photographs". A zero is
 * "not counted" on this door, so it prints the kind alone rather than a "0".
 */
private fun topHitSub(hit: SearchTopHit): String {
    val kind = when (hit.kind) {
        SearchMatch.Kind.KIND_PERSON -> "Person"
        SearchMatch.Kind.KIND_PLACE -> "Place"
        SearchMatch.Kind.KIND_ALBUM -> "Album"
        else -> ""
    }
    val count = hit.photo_count
    if (count == 0) return kind
    val noun = if (count == 1) "photograph" else "photographs"
    val phrase = if (hit.photo_count_capped) "at least $count $noun" else "$count $noun"
    return if (kind.isEmpty()) phrase else "$kind · $phrase"
}

private fun kindIcon(kind: SearchMatch.Kind): String = when (kind) {
    SearchMatch.Kind.KIND_PERSON -> "person"
    SearchMatch.Kind.KIND_PLACE -> "place"
    SearchMatch.Kind.KIND_ALBUM -> "album"
    else -> "Search"
}

/** v0's `SEARCH_COPY.miss.body`, in this build's words for what search reaches. */
private const val MISS_BODY: String = "Nothing in captions, people, places, labels or album names."

/**
 * THE SEARCH FIELD, WHERE THE BAND WAS — the system Photos app's search, in
 * both of its states; the twin of iOS's `PhotosSearchBar`, which carries the
 * full argument and the measures.
 *
 * **TYPING:** the field and a round close control, 8 from the screen's sides
 * and 8 above the keyboard. **NOT TYPING** (the keyboard's Search action, or a
 * scroll through the hits): the row drops into the band's slot, 21 from the
 * edges, and gains a circle carrying the mark of the place the member came
 * from — back there with the query kept; the close control goes back with it
 * cleared.
 *
 * **THE ONLY PLACE A KEYSTROKE EXISTS BEFORE THE REDUCER HAS IT.** The machine
 * holds the query it last reduced; a character the member has just typed is in
 * neither until this field hands it over.
 */
@Composable
public fun PhotosSearchBar(
    query: String,
    onQuery: (String) -> Unit,
    returnIconKey: String,
    returnLabel: String,
    onReturn: () -> Unit,
    onClose: () -> Unit,
) {
    var typed by remember { mutableStateOf(query) }
    var focused by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    val focusManager = LocalFocusManager.current
    // THE FIELD OPENS READY: a member who pressed Search wants to type.
    LaunchedEffect(Unit) { focus.requestFocus() }

    val inset = if (focused) SEARCH_INSET else BandPolicy.BAND_INSET.dp + REST_PAD
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = inset, end = inset, top = BandPolicy.BAND_TOP_GAP.dp)
            .then(
                if (focused) {
                    Modifier.padding(bottom = SEARCH_INSET)
                } else {
                    Modifier.bandFloor().padding(vertical = REST_PAD)
                },
            ),
        horizontalArrangement = Arrangement.spacedBy(if (focused) SEARCH_INSET else 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (!focused) {
            SearchCircle(returnIconKey, "Back to $returnLabel", "photos.search.return", onReturn)
        }
        Row(
            Modifier
                .weight(1f)
                .height(SEARCH_HEIGHT)
                .background(centraidColor("bgElev"), CircleShape)
                .border(CentraidGeometry.HAIRLINE.dp, centraidColor("lineStrong"), CircleShape)
                .clickable(
                    interactionSource = remember { MutableInteractionSource() },
                    indication = null,
                ) { focus.requestFocus() }
                .padding(start = 10.dp, end = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CentraidIcon(iconKey = "Search", tint = centraidColor("textSoft"), size = 17.dp)
            Box(Modifier.width(9.dp))
            Box(Modifier.weight(1f), contentAlignment = Alignment.CenterStart) {
                if (typed.isEmpty()) {
                    Text(
                        "Search your library…",
                        style = centraidType("body"),
                        color = centraidColor("textFaint"),
                        maxLines = 1,
                    )
                }
                BasicTextField(
                    value = typed,
                    onValueChange = { next ->
                        typed = next
                        // A QUERY CHANGE IS A DIFFERENCE FROM THE STATE, not an
                        // assignment to it: re-sending the query the reducer just
                        // published would be a read per round trip.
                        if (next != query) onQuery(next)
                    },
                    singleLine = true,
                    textStyle = centraidType("body").copy(color = centraidColor("text")),
                    cursorBrush = SolidColor(centraidColor("text")),
                    // NOTHING OVER THE KEYBOARD that the IME can be talked out
                    // of: no autocorrection, no capitals. The Search action puts
                    // the keyboard away — the query is already live.
                    keyboardOptions = KeyboardOptions(
                        capitalization = KeyboardCapitalization.None,
                        autoCorrectEnabled = false,
                        imeAction = ImeAction.Search,
                    ),
                    keyboardActions = KeyboardActions(onSearch = { focusManager.clearFocus() }),
                    modifier = Modifier
                        .fillMaxWidth()
                        .focusRequester(focus)
                        .onFocusChanged { focused = it.isFocused }
                        .testTag("photos.search.field"),
                )
            }
            if (typed.isNotEmpty()) {
                Box(
                    Modifier
                        .size(34.dp)
                        .clickable { typed = ""; onQuery("") }
                        .semantics { contentDescription = "Clear search"; role = Role.Button },
                    contentAlignment = Alignment.Center,
                ) {
                    CentraidIcon(iconKey = "XCircle", tint = centraidColor("textFaint"), size = 18.dp)
                }
            }
        }
        SearchCircle("X", "Close search", "photos.search.close", onClose)
    }
}

@Composable
private fun SearchCircle(iconKey: String, spoken: String, tag: String, onPress: () -> Unit) {
    Box(
        Modifier
            .size(SEARCH_HEIGHT)
            .background(centraidColor("bgElev"), CircleShape)
            .border(CentraidGeometry.HAIRLINE.dp, centraidColor("lineStrong"), CircleShape)
            .clickable(onClick = onPress)
            .testTag(tag)
            .semantics { contentDescription = spoken; role = Role.Button },
        contentAlignment = Alignment.Center,
    ) {
        CentraidIcon(iconKey = iconKey, tint = centraidColor("text"), size = 20.dp)
    }
}

/** The system search bar's measures — see iOS's `BandMetrics`. */
private val SEARCH_HEIGHT = 48.dp
private val SEARCH_INSET = 8.dp
private val REST_PAD = ((BandPolicy.BAND_HEIGHT - 48) / 2).dp

/**
 * NOTHING HAS BEEN ASKED YET — so this says what there is to ask FOR.
 *
 * One line that is true of every vault — what a search reaches — and then this
 * vault's own vocabulary under it: the people confirmed on its photographs and
 * the places they were taken, each a door to its shelf, and the labels on them
 * as words to type. Never a fixed list of words the product hopes are there;
 * a vault with none of them shows the line alone, which is the honest resting
 * page of a new vault.
 */
@Composable
private fun RestingPanel(resting: SearchResting, onOpenShelf: (PhotoShelf) -> Unit) {
    Column(
        Modifier.fillMaxWidth().verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            text = RESTING_NOTE,
            style = centraidType("small"),
            color = centraidColor("textSoft"),
        )
        if (resting.people.isNotEmpty()) {
            RestingSection("People") {
                resting.people.forEach { person ->
                    RestingDoor(person.display_name, "person") {
                        onOpenShelf(
                            PhotoShelf(
                                state_view = PhotoStateView(
                                    person = PhotoStateView.Person(
                                        party_id = person.party_id,
                                        person_name = person.display_name,
                                    ),
                                ),
                            ),
                        )
                    }
                }
            }
        }
        if (resting.places.isNotEmpty()) {
            RestingSection("Places") {
                resting.places.forEach { place ->
                    RestingDoor(place.place_name, "place") { onOpenShelf(PhotoShelf(place = place)) }
                }
            }
        }
        if (resting.suggested_labels.isNotEmpty()) {
            // WORDS, NOT DOORS: a label has no shelf of its own, so it is
            // offered as something to type rather than drawn as a control that
            // would open nothing.
            RestingSection("Labels") {
                Text(
                    text = resting.suggested_labels.joinToString(" · ") { it.label },
                    style = centraidType("body"),
                    color = centraidColor("text"),
                    modifier = Modifier.semantics {
                        contentDescription = "Labels you can search for: " +
                            resting.suggested_labels.joinToString(", ") { it.label }
                    },
                )
            }
        }
    }
}

/** A heading over one kind of word, and nothing at all when there are none. */
@Composable
private fun RestingSection(title: String, content: @Composable () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(
            title,
            style = centraidType("smallStrong"),
            color = centraidColor("textSoft"),
            modifier = Modifier.padding(top = 8.dp, bottom = 4.dp),
        )
        content()
    }
}

/** One person or place on the resting page, opening its shelf. */
@Composable
private fun RestingDoor(label: String, iconKey: String, onOpen: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = CentraidGeometry.TARGET_MIN_COARSE.dp)
            .clickable(onClick = onOpen)
            .semantics(mergeDescendants = true) {
                contentDescription = "Open $label"
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        CentraidIcon(iconKey = iconKey, tint = centraidColor("textSoft"), size = 20.dp)
        Text(
            label,
            style = centraidType("body"),
            color = centraidColor("text"),
            maxLines = 1,
            modifier = Modifier.weight(1f),
        )
        CentraidIcon(iconKey = "ChevronRight", tint = centraidColor("textFaint"))
    }
}

/** What a search reaches, true of every vault. `PhotosSearchView.swift` says the same. */
private const val RESTING_NOTE: String =
    "Search finds people, places, albums, labels and the captions you have written."

/**
 * `matches`, as a sentence.
 *
 * **THE KIND IS THE CONTRACT'S AND THE WORDS ARE THE SHELL'S.** The field used
 * to be `repeated string matched_on` and it was the one place in that section
 * carrying a kind as prose — two shells composing their own "Person: Ada" and
 * "In Lisbon" is two shells wording one fact two ways, which is how v0's empty
 * states drifted apart. So the enum travels and this is where Compose spells
 * it; `PhotosSearchView.swift` spells the same five the same way, and the two
 * are kept in step by hand.
 *
 * Grouped by kind rather than listed flat, because "Captions: a, b - Places:
 * Lisbon" is one sentence and a flat list with a prefix per value is five.
 */
private fun reason(matches: List<SearchMatch>): String {
    val order = listOf(
        SearchMatch.Kind.KIND_PERSON,
        SearchMatch.Kind.KIND_PLACE,
        SearchMatch.Kind.KIND_ALBUM,
        SearchMatch.Kind.KIND_LABEL,
        SearchMatch.Kind.KIND_TITLE,
    )
    val parts = order.mapNotNull { kind ->
        val values = matches.filter { it.kind == kind }.map { it.value_ }
        if (values.isEmpty()) null else "${noun(kind)}: " + values.joinToString(", ")
    }
    // A KIND THIS SHELL DOES NOT KNOW IS NOT DROPPED SILENTLY. Its values still
    // reach the member, unlabelled, which is the honest thing for a newer core
    // naming a fifth reason — the alternative is a grid that explains some of
    // itself and quietly omits the rest.
    val rest = matches.filterNot { it.kind in order }.map { it.value_ }
    val all = parts + if (rest.isEmpty()) emptyList() else listOf(rest.joinToString(", "))
    return if (all.isEmpty()) "" else "Matched " + all.joinToString(" \u2014 ")
}

private fun noun(kind: SearchMatch.Kind): String = when (kind) {
    SearchMatch.Kind.KIND_PERSON -> "People"
    SearchMatch.Kind.KIND_PLACE -> "Places"
    SearchMatch.Kind.KIND_ALBUM -> "Albums"
    SearchMatch.Kind.KIND_LABEL -> "Labels"
    SearchMatch.Kind.KIND_TITLE -> "Captions"
    SearchMatch.Kind.KIND_UNSPECIFIED -> ""
}
