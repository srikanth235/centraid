import { useEffect, useState } from "react";
import type { JSX } from "react";

import { cx } from "../../ui/cx.js";
import { iconSvg } from "../iconSvg.js";
import type { ConnectivityReport } from "./connectFlow-core.js";
import { runConnectivityTest } from "./connectFlowIO.js";
import HandshakeLadder, { reportSummaryText } from "./HandshakeLadder.js";

import controlsCss from "../../styles/controls.module.css";
import buttonCss from "../../ui/Button.module.css";
import connectFlowStyles from "./ConnectFlow.module.css";
import spaceModalStyles from "./SpaceModal.module.css";

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
  const [attempt, setAttempt] = useState(0);
  // The report is stamped with the (gateway, attempt) that produced it, so a
  // retry reads as pending during render rather than needing the effect to
  // clear the previous report first.
  const [settled, setSettled] = useState<{
    key: string;
    report: ConnectivityReport;
  } | null>(null);
  const key = `${gatewayId} ${attempt}`;
  const report =
    settled !== null && settled.key === key ? settled.report : null;
  const pending = report === null;

  useEffect(() => {
    let alive = true;
    void runConnectivityTest({ gatewayId, kind: "gateway" }).then((r) => {
      if (alive) setSettled({ key, report: r });
    });
    return () => {
      alive = false;
    };
  }, [gatewayId, key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
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
      <dialog open className={spaceModalStyles.profModal} aria-modal="true">
        <div className={spaceModalStyles.profModalHead}>
          <span
            className={spaceModalStyles.profModalHeadIcon}
            dangerouslySetInnerHTML={{ __html: iconSvg("Wifi", 14) }}
          />
          <h2 className={spaceModalStyles.profModalTitle}>
            Test connection · {gatewayLabel}
          </h2>
          <button
            type="button"
            className={cx(controlsCss.iconBtn, spaceModalStyles.profModalClose)}
            title="Close"
            aria-label="Close"
            onClick={onClose}
            dangerouslySetInnerHTML={{ __html: iconSvg("X", 14) }}
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
      </dialog>
    </div>
  );
}
