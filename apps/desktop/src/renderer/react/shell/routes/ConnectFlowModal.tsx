import { type JSX, useEffect } from 'react';
import { iconSvg } from '../iconSvg.js';
// Reuses SpaceModal's overlay/scrim/head/foot chrome verbatim, same
// precedent the retired GatewayModal.tsx set (issue #376) for the "Add X"
// dialog family — one implementation of the overlay/backdrop/pop-animation
// CSS shared by every "Add ___" modal in Settings/the switcher.
import spaceModalStyles from './SpaceModal.module.css';
import controlsCss from '../../styles/controls.module.css';
import { cx } from '../../ui/cx.js';
import ConnectFlow, { type ConnectFlowProps } from './ConnectFlow.js';

export interface ConnectFlowModalProps extends Omit<ConnectFlowProps, 'onCancel'> {
  onCancel: () => void;
}

/** The switcher's "Add gateway…" modal (issue #382) — dialog chrome around
 *  the shared ConnectFlow wizard, offering "Existing gateway" and "Over SSH"
 *  only ('local' is always already registered, so re-offering it here would
 *  be a dead end rather than a new connection). */
export default function ConnectFlowModal({
  methods = ['gateway', 'ssh'],
  onCancel,
  onDone,
  context,
}: ConnectFlowModalProps): JSX.Element {
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
          <ConnectFlow context={context} methods={methods} onDone={onDone} />
        </div>
      </div>
    </div>
  );
}
