import { Meter } from "../../_shared/Meter.tsx";
// The password generator modal — kit-owned overlay markup (`.kit-modal-back`
// / `.kit-modal`). Its length/symbols/numbers/value live in app.tsx's module
// state (not local component state) because they must survive being reopened
// from a different field mid-edit, and "Use" needs to push the generated
// value back into whichever field opened it — see logic.ts's
// `openGenerator`/`closeGen`.
import { strength } from "../totp.ts";
import { Icon } from "./Shared.tsx";

import styles from "./Generator.module.css";
import shared from "./shared.module.css";

function ToggleRow({
  label,
  on,
  onClick,
  last = false,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  last?: boolean;
}) {
  return (
    <div
      className={styles.toggleRow}
      style={last ? { borderBottom: "none" } : undefined}
    >
      <span style={{ font: "var(--t-body)", fontSize: "13.5px" }}>{label}</span>
      {/* The switch draws nothing but its knob, so the visible row label is
          also its accessible name; `aria-pressed` reports the on/off state the
          `.on` class draws (issue #573). */}
      <button
        type="button"
        className={on ? `${styles.switch} ${styles.on}` : styles.switch}
        aria-label={label}
        aria-pressed={on}
        onClick={onClick}
      >
        <i />
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
}: {
  genLen: number;
  genNum: boolean;
  genSym: boolean;
  genValue: string;
  onRegen: () => void;
  onSetLen: (n: number) => void;
  onToggleNum: () => void;
  onToggleSym: () => void;
  onClose: () => void;
  onUse: () => void;
}) {
  const st = strength(genValue);
  return (
    <div className="kit-modal-back">
      {/* Dismiss-on-outside-click: a real "Close" button laid under the card
          (`.kit-modal` is `position: relative`) instead of a click handler on
          the backdrop that only a mouse could reach. It replaces both the
          `e.target === e.currentTarget` guard and the card's stopPropagation —
          clicks inside the card never reach the scrim now (issue #573). */}
      <button
        type="button"
        className="kit-modal-scrim"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="kit-modal" style={{ maxWidth: "420px" }}>
        <h2>Password generator</h2>

        <div className={shared.genrow}>
          <div className={styles.genout}>{genValue}</div>
          <button
            type="button"
            className={shared.iconbtn}
            aria-label="Regenerate"
            onClick={onRegen}
          >
            <Icon name="regen" />
          </button>
        </div>

        <div className={shared.strength}>
          <Meter ratio={st.ratio} tone={st.tone} />
          <span
            style={{ font: "var(--t-mono)", fontSize: "10px", color: st.color }}
          >
            {st.label}
          </span>
        </div>

        <div className={shared.fieldLg}>
          <div className={shared.flabel}>Length · {genLen}</div>
          <input
            type="range"
            className={styles.slider}
            min="8"
            max="40"
            value={genLen}
            onChange={(e) => onSetLen(Math.trunc(Number(e.target.value)))}
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
