import { type JSX, useEffect } from 'react';
import { iconSvg } from '../iconSvg.js';
// Reuses SpaceModal's overlay/scrim/head/foot chrome verbatim (issue #376) —
// same dialog shape as the Spaces "New profile" modal, just a different body.
// Keeps the two "Add X" modals in Settings pixel-identical without a second
// copy of ~140 lines of overlay/backdrop/pop-animation CSS.
import spaceModalStyles from './SpaceModal.module.css';
import controlsCss from '../../styles/controls.module.css';
import { cx } from '../../ui/cx.js';
import GatewayPairingForm from './GatewayPairingForm.js';
import type { GatewayConnectSuccess } from './gatewayModals.js';

export interface GatewayModalProps {
  onCancel: () => void;
  onConnected: (result: GatewayConnectSuccess) => void;
}

/** Settings → Connections "Add gateway" modal (issue #376). All the gateway
 *  I/O + the ticket-form lifecycle live in GatewayPairingForm /
 *  gatewayModals.ts — this is just the dialog chrome around it. */
export default function GatewayModal({ onCancel, onConnected }: GatewayModalProps): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

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
            dangerouslySetInnerHTML={{ __html: iconSvg('Plug', 14) }}
          />
          <h2 className={spaceModalStyles.profModalTitle}>Add gateway</h2>
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
          <div className={controlsCss.note}>
            Connect to a gateway running elsewhere — paste the pairing ticket from{' '}
            <code>centraid-gateway pair --vault &lt;name&gt;</code> on that machine.
          </div>
          <GatewayPairingForm onCancel={onCancel} onConnected={onConnected} />
        </div>
      </div>
    </div>
  );
}
