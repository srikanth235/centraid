package dev.centraid.android.kit

import androidx.compose.foundation.background
import dev.centraid.android.theme.centraidDark
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import centraid.core.v1.Autosave
import centraid.core.v1.ListRow
import centraid.core.v1.SearchContainer
import centraid.core.v1.StatusChip
import dev.centraid.android.theme.centraidColor
import androidx.compose.ui.text.font.FontWeight
import dev.centraid.android.theme.centraidType

/**
 * THE ONE ROW SHAPE (hand-off v17: "one row shape per app reused by every list
 * in it"). Title over meta, a trailing figure or word inked by [trailingTone],
 * its [chips] in draw order, the 2px hue rule at inline-start when [hueKey]
 * names a party hue, 44dp minimum.
 *
 * [a11y] replaces what the row says when set (a row is one stop, not four);
 * otherwise the visible words are merged. [pending] draws the trailing
 * `Saving` word — a write in flight on this row. [accessory] is the one slot
 * for per-row controls (Trash's Restore / Delete forever).
 */
@Composable
public fun CentraidRow(
    title: String,
    modifier: Modifier = Modifier,
    meta: String = "",
    trailing: String = "",
    trailingNote: String = "",
    trailingTone: StatusChip.Tone = StatusChip.Tone.TONE_UNSPECIFIED,
    chips: List<StatusChip> = emptyList(),
    hueKey: String = "",
    dimmed: Boolean = false,
    pending: Boolean = false,
    pendingLabel: String = KitWords.PENDING,
    a11y: String = "",
    testTag: String = "kit-row",
    onTap: (() -> Unit)? = null,
    metaRuns: androidx.compose.ui.text.AnnotatedString? = null,
    accessory: (@Composable RowScope.() -> Unit)? = null,
) {
    val titleInk = if (dimmed) Surface.meta else Surface.ink
    val softInk = Surface.meta
    val line = Surface.line
    Column(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = KitGeometry.ROW_MIN)
                .then(if (onTap != null) Modifier.clickable(onClick = onTap) else Modifier)
                .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
                .testTag(testTag)
                .then(
                    when {
                        accessory != null -> Modifier.semantics(mergeDescendants = false) { }
                        a11y.isNotEmpty() -> Modifier.clearAndSetSemantics {
                            contentDescription = a11y
                            if (onTap != null) role = Role.Button
                        }
                        else -> Modifier.semantics(mergeDescendants = true) {
                            if (onTap != null) role = Role.Button
                        }
                    },
                ),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (hueKey.isNotEmpty()) {
                Box(
                    Modifier
                        .padding(end = 10.dp)
                        .width(2.dp)
                        .height(28.dp)
                        .clip(RoundedCornerShape(1.dp))
                        .background(hueColor(hueKey)),
                )
            }
            Column(Modifier.weight(1f)) {
                KitText(title, KitType.Row, titleInk, maxLines = 2)
                // [metaRuns] is the same line with spans a machine marked (a
                // search snippet's matches); it replaces [meta] when set.
                if (metaRuns != null && metaRuns.isNotEmpty()) {
                    Text(
                        metaRuns,
                        style = kitTextStyle(KitType.Meta),
                        color = softInk,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                } else if (meta.isNotEmpty()) {
                    KitText(meta, KitType.Meta, softInk, maxLines = 2)
                }
            }
            // THE MONEY BOARDS' TRAILING COLUMN: a figure with its state chip UNDER it; a chip
            // alone stays beside the title.
            val chipUnderFigure = trailing.isNotEmpty() && chips.isNotEmpty()
            if (!chipUnderFigure) {
                chips.forEach { chip -> StatusChipView(chip, Modifier.padding(start = 8.dp)) }
            }
            if (trailing.isNotEmpty() || pending) {
                // THE FIGURE: right-aligned, with its sub-label under it.
                Column(Modifier.padding(start = 8.dp), horizontalAlignment = Alignment.End) {
                    if (trailing.isNotEmpty()) {
                        val figureInk = if (dimmed) titleInk else toneInk(trailingTone, neutral = "text")
                        Text(
                            trailing,
                            style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
                            color = figureInk,
                            textAlign = TextAlign.End,
                            maxLines = 1,
                        )
                    }
                    if (chipUnderFigure) {
                        Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            chips.forEach { chip -> StatusChipView(chip) }
                        }
                    }
                    val note = if (pending) pendingLabel else trailingNote
                    if (note.isNotEmpty()) {
                        KitText(note, KitType.Meta, softInk, Modifier, maxLines = 1)
                    }
                }
            }
            accessory?.invoke(this)
        }
        // THE HAIRLINE starts at the text, not at the edge.
        Spacer(Modifier.padding(start = KitGeometry.GUTTER).fillMaxWidth().height(KitGeometry.HAIRLINE).background(line))
    }
}

/** A kit `ListRow`, drawn as the one row. */
@Composable
public fun CentraidRow(row: ListRow, modifier: Modifier = Modifier, onTap: (() -> Unit)? = null) {
    CentraidRow(
        title = row.title,
        modifier = modifier,
        meta = row.meta,
        trailing = row.trailing,
        trailingTone = row.trailing_tone,
        chips = row.chips,
        hueKey = row.hue_key,
        dimmed = row.dimmed,
        pending = row.pending,
        a11y = row.accessibility_label,
        testTag = "kit-row-${row.id}",
        onTap = onTap,
    )
}

/**
 * THE ONE BADGE SHAPE (#1173): 11pt capitals on a pale tint. A tone that says a state wears
 * that state's colour (not yet and caution are amber, owe and leaves are red); a plain chip is
 * quiet ink on the fill.
 */
@Composable
public fun StatusChipView(chip: StatusChip, modifier: Modifier = Modifier) {
    if (chip.label.isEmpty()) return
    val tagged = modifier.testTag("kit-chip")
    when (chip.tone) {
        StatusChip.Tone.TONE_SEAM, StatusChip.Tone.TONE_WARNING -> KitBadge(chip.label, StateColor.Amber, tagged)
        StatusChip.Tone.TONE_NET -> KitBadge(chip.label, StateColor.Red, tagged)
        // THE APP'S OWN GOOD NEWS: the accent's chip ground under the accent's text.
        StatusChip.Tone.TONE_ACCENT -> {
            val accent = appAccent()
            KitText(
                chip.label,
                KitType.Badge,
                accent.text,
                tagged
                    .clip(RoundedCornerShape(KitBadgeRadius))
                    .background(accent.tint ?: accent.wash(centraidDark()))
                    .padding(horizontal = 6.dp, vertical = 3.dp),
                maxLines = 1,
            )
        }
        else -> KitText(
            chip.label,
            KitType.Badge,
            Surface.meta,
            tagged
                .clip(RoundedCornerShape(KitBadgeRadius))
                .background(Surface.fill)
                .padding(horizontal = 6.dp, vertical = 3.dp),
            maxLines = 1,
        )
    }
}

/** A tone's ink: the state's colour for a state, otherwise the plain ink ([neutral] `text`) or meta. */
@Composable
public fun toneInk(tone: StatusChip.Tone, neutral: String): Color = when (tone) {
    StatusChip.Tone.TONE_SEAM, StatusChip.Tone.TONE_WARNING -> StateColor.Amber.text
    StatusChip.Tone.TONE_NET -> StateColor.Red.text
    else -> if (neutral == "text") Surface.ink else Surface.meta
}

/** THE SECTION HEAD: a title, its count, and one text verb. */
@Composable
public fun SectionHeader(
    head: SectionHead,
    modifier: Modifier = Modifier,
    /** The board's sentence-case head (Catch up's piles): the row rung in semibold, not 12pt capitals. */
    sentenceCase: Boolean = false,
    onVerb: (() -> Unit)? = null,
) {
    Row(
        modifier
            .fillMaxWidth()
            .padding(start = KitGeometry.GUTTER, end = 8.dp, top = 20.dp, bottom = 4.dp)
            .testTag("kit-section"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val count = head.count
        val title = if (count != null) "${head.title} · $count" else head.title
        if (sentenceCase) {
            Text(
                title,
                style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
                color = Surface.meta,
                modifier = Modifier.weight(1f).semantics { heading() },
            )
        } else {
            KitText(title, KitType.Group, Surface.meta, Modifier.weight(1f).semantics { heading() })
        }
        if (head.verb_label.isNotEmpty() && onVerb != null) {
            Text(
                head.verb_label,
                style = kitTextStyle(KitType.Meta).copy(fontWeight = FontWeight.SemiBold),
                color = appAccent().text,
                modifier = Modifier
                    .heightIn(min = 36.dp)
                    .clip(RoundedCornerShape(KitGeometry.RADIUS))
                    .clickable(onClick = onVerb)
                    .padding(horizontal = 8.dp, vertical = 9.dp)
                    .semantics { role = Role.Button },
            )
        }
    }
}

/**
 * "SHOW MORE" at the foot of a paged list: drawn while there is a next page,
 * quiet while the page is on its way. The member pulls the next page; nothing
 * pages on its own.
 */
@Composable
public fun ShowMoreFooter(
    visible: Boolean,
    loading: Boolean,
    onMore: () -> Unit,
    modifier: Modifier = Modifier,
    label: String = KitWords.SHOW_MORE,
    loadingLabel: String = KitWords.LOADING_MORE,
) {
    if (!visible) return
    Box(modifier.fillMaxWidth().padding(KitGeometry.GUTTER), contentAlignment = Alignment.Center) {
        if (loading) {
            Text(loadingLabel, style = centraidType("annotLabel"), color = centraidColor("textFaint"))
        } else {
            OutlineButton(label = label, testTag = "kit-show-more", onPress = onMore)
        }
    }
}

/** THE FIELD ROW: key, value, and a note under them. Read-only. */
@Composable
public fun FieldRow(key: String, value: String, modifier: Modifier = Modifier, note: String = "") {
    Column(
        modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
            .semantics(mergeDescendants = true) { },
    ) {
        Text(key, style = centraidType("eyebrow"), color = centraidColor("textSoft"))
        Text(value, style = centraidType("body"), color = centraidColor("text"))
        if (note.isNotEmpty()) Text(note, style = centraidType("annotLabel"), color = centraidColor("textFaint"))
    }
}

/**
 * EDITOR TEXT THAT CANNOT DROP A KEYSTROKE.
 *
 * The member's typing lives HERE, not in the machine's state: a field whose
 * value round-tripped through an event and a reduce would lose every character
 * typed while the last one was in flight. The machine's value replaces the
 * local text only when [reload] changes to a non-null value — the state's own
 * "this came from the vault" signal (for an autosave editor: the baseline,
 * while the phase is CLEAN) — AND the value is not an echo of this field's own
 * typing ([TypedText]): a save that lands mid-typing carries an older draft,
 * and taking it back dropped every keystroke since (#1047 walk, B1).
 */
public class EditorText internal constructor(
    public val text: MutableState<String>,
    private val typed: TypedText,
) {
    /** The member typed [next]: `true` when it is to be sent as the edit. */
    public fun edited(next: String): Boolean {
        text.value = next
        return typed.edited(next)
    }

    /** The machine says [value]; the local text follows only when it is not an echo. */
    public fun heard(value: String, open: Boolean = true) {
        typed.answer(value, shown = text.value, open = open)?.let { text.value = it }
    }
}

@Composable
public fun rememberEditorText(value: String, reload: Any?): EditorText {
    val editor = remember { EditorText(mutableStateOf(value), TypedText(value)) }
    val lastReload = remember { arrayOfNulls<Any?>(1) }
    val open = reload != null && reload != lastReload[0]
    lastReload[0] = reload
    editor.heard(value, open)
    return editor
}

/**
 * A FIELD WITH NO RELOAD SIGNAL (a search term, a quick add): the local text
 * follows every value the machine says that is not an echo of its typing — a
 * clear after submit, a close, words handed in — and never a late echo.
 */
@Composable
public fun rememberFollowedText(value: String): EditorText {
    val editor = remember { EditorText(mutableStateOf(value), TypedText(value)) }
    editor.heard(value)
    return editor
}

/**
 * AN EDITABLE FIELD ROW: key over a bare text field. [onEdit] is sent only for
 * a difference from [value], from local text held by [rememberEditorText].
 */
@Composable
public fun EditableFieldRow(
    key: String,
    value: String,
    reload: Any?,
    onEdit: (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    singleLine: Boolean = true,
    style: String = "body",
    testTag: String = "kit-field",
) {
    val editor = rememberEditorText(value, reload)
    val text = editor.text
    Column(modifier.fillMaxWidth().padding(horizontal = KitGeometry.GUTTER, vertical = 6.dp)) {
        if (key.isNotEmpty()) Text(key, style = centraidType("eyebrow"), color = centraidColor("textSoft"))
        Box(Modifier.fillMaxWidth().heightIn(min = 36.dp), contentAlignment = Alignment.CenterStart) {
            if (text.value.isEmpty() && placeholder.isNotEmpty()) {
                Text(
                    placeholder,
                    style = centraidType(style),
                    color = centraidColor("textFaint"),
                    modifier = Modifier.clearAndSetSemantics { },
                )
            }
            BasicTextField(
                value = text.value,
                onValueChange = { next -> if (editor.edited(next)) onEdit(next) },
                singleLine = singleLine,
                textStyle = centraidType(style).copy(color = centraidColor("text")),
                cursorBrush = SolidColor(centraidColor("text")),
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag(testTag)
                    .semantics { contentDescription = key.ifEmpty { placeholder } },
            )
        }
    }
}

/** A CHOICE FIELD ROW: key and the current value; a tap opens the choice sheet. */
@Composable
public fun ChoiceFieldRow(
    key: String,
    value: String,
    onTap: () -> Unit,
    modifier: Modifier = Modifier,
    testTag: String = "kit-choice",
) {
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .clickable(onClick = onTap)
            .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
            .testTag(testTag)
            .clearAndSetSemantics {
                contentDescription = "$key, $value"
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(key, style = centraidType("body"), color = centraidColor("textSoft"), modifier = Modifier.weight(1f))
        Text(value, style = centraidType("body"), color = centraidColor("text"))
        CentraidIcon(
            iconKey = "ChevronRight",
            tint = centraidColor("textFaint"),
            size = 16.dp,
            modifier = Modifier.padding(start = 6.dp),
        )
    }
}

/**
 * What an autosave says, in words: the status line an [EditorRoom] hosts. The
 * machine's own words (`Autosave.label`, the kit law's), never spelt here.
 */
public fun autosaveLabel(autosave: Autosave?): String = autosave?.label.orEmpty()

/**
 * THE AUTOSAVE STATUS LINE. A refusal is `net` ink and its sentence, over the
 * words and never instead of them; everything else is quiet.
 */
@Composable
public fun AutosaveStatus(autosave: Autosave?, modifier: Modifier = Modifier) {
    val label = autosaveLabel(autosave)
    if (label.isEmpty()) return
    val refused = autosave?.refused == true
    val reload = autosave?.reload_label.orEmpty()
    val acted = LocalStatusActed.current
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        Text(
            label,
            style = centraidType("annotLabel"),
            color = if (refused) centraidColor("net") else centraidColor("textSoft"),
            maxLines = 2,
            modifier = Modifier.testTag("kit-autosave"),
        )
        // A SAVE THE VAULT REFUSED BECAUSE THE RECORD CHANGED ELSEWHERE (#1185): the words stay,
        // and Reload is the one verb. It is the kit's `StatusActed`, which Rust answers.
        if (reload.isNotEmpty()) {
            Text(
                reload,
                style = centraidType("annotLabel").copy(fontWeight = FontWeight.SemiBold),
                color = centraidColor("text"),
                modifier = Modifier
                    .heightIn(min = KitGeometry.ROW_MIN)
                    .clickable(onClick = acted)
                    .padding(horizontal = 12.dp, vertical = 10.dp)
                    .testTag("kit-autosave-reload")
                    .semantics { role = Role.Button },
            )
        }
    }
}

/**
 * A party hue to its colour. The state carries either the theme's colour role
 * itself (`cRose` — People) or a wheel key (`rose` — Agenda), and both
 * draw the same role. An unknown value draws slate, the neutral for "no party".
 */
@Composable
public fun hueColor(key: String): Color {
    val role = when {
        key in PARTY_ROLES -> key
        key in PARTY_HUES -> "c" + key.replaceFirstChar { it.uppercase() }
        else -> "cSlate"
    }
    return centraidColor(role)
}

/** The eight party hues (`IDENTITY_HUE_KEYS` in `crates/design`). */
private val PARTY_HUES: Set<String> =
    setOf("rose", "amber", "ochre", "forest", "teal", "slate", "indigo", "violet")

/** The same eight, as the theme's colour roles. */
private val PARTY_ROLES: Set<String> = PARTY_HUES.mapTo(mutableSetOf()) { "c" + it.replaceFirstChar(Char::uppercaseChar) }


/**
 * THE SAME ROW FROM THE SCREEN RUNTIME'S CONTAINER (#1135): a tap hands the
 * container's own [centraid.core.v1.Route] to the shell, which pushes it.
 */
@Composable
public fun SearchContainerRow(
    container: centraid.core.v1.SearchContainer,
    modifier: Modifier = Modifier,
    onOpen: (centraid.core.v1.Route) -> Unit,
) {
    val route = container.route
    SearchContainerLine(
        container.entity,
        container.id,
        container.icon_key,
        container.title,
        container.kind_label,
        container.accessibility_label,
        modifier,
        onTap = if (route != null) ({ onOpen(route) }) else null,
    )
}

@Composable
private fun SearchContainerLine(
    entity: String,
    id: String,
    iconKey: String,
    title: String,
    kindLabel: String,
    accessibilityLabel: String,
    modifier: Modifier,
    onTap: (() -> Unit)?,
) {
    // A matched container is one pill above the rows (#1173): its glyph in the app's colour, the
    // kind in meta, then its name.
    val shape = RoundedCornerShape(percent = 50)
    Box(
        modifier
            .fillMaxWidth()
            .heightIn(min = KitGeometry.ROW_MIN)
            .padding(horizontal = KitGeometry.GUTTER + 2.dp, vertical = 4.dp)
            .testTag("search-container-$entity-$id")
            .clearAndSetSemantics {
                contentDescription = accessibilityLabel
                role = Role.Button
            },
        contentAlignment = Alignment.CenterStart,
    ) {
        Row(
            Modifier
                .clip(shape)
                .background(Surface.card)
                .border(KitGeometry.HAIRLINE, Surface.border, shape)
                .then(if (onTap != null) Modifier.clickable(onClick = onTap) else Modifier)
                .heightIn(min = KitGeometry.ROW_MIN)
                .padding(start = 8.dp, end = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CentraidIcon(iconKey = iconKey, tint = appAccent().text, size = 16.dp)
            KitText(kindLabel, KitType.Meta, Surface.meta, Modifier.padding(start = 6.dp), maxLines = 1)
            KitText(title, KitType.Row, Surface.ink, Modifier.padding(start = 6.dp), maxLines = 1)
        }
    }
}
