import { type JSX, useEffect, useRef, useState } from 'react';
import { iconSvg } from '../iconSvg.js';
import spaceModalStyles from './SpaceModal.module.css';
import controlsCss from '../../styles/controls.module.css';
import { cx } from '../../ui/cx.js';

export interface RenameGatewayModalProps {
  initialLabel: string;
  onCancel: () => void;
  onCommit: (label: string) => void;
}

/** The switcher overflow menu's "Rename…" action (issue #382) — a single-field
 *  sibling of SpaceModal/ConnectFlowModal, reusing the same `.prof*` dialog
 *  chrome so every "small form in a modal" in this app looks identical. */
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
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(id);
      document.removeEventListener('keydown', onKey);
    };
  }, [onCancel]);

  const ready = label.trim().length > 0;
  const submit = (): void => {
    if (!ready) return;
    onCommit(label.trim());
  };

  return (
    <div className={spaceModalStyles.profOverlay}>
      <button
        type="button"
        className={spaceModalStyles.profScrim}
        aria-label="Close"
        tabIndex={-1}
        onClick={onCancel}
      />
      <div className={spaceModalStyles.profModal} role="dialog" aria-modal="true">
        <div className={spaceModalStyles.profModalHead}>
          <span
            className={spaceModalStyles.profModalHeadIcon}
            dangerouslySetInnerHTML={{ __html: iconSvg('Pencil', 14) }}
          />
          <h2 className={spaceModalStyles.profModalTitle}>Rename gateway</h2>
          <button
            type="button"
            className={cx(controlsCss.iconBtn, spaceModalStyles.profModalClose)}
            title="Close"
            aria-label="Close"
            onClick={onCancel}
            dangerouslySetInnerHTML={{ __html: iconSvg('X', 14) }}
          />
        </div>
        <div className={spaceModalStyles.profModalBody}>
          <label className={spaceModalStyles.profField}>
            <span className={spaceModalStyles.profFieldLabel}>Label</span>
            <input
              ref={ref}
              className={spaceModalStyles.profFieldInput}
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  submit();
                }
              }}
            />
          </label>
        </div>
        <div className={spaceModalStyles.profModalFoot}>
          <span style={{ flex: 1 }} />
          <button type="button" className={controlsCss.chip} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={spaceModalStyles.profModalSave}
            disabled={!ready}
            data-enabled={ready ? 'true' : 'false'}
            onClick={submit}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
