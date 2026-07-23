// The add/edit expense form: description, amount, category, group/paid-by
// selects, the equal/exact/percent split method and one row per member with
// its include-toggle and (for exact/percent) its own input. `exp` is
// app.tsx's mutable `state.expense` — every field change calls `onPatch`
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
} from '../format.ts';
import { I } from '../icons.ts';
import type { ReactNode } from 'react';
import type { ExpenseModel, Group, Member } from '../types.ts';
import { ArmedButton, Icon, KitAvatar, ModalBackdrop } from './Shared.tsx';
import styles from './ExpenseModal.module.css';
import shared from './shared.module.css';

function SplitRow({
  m,
  exp,
  eqShare,
  me,
  currency,
  onPatch,
}: {
  m: Member;
  exp: ExpenseModel;
  eqShare: number;
  me: string | null;
  currency: string;
  onPatch: (patch: Partial<ExpenseModel>) => void;
}) {
  const inc = exp.include.has(m.party_id);
  const name = m.is_me || m.party_id === me ? 'You' : m.name;

  let right: ReactNode;
  if (exp.method === 'equal') {
    right = <span className={styles.splitshare}>{inc ? money(eqShare, currency) : '—'}</span>;
  } else if (exp.method === 'exact') {
    right = inc ? (
      <input
        className={styles.splitin}
        value={exp.exact[m.party_id] || ''}
        inputMode="decimal"
        placeholder="0.00"
        onChange={(e) => onPatch({ exact: { ...exp.exact, [m.party_id]: e.target.value } })}
      />
    ) : (
      <span className={styles.splitshare}>—</span>
    );
  } else {
    right = inc ? (
      <input
        className={styles.splitin}
        value={exp.percent[m.party_id] || ''}
        inputMode="decimal"
        placeholder="0%"
        onChange={(e) => onPatch({ percent: { ...exp.percent, [m.party_id]: e.target.value } })}
      />
    ) : (
      <span className={styles.splitshare}>—</span>
    );
  }

  return (
    <div className={styles.splitrow}>
      <button
        type="button"
        className={`${styles.splitbox} ${inc ? styles.on : ''}`}
        aria-label="Include"
        onClick={() => {
          const next = new Set(exp.include);
          if (inc) next.delete(m.party_id);
          else next.add(m.party_id);
          onPatch({ include: next });
        }}
      >
        {inc ? <Icon svg={I.check!} /> : null}
      </button>
      <KitAvatar name={m.name} size="26px" color={m.color} initials={m.initials} />
      <span className={styles.splitname}>{name}</span>
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
}: {
  exp: ExpenseModel;
  members: Member[];
  groups: Group[];
  me: string | null;
  currency: string;
  onPatch: (patch: Partial<ExpenseModel>) => void;
  onGroupChange: (groupId: string) => void;
  onClose: () => void;
  onSave: () => void;
  onDelete: (expenseId: string) => void;
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
      <div className={`kit-modal ${styles.wide}`} onClick={(e) => e.stopPropagation()}>
        <h2>{exp.mode === 'edit' ? 'Edit expense' : 'Add an expense'}</h2>
        <input
          className={shared.in}
          style={{ fontSize: '15px' }}
          value={exp.desc}
          placeholder="What was it for?"
          onChange={(e) => onPatch({ desc: e.target.value })}
        />
        <div className={shared.field}>
          <div className={shared.amtwrap}>
            <span className={shared.cur}>{curSymbolFor(currency)}</span>
            <input
              className={shared.amt}
              value={exp.amount}
              inputMode="decimal"
              placeholder="0.00"
              onChange={(e) => onPatch({ amount: e.target.value })}
            />
          </div>
        </div>
        <div className={shared.field}>
          <div className={shared.flabel}>Category</div>
          <div className={shared.catrow}>
            {CAT_LIST.map((c) => (
              <button
                key={c}
                type="button"
                className="kit-chip quiet"
                aria-pressed={exp.category === c}
                onClick={() => onPatch({ category: c })}
              >
                {cat(c).icon} {c.charAt(0).toUpperCase() + c.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <div className={shared.row2}>
          <div className={shared.field} style={{ flex: 1 }}>
            <div className={shared.flabel}>Group</div>
            <select
              className={shared.select}
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
          <div className={shared.field} style={{ flex: 1 }}>
            <div className={shared.flabel}>Paid by</div>
            <select
              className={shared.select}
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
        <div className={shared.field}>
          <div className={shared.flabel}>Split</div>
          <div className="kit-seg stretch">
            <button
              type="button"
              aria-pressed={exp.method === 'equal'}
              onClick={() => onPatch({ method: 'equal' })}
            >
              Equally
            </button>
            <button
              type="button"
              aria-pressed={exp.method === 'exact'}
              onClick={() => onPatch({ method: 'exact' })}
            >
              Exact
            </button>
            <button
              type="button"
              aria-pressed={exp.method === 'percent'}
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
            <div className={`${styles.splitsum}${sumInfo.bad ? ' ' + styles.bad : ''}`}>
              {sumInfo.text}
            </div>
          </div>
        </div>
        <div className="kit-modal-foot">
          {exp.mode === 'edit' ? (
            <ArmedButton
              className={`kit-btn danger ${shared.del}`}
              label="Delete"
              armedLabel="Delete — sure?"
              onConfirm={() => onDelete(exp.expense_id!)}
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
