// The lock overlay — a self-contained, stateful leaf (its own useState for
// the passphrase draft; it never touches app.tsx's `state` directly, same
// pattern as tasks/notes' Capture/QuickAdd). Mounted only while
// `state.locked` is true, so its local state always starts fresh. Matches
// app.js's original: `unlock()` has no real passphrase check — clicking
// Unlock (or pressing Enter) always unlocks. Ported behavior, not a
// redesign.
import { useEffect, useRef, useState } from '../react-core.min.js';
import { Icon } from './Shared.tsx';
import styles from './LockScreen.module.css';

export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className={styles.lockscreen}>
      <span className={styles.lockMark}>
        <Icon name="lock" sw={1.7} size={30} stroke="#fff" />
      </span>
      <div style={{ textAlign: 'center' }}>
        <div className={styles.lockTitle}>Locker is locked</div>
        <div className={styles.lockSub}>Enter your passphrase to unlock</div>
      </div>
      <input
        ref={inputRef}
        className={styles.lockIn}
        type="password"
        placeholder="••••••••"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onUnlock();
        }}
      />
      <button type="button" className={styles.lockBtn} onClick={onUnlock}>
        Unlock
      </button>
    </div>
  );
}
