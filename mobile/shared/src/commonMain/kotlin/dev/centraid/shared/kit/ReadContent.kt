package dev.centraid.shared.kit

import centraid.screen.v1.ReadFailure

/**
 * THE READ LAW'S ARMS, AS ONE TYPE THE KIT CAN MOVE BETWEEN (law 1).
 *
 * Every screen's `content` oneof is loading, a failure, or data — plus the
 * denied arm where a screen carries one. The oneof stays in each screen's own
 * proto message, so law 1 is readable per screen; this is the view of it the
 * kit's laws take, through a [ContentLens] each screen writes once.
 *
 * `Data` is never produced from a failure: an empty data case standing in for
 * a refusal is the fourth shape law 1 exists to forbid.
 */
public sealed interface ReadContent<out D> {
    public data class Loading(val firstLoad: Boolean) : ReadContent<Nothing>

    public data class Failed(val failure: ReadFailure) : ReadContent<Nothing>

    public data class Denied(val denied: centraid.screen.v1.Denied) : ReadContent<Nothing>

    public data class Data<D>(val data: D) : ReadContent<D>
}

/**
 * How the kit reads and writes one screen's `content` oneof.
 *
 * [with] sets EXACTLY one arm and clears the others — Wire refuses a message
 * with two arms of one oneof set, so a lens that forgot to clear one throws at
 * the first state it builds rather than drawing two arms at once. A screen with
 * no denied arm maps [ReadContent.Denied] onto its failure arm.
 */
public interface ContentLens<S, D> {
    public fun content(state: S): ReadContent<D>

    public fun with(state: S, content: ReadContent<D>): S
}

/** The data on screen, or null when the content is any other arm. */
public fun <S, D> ContentLens<S, D>.dataOf(state: S): D? =
    (content(state) as? ReadContent.Data<D>)?.data
