package dev.centraid.android.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.font.FontWeight
import dev.centraid.design.CentraidCatalog
import dev.centraid.android.theme.LocalCentraidTokens
import dev.centraid.android.theme.centraidDark
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.disabled
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import centraid.core.v1.Denied
import centraid.core.v1.EmptyState
import centraid.core.v1.Loading
import centraid.core.v1.PageNote
import centraid.core.v1.PageState
import centraid.core.v1.Failure as ReadFailure
import dev.centraid.android.theme.centraidColor
import dev.centraid.design.CentraidGeometry
import dev.centraid.design.CentraidTokens
import dev.centraid.android.theme.centraidType

/**
 * THE READ LAW'S FOUR ARMS, AS A VIEW SEES THEM (K5, #1029).
 *
 * `screen.proto` law 1: loading, failure and data are three arms, never two —
 * and the kit adds the fourth, [Denied], which has no band and no retry. A
 * screen builds one of these from its own `content` oneof with [screenContentOf]
 * and hands it to [ReadStateView], which is the only place a list screen
 * switches on content.
 */
public sealed interface ScreenContent<out V> {
    public data class Loading(val firstLoad: Boolean) : ScreenContent<Nothing>
    public data class Failure(val sentence: String, val remedy: String) : ScreenContent<Nothing>
    public data class Gate(val denied: Denied) : ScreenContent<Nothing>
    public data class Data<V>(val value: V) : ScreenContent<V>
}

/**
 * One screen's `content` oneof, as [ScreenContent]. At most one argument is set
 * (Wire enforces the oneof); none set is the seeded first load.
 */
public fun <V : Any> screenContentOf(
    loading: Loading?,
    failure: ReadFailure?,
    data: V?,
    denied: Denied? = null,
): ScreenContent<V> = when {
    denied != null -> ScreenContent.Gate(denied)
    failure != null -> ScreenContent.Failure(failure.sentence, failure.remedy)
    data != null -> ScreenContent.Data(data)
    else -> ScreenContent.Loading(loading?.first_load ?: true)
}

/**
 * THE ONE SWITCH ON CONTENT. Loading draws [skeleton] (row geometry, never a
 * spinner), failure draws [FailureView] with a member-sent retry, denied draws
 * [DeniedGate], and data draws [data].
 *
 * [onRetry] is the screen's `Refreshed` event. Null only for a screen whose
 * machine has no member-initiated re-read; a refusal NEVER retries itself.
 */
@Composable
public fun <V> ReadStateView(
    content: ScreenContent<V>,
    onRetry: (() -> Unit)?,
    modifier: Modifier = Modifier,
    retryLabel: String = KitWords.RETRY,
    skeleton: @Composable () -> Unit = { RowSkeleton() },
    data: @Composable (V) -> Unit,
) {
    Box(modifier.fillMaxSize()) {
        when (content) {
            is ScreenContent.Loading -> skeleton()
            is ScreenContent.Failure -> FailureView(content.sentence, content.remedy, onRetry, retryLabel = retryLabel)
            is ScreenContent.Gate -> DeniedGate(content.denied)
            is ScreenContent.Data -> data(content.value)
        }
    }
}

/**
 * THE PAGE'S READ, DRAWN ONCE (#1185): the same switch over the kit's [PageState], which the
 * screen's Rust builds from `Page::wire`. A first load draws [skeleton]; a gate draws
 * [DeniedGate] (no retry, it never retries itself); a failed read draws [FailureView] with
 * Retry; an empty one draws [EmptyStateView]; none of those set means ready, and [data] is drawn
 * under the [PageNoteBanner] when the state carries a note.
 *
 * [onRetry] is the screen's own re-read event and also answers a note's action; [onEmptyAction]
 * answers the empty state's one action. The shell decides nothing: every word is the state's.
 *
 * [stage] is the full-bleed variant for a page that is a dark stage (the slideshow): the gate, the
 * failure, the empty state and the note are drawn in the dark scheme and centred over the
 * caller's own ground, and the note floats over the top of [data] instead of pushing it down.
 * The SwiftUI twin is `PageReadStateView(stage: true)`.
 */
@Composable
public fun ReadStateView(
    page: PageState,
    onRetry: (() -> Unit)?,
    modifier: Modifier = Modifier,
    onEmptyAction: (() -> Unit)? = null,
    onNoteAction: (() -> Unit)? = onRetry,
    retryLabel: String = KitWords.RETRY,
    stage: Boolean = false,
    skeleton: @Composable () -> Unit = { RowSkeleton() },
    data: @Composable () -> Unit,
) {
    val failed = page.failed
    val refused = page.refused
    val empty = page.empty
    // A note whose kind is unset is not a note: it is never drawn.
    val note = page.note?.takeIf { it.kind != PageNote.Kind.KIND_UNSPECIFIED }
    Box(modifier.fillMaxSize(), contentAlignment = if (stage) Alignment.Center else Alignment.TopStart) {
        when {
            page.loading != null -> skeleton()
            refused != null -> StageScheme(stage) { DeniedGate(refused) }
            failed != null -> StageScheme(stage) {
                FailureView(failed.sentence, failed.remedy, onRetry, retryLabel = retryLabel)
            }
            empty != null -> StageScheme(stage) { EmptyStateView(empty, onEmptyAction) }
            stage -> {
                data()
                if (note != null) {
                    Box(Modifier.fillMaxWidth().align(Alignment.TopCenter)) {
                        StageScheme(true) { PageNoteBanner(note, onNoteAction) }
                    }
                }
            }
            else -> Column(Modifier.fillMaxSize()) {
                if (note != null) {
                    PageNoteBanner(note, onNoteAction)
                }
                Box(Modifier.weight(1f)) { data() }
            }
        }
    }
}

/** [content] in the dark scheme when [stage]: a state drawn on the full-bleed dark stage reads dark. */
@Composable
private fun StageScheme(stage: Boolean, content: @Composable () -> Unit) {
    if (stage) {
        CompositionLocalProvider(LocalCentraidTokens provides CentraidTokens.dark) { content() }
    } else {
        content()
    }
}

/**
 * ONE SENTENCE OVER DATA, and at most one action. It is a polite live region and speaks its
 * sentence (the action reads "{sentence}" then its label as a button). It is drawn in place with
 * no entry animation, so reduced motion needs nothing: there is no motion to remove.
 */
@Composable
public fun PageNoteBanner(
    note: PageNote,
    onAction: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val shape = RoundedCornerShape(KitGeometry.RADIUS)
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 8.dp)
            .clip(shape)
            .background(Surface.fill, shape)
            .border(KitGeometry.HAIRLINE, Surface.border, shape)
            .heightIn(min = KitGeometry.ROW_MIN)
            .padding(horizontal = 14.dp, vertical = 6.dp)
            .testTag(if (note.kind == PageNote.Kind.KIND_NOT_CHECKED) "kit-note-unchecked" else "kit-note-partial")
            .semantics {
                contentDescription = note.sentence
                liveRegion = LiveRegionMode.Polite
            },
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        KitText(note.sentence, KitType.Meta, Surface.ink, Modifier.weight(1f).clearAndSetSemantics { })
        if (note.action_label.isNotEmpty() && onAction != null) {
            Text(
                note.action_label,
                style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
                color = Surface.ink,
                modifier = Modifier
                    .heightIn(min = KitGeometry.ROW_MIN)
                    .clickable(onClick = onAction)
                    .padding(horizontal = 6.dp, vertical = 12.dp)
                    .testTag("kit-note-action")
                    .semantics { role = Role.Button },
            )
        }
    }
}

/**
 * SKELETON ROWS AT ROW GEOMETRY: static bars in `skel`, one per 44dp row, a
 * title bar and (when [meta]) a meta bar under it. Spoken once, as [label].
 */
@Composable
public fun RowSkeleton(
    modifier: Modifier = Modifier,
    rows: Int = 8,
    meta: Boolean = true,
    label: String = KitWords.OPENING,
) {
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER)
            .testTag("kit-skeleton")
            .clearAndSetSemantics { contentDescription = label },
    ) {
        repeat(rows) { index ->
            Column(
                Modifier.fillMaxWidth().heightIn(min = KitGeometry.ROW_MIN).padding(vertical = 10.dp),
                verticalArrangement = Arrangement.Center,
            ) {
                SkeletonBar(if (index % 3 == 0) 200.dp else if (index % 3 == 1) 150.dp else 176.dp)
                if (meta) {
                    SkeletonBar(96.dp, Modifier.padding(top = 6.dp), height = 8.dp)
                }
            }
        }
    }
}

@Composable
internal fun SkeletonBar(width: Dp, modifier: Modifier = Modifier, height: Dp = 12.dp) {
    Box(
        modifier
            .width(width)
            .height(height)
            .clip(RoundedCornerShape(KitGeometry.RADIUS))
            .background(centraidColor("skel")),
    )
}

/**
 * A READ THAT FAILED: its sentence, its remedy (the half a member can act on)
 * and a retry that sends the screen's own `Refreshed`.
 */
@Composable
public fun FailureView(
    sentence: String,
    remedy: String,
    onRetry: (() -> Unit)?,
    modifier: Modifier = Modifier,
    retryLabel: String = KitWords.RETRY,
) {
    Column(modifier.fillMaxWidth().padding(KitGeometry.GUTTER).testTag("kit-failure")) {
        KitText(sentence, KitType.Row, Surface.ink)
        if (remedy.isNotEmpty()) {
            KitText(remedy, KitType.Meta, Surface.meta, Modifier.padding(top = 4.dp))
        }
        if (onRetry != null) {
            OutlineButton(
                label = retryLabel,
                testTag = "kit-retry",
                modifier = Modifier.padding(top = 12.dp),
                onPress = onRetry,
            )
        }
    }
}

/**
 * NOTHING HERE: one sentence, at most one more, and at most one action
 * (product-intuition/references/design-behaviour.md § Wording). The strings are finished; the action is the
 * screen's own event.
 *
 * A ported app's day one that offers the phone's own data (People's contacts,
 * Agenda's calendar) puts the import's verb in `action_label` and answers it
 * with the screen's own event (#1135); the app's own add stays in its header.
 */
@Composable
public fun EmptyStateView(
    empty: EmptyState,
    onAction: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    // THE EMPTY STATE PATTERN (#1173): a card on the page with the app's glyph on a wash of its
    // colour, the one sentence, the reason, and at most one action as the app's pill.
    val accent = appAccent()
    val glyph = empty.icon_key.ifEmpty { CentraidCatalog.byId[accent.appId]?.iconKey }
    Column(
        modifier
            .fillMaxWidth()
            .padding(horizontal = KitGeometry.GUTTER, vertical = 12.dp)
            .kitCard()
            .padding(horizontal = 20.dp, vertical = 28.dp)
            .testTag("kit-empty"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        if (glyph != null) {
            Box(
                Modifier.size(52.dp).clip(CircleShape).background(accent.wash(centraidDark())).clearAndSetSemantics { },
                contentAlignment = Alignment.Center,
            ) { CentraidIcon(iconKey = glyph, tint = accent.text, size = 22.dp) }
        }
        KitText(empty.headline, KitType.Section, Surface.ink, Modifier.semantics { heading() })
        if (empty.body.isNotEmpty()) {
            Text(empty.body, style = kitTextStyle(KitType.Row), color = Surface.body, textAlign = TextAlign.Center)
        }
        if (empty.action_label.isNotEmpty() && onAction != null) {
            KitPillButton(empty.action_label, onAction, testTag = "kit-empty-action")
        }
    }
}

/**
 * THE DENIED GATE: title, body and the receipt, and NO band — there is no app
 * to move around in. The system back gesture is the way out.
 */
@Composable
public fun DeniedGate(denied: Denied, modifier: Modifier = Modifier) {
    Column(
        modifier.fillMaxSize().padding(24.dp).testTag("kit-denied"),
        verticalArrangement = Arrangement.Center,
    ) {
        KitText(denied.title, KitType.Section, Surface.ink, Modifier.semantics { heading() })
        if (denied.body.isNotEmpty()) {
            Text(
                denied.body,
                style = kitTextStyle(KitType.Row),
                color = Surface.body,
                modifier = Modifier.padding(top = 8.dp),
            )
        }
        if (denied.receipt.isNotEmpty()) {
            Text(
                denied.receipt,
                style = centraidType("mono"),
                color = centraidColor("textFaint"),
                modifier = Modifier.padding(top = 12.dp),
            )
        }
    }
}

/**
 * An outline button: words on a hairline, no fill. IT HUGS ITS LABEL and sits
 * at the leading edge of what is above it; there is no width switch on the
 * call. The one place it stretches is inside a [ChoiceStack], which hands every
 * button in it the same full width (and the ink button's 44dp height).
 */
@Composable
public fun OutlineButton(
    label: String,
    modifier: Modifier = Modifier,
    testTag: String = "kit-button",
    ink: String = "text",
    enabled: Boolean = true,
    onPress: () -> Unit,
) {
    val stacked = LocalChoiceStack.current
    val inRow = LocalChoiceRow.current
    val edge = when {
        !enabled -> Surface.fill
        ink == "text" -> Surface.border
        else -> StateColor.Red.text
    }
    val shape = RoundedCornerShape(percent = 50)
    Text(
        label,
        style = kitTextStyle(KitType.Row).copy(fontWeight = FontWeight.SemiBold),
        color = if (!enabled) Surface.meta else if (ink == "text") Surface.ink else StateColor.Red.text,
        textAlign = if (stacked) TextAlign.Center else TextAlign.Unspecified,
        maxLines = if (inRow) 1 else Int.MAX_VALUE,
        modifier = modifier
            .then(if (stacked) Modifier.fillMaxWidth() else Modifier)
            .heightIn(min = if (stacked) KitGeometry.ROW_MIN else 36.dp)
            .widthIn(min = 44.dp)
            .clip(shape)
            // THE ACTION ROW'S KEYS ARE WHITE PILLS (AgendaEvent): inside a choice row the outline
            // sits on a card fill, so the keys read as keys on the page.
            .then(if (inRow) Modifier.background(Surface.card, shape) else Modifier)
            .border(KitGeometry.HAIRLINE, edge, shape)
            .clickable(enabled = enabled, onClick = onPress)
            // 13 + 18 (the label's line) + 13 is the stack's 44; 9 + 18 + 9 is
            // the hugging button's 36.
            .padding(horizontal = if (inRow) 6.dp else 12.dp, vertical = if (stacked) 13.dp else 9.dp)
            .testTag(testTag)
            .semantics {
                role = Role.Button
                if (!enabled) disabled()
            },
    )
}

/**
 * True inside a [ChoiceStack]: an [OutlineButton] there stretches to the
 * stack's width. Nothing else reads it.
 */
public val LocalChoiceStack: ProvidableCompositionLocal<Boolean> = compositionLocalOf { false }

/**
 * ALTERNATIVES STACKED VERTICALLY: an ink button and its Cancel or Not now, or
 * a set of choices like a Money transaction's offers. Every button in the stack
 * shares one full width, [InkButton] and [OutlineButton] alike, so the column
 * reads as one set of answers to one question. This is the only place an
 * outline button stretches; anywhere else it hugs its label.
 */
@Composable
public fun ChoiceStack(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    CompositionLocalProvider(LocalChoiceStack provides true) {
        Column(
            modifier.fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(KitGeometry.STACK_GAP),
            content = content,
        )
    }
}

/** True inside a [ChoiceRow]: the outline buttons share one line, so the label gets the room. */
public val LocalChoiceRow: ProvidableCompositionLocal<Boolean> = compositionLocalOf { false }

/**
 * A SHORT SET OF ACTIONS ON ONE LINE (#1173): the event page's Open in Maps, Edit and Cancel. Each
 * button takes an equal share of the width (pass `Modifier.weight(1f)`), in the stack's full-width
 * look, with 10dp between them.
 */
@Composable
public fun ChoiceRow(
    modifier: Modifier = Modifier,
    content: @Composable RowScope.() -> Unit,
) {
    CompositionLocalProvider(LocalChoiceStack provides true, LocalChoiceRow provides true) {
        Row(
            modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            content = content,
        )
    }
}

/** The kit's geometry, in one place. */
public object KitGeometry {
    /**
     * The page margin: the emitted `CentraidGeometry.PAGE_MARGIN` (design/tokens.toml fixes it), the one
     * definition every kit and screen inset reads. The name stays; the value is no longer typed here.
     */
    public val GUTTER: Dp = CentraidGeometry.PAGE_MARGIN.dp

    /** A thumb's press: every row and key is at least this tall. */
    public val ROW_MIN: Dp = 44.dp

    /** The control radius: the token scale's `radii.md`, read, never typed. */
    public val RADIUS: Dp = (CentraidTokens.light.radii["md"] ?: 0).dp

    public val HAIRLINE: Dp = 1.dp

    /** The gap between the buttons of a [ChoiceStack]: the token scale's `spacing.3`. */
    public val STACK_GAP: Dp = (CentraidTokens.light.spacing["3"] ?: 0).dp
}

