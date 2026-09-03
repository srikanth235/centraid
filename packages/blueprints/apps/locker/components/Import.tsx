import type { ReactNode } from "react";

import { LOCKER_ENTITY, batchMeta, verdictOf } from "../import-model.ts";
import type { StagedBatch, StagedRow } from "../import-model.ts";
import {
  IMPORT_CHOOSE,
  IMPORT_DISCARD,
  IMPORT_DRAFTS,
  IMPORT_DRAFTS_META,
  IMPORT_FILE_NOTE,
  IMPORT_FILE_ROW,
  IMPORT_HEAD,
  IMPORT_LEDE,
  IMPORT_NO_DOOR,
  IMPORT_NO_DRAFTS,
  IMPORT_OFFLINE,
  IMPORT_OTHER_ENTITY,
  IMPORT_PUBLISH,
  IMPORT_PUBLISH_NOTE,
  IMPORT_PUBLISH_ROW,
  IMPORT_REVIEW_OPEN,
  IMPORT_ROWS,
  IMPORT_ROWS_META,
  IMPORT_VERDICTS_ROW,
} from "../route-copy.ts";
import { IMPORT_VERDICT, IMPORT_VERDICT_CHIP } from "../view-copy.ts";
import { FieldRow } from "./Fields.tsx";
import { Section } from "./Rows.tsx";

import styles from "./Rows.module.css";

export interface ImportScreenProps {
  hasDoor: boolean;
  offline: boolean;
  batches: readonly StagedBatch[] | null;
  rows: readonly StagedRow[] | null;
  openBatchId: string | null;
  note: string;
  onStage: (file: File) => void;
  onOpen: (batchId: string) => void;
  onPublish: (batchId: string) => void;
  onDiscard: (batchId: string) => void;
}

function Verdicts(): ReactNode {
  return (
    <FieldRow label={IMPORT_VERDICTS_ROW}>
      <span className={styles.verdictList}>
        {(
          [
            ["new", IMPORT_VERDICT.new],
            ["gapfill", IMPORT_VERDICT.gapfill],
            ["held", IMPORT_VERDICT.held],
          ] as ReadonlyArray<readonly [keyof typeof IMPORT_VERDICT, string]>
        ).map(([key, sentence]) => (
          <span key={key} className={styles.verdictLine}>
            <span
              className={styles.status}
              {...(key === "held" ? { "data-tone": "seam" } : {})}
            >
              {IMPORT_VERDICT_CHIP[key]}
            </span>
            <span className={styles.fieldNote}>{sentence}</span>
          </span>
        ))}
      </span>
    </FieldRow>
  );
}

export function ImportScreen(props: ImportScreenProps): ReactNode {
  const batches = props.batches ?? [];
  const rows = props.rows ?? [];

  return (
    <section className={styles.item}>
      <header className={styles.itemHead}>
        <h2 className={styles.screenTitle}>{IMPORT_HEAD}</h2>
        <p className={styles.lede}>{IMPORT_LEDE}</p>
      </header>

      {/* C1: no door, no control, and the fact in its place. */}
      {props.hasDoor ? (
        props.offline ? (
          <FieldRow label={IMPORT_FILE_ROW} note={IMPORT_OFFLINE} />
        ) : (
          <FieldRow label={IMPORT_FILE_ROW} note={IMPORT_FILE_NOTE}>
            <label className={styles.fieldValue}>
              <span className="kit-btn">{IMPORT_CHOOSE}</span>
              <input
                className="kit-sr-only"
                type="file"
                accept=".csv,text/csv"
                aria-label={IMPORT_CHOOSE}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) props.onStage(file);
                }}
              />
            </label>
          </FieldRow>
        )
      ) : (
        <FieldRow label={IMPORT_FILE_ROW} note={IMPORT_NO_DOOR} />
      )}

      <Verdicts />

      {props.note ? <p className={styles.fieldNote}>{props.note}</p> : null}

      {props.hasDoor && !props.offline ? (
        <>
          <Section
            label={IMPORT_DRAFTS}
            meta={IMPORT_DRAFTS_META}
            count={batches.length}
            loaded={props.batches !== null}
            empty={<p className={styles.fieldNote}>{IMPORT_NO_DRAFTS}</p>}
          >
            {batches.map((batch) => (
              <div key={batch.batchId} className={styles.rowWrap}>
                <div className={styles.row}>
                  <span className={styles.open}>
                    <span className={styles.title}>{batch.batchId}</span>
                    <span className={styles.meta}>{batchMeta(batch)}</span>
                  </span>
                  <button
                    type="button"
                    className="kit-btn quiet"
                    onClick={() => props.onOpen(batch.batchId)}
                  >
                    {IMPORT_REVIEW_OPEN}
                  </button>
                </div>
              </div>
            ))}
          </Section>

          {props.openBatchId ? (
            <>
              <Section
                label={IMPORT_ROWS}
                meta={IMPORT_ROWS_META}
                count={rows.length}
                loaded={props.rows !== null}
                empty={<p className={styles.fieldNote}>{IMPORT_NO_DRAFTS}</p>}
              >
                {rows.map((row) => {
                  const key = verdictOf(row.disposition);
                  return (
                    <div key={row.seq} className={styles.rowWrap}>
                      <div className={styles.row}>
                        <span className={styles.open}>
                          <span className={styles.title}>{row.externalId}</span>
                          <span className={styles.meta}>
                            {[
                              IMPORT_VERDICT[key],
                              row.entityType === LOCKER_ENTITY
                                ? null
                                : IMPORT_OTHER_ENTITY,
                              row.mapping,
                              row.note,
                            ]
                              .filter(Boolean)
                              .join("  ·  ")}
                          </span>
                        </span>
                        <span
                          className={styles.status}
                          {...(key === "held" ? { "data-tone": "seam" } : {})}
                        >
                          {IMPORT_VERDICT_CHIP[key]}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </Section>

              <FieldRow
                label={IMPORT_PUBLISH_ROW}
                note={IMPORT_PUBLISH_NOTE}
                acts={[
                  {
                    label: IMPORT_PUBLISH,
                    run: () => props.onPublish(props.openBatchId ?? ""),
                  },
                  {
                    label: IMPORT_DISCARD,
                    run: () => props.onDiscard(props.openBatchId ?? ""),
                  },
                ]}
              />
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
