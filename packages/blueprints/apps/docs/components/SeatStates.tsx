// Seat states (docs spec §12), stated once per screen above the route body.
import type { ReactNode } from "react";

import { Panel } from "./Blocks.tsx";

import styles from "./SeatStates.module.css";

/** §12 `readonly`: placed in, may not write; read `canWrite`, never infer. */
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

/** §12 `permission`: grant gone; app dark, documents untouched; banner is the way back. */
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
