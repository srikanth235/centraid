// The two states that are about the SEAT rather than about the drive
// (Docs spec §12's `readonly` and `permission`).
//
// Both answer the same shape of question — "why can I not do the thing this
// screen is offering" — and both are failures of the standard kind: silent.
// A member in a read-only space presses Rename, nothing happens, and they
// conclude the app is broken. A member whose grant was revoked mid-session
// watches a drive full of titles they can no longer open. Neither state is
// wrong; both are unspeakable unless something says them.
//
// They stand ABOVE the route body, on the same terms as the offline banner:
// they change what every control below them can promise, so they are stated
// once for the whole screen rather than on each control that would refuse.
import type { ReactNode } from "react";

import { Panel } from "./Blocks.tsx";

import styles from "./SeatStates.module.css";

/**
 * §12's `readonly` — a space the member was placed in and may not write to.
 *
 * The scope's `canWrite` is the shell's own answer to "may this member add
 * here?", so this is read and never inferred. What it changes is every writing
 * verb in the app at once, which is exactly why it is said here instead of
 * being discovered one disabled button at a time.
 */
export function ReadOnlyPanel({ label }: { label: string }): ReactNode {
  return (
    <div className={styles.wrap}>
      <Panel
        net
        eyebrow="Read-only"
        title={`${label} · you may open and download`}
        body="A shared space you were placed in. The documents are all here and all readable; what is unavailable is changing them."
        facts={[
          { k: "what you may do", v: "open · download · search · star" },
          {
            k: "what you may not",
            v: "rename · move · replace · edit · trash",
            net: true,
          },
          {
            k: "who can",
            v: "whoever placed these here — the space's owner",
          },
        ]}
      />
    </div>
  );
}

/**
 * §12's `permission` — the grant that let Docs read this vault is gone.
 *
 * THE APP GOES DARK; THE DOCUMENTS DO NOT MOVE. That distinction is the whole
 * screen: a member watching an app empty itself needs to be told, in the same
 * breath, that nothing was deleted. The way back to the grant is the banner
 * this panel stands under (`Chrome.tsx`, with `VaultAccessButton`) — a denied
 * read always offers a direct way to the grant, and never a dead end.
 */
export function PermissionPanel(): ReactNode {
  return (
    <div className={styles.wrap}>
      <Panel
        net
        eyebrow="No grant"
        title="Docs cannot reach these documents"
        body="The grant that let Docs read this vault has been revoked, so the app goes dark rather than show a stale copy."
        facts={[
          {
            k: "what is true right now",
            v: "every document is still in the vault, untouched",
          },
          {
            k: "what docs can see",
            v: "nothing — not titles, not folders, not sizes",
            net: true,
          },
          {
            k: "if the grant returns",
            v: "the drive is exactly as you left it, including the sort and the view",
          },
        ]}
      />
    </div>
  );
}
