// THE FOUR SURFACES THIS SEAT CAN DESCRIBE BUT NOT YET PERFORM.
//
// Import, Access history, Export and Companion are drawn AGAINST THE ASK: the
// flow is stated, each row carries the gap tag that names what is missing, and
// NOTHING OFFERS A CONTROL THAT WOULD DO NOTHING. That is the rule this file
// exists to hold — a disabled button teaches a member the app is broken; a
// stated reason teaches them what the app is waiting for.
//
// What is missing, precisely, and why each is drawn rather than built:
//
//   * IMPORT — the staging plane exists server-side (a password-manager CSV
//     parses, disposition and publish are the vault's), and the shell's app
//     client offers reads, writes and blob staging with NO door to it. A drop
//     control here would stage bytes into the CAS and never reach a draft.
//   * ACCESS HISTORY — every reveal, fill and refusal is receipted, and no
//     query serves those receipts to an app. Drawing five plausible rows would
//     be inventing an audit trail, which is the one thing an audit surface may
//     never do.
//   * EXPORT — no command writes the file, and nothing on this screen produces
//     plaintext client-side. The lede is the design; the commit is a stated
//     gap where the destructive button will go.
//   * COMPANION — it runs in the browser extension, beside the page. The
//     candidate and fill queries are the extension's, so this screen does not
//     dispatch them; it explains what Companion offers and, in §6's own words,
//     the three reasons a credential a member HAS was not offered.
import type { ReactNode } from "react";

import {
  ACCESS_HEAD,
  ACCESS_LEDE,
  ACCESS_NOT_SERVED,
  ACCESS_REGISTER,
  ACCESS_WHERE,
  EXPORT_COMMIT_NOTE,
  EXPORT_COMMIT_ROW,
  EXPORT_FORMAT_NOTE,
  EXPORT_FORMAT_ROW,
  EXPORT_FORMAT_VALUE,
  EXPORT_HEAD,
  EXPORT_LEDE_TAIL,
  EXPORT_WHAT_ROW,
  EXPORT_WHERE_NOTE,
  EXPORT_WHERE_ROW,
  EXPORT_WHERE_VALUE,
  FILL_GET,
  FILL_GET_ROW,
  FILL_HEAD,
  FILL_LEDE,
  FILL_NOT_OFFERED,
  FILL_NOT_OFFERED_META,
  FILL_OFFERS,
  FILL_OFFERS_ROW,
  FILL_WHERE,
  FILL_WHERE_ROW,
  IMPORT_FILE_NOTE,
  IMPORT_FILE_ROW,
  IMPORT_FILE_VALUE,
  IMPORT_HEAD,
  IMPORT_LEDE,
  IMPORT_PUBLISH_NOTE,
  IMPORT_PUBLISH_ROW,
  IMPORT_VERDICTS_ROW,
  exportWhat,
} from "../route-copy.ts";
import {
  EXPORT_LEDE,
  IMPORT_VERDICT,
  IMPORT_VERDICT_CHIP,
  NOT_OFFERED,
} from "../view-copy.ts";
import { FieldRow } from "./Fields.tsx";
import { Section } from "./Rows.tsx";

import styles from "./Rows.module.css";

/** The head every stated surface wears: a title and one sentence. `net` puts
 *  the lede in the leaves-the-device tone — a border and type, never a fill. */
function Head({
  title,
  lede,
  net,
}: {
  title: string;
  lede: string;
  net?: boolean;
}): ReactNode {
  return (
    <header className={styles.itemHead}>
      <h2 className={styles.screenTitle}>{title}</h2>
      <p className={net ? styles.ledeNet : styles.lede}>{lede}</p>
    </header>
  );
}

// ---------------------------------------------------------------------------

export function ImportScreen(): ReactNode {
  return (
    <section className={styles.item}>
      <Head title={IMPORT_HEAD} lede={IMPORT_LEDE} />

      {/* Drop / choose, inert and with the reason where the control would be.
          Not a disabled button: there is no door behind it to enable. */}
      <FieldRow
        label={IMPORT_FILE_ROW}
        value={IMPORT_FILE_VALUE}
        note={IMPORT_FILE_NOTE}
      />

      {/* The review step, as the three verdicts a row can wear. These are the
          server's own dispositions — `lockerItemPublisher.probe` matches a
          login by title and username and holds it — so the words here and the
          behaviour there are one thing said once. */}
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

      <FieldRow label={IMPORT_PUBLISH_ROW} note={IMPORT_PUBLISH_NOTE} />
    </section>
  );
}

// ---------------------------------------------------------------------------

export function AccessScreen(): ReactNode {
  return (
    <section className={styles.item}>
      <Head title={ACCESS_HEAD} lede={ACCESS_LEDE} />

      <dl className={styles.facts}>
        {ACCESS_REGISTER.map(([kind, holds]) => (
          <div key={kind} className={styles.fact}>
            <dt className={styles.factKey}>{kind}</dt>
            <dd className={styles.factValue}>{holds}</dd>
          </div>
        ))}
      </dl>

      {/* The one honest line. The receipts exist; this screen has no read. */}
      <p className={styles.fieldNote}>{ACCESS_NOT_SERVED}</p>
      <p className={styles.fieldNote}>{ACCESS_WHERE}</p>
    </section>
  );
}

// ---------------------------------------------------------------------------

export function ExportScreen({ items }: { items: number }): ReactNode {
  return (
    <section className={styles.item}>
      <Head
        title={EXPORT_HEAD}
        lede={`${EXPORT_LEDE} ${EXPORT_LEDE_TAIL}`}
        net
      />

      <FieldRow label={EXPORT_WHAT_ROW} value={exportWhat(items)} numeric />
      <FieldRow
        label={EXPORT_FORMAT_ROW}
        value={EXPORT_FORMAT_VALUE}
        note={EXPORT_FORMAT_NOTE}
      />
      <FieldRow
        label={EXPORT_WHERE_ROW}
        value={EXPORT_WHERE_VALUE}
        note={EXPORT_WHERE_NOTE}
      />
      {/* Where the destructive commit goes — outlined in `--net`, confirmed,
          and naming the consequence. It is a row and not a button because no
          command writes the file: nothing here produces plaintext. */}
      <FieldRow label={EXPORT_COMMIT_ROW} note={EXPORT_COMMIT_NOTE} />
    </section>
  );
}

// ---------------------------------------------------------------------------

export function FillScreen(): ReactNode {
  const reasons: ReadonlyArray<readonly [string, string]> = [
    ["policy", NOT_OFFERED.policy],
    ["http", NOT_OFFERED.http],
    ["nomatch", NOT_OFFERED.nomatch],
  ];
  return (
    <section className={styles.item}>
      <Head title={FILL_HEAD} lede={FILL_LEDE} />

      <FieldRow label={FILL_WHERE_ROW} note={FILL_WHERE} />
      <FieldRow label={FILL_GET_ROW} note={FILL_GET} />
      <FieldRow label={FILL_OFFERS_ROW} note={FILL_OFFERS} />

      <Section
        label={FILL_NOT_OFFERED}
        meta={FILL_NOT_OFFERED_META}
        count={reasons.length}
      >
        {reasons.map(([key, sentence]) => (
          <div key={key} className={styles.rowWrap}>
            <div className={styles.row}>
              <span className={styles.checkWhy}>{sentence}</span>
            </div>
          </div>
        ))}
      </Section>
    </section>
  );
}
