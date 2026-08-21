import { useId } from "react";
import type { JSX } from "react";

import type { StorageMetrics } from "../../storage-metrics.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";
import type { BackupStatusDTO } from "./BackupCard.js";

import buttonCss from "../ui/Button.module.css";
import styles from "./BackupCard.module.css";

// The three pillars the brief asks for (issue #708 A2, docs/design/handoff-
// binding-layer/README.md "Backup"): what is copied, how it is protected,
// and what is held back — plus the Restore control, wrapped in its own card
// and headed exactly as the brief has it, OUTLINED destructive and on the
// primary surface rather than buried in Diagnostics.

function WhatIsCopiedCard(): JSX.Element {
  return (
    <div className={styles.copyCard}>
      <h3>What is copied</h3>
      <p>
        Every store, in full — Photos, Docs, Calendar, People, Tasks, Files,
        Chat, and each app’s own store.
      </p>
      <ul className={styles.copyCardList}>
        <li>Every database — every app’s data, in full</li>
        <li>Your code — apps, automations, and their history</li>
        <li>Attachments — photos, documents, every file you’ve added</li>
      </ul>
    </div>
  );
}

function HowItIsProtectedCard({
  privacy,
  provider,
  vaultCount,
}: {
  privacy: StorageMetrics["privacy"];
  provider: string | undefined;
  vaultCount: number;
}): JSX.Element {
  return (
    <div className={styles.copyCard}>
      <h3>How it is protected</h3>
      <p>
        Encrypted with a key derived on this device. A backup disk on its own
        reveals nothing.
      </p>
      <dl className={styles.copyCardFacts}>
        <div>
          <dt>Sealed bytes</dt>
          <dd>{privacy.sealedBytes ? "Always" : "—"}</dd>
        </div>
        <div>
          <dt>Key custody</dt>
          <dd>{privacy.keyCustody === "client-only" ? "You only" : "—"}</dd>
        </div>
        <div>
          <dt>Where</dt>
          <dd>{provider ?? "Not configured"}</dd>
        </div>
      </dl>
      <p className={styles.copyCardMeta}>
        {vaultCount} vault{vaultCount === 1 ? "" : "s"} on this gateway
      </p>
    </div>
  );
}

function WhatIsHeldBackCard(): JSX.Element {
  return (
    <div className={styles.copyCard}>
      <h3>What is held back</h3>
      <p className={styles.copyCardEmphasis}>
        Nothing. A partial backup would be a promise Centraid could not keep.
      </p>
    </div>
  );
}

export default function BackupCopyCards({
  status,
  metrics,
  onRestore,
  readOnly,
}: {
  status: BackupStatusDTO;
  metrics: StorageMetrics;
  /** Absent until a client-side restore flow exists — the button still
   *  renders (never buried), disabled, with an honest reason. */
  onRestore?: () => void;
  readOnly?: boolean;
}): JSX.Element {
  const restoreReasonId = useId();
  return (
    <div className={styles.copyCardsWrap}>
      <div className={styles.copyCards}>
        <WhatIsCopiedCard />
        <HowItIsProtectedCard
          privacy={metrics.privacy}
          provider={status.provider}
          vaultCount={status.vaults.length}
        />
        <WhatIsHeldBackCard />
      </div>
      {readOnly ? null : (
        <div className={cx(styles.copyCard, styles.restoreCard)}>
          <h3>Restore from a backup</h3>
          <p className={styles.restoreNote}>
            Restoring replaces everything on this device with the contents of a
            backup. Centraid shows what is in it, and when it was made, before
            anything is written.
          </p>
          <button
            type="button"
            className={cx(
              buttonCss.btn,
              buttonCss.destructive,
              styles.restoreBtn
            )}
            disabled={!onRestore}
            onClick={onRestore}
            aria-describedby={onRestore ? undefined : restoreReasonId}
          >
            <Icon name="History" size={14} />
            <span>Restore from backup</span>
          </button>
          {onRestore ? null : (
            <p className={styles.restoreSeamNote} id={restoreReasonId}>
              Restoring from an offsite copy is a gateway-side act today — see
              the recovery runbook.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
