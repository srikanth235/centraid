package dev.centraid.android.kit

import centraid.screen.v1.Autosave
import centraid.screen.v1.Confirm
import centraid.screen.v1.Denied
import centraid.screen.v1.EmptyState
import centraid.screen.v1.ImportSource
import centraid.screen.v1.ListRow
import centraid.screen.v1.Loading
import centraid.screen.v1.ReadFailure
import centraid.screen.v1.StatusChip
import centraid.screen.v1.StatusLine as StatusLineMessage

/**
 * THE KIT'S VIEW VOCABULARY, FROM THE SCREEN RUNTIME'S (#1135).
 *
 * The kit composables below this package still take `centraid.screen.v1`
 * messages (`Denied`, `EmptyState`, `Confirm`, `Autosave`, `ListRow`, the
 * status line): the apps not yet ported to `crates/screens` pass those. A ported
 * app's view states carry the `centraid.core.v1` twins, and these are the one
 * place that turns a twin into the message the kit draws, field for field and
 * deciding nothing. Each is deleted with the last app that needs the old type.
 */
internal fun centraid.core.v1.Denied.toKit(): Denied = Denied(title = title, body = body, receipt = receipt)

internal fun centraid.core.v1.Loading.toKit(): Loading = Loading(first_load = first_load)

internal fun centraid.core.v1.Failure.toKit(): ReadFailure = ReadFailure(sentence = sentence, remedy = remedy)

internal fun centraid.core.v1.EmptyState.toKit(): EmptyState = EmptyState(
    headline = headline,
    body = body,
    action_label = action_label,
    import_source = import_source.toKit(),
)

internal fun centraid.core.v1.ImportSource.toKit(): ImportSource = ImportSource.fromValue(value) ?: ImportSource.IMPORT_SOURCE_UNSPECIFIED

internal fun centraid.core.v1.StatusLine.toKit(): StatusLineMessage =
    StatusLineMessage(sentence = sentence, action_label = action_label, refused = refused)

internal fun centraid.core.v1.Confirm.toKit(): Confirm =
    Confirm(title = title, body = body, confirm_label = confirm_label, destructive = destructive)

/** Only what the kit draws of an autosave: its words and whether the save was refused. */
internal fun centraid.core.v1.Autosave.toKit(): Autosave = Autosave(label = label, refused = refused)

internal fun centraid.core.v1.ListRow.toKit(): ListRow = ListRow(
    id = id,
    title = title,
    meta = meta,
    trailing = trailing,
    chips = chips.map { it.toKit() },
    hue_key = hue_key,
    accessibility_label = accessibility_label,
    dimmed = dimmed,
    pending = pending,
    trailing_tone = trailing_tone.toKit(),
)

internal fun centraid.core.v1.StatusChip.toKit(): StatusChip = StatusChip(label = label, tone = tone.toKit())

private fun centraid.core.v1.StatusChip.Tone.toKit(): StatusChip.Tone =
    StatusChip.Tone.fromValue(value) ?: StatusChip.Tone.TONE_UNSPECIFIED

/**
 * One screen's `content` oneof from the runtime's messages, as [ScreenContent]:
 * the same switch [screenContentOf] makes over the old ones.
 */
public fun <V : Any> screenContentOf(
    loading: centraid.core.v1.Loading?,
    failure: centraid.core.v1.Failure?,
    data: V?,
    denied: centraid.core.v1.Denied? = null,
): ScreenContent<V> = screenContentOf(loading?.toKit(), failure?.toKit(), data, denied?.toKit())
