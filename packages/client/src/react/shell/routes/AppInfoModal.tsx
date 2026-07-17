import { useEffect, useState, type JSX } from 'react';
import type { VaultBlockDTO } from '../../screen-contracts.js';
import VaultScreen from '../../screens/VaultScreen.js';
import { iconSvg } from '../iconSvg.js';
import { cx } from '../../ui/cx.js';
import buttonCss from '../../ui/Button.module.css';
import modalCss from '../../styles/modal.module.css';
import appSettingsCss from '../../styles/appSettings.module.css';
import styles from './AppInfoModal.module.css';
import { buildVaultProps, fetchAppManifestRaw, manifestVaultBlock } from './appSettingsData.js';

// App info (issue #434) — the installed-app "what can this touch" surface,
// reached from the Home / sidebar context menu. It reuses the existing per-app
// consent pane (VaultScreen + buildVaultProps, the same component AppView's
// gear popover mounts): requested access, live grants, revoke, and any parked
// invocations — all read from the app's live `app.json` vault block. Uninstall
// lives here too, so "review access → remove" is one surface.
export interface AppInfoModalProps {
  app: AppMetaResolvedType;
  /** The gateway app id (a bundled app's is its own id). */
  appId: string;
  onClose: () => void;
  onUninstall: () => void;
  showToast: (message: string) => void;
}

type BlockState =
  | { phase: 'loading' }
  | { phase: 'none' }
  | { phase: 'ready'; block: VaultBlockDTO };

export default function AppInfoModal({
  app,
  appId,
  onClose,
  onUninstall,
  showToast,
}: AppInfoModalProps): JSX.Element {
  const [state, setState] = useState<BlockState>({ phase: 'loading' });

  useEffect(() => {
    let alive = true;
    void fetchAppManifestRaw(appId).then((raw) => {
      if (!alive) return;
      const block = manifestVaultBlock(raw);
      setState(block ? { phase: 'ready', block } : { phase: 'none' });
    });
    return () => {
      alive = false;
    };
  }, [appId]);

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

  const finish = window.CentraidTokens.tileFinish(app.color, 'gradient');

  return (
    <>
      <div className={modalCss.backdrop} role="presentation" onClick={onClose} />
      <div className={cx(modalCss.card, styles.card)} role="dialog" aria-label={`${app.name} info`}>
        <button
          type="button"
          className={cx(buttonCss.icon, modalCss.close)}
          aria-label="Close"
          onClick={onClose}
          dangerouslySetInnerHTML={{ __html: iconSvg('X', 16, 1.7) }}
        />
        <div className={styles.head}>
          <span
            className={styles.headIcon}
            style={{
              background: finish.background,
              color: finish.glyphColor,
              boxShadow: finish.boxShadow || undefined,
            }}
            dangerouslySetInnerHTML={{ __html: iconSvg(app.iconKey || 'Sparkle', 20, 1.85) }}
          />
          <div style={{ minWidth: 0 }}>
            <div className={styles.eyebrow}>App info</div>
            <h3>{app.name}</h3>
          </div>
        </div>

        <div className={styles.body}>
          {state.phase === 'loading' ? (
            <div className={appSettingsCss.appSettingsNote}>Loading access…</div>
          ) : state.phase === 'none' ? (
            <div className={appSettingsCss.appSettingsNote}>
              This app requests no access to your vault.
            </div>
          ) : (
            <VaultScreen {...buildVaultProps(appId, state.block, { showToast })} />
          )}
        </div>

        <div className={modalCss.actions}>
          <button
            type="button"
            className={cx(buttonCss.btn, styles.uninstallBtn)}
            onClick={onUninstall}
          >
            Uninstall…
          </button>
          <button type="button" className={cx(buttonCss.btn, buttonCss.ghost)} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </>
  );
}
