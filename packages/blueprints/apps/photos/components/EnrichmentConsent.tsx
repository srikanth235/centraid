// THE ENRICHMENT CONSENT SURFACE (v4 handoff §8, prototype `s==='enrich'`).
//
// Two panels, shown BEFORE anything runs, then the note. Panel A is the
// device: nothing leaves. Panel B is the gateway's cloud helper, bordered in
// `--net`, and it exists to say — in the mono fact register, flagged — that a
// downscaled copy of every photograph would leave this device.
//
// A PURE VIEW. It holds no state, reads nothing, and writes nothing: every
// answer leaves through a callback, so "can an enrichment write be issued
// without an explicit answer" is a question about this file's props, not about
// its internals. The gate itself lives in Enrichment.tsx.
//
// WHY BOTH PANELS ALWAYS RENDER. Panel B's action has no backend in this repo
// (see `ENRICHMENT_UNAVAILABLE.cloudUnavailable` in ../enrichment-copy.ts).
// The panel renders anyway, with its unavailability stated as a fact beside a
// visibly unavailable control, because a build that drops the panel drops the
// only place the product discloses that photographs can leave the device.
// Hiding a disclosure because its button is not wired is a privacy defect, not
// a tidy-up.
//
// ONE FILLED ELEMENT (§18): `Run on this device`. `Not now` is plain, and the
// cloud action is OUTLINED in `--net`/`--danger` — destructive and egress ink
// is never a fill.
import {
  CLOUD_PANEL,
  ENRICHMENT_NOTE,
  ON_DEVICE_PANEL,
  onDeviceTitle,
} from "../enrichment-consent.ts";
import type {
  AnswerAvailability,
  ConsentFact,
  ConsentPanelCopy,
} from "../enrichment-consent.ts";

import styles from "./EnrichmentConsent.module.css";

export interface EnrichmentConsentProps {
  /** How many photographs the question is about. `null` while the library
   *  count is unknown — the title then asks about "these photographs" rather
   *  than inventing a number. */
  count: number | null;
  onDevice: AnswerAvailability;
  cloud: AnswerAvailability;
  /** A write is in flight. Both answers go unavailable — an answered question
   *  is not re-answerable by a double click. */
  busy?: boolean;
  /** Set once the member has answered, so the surface stops offering the
   *  question it has already been given an answer to. */
  answered?: "device" | "declined" | null;
  onRunOnDevice: () => void;
  onDecline: () => void;
  /** Absent while no cloud helper can be chosen — see the header. */
  onChooseCloud?: () => void;
}

function Facts({ facts }: { facts: readonly ConsentFact[] }) {
  return (
    <dl className={styles.facts}>
      {facts.map((fact) => (
        <div
          key={fact.label}
          className={styles.fact}
          // The egress flag is data, not a colour decision made here: the
          // stylesheet gives the flagged row its `--net` rule.
          {...(fact.net ? { "data-net": "true" } : {})}
        >
          <dt className={styles.factLabel}>{fact.label}</dt>
          <dd className={styles.factValue}>{fact.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Panel({
  copy,
  title,
  children,
}: {
  copy: ConsentPanelCopy;
  /** The live title when the panel has one (the on-device count). */
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={styles.panel}
      {...(copy.net ? { "data-net": "true" } : {})}
      aria-label={title ?? copy.title}
    >
      <p className={styles.eyebrow}>{copy.eyebrow}</p>
      <h2 className={styles.title}>{title ?? copy.title}</h2>
      <p className={styles.body}>{copy.body}</p>
      <Facts facts={copy.facts} />
      {children}
    </section>
  );
}

export function EnrichmentConsent({
  count,
  onDevice,
  cloud,
  busy,
  answered,
  onRunOnDevice,
  onDecline,
  onChooseCloud,
}: EnrichmentConsentProps) {
  const deviceReady = onDevice.available && !busy && !answered;
  const cloudReady = cloud.available && !busy && !answered && !!onChooseCloud;
  return (
    <div className={styles.screen}>
      <Panel
        copy={ON_DEVICE_PANEL}
        title={count == null ? undefined : onDeviceTitle(count)}
      >
        {onDevice.reason ? (
          <p className={styles.unavailable}>{onDevice.reason}</p>
        ) : null}
        <div className={styles.actions}>
          <button
            type="button"
            className="kit-btn primary"
            disabled={!deviceReady}
            onClick={onRunOnDevice}
          >
            {ON_DEVICE_PANEL.action}
          </button>
          <button
            type="button"
            className="kit-btn"
            disabled={!!busy}
            onClick={onDecline}
          >
            {ON_DEVICE_PANEL.action2}
          </button>
        </div>
      </Panel>

      <Panel copy={CLOUD_PANEL}>
        {cloud.reason ? (
          <p className={styles.unavailable}>{cloud.reason}</p>
        ) : null}
        <div className={styles.actions}>
          {/* Outlined in `--net`, never filled, and never absent: a member who
              cannot take this option still has to be told what it would cost.
              `onClick` is the callback or nothing — a disabled control that
              carries a handler is one CSS regression away from firing. */}
          <button
            type="button"
            className="kit-btn destructive"
            disabled={!cloudReady}
            {...(cloudReady && onChooseCloud ? { onClick: onChooseCloud } : {})}
          >
            {CLOUD_PANEL.action}
          </button>
        </div>
      </Panel>

      <p className={styles.note}>{ENRICHMENT_NOTE}</p>
    </div>
  );
}
