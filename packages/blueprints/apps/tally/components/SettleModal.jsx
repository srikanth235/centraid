// The settle-up form: from/to selects over the ledger's people list, an
// amount, and a live "X pays Y $Z" hint. `st` is app.jsx's mutable
// `state.settle`; `onPatch` mutates it in place and re-renders, same pattern
// as ExpenseModal's `onPatch`.
import { curSymbolFor, first, money, toCents } from '../format.js';
import { ModalBackdrop } from './Shared.jsx';

function SettleSelect({ people, value, me, onChange }) {
  const nameFor = (p) => (p.party_id === me ? 'You' : p.name);
  return (
    <select className="s-select" value={value} onChange={(e) => onChange(e.target.value)}>
      {people.map((p) => (
        <option key={p.party_id} value={p.party_id}>
          {nameFor(p)}
        </option>
      ))}
    </select>
  );
}

export function SettleModal({ st, me, currency, personOf, onPatch, onClose, onSave }) {
  const cents = toCents(st.amount);
  const hint =
    `${st.from === me ? 'You' : first(personOf(st.from).name)} pays ${st.to === me ? 'you' : first(personOf(st.to).name)}` +
    (cents > 0 ? ' ' + money(cents, currency) : '');

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="kit-modal" style={{ maxWidth: '420px' }} onClick={(e) => e.stopPropagation()}>
        <h2>Settle up</h2>
        <div className="s-row2">
          <div className="s-field" style={{ flex: 1 }}>
            <div className="s-flabel">From</div>
            <SettleSelect people={st.people} value={st.from} me={me} onChange={(v) => onPatch({ from: v })} />
          </div>
          <div className="s-field" style={{ flex: 1 }}>
            <div className="s-flabel">To</div>
            <SettleSelect people={st.people} value={st.to} me={me} onChange={(v) => onPatch({ to: v })} />
          </div>
        </div>
        <div className="s-field">
          <div className="s-flabel">Amount</div>
          <div className="s-amtwrap">
            <span className="cur">{curSymbolFor(currency)}</span>
            <input
              className="s-amt"
              value={st.amount}
              inputMode="decimal"
              placeholder="0.00"
              onChange={(e) => onPatch({ amount: e.target.value })}
            />
          </div>
        </div>
        <div className="s-sub" style={{ marginTop: '10px' }}>
          {hint}
        </div>
        <div className="kit-modal-foot">
          <button type="button" className="kit-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="kit-btn primary" disabled={!(cents > 0 && st.from !== st.to)} onClick={onSave}>
            Record payment
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
