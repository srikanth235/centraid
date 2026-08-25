// The two import outcomes worth explaining (v4 handoff §11, proto 4378-4400).
//
// WHAT THIS IS AND IS NOT. The prototype's Import screen has four parts: the
// three ways in, the running panel, and two panels that are "read after the
// fact" — Deduped and Restored. Three of those four already exist in this app
// and are deliberately NOT redrawn here:
//
//   * the three ways in are the app bar's Import, the page-wide drop target
//     and (on the phone) the camera, all wired at boot in upload.ts;
//   * the running panel is the FRAME's one status line, determinate and with
//     exact counts (§14). A second progress surface is the thing §14 exists to
//     forbid, so `runUpload` still narrates `Importing 41 of 96…` there.
//
// What was missing is the pair below, and they are the reason `runUpload` now
// returns an `ImportResult` at all: a member who chose 96 files and got 91 has
// a question, and "4 were already here, 1 came back from the trash" is the
// answer. Both numbers are counted off the run's own command outputs — see
// `tallyDedupes` in upload.ts for how "already here" and "restored" are told
// apart, and why the split can only under-report restores, never invent one.
//
// NO ACTION ON EITHER PANEL. The prototype offers `Show the four` and `Show
// it` / `Trash it again`. Showing an arbitrary set of asset ids needs a view
// this app has no shelf for — every shelf is the timeline under a filter, and
// "the ids from the last import" is not one of them — so rather than ship a
// control that does nothing, the panels carry the one control that IS backed:
// dismissing them. The gap is reported rather than stubbed.
import styles from "./Import.module.css";

/**
 * What one completed import actually did (proto 4378-4400).
 *
 * Every field is a COUNT OF FILES the run observed, never a projection. The
 * shape and the split below live beside the view that explains them — the same
 * arrangement components/Storage.tsx uses for `storageFacts` and
 * components/Places.tsx for `placeSections` — rather than in upload.ts, whose
 * own module graph reaches the DOM and the media decoders.
 */
export interface ImportResult {
  /** Files that minted a NEW photograph. A dedupe added nothing, so it is
   *  counted below instead of here. */
  added: number;
  /** Files whose bytes were already a live photograph in the library. */
  deduped: number;
  /** Files whose bytes matched something this device had in the trash. */
  restored: number;
}

/**
 * Split a run's dedupes into "already here" and "restored".
 *
 * `media.add_asset` answers `deduped: 1` for BOTH cases — it clears
 * `deleted_at` and returns the same shape either way (packages/vault
 * src/commands/media.ts) — so the command output alone cannot tell them apart.
 * What CAN is what the caller knew a moment ago: an asset the trash held
 * before the run, that these bytes have just brought back, was restored.
 * `wasTrashed` is therefore asked against a snapshot taken BEFORE the run;
 * afterwards the row is live again and the evidence is gone.
 *
 * An id the caller cannot vouch for counts as an ordinary dedupe. This
 * under-reports restores rather than inventing them, which is the only
 * direction it is allowed to err in.
 */
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

/**
 * Final copy. It lives here rather than in view-copy.ts because these are the
 * only strings the panels say and nothing else reads them; the prototype's own
 * words throughout, except that no line prints the storage noun for a place
 * (#599 — a member reads a scope's label, never what holds it).
 */
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

/** One panel: the prototype's `panelBlock(eyebrow, title, body, facts)`. */
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

/**
 * The head of the timeline after an import that had something to explain. The
 * caller draws it only while `deduped + restored > 0` (app-root.tsx): a run
 * where every file was new explained itself on the status line and has no
 * second surface, which is why there is no "Imported N" panel here.
 */
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
