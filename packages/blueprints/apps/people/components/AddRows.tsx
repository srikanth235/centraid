// The profile drawer's dashed "+ add" input rows (the prototype's
// `.d-noteadd` idiom) — small, self-contained stateful leaves (each owns its
// own field state), so typing here re-renders only the one row, never the
// whole drawer. Each calls up to its `onSubmit` with the assembled fields and
// clears its own fields once the write actually lands (mirrors the old
// version's behavior: a successful write re-reads the person, which used to
// recreate these DOM-imperative rows from scratch; a failed/parked one left
// the typed draft in place so nothing the owner typed is lost).
import { useState } from '../react-core.min.js';
import type { ReactNode } from '../react-core.min.js';
import { dateInputToMonthDay } from '../format.ts';
import { I } from '../icons.ts';
import { Icon } from './Shared.tsx';
import styles from './AddRows.module.css';
import shared from './shared.module.css';

type SubmitFn = (fields: Record<string, unknown>) => Promise<boolean>;

function AddRow({
  canCommit,
  onCommit,
  children,
}: {
  canCommit: boolean;
  onCommit: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className={styles.noteadd}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onCommit();
        }
      }}
    >
      {children}
      <button
        type="button"
        className={shared.miniBtn}
        aria-label="Add"
        style={{
          background: canCommit ? 'var(--accd)' : 'color-mix(in oklab, var(--ink) 8%, transparent)',
          color: canCommit ? '#fff' : 'var(--ink-3)',
        }}
        onClick={onCommit}
      >
        <Icon svg={I.plus} />
      </button>
    </div>
  );
}

export function RelationshipAddRow({ onSubmit }: { onSubmit: SubmitFn }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('');
  const [pet, setPet] = useState('');
  const commit = async () => {
    const n = name.trim();
    const k = kind.trim();
    if (!n || !k) return;
    const ok = await onSubmit({ name: n, kind: k, ...(pet.trim() ? { pet: pet.trim() } : {}) });
    if (ok) {
      setName('');
      setKind('');
      setPet('');
    }
  };
  return (
    <AddRow canCommit={Boolean(name.trim() && kind.trim())} onCommit={commit}>
      <input
        placeholder="Name"
        aria-label="Relationship name"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        className={styles.narrow}
        placeholder="Kind"
        aria-label="Relationship kind"
        value={kind}
        onChange={(e) => setKind(e.target.value)}
      />
      <input
        className={styles.narrow}
        placeholder="Pet?"
        aria-label="Pet kind (optional)"
        value={pet}
        onChange={(e) => setPet(e.target.value)}
      />
    </AddRow>
  );
}

export function DateAddRow({ onSubmit }: { onSubmit: SubmitFn }) {
  const [label, setLabel] = useState('');
  const [date, setDate] = useState('');
  const commit = async () => {
    const l = label.trim();
    const md = dateInputToMonthDay(date);
    if (!l || !md) return;
    const ok = await onSubmit({ label: l, month_day: md, reminder_on: true });
    if (ok) {
      setLabel('');
      setDate('');
    }
  };
  return (
    <AddRow canCommit={Boolean(label.trim() && date)} onCommit={commit}>
      <input
        placeholder="Label (Birthday…)"
        aria-label="Date label"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />
      <input
        type="date"
        className={styles.narrow}
        aria-label="Date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
    </AddRow>
  );
}

export function TaskAddRow({ onSubmit }: { onSubmit: SubmitFn }) {
  const [text, setText] = useState('');
  const commit = async () => {
    const t = text.trim();
    if (!t) return;
    const ok = await onSubmit({ text: t });
    if (ok) setText('');
  };
  return (
    <AddRow canCommit={Boolean(text.trim())} onCommit={commit}>
      <input
        placeholder="Add a task…"
        aria-label="Task text"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </AddRow>
  );
}

export function NoteAddRow({ onSubmit }: { onSubmit: SubmitFn }) {
  const [text, setText] = useState('');
  const commit = async () => {
    const t = text.trim();
    if (!t) return;
    const ok = await onSubmit({ text: t });
    if (ok) setText('');
  };
  return (
    <AddRow canCommit={Boolean(text.trim())} onCommit={commit}>
      <input
        placeholder="Add a note…"
        aria-label="Note text"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </AddRow>
  );
}

export function GiftAddRow({ onSubmit }: { onSubmit: SubmitFn }) {
  const [text, setText] = useState('');
  const commit = async () => {
    const t = text.trim();
    if (!t) return;
    const ok = await onSubmit({ text: t });
    if (ok) setText('');
  };
  return (
    <AddRow canCommit={Boolean(text.trim())} onCommit={commit}>
      <input
        placeholder="A gift idea…"
        aria-label="Gift idea"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
    </AddRow>
  );
}

export function DebtAddRow({ onSubmit }: { onSubmit: SubmitFn }) {
  const [dir, setDir] = useState('owe');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const commit = async () => {
    const dollars = parseFloat(amount);
    if (!(dollars > 0)) return;
    const ok = await onSubmit({
      direction: dir,
      amount_minor: Math.round(dollars * 100),
      ...(reason.trim() ? { reason: reason.trim() } : {}),
    });
    if (ok) {
      setAmount('');
      setReason('');
    }
  };
  return (
    <AddRow canCommit={parseFloat(amount) > 0} onCommit={commit}>
      <div className={`kit-seg ${styles.seg}`}>
        <button type="button" aria-pressed={dir === 'owe'} onClick={() => setDir('owe')}>
          You owe
        </button>
        <button type="button" aria-pressed={dir === 'owed'} onClick={() => setDir('owed')}>
          Owes you
        </button>
      </div>
      <input
        className={styles.narrow}
        type="number"
        min="0"
        step="0.01"
        placeholder="$0.00"
        aria-label="Amount"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <input
        placeholder="Reason"
        aria-label="Reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
    </AddRow>
  );
}
