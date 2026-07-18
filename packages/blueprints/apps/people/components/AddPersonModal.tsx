// The "Add someone" modal (#modalRoot root). A self-contained, stateful leaf:
// its own name/role/list/cadence draft, focused once on mount. Calls up to
// `onSubmit` with the assembled fields; on success the caller closes the
// modal (unmounting this component) and opens the new person's drawer, same
// as the old version. On failure/park, the draft and open state stay put so
// nothing typed is lost.
import { useEffect, useRef, useState } from '../react-core.min.js';
import type { PersonList } from '../types.ts';
import styles from './AddPersonModal.module.css';

const CADENCE_OPTS: Array<{ d: number; l: string }> = [
  { d: 7, l: 'Weekly' },
  { d: 14, l: 'Biweekly' },
  { d: 30, l: 'Monthly' },
  { d: 90, l: 'Quarterly' },
];

interface AddFields {
  name: string;
  role: string;
  listId: string | null;
  cadence: number;
}

export function AddPersonModal({
  lists,
  onSubmit,
  onClose,
}: {
  lists: PersonList[];
  onSubmit: (fields: AddFields) => Promise<boolean>;
  onClose: () => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [listId, setListId] = useState<string | null>(null);
  const [cadence, setCadence] = useState(30);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const listOpts: Array<{ list_id: string | null; name: string }> = [
    { list_id: null, name: 'No list' },
    ...lists,
  ];

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    const ok = await onSubmit({ name: trimmed, role: role.trim(), listId, cadence });
    if (!ok) setBusy(false);
  };

  return (
    <div className="kit-modal-back" onClick={onClose}>
      <div className="kit-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Add someone</h2>
        <p className="hint">Who do you want to keep up with?</p>
        <input
          ref={nameRef}
          className={styles.input}
          placeholder="Name"
          aria-label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className={styles.input}
          style={{ marginTop: '8px' }}
          placeholder="Role or where they are (optional)"
          aria-label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        />
        <div className={styles.modalLabel}>List</div>
        <div className={styles.pick}>
          {listOpts.map((c) => (
            <button
              key={c.list_id ?? 'none'}
              type="button"
              className="kit-chip quiet"
              aria-pressed={listId === c.list_id}
              onClick={() => setListId(c.list_id)}
            >
              {c.name}
            </button>
          ))}
        </div>
        <div className={styles.modalLabel}>Reach out</div>
        <div className={styles.pick}>
          {CADENCE_OPTS.map((o) => (
            <button
              key={o.d}
              type="button"
              className="kit-chip quiet"
              aria-pressed={cadence === o.d}
              onClick={() => setCadence(o.d)}
            >
              {o.l}
            </button>
          ))}
        </div>
        <div className={`kit-modal-foot ${styles.modalFoot}`}>
          <button type="button" className="kit-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="kit-btn primary"
            disabled={busy || !name.trim()}
            onClick={submit}
          >
            Add person
          </button>
        </div>
      </div>
    </div>
  );
}
