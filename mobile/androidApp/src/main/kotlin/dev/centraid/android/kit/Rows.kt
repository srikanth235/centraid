package dev.centraid.android.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import centraid.screen.v1.Autosave
import centraid.screen.v1.ListRow
import centraid.screen.v1.SectionHead
import centraid.screen.v1.StatusChip
import dev.centraid.android.theme.centraidColor
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
    accessory: (@Composable RowScope.() -> Unit)? = null,
) {
    val titleInk = if (dimmed) centraidColor("textFaint") else centraidColor("text")
    val softInk = if (dimmed) centraidColor("textFaint") else centraidColor("textSoft")
    Row(
        modifier
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
            Text(
                title,
                style = centraidType("body"),
                color = titleInk,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (meta.isNotEmpty()) {
                Text(
                    meta,
                    style = centraidType("annotLabel"),
                    color = softInk,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        chips.forEach { chip -> StatusChipView(chip, Modifier.padding(start = 8.dp)) }
        if (trailing.isNotEmpty() || pending) {
            // THE FIGURE: right-aligned, with its sub-label under it.
            Column(Modifier.padding(start = 8.dp), horizontalAlignment = Alignment.End) {
                if (trailing.isNotEmpty()) {
                    val figureInk = if (dimmed) titleInk else toneInk(trailingTone, neutral = "text")
                    Text(trailing, style = centraidType("bodyStrong"), color = figureInk, textAlign = TextAlign.End, maxLines = 1)
                }
                val note = if (pending) pendingLabel else trailingNote
                if (note.isNotEmpty()) {
                    Text(note, style = centraidType("annotLabel"), color = softInk, textAlign = TextAlign.End, maxLines = 1)
                }
            }
        }
        accessory?.invoke(this)
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
 * A CHIP: a finished label on a hairline in its tone's ink. `seam` is "not
 * yet", `net` is "owe / leaves", `warning` is the warning role; neutral is
 * soft ink. No fill — a chip is read, not pressed.
 */
@Composable
public fun StatusChipView(chip: StatusChip, modifier: Modifier = Modifier) {
    if (chip.label.isEmpty()) return
    val ink = toneInk(chip.tone, neutral = "textSoft")
    Text(
        chip.label,
        style = centraidType("annotLabel"),
        color = ink,
        maxLines = 1,
        modifier = modifier
            .border(KitGeometry.HAIRLINE, ink, RoundedCornerShape(4.dp))
            .padding(horizontal = 6.dp, vertical = 1.dp)
            .testTag("kit-chip"),
    )
}

/** A tone's ink role: `seam`, `net`, `warning`, or [neutral] for the rest. */
@Composable
public fun toneInk(tone: StatusChip.Tone, neutral: String): Color = centraidColor(
    when (tone) {
        StatusChip.Tone.TONE_SEAM -> "seam"
        StatusChip.Tone.TONE_NET -> "net"
        StatusChip.Tone.TONE_WARNING -> "warning"
        else -> neutral
    },
)

/** THE SECTION HEAD: a title, its count, and one text verb. */
@Composable
public fun SectionHeader(head: SectionHead, modifier: Modifier = Modifier, onVerb: (() -> Unit)? = null) {
    Row(
        modifier
            .fillMaxWidth()
            .padding(start = KitGeometry.GUTTER, end = 8.dp, top = 20.dp, bottom = 4.dp)
            .testTag("kit-section"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val count = head.count
        Text(
            if (count != null) "${head.title} · $count" else head.title,
            style = centraidType("smallStrong"),
            color = centraidColor("textSoft"),
            modifier = Modifier.weight(1f).semantics { heading() },
        )
        if (head.verb_label.isNotEmpty() && onVerb != null) {
            Text(
                head.verb_label,
                style = centraidType("annotLabelOn"),
                color = centraidColor("link"),
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
            QuietButton(label = label, testTag = "kit-show-more", onPress = onMore)
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
 * while the phase is CLEAN) — so a remote load lands and typing never fights it.
 */
@Composable
public fun rememberEditorText(value: String, reload: Any?): MutableState<String> {
    val text = remember { mutableStateOf(value) }
    LaunchedEffect(reload) {
        if (reload != null && text.value != value) text.value = value
    }
    return text
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
    val text = rememberEditorText(value, reload)
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
                onValueChange = { next ->
                    text.value = next
                    if (next != value) onEdit(next)
                },
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

/** What an autosave says, in words: the status line an [EditorRoom] hosts. */
public fun autosaveLabel(autosave: Autosave?): String {
    if (autosave == null) return ""
    return when (autosave.phase) {
        Autosave.Phase.PHASE_DIRTY, Autosave.Phase.PHASE_SAVING -> KitWords.SAVING
        Autosave.Phase.PHASE_REFUSED -> autosave.failure?.sentence?.ifEmpty { null } ?: KitWords.NOT_SAVED
        Autosave.Phase.PHASE_CONFLICT -> KitWords.CHANGED_ELSEWHERE
        Autosave.Phase.PHASE_CLEAN, Autosave.Phase.PHASE_SAVED -> KitWords.SAVED
        Autosave.Phase.PHASE_UNSPECIFIED -> ""
    }
}

/**
 * THE AUTOSAVE STATUS LINE. A refusal is `net` ink and its sentence, over the
 * words and never instead of them; everything else is quiet.
 */
@Composable
public fun AutosaveStatus(autosave: Autosave?, modifier: Modifier = Modifier) {
    val label = autosaveLabel(autosave)
    if (label.isEmpty()) return
    val refused = autosave?.phase == Autosave.Phase.PHASE_REFUSED
    Text(
        label,
        style = centraidType("annotLabel"),
        color = if (refused) centraidColor("net") else centraidColor("textSoft"),
        maxLines = 2,
        modifier = modifier.testTag("kit-autosave"),
    )
}

/**
 * A party hue to its colour. The state carries either the theme's colour role
 * itself (`cRose` — People) or a wheel key (`rose` — Agenda, Tally), and both
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

/** `packages/design`'s eight party hues. */
private val PARTY_HUES: Set<String> =
    setOf("rose", "amber", "ochre", "forest", "teal", "slate", "indigo", "violet")

/** The same eight, as the theme's colour roles. */
private val PARTY_ROLES: Set<String> = PARTY_HUES.mapTo(mutableSetOf()) { "c" + it.replaceFirstChar(Char::uppercaseChar) }
