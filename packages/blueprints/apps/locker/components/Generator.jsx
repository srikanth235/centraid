// The password generator modal — kit-owned overlay markup (`.kit-modal-back`
// / `.kit-modal`). Its length/symbols/numbers/value live in app.jsx's module
// state (not local component state) because they must survive being reopened
// from a different field mid-edit, and "Use" needs to push the generated
// value back into whichever field opened it — see logic.js's
// `openGenerator`/`closeGen`.
import { strength } from '../totp.js';
import { Icon } from './Shared.jsx';

function ToggleRow({ label, on, onClick, last = false }) {
  return (
    <div className="v-toggle-row" style={last ? { borderBottom: 'none' } : undefined}>
      <span style={{ font: 'var(--t-body)', fontSize: '13.5px' }}>{label}</span>
      <button type="button" className={on ? 'v-switch on' : 'v-switch'} onClick={onClick}>
        <i></i>
      </button>
    </div>
  );
}

export function Generator({
  genLen,
  genNum,
  genSym,
  genValue,
  onRegen,
  onSetLen,
  onToggleNum,
  onToggleSym,
  onClose,
  onUse,
}) {
  const st = strength(genValue);
  return (
    <div
      className="kit-modal-back"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="kit-modal" style={{ maxWidth: '420px' }} onClick={(e) => e.stopPropagation()}>
        <h2>Password generator</h2>

        <div className="v-genrow">
          <div className="v-genout">{genValue}</div>
          <button type="button" className="v-iconbtn" aria-label="Regenerate" onClick={onRegen}>
            <Icon name="regen" />
          </button>
        </div>

        <div className="v-strength">
          <kit-meter ratio={st.ratio} tone={st.tone}></kit-meter>
          <span style={{ font: 'var(--t-mono)', fontSize: '10px', color: st.color }}>
            {st.label}
          </span>
        </div>

        <div className="v-field-lg">
          <div className="v-flabel">Length · {genLen}</div>
          <input
            type="range"
            className="v-slider"
            min="8"
            max="40"
            value={genLen}
            onChange={(e) => onSetLen(parseInt(e.target.value, 10))}
          />
        </div>

        <ToggleRow label="Numbers" on={genNum} onClick={onToggleNum} />
        <ToggleRow label="Symbols" on={genSym} onClick={onToggleSym} last />

        <div className="kit-modal-foot">
          <button type="button" className="kit-btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="kit-btn primary" onClick={onUse}>
            Copy
          </button>
        </div>
      </div>
    </div>
  );
}
