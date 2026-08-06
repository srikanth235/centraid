// OFFLINE, EXPLAINED (v4 handoff §14, README §14, proto 4867-4873).
//
// README §14 states the bug this component closes in one line: "A grey mosaic
// with no explanation is a bug." Photos had no offline concept at all on the
// web — a failed read became one invented sentence on the status line, and the
// grid it produced was exactly that unexplained mosaic.
//
// What this is, precisely, and what it is NOT:
//
//  * A BORDERED banner. 1px `--net`, container radius, no fill and no icon.
//    `--net` is the "this leaves the device" role and the brief allows it as a
//    border or a 2px rule, never as a ground (§18) — a red-filled strip would
//    make an expected state read as an alarm.
//  * NOT a screen. Everything behind it still renders: months, days, counts,
//    captions, albums, people, the toolbar, the scrub rail, Select, the
//    memories strip. The whole claim of the banner is that the meaning is
//    still here, so hiding the meaning to show the banner would refute it.
//  * NOT a dimmer. The container keeps its own opacity (README §14's
//    "no container dimming" — a recessive state takes its own token on the
//    leaf, never an `opacity` on everything above it).
//
// One outlined control: `Retry`. It re-reads; it does not "reconnect", because
// this app does not own the connection and would be naming something it cannot
// do.
import { OFFLINE_COPY } from "../view-copy.ts";

import styles from "./OfflineBanner.module.css";

export function OfflineBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <section
      className={styles.banner}
      aria-label={OFFLINE_COPY.label}
      // `polite`, not `assertive`: an unreachable gateway is not an
      // interruption — every word on screen is still true.
      aria-live="polite"
    >
      <p className={styles.body}>{OFFLINE_COPY.banner}</p>
      <button type="button" className="kit-btn" onClick={onRetry}>
        {OFFLINE_COPY.retry}
      </button>
    </section>
  );
}
