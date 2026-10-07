package dev.centraid.shared.kit

import dev.centraid.shared.screen.ScreenEffect
import dev.centraid.shared.screen.Step

/** Which band destination a screen is on — a parameter, not a screen (law 2). */
public interface BandLens<S, Dst> {
    public fun destination(state: S): Dst

    public fun with(state: S, destination: Dst): S
}

/**
 * A BAND TAP (law 2). One machine per band; the destination is a parameter the
 * reads object switches on, and `tables` must cover every destination's reads
 * because `rowsChanged` is one declaration. More is a sheet and search is a
 * field on the current surface — neither is a destination.
 */
public object BandLaw {
    /**
     * The same destination again is NOTHING: no reset and no read (a band tap
     * on the tab you are on used to read twice on Android). Another destination
     * starts that destination's first load.
     */
    public fun <S, Dst, D> changed(
        b: BandLens<S, Dst>,
        c: ContentLens<S, D>,
        screenId: String,
        s: S,
        to: Dst,
    ): Step<S> {
        if (b.destination(s) == to) return Step(s)
        return Step(
            c.with(b.with(s, to), ReadContent.Loading(firstLoad = true)),
            listOf(ScreenEffect.ReadPage(screenId, afterCursor = null)),
        )
    }
}
