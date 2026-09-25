package dev.centraid.android.kit

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import centraid.screen.v1.Denied
import centraid.screen.v1.EmptyState
import centraid.screen.v1.Loading
import centraid.screen.v1.ReadFailure
import dev.centraid.android.theme.centraidColor
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
        Text(sentence, style = centraidType("body"), color = centraidColor("text"))
        if (remedy.isNotEmpty()) {
            Text(
                remedy,
                style = centraidType("small"),
                color = centraidColor("textSoft"),
                modifier = Modifier.padding(top = 4.dp),
            )
        }
        if (onRetry != null) {
            QuietButton(
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
 * (DESIGN.md copy table). The strings are finished; the action is the
 * screen's own event.
 */
@Composable
public fun EmptyStateView(
    empty: EmptyState,
    onAction: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier.fillMaxSize().padding(24.dp).testTag("kit-empty"),
        verticalArrangement = Arrangement.Center,
    ) {
        Text(empty.headline, style = centraidType("title"), color = centraidColor("text"))
        if (empty.body.isNotEmpty()) {
            Text(
                empty.body,
                style = centraidType("body"),
                color = centraidColor("textSoft"),
                modifier = Modifier.padding(top = 8.dp),
            )
        }
        if (empty.action_label.isNotEmpty() && onAction != null) {
            QuietButton(
                label = empty.action_label,
                testTag = "kit-empty-action",
                modifier = Modifier.padding(top = 16.dp),
                onPress = onAction,
            )
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
        Text(
            denied.title,
            style = centraidType("title"),
            color = centraidColor("text"),
            modifier = Modifier.semantics { heading() },
        )
        if (denied.body.isNotEmpty()) {
            Text(
                denied.body,
                style = centraidType("body"),
                color = centraidColor("textSoft"),
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

/** A quiet button: words on a hairline, no fill, a 44dp-wide target. */
@Composable
public fun QuietButton(
    label: String,
    modifier: Modifier = Modifier,
    testTag: String = "kit-button",
    ink: String = "text",
    onPress: () -> Unit,
) {
    Text(
        label,
        style = centraidType("annotLabelOn"),
        color = centraidColor(ink),
        modifier = modifier
            .heightIn(min = 36.dp)
            .widthIn(min = 44.dp)
            .clip(RoundedCornerShape(KitGeometry.RADIUS))
            .border(KitGeometry.HAIRLINE, centraidColor(if (ink == "text") "line" else ink), RoundedCornerShape(KitGeometry.RADIUS))
            .clickable(onClick = onPress)
            .padding(horizontal = 12.dp, vertical = 9.dp)
            .testTag(testTag)
            .semantics { role = Role.Button },
    )
}

/** The kit's geometry, in one place. */
public object KitGeometry {
    /** The page gutter. */
    public val GUTTER: Dp = 16.dp

    /** A thumb's press: every row and key is at least this tall. */
    public val ROW_MIN: Dp = 44.dp

    /** The control radius. */
    public val RADIUS: Dp = 8.dp

    public val HAIRLINE: Dp = 1.dp
}

