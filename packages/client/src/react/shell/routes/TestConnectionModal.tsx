import { type JSX, useEffect, useState } from 'react';
import { iconSvg } from '../iconSvg.js';
import spaceModalStyles from './SpaceModal.module.css';
import connectFlowStyles from './ConnectFlow.module.css';
import controlsCss from '../../styles/controls.module.css';
import buttonCss from '../../ui/Button.module.css';
import { cx } from '../../ui/cx.js';
import HandshakeLadder, { reportSummaryText } from './HandshakeLadder.js';
import { runConnectivityTest } from './connectFlowIO.js';
import type { ConnectivityReport } from './connectFlow-core.js';

export interface TestConnectionModalProps {
  gatewayId: string;
  gatewayLabel: string;
  onClose: () => void;
}

/** The switcher overflow menu's "Test connection…" action (issue #382) — the
 *  same handshake-ladder moment ConnectFlow's test step uses, run standalone
 *  against an already-registered gateway (`{kind:'gateway', gatewayId}`). */
export default function TestConnectionModal({
  gatewayId,
  gatewayLabel,
  onClose,
}: TestConnectionModalProps): JSX.Element {
  const [report, setReport] = useState<ConnectivityReport | null>(null);
  const [pending, setPending] = useState(true);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setPending(true);
    setReport(null);
    void runConnectivityTest({ gatewayId, kind: 'gateway' }).then((r) => {
      if (alive) {
        setReport(r);
        setPending(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [gatewayId, attempt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className={spaceModalStyles.profOverlay}>
      <button
        type="button"
        className={spaceModalStyles.profScrim}
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
      />
      <div className={spaceModalStyles.profModal} role="dialog" aria-modal="true">
        <div className={spaceModalStyles.profModalHead}>
          <span
            className={spaceModalStyles.profModalHeadIcon}
            dangerouslySetInnerHTML={{ __html: iconSvg('Wifi', 14) }}
          />
          <h2 className={spaceModalStyles.profModalTitle}>Test connection · {gatewayLabel}</h2>
          <button
            type="button"
            className={cx(controlsCss.iconBtn, spaceModalStyles.profModalClose)}
            title="Close"
            aria-label="Close"
            onClick={onClose}
            dangerouslySetInnerHTML={{ __html: iconSvg('X', 14) }}
          />
        </div>
        <div className={spaceModalStyles.profModalBody}>
          <HandshakeLadder stages={report?.stages ?? []} pending={pending} />
          {report ? (
            <div className={connectFlowStyles.testSummary} data-ok={report.ok}>
              {reportSummaryText(report)}
            </div>
          ) : null}
        </div>
        <div className={spaceModalStyles.profModalFoot}>
          <span style={{ flex: 1 }} />
          <button type="button" className={controlsCss.chip} onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className={cx(buttonCss.btn, buttonCss.primary, buttonCss.sm)}
            disabled={pending}
            onClick={() => setAttempt((n) => n + 1)}
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}
