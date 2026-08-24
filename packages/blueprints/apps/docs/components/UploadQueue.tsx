// The upload queue, per file (Docs spec §4.4's `bulk`).
//
// NEVER A ROLLING NOTICE. A bar reading "Uploading 3 of 12…", overwritten once
// a second and then by a summary, tells a member who dropped twelve files and
// had three refused the count and never the names. The rule the spec puts on
// this screen is "nothing was discarded", and a member cannot check that claim
// against a sentence that has already scrolled away.
//
// EVERY FAILURE NAMES ITS OWN RULE. Over the size ceiling, could not be read,
// refused by the vault — three different sentences, each on the row it belongs
// to, because "3 failed" is a number and "Council tax band.png · over the
// 512 MB ceiling" is something a member can act on.
//
// It stands ABOVE the route body, not over it: an upload is a thing happening
// to the drive, and covering the drive with news about it is how a member
// loses the row they were looking at.
import type { ReactNode } from "react";

import { displayText } from "../../_shared/untrusted.ts";
import type { UploadItem } from "../types.ts";
import { ActionBtn } from "./Shared.tsx";

import styles from "./UploadQueue.module.css";

/** The reading at the trailing edge of each row. */
const STATE_WORD: Record<UploadItem["state"], string> = {
  waiting: "waiting",
  running: "in flight",
  landed: "landed",
  parked: "waiting for approval",
  failed: "did not land",
};

export function UploadQueue({
  items,
  onDismiss,
}: {
  items: readonly UploadItem[];
  /** Clear a finished queue the member has read. Absent while files are still
   *  moving — dismissing a run in flight would hide the only account of it. */
  onDismiss?: () => void;
}): ReactNode {
  if (items.length === 0) return null;
  const landed = items.filter((i) => i.state === "landed").length;
  const failed = items.filter((i) => i.state === "failed").length;
  const running = items.some(
    (i) => i.state === "running" || i.state === "waiting"
  );

  return (
    <section
      className={styles.panel}
      data-net={String(failed > 0 && !running)}
      aria-label="Upload queue"
      aria-live="polite"
    >
      <div className={styles.head}>
        <div className={styles.headText}>
          <p className={styles.eyebrow}>
            {running ? "Running" : failed > 0 ? "Partial failure" : "Done"}
          </p>
          <h2 className={styles.title}>
            {running
              ? `Adding ${items.length} file${items.length === 1 ? "" : "s"}`
              : failed > 0
                ? `${landed} landed. ${failed} did not.`
                : `${landed} added`}
          </h2>
        </div>
        {onDismiss && !running ? (
          <ActionBtn icon="dismiss" label="Dismiss" onClick={onDismiss} />
        ) : null}
      </div>

      <ul className={styles.rows}>
        {items.map((item) => (
          <li
            className={styles.row}
            key={item.name}
            data-state={item.state}
            data-net={String(item.state === "failed")}
          >
            <span className={styles.name}>{displayText(item.name)}</span>
            <span className={styles.state}>
              {item.reason
                ? `${STATE_WORD[item.state]} · ${item.reason}`
                : STATE_WORD[item.state]}
            </span>
          </li>
        ))}
      </ul>

      {/* THE PROMISE, said where it can be checked. A member reading three
          refusals needs to know the three files are still on their device — it
          is the difference between "retry this" and "that is gone". */}
      {failed > 0 && !running ? (
        <p className={styles.foot}>
          Nothing was discarded: every file that did not land is still on this
          device, exactly as it was.
        </p>
      ) : null}
    </section>
  );
}
