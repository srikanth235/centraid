// The "Add someone" modal (#modalRoot root). A self-contained, stateful leaf:
// its own name/role/list/cadence draft, focused once on mount. Calls up to
// `onSubmit` with the assembled fields; on success the caller closes the
// modal (unmounting this component) and opens the new person's drawer, same
// as the old version. On failure/park, the draft and open state stay put so
// nothing typed is lost.
import { useEffect, useRef, useState } from '../react-core.min.js';

const CADENCE_OPTS = [
  { d: 7, l: 'Weekly' },
  { d: 14, l: 'Biweekly' },
  { d: 30, l: 'Monthly' },
  { d: 90, l: 'Quarterly' },
];

export function AddPersonModal({ lists, onSubmit, onClose }) {
  const nameRef = useRef(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [listId, setListId] = useState(null);
  const [cadence, setCadence] = useState(30);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const listOpts = [{ list_id: null, name: 'No list' }, ...lists];

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
          className="d-input"
          placeholder="Name"
          aria-label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          className="d-input"
          style={{ marginTop: '8px' }}
          placeholder="Role or where they are (optional)"
          aria-label="Role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        />
        <div className="d-modal-label">List</div>
        <div className="d-pick">
          {listOpts.map((c) => (
            <button
              key={c.list_id ?? 'none'}
              type="button"
              className="kit-chip quiet"
              aria-pressed={String(listId === c.list_id)}
              onClick={() => setListId(c.list_id)}
            >
              {c.name}
            </button>
          ))}
        </div>
        <div className="d-modal-label">Reach out</div>
        <div className="d-pick">
          {CADENCE_OPTS.map((o) => (
            <button
              key={o.d}
              type="button"
              className="kit-chip quiet"
              aria-pressed={String(cadence === o.d)}
              onClick={() => setCadence(o.d)}
            >
              {o.l}
            </button>
          ))}
        </div>
        <div className="kit-modal-foot d-modal-foot">
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
