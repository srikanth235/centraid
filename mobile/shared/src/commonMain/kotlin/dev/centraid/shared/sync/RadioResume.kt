package dev.centraid.shared.sync

/**
 * THE RADIO IS AN EVENT, NOT A POLL (#1025, D-1025-S7-40, R-SHELL-4).
 *
 * Airplane mode off is the member still looking at a tail that died. The three
 * occasions do not grow a fourth: this is the foreground occasion surviving an
 * interruption. A rising edge while the member is looking reopens the tail; a
 * falling edge lowers reachability and never raises it (trap unreachable-vault).
 * Nothing here is a timer.
 *
 * [wasOnline] is the last reading this session actually heard. Null is "we
 * have not heard yet": a first `online = true` is not a resume (the member
 * just arrived, `foreground()` already opened the tail), and a first
 * `online = false` while looking is a loss (the header must not stay "synced"
 * over a phone that is already in airplane mode).
 */
internal object RadioResume {
    internal enum class Act {
        NONE,
        LOST,
        RESUME,
    }

    internal fun act(
        looking: Boolean,
        wasOnline: Boolean?,
        nowOnline: Boolean,
    ): Act {
        if (!looking) return Act.NONE
        if (wasOnline == false && nowOnline) return Act.RESUME
        if (!nowOnline && wasOnline != false) return Act.LOST
        return Act.NONE
    }
}
