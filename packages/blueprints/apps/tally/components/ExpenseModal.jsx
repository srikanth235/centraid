// The add/edit expense form: description, amount, category, group/paid-by
// selects, the equal/exact/percent split method and one row per member with
// its include-toggle and (for exact/percent) its own input. `exp` is
// app.jsx's mutable `state.expense` — every field change calls `onPatch`
// (the old `setE`: `Object.assign(state.expense, patch)` then a full modal
// re-render), so this stays a pure function of props exactly like the old
// Lit template did of `state.expense`. Plain controlled inputs replace Lit's
// `live()` directive — a full re-render on every keystroke already keeps the
// value in sync, same as every other field here.
import {
  CAT_LIST,
  cat,
  curSymbolFor,
  money,
  resolveSplits,
  splitSumInfo,
  toCents,
} from '../format.js';
import { I } from '../icons.js';
import { ArmedButton, Icon, ModalBackdrop } from './Shared.jsx';

function SplitRow({ m, exp, eqShare, me, currency, onPatch }) {
  const inc = exp.include.has(m.party_id);
  const name = m.is_me || m.party_id === me ? 'You' : m.name;

  let right;
  if (exp.method === 'equal') {
    right = <span className="s-splitshare">{inc ? money(eqShare, currency) : '—'}</span>;
  } else if (exp.method === 'exact') {
    right = inc ? (
      <input
        className="s-splitin"
        value={exp.exact[m.party_id] || ''}
        inputMode="decimal"
        placeholder="0.00"
        onChange={(e) => onPatch({ exact: { ...exp.exact, [m.party_id]: e.target.value } })}
      />
    ) : (
      <span className="s-splitshare">—</span>
    );
  } else {
    right = inc ? (
      <input
        className="s-splitin"
        value={exp.percent[m.party_id] || ''}
        inputMode="decimal"
        placeholder="0%"
        onChange={(e) => onPatch({ percent: { ...exp.percent, [m.party_id]: e.target.value } })}
      />
    ) : (
      <span className="s-splitshare">—</span>
    );
  }

  return (
    <div className="s-splitrow">
      <button
        type="button"
        className={`s-splitbox ${inc ? 'on' : ''}`}
        aria-label="Include"
        onClick={() => {
          const next = new Set(exp.include);
          if (inc) next.delete(m.party_id);
          else next.add(m.party_id);
          onPatch({ include: next });
        }}
      >
        {inc ? <Icon svg={I.check} /> : null}
      </button>
      <kit-avatar name={m.name} size="26px" color={m.color} initials={m.initials} />
      <span className="s-splitname">{name}</span>
      {right}
    </div>
  );
}

export function ExpenseModal({
  exp,
  members,
  groups,
  me,
  currency,
  onPatch,
  onGroupChange,
  onClose,
  onSave,
  onDelete,
}) {
  const amountCents = toCents(exp.amount);
  const parts = members.filter((m) => exp.include.has(m.party_id));
  const eqShare = parts.length && amountCents > 0 ? amountCents / parts.length : 0;
  const sumInfo = splitSumInfo(exp, members, currency);
  const valid = Boolean(
    exp.desc.trim() && amountCents > 0 && resolveSplits(exp, amountCents, members),
  );

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="kit-modal s-wide" onClick={(e) => e.stopPropagation()}>
        <h2>{exp.mode === 'edit' ? 'Edit expense' : 'Add an expense'}</h2>
        <input
          className="s-in"
          style={{ fontSize: '15px' }}
          value={exp.desc}
          placeholder="What was it for?"
          onChange={(e) => onPatch({ desc: e.target.value })}
        />
        <div className="s-field">
          <div className="s-amtwrap">
            <span className="cur">{curSymbolFor(currency)}</span>
            <input
              className="s-amt"
              value={exp.amount}
              inputMode="decimal"
              placeholder="0.00"
              onChange={(e) => onPatch({ amount: e.target.value })}
            />
          </div>
        </div>
        <div className="s-field">
          <div className="s-flabel">Category</div>
          <div className="s-catrow">
            {CAT_LIST.map((c) => (
              <button
                key={c}
                type="button"
                className="kit-chip quiet"
                aria-pressed={String(exp.category === c)}
                onClick={() => onPatch({ category: c })}
              >
                {cat(c).icon} {c.charAt(0).toUpperCase() + c.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className="s-row2">
          <div className="s-field" style={{ flex: 1 }}>
            <div className="s-flabel">Group</div>
            <select
              className="s-select"
              value={exp.groupId}
              onChange={(e) => onGroupChange(e.target.value)}
            >
              {groups.map((g) => (
                <option key={g.group_id} value={g.group_id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
          <div className="s-field" style={{ flex: 1 }}>
            <div className="s-flabel">Paid by</div>
            <select
              className="s-select"
              value={exp.paidBy}
              onChange={(e) => onPatch({ paidBy: e.target.value })}
            >
              {members.map((m) => (
                <option key={m.party_id} value={m.party_id}>
                  {m.is_me || m.party_id === me ? 'You' : m.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="s-field">
          <div className="s-flabel">Split</div>
          <div className="kit-seg stretch">
            <button
              type="button"
              aria-pressed={String(exp.method === 'equal')}
              onClick={() => onPatch({ method: 'equal' })}
            >
              Equally
            </button>
            <button
              type="button"
              aria-pressed={String(exp.method === 'exact')}
              onClick={() => onPatch({ method: 'exact' })}
            >
              Exact
            </button>
            <button
              type="button"
              aria-pressed={String(exp.method === 'percent')}
              onClick={() => onPatch({ method: 'percent' })}
            >
              Percent
            </button>
          </div>
          <div style={{ marginTop: '10px' }}>
            {members.map((m) => (
              <SplitRow
                key={m.party_id}
                m={m}
                exp={exp}
                eqShare={eqShare}
                me={me}
                currency={currency}
                onPatch={onPatch}
              />
            ))}
            <div className={`s-splitsum${sumInfo.bad ? ' bad' : ''}`}>{sumInfo.text}</div>
          </div>
        </div>
        <div className="kit-modal-foot">
          {exp.mode === 'edit' ? (
            <ArmedButton
              className="kit-btn danger s-del"
              label="Delete"
              armedLabel="Delete — sure?"
              onConfirm={() => onDelete(exp.expense_id)}
            />
          ) : null}
          <button type="button" className="kit-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="kit-btn primary" disabled={!valid} onClick={onSave}>
            Save
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
