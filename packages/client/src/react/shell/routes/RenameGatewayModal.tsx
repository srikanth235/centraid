import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import { cx } from "../../ui/cx.js";
import ShellModal from "../../ui/ShellModal.js";
import { iconSvg } from "../iconSvg.js";

import controlsCss from "../../styles/controls.module.css";
import vaultModalStyles from "./VaultModal.module.css";

export interface RenameGatewayModalProps {
  initialLabel: string;
  onCancel: () => void;
  onCommit: (label: string) => void;
}

export default function RenameGatewayModal({
  initialLabel,
  onCancel,
  onCommit,
}: RenameGatewayModalProps): JSX.Element {
  const [label, setLabel] = useState(initialLabel);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.select();
    });
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener("keydown", onKey);
    };
  }, [onCancel]);

  const ready = label.trim().length > 0;
  const submit = (): void => {
    if (!ready) return;
    onCommit(label.trim());
  };

  return (
    <div className={vaultModalStyles.profOverlay}>
      <button
        type="button"
        className={vaultModalStyles.profScrim}
        aria-label="Close"
        tabIndex={-1}
        onClick={onCancel}
      />
      <ShellModal
        layer="inline"
        className={vaultModalStyles.profModal}
        ariaModal
      >
        <div className={vaultModalStyles.profModalHead}>
          <span
            className={vaultModalStyles.profModalHeadIcon}
            // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
            dangerouslySetInnerHTML={{ __html: iconSvg("Pencil", 14) }}
          />
          <h2 className={vaultModalStyles.profModalTitle}>Rename gateway</h2>
          <button
            type="button"
            className={cx(controlsCss.iconBtn, vaultModalStyles.profModalClose)}
            title="Close"
            aria-label="Close"
            onClick={onCancel}
            // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
            dangerouslySetInnerHTML={{ __html: iconSvg("X", 14) }}
          />
        </div>
        <div className={vaultModalStyles.profModalBody}>
          <label className={vaultModalStyles.profField}>
            <span className={vaultModalStyles.profFieldLabel}>Label</span>
            <input
              ref={ref}
              className={vaultModalStyles.profFieldInput}
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </label>
        </div>
        <div className={vaultModalStyles.profModalFoot}>
          <span style={{ flex: 1 }} />
          <button type="button" className={controlsCss.chip} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={vaultModalStyles.profModalSave}
            disabled={!ready}
            data-enabled={ready ? "true" : "false"}
            onClick={submit}
          >
            Save
          </button>
        </div>
      </ShellModal>
    </div>
  );
}
