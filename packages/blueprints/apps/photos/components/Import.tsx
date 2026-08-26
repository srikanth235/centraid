// Progress belongs to the frame's one status line (§14) — never add a second
// progress surface. No panel action beyond dismiss: an arbitrary set of asset
// ids has no shelf here (every shelf is the timeline under a filter).
import styles from "./Import.module.css";

export interface ImportResult {
  added: number;
  deduped: number;
  restored: number;
}

/** `media.add_asset` answers `deduped: 1` for both cases, so `wasTrashed` must
 *  be asked against a snapshot taken BEFORE the run. An unvouched id counts as
 *  a plain dedupe: under-reporting restores is the only allowed error. */
export function tallyDedupes(
  dedupedAssetIds: readonly string[],
  wasTrashed: (assetId: string) => boolean
): { deduped: number; restored: number } {
  let deduped = 0;
  let restored = 0;
  for (const assetId of dedupedAssetIds) {
    if (assetId && wasTrashed(assetId)) restored += 1;
    else deduped += 1;
  }
  return { deduped, restored };
}

/** No line prints the storage noun for a place (#599). */
const IMPORT_COPY = {
  dedupedEyebrow: "Deduped",
  dedupedTitle: (n: number) =>
    n === 1 ? "1 of these was already here" : `${n} of these were already here`,
  dedupedBody:
    "Identical bytes become one photograph — these point at photographs already in your library.",
  dedupedHappened: (n: number) =>
    `${n} ${n === 1 ? "file" : "files"} matched photographs already here`,
  restoredEyebrow: "Restored",
  restoredTitle: (n: number) =>
    n === 1 ? "1 of these you had deleted" : `${n} of these you had deleted`,
  restoredBody:
    "These were in your trash — the same bytes brought them back out, on the day they were taken.",
  restoredHappened: (n: number) =>
    `${n} ${n === 1 ? "file" : "files"} matched something in the trash`,
  changedLabel: "what changed",
  changedNothing: "nothing",
  changedRestored: "they are in the timeline again, not in the trash",
  happenedLabel: "what happened",
  whereLabel: "where they are",
  whereDeduped: "in the timeline, on their original dates",
  dismiss: "Dismiss",
} as const;

function Panel({
  eyebrow,
  title,
  body,
  facts,
}: {
  eyebrow: string;
  title: string;
  body: string;
  facts: readonly { label: string; value: string }[];
}) {
  return (
    <section className={styles.panel}>
      <p className={styles.eyebrow}>{eyebrow}</p>
      <h3 className={styles.title}>{title}</h3>
      <p className={styles.body}>{body}</p>
      <dl className={styles.facts}>
        {facts.map((fact) => (
          <div key={fact.label} className={styles.fact}>
            <dt className={styles.factLabel}>{fact.label}</dt>
            <dd className={styles.factValue}>{fact.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ImportPanels({
  result,
  onDismiss,
}: {
  result: ImportResult;
  onDismiss: () => void;
}) {
  return (
    <div className={styles.panels}>
      {result.restored > 0 ? (
        <Panel
          eyebrow={IMPORT_COPY.restoredEyebrow}
          title={IMPORT_COPY.restoredTitle(result.restored)}
          body={IMPORT_COPY.restoredBody}
          facts={[
            {
              label: IMPORT_COPY.happenedLabel,
              value: IMPORT_COPY.restoredHappened(result.restored),
            },
            {
              label: IMPORT_COPY.changedLabel,
              value: IMPORT_COPY.changedRestored,
            },
          ]}
        />
      ) : null}
      {result.deduped > 0 ? (
        <Panel
          eyebrow={IMPORT_COPY.dedupedEyebrow}
          title={IMPORT_COPY.dedupedTitle(result.deduped)}
          body={IMPORT_COPY.dedupedBody}
          facts={[
            {
              label: IMPORT_COPY.happenedLabel,
              value: IMPORT_COPY.dedupedHappened(result.deduped),
            },
            {
              label: IMPORT_COPY.changedLabel,
              value: IMPORT_COPY.changedNothing,
            },
            {
              label: IMPORT_COPY.whereLabel,
              value: IMPORT_COPY.whereDeduped,
            },
          ]}
        />
      ) : null}
      <button type="button" className="kit-btn" onClick={onDismiss}>
        {IMPORT_COPY.dismiss}
      </button>
    </div>
  );
}
