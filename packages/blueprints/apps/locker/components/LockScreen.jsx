// The lock overlay — a self-contained, stateful leaf (its own useState for
// the passphrase draft; it never touches app.jsx's `state` directly, same
// pattern as tasks/notes' Capture/QuickAdd). Mounted only while
// `state.locked` is true, so its local state always starts fresh. Matches
// app.js's original: `unlock()` has no real passphrase check — clicking
// Unlock (or pressing Enter) always unlocks. Ported behavior, not a
// redesign.
import { useEffect, useRef, useState } from '../react-core.min.js';
import { Icon } from './Shared.jsx';

export function LockScreen({ onUnlock }) {
  const [value, setValue] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="v-lockscreen">
      <span className="v-lock-mark">
        <Icon name="lock" sw={1.7} size={30} stroke="#fff" />
      </span>
      <div style={{ textAlign: 'center' }}>
        <div className="v-lock-title">Locker is locked</div>
        <div className="v-lock-sub">Enter your passphrase to unlock</div>
      </div>
      <input
        ref={inputRef}
        className="v-lock-in"
        type="password"
        placeholder="••••••••"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onUnlock();
        }}
      />
      <button type="button" className="v-lock-btn" onClick={onUnlock}>
        Unlock
      </button>
    </div>
  );
}
