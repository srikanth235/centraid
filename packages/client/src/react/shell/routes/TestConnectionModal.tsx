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
import vaultModalStyles from "./VaultModal.module.css";

export interface TestConnectionModalProps {
  gatewayId: string;
  gatewayLabel: string;
  onClose: () => void;
}

/** The switcher overflow menu's "Test connection…" action (#382) — the
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
    <div className={vaultModalStyles.profOverlay}>
      <button
        type="button"
        className={vaultModalStyles.profScrim}
        aria-label="Close"
        tabIndex={-1}
        onClick={onClose}
      />
      <dialog open className={vaultModalStyles.profModal} aria-modal="true">
        <div className={vaultModalStyles.profModalHead}>
          <span
            className={vaultModalStyles.profModalHeadIcon}
            // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
            dangerouslySetInnerHTML={{ __html: iconSvg("Wifi", 14) }}
          />
          <h2 className={vaultModalStyles.profModalTitle}>
            Test connection · {gatewayLabel}
          </h2>
          <button
            type="button"
            className={cx(controlsCss.iconBtn, vaultModalStyles.profModalClose)}
            title="Close"
            aria-label="Close"
            onClick={onClose}
            // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
            dangerouslySetInnerHTML={{ __html: iconSvg("X", 14) }}
          />
        </div>
        <div className={vaultModalStyles.profModalBody}>
          <HandshakeLadder stages={report?.stages ?? []} pending={pending} />
          {report ? (
            <div className={connectFlowStyles.testSummary} data-ok={report.ok}>
              {reportSummaryText(report)}
            </div>
          ) : null}
        </div>
        <div className={vaultModalStyles.profModalFoot}>
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
