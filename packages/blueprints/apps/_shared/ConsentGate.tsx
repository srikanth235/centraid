// THE §8 CONSENT GATE — GENERIC TWO-PANEL RENDERER (#712 C1, web).
//
// Two panels, shown BEFORE anything runs, then the note.
// Panel A is the on-device/primary answer: the ONE filled element on the
// surface (§18). Panel B is bordered in `--net` and outlined, never filled —
// it exists to say what would leave the device, and it renders even when its
// own action cannot be taken from here (Photos' unwired cloud helper, Docs'
// automatic-only gateway backstop).
//
// A PURE VIEW. It holds no state, reads nothing, and writes nothing: every
// answer leaves through a callback, so "can a write be issued without an
// explicit answer" is a question about a caller's props, not about this
// file's internals.
import type {
  ConsentFact,
  ConsentGateProps,
  ConsentPanelCopy,
} from "./consent-gate.ts";

import styles from "./ConsentGate.module.css";

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
  /** A live title override (e.g. the on-device panel's count-based question). */
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

export function ConsentGate({
  domain,
  onDevicePanel,
  onDeviceTitle,
  onDevice,
  netPanel,
  net,
  note,
  busy,
  answered,
  onRunOnDevice,
  onDecline,
  onChooseNet,
}: ConsentGateProps) {
  const deviceReady = onDevice.available && !busy && !answered;
  const netReady = net.available && !busy && !answered && !!onChooseNet;
  return (
    <div className={styles.screen} data-domain={domain}>
      <Panel copy={onDevicePanel} title={onDeviceTitle}>
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
            {onDevicePanel.action}
          </button>
          {onDevicePanel.action2 ? (
            <button
              type="button"
              className="kit-btn"
              disabled={!!busy}
              onClick={onDecline}
            >
              {onDevicePanel.action2}
            </button>
          ) : null}
        </div>
      </Panel>

      <Panel copy={netPanel}>
        {net.reason ? <p className={styles.unavailable}>{net.reason}</p> : null}
        <div className={styles.actions}>
          {/* Outlined in `--net`/`--danger`, never filled, and never absent: a
              member who cannot take this option still has to be told what it
              would cost. `onClick` is the callback or nothing — a disabled
              control that carries a handler is one CSS regression away from
              firing. */}
          <button
            type="button"
            className={
              netPanel.dangerous ? "kit-btn destructive" : "kit-btn secondary"
            }
            disabled={!netReady}
            {...(netReady && onChooseNet ? { onClick: onChooseNet } : {})}
          >
            {netPanel.action}
          </button>
        </div>
      </Panel>

      <p className={styles.note}>{note}</p>
    </div>
  );
}
