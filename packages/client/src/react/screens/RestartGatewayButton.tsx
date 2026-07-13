import { useState, type JSX } from 'react';
import Icon from '../ui/Icon.js';
import { cx } from '../ui/cx.js';
import buttonCss from '../ui/Button.module.css';
import controlsCss from '../styles/controls.module.css';
import styles from './GatewayScreen.module.css';

/**
 * "Restart gateway" (issue #351 wave 2) — serialized stop→start on the
 * local embedded gateway; a remote gateway answers {ok:false} with an
 * explanation rendered inline. Split out of GatewayScreen.tsx to keep the
 * screen under the repo-hygiene 500-line cap.
 */
export default function RestartGatewayButton({
  onRestart,
}: {
  onRestart: () => Promise<{ ok: boolean; error?: string }>;
}): JSX.Element {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const restart = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      const result = await onRestart();
      if (!result.ok) setError(result.error ?? 'Restart was refused.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={styles.restartWrap}>
      <button
        type="button"
        className={cx(buttonCss.btn, buttonCss.sm, controlsCss.soft)}
        disabled={pending}
        onClick={() => void restart()}
      >
        <span className={styles.restartIcon} data-spin={pending || undefined}>
          <Icon name={pending ? 'Loader' : 'Power'} size={13} />
        </span>
        <span>{pending ? 'Restarting…' : 'Restart gateway'}</span>
      </button>
      {error ? <div className={styles.restartError}>{error}</div> : null}
    </div>
  );
}
