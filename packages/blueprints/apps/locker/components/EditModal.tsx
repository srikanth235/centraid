// The add/edit item modal — a self-contained, stateful leaf (its own
// useState for title/type/tags/alias/fields), matching tasks/notes/agenda's
// modal idiom (CreateModal.tsx et al). Mounted only while `state.edit` is
// set and unmounts on close, so its local state always starts fresh from the
// `edit` seed app.tsx built in `openNew()`/`openEdit()`. The password
// generator is a sibling overlay, not a child — `onOpenGenerator` hands it a
// callback that writes the generated value straight into this component's
// own `fields` state, the same bridge app.js's `genTarget` gave the
// module-level `state.edit.fields`.
import { useState } from '../react-core.min.js';
import { CAT_ORDER, TYPE_LABEL } from '../format.ts';
import type { EditSeed, SavePayload } from '../types.ts';
import { Icon } from './Shared.tsx';
import styles from './EditModal.module.css';
import shared from './shared.module.css';

interface FieldDef {
  label: string;
  key: string;
  ph?: string;
  mono?: boolean;
  gen?: boolean;
}

// Field descriptors for the edit modal, keyed by the ACTION's input keys
// (otp_seed, card_number) — the map from prototype names happens here.
function editFieldsFor(type: string): FieldDef[] {
  switch (type) {
    case 'login':
      return [
        { label: 'Username', key: 'username', ph: 'you@email.com' },
        { label: 'Password', key: 'password', mono: true, gen: true },
        { label: 'Website', key: 'url', ph: 'https://' },
        { label: 'One-time secret', key: 'otp_seed', mono: true, ph: 'base32 seed (optional)' },
      ];
    case 'card':
      return [
        { label: 'Card number', key: 'card_number', mono: true },
        { label: 'Cardholder', key: 'cardholder' },
        { label: 'Expiry', key: 'expiry', mono: true, ph: 'MM/YY' },
        { label: 'CVV', key: 'cvv', mono: true },
        { label: 'Brand', key: 'brand', ph: 'Visa' },
      ];
    case 'note':
      return [{ label: 'Content', key: 'content' }];
    case 'identity':
      return [
        { label: 'Full name', key: 'fullname' },
        { label: 'Email', key: 'email' },
        { label: 'Phone', key: 'phone', mono: true },
        { label: 'Address', key: 'address' },
      ];
    case 'wifi':
      return [
        { label: 'Network', key: 'network' },
        { label: 'Password', key: 'password', mono: true, gen: true },
      ];
    default:
      return [{ label: 'Password', key: 'password', mono: true, gen: true }];
  }
}

function EditFieldRow({
  f,
  value,
  onChange,
  onGenerate,
}: {
  f: FieldDef;
  value: string | undefined;
  onChange: (key: string, value: string) => void;
  onGenerate: (key: string) => void;
}) {
  const input = (
    <input
      className={f.mono ? `${styles.in} ${styles.mono}` : styles.in}
      placeholder={f.ph || ''}
      value={value || ''}
      onChange={(e) => onChange(f.key, e.target.value)}
    />
  );
  return (
    <div className={shared.fieldLg}>
      <div className={shared.flabel}>{f.label}</div>
      {f.gen ? (
        <div className={shared.genrow}>
          {input}
          <button
            type="button"
            className={shared.iconbtn}
            aria-label="Generate"
            onClick={() => onGenerate(f.key)}
          >
            <Icon name="regen" />
          </button>
        </div>
      ) : (
        input
      )}
    </div>
  );
}

export function EditModal({
  edit,
  onClose,
  onSave,
  onOpenGenerator,
}: {
  edit: EditSeed;
  onClose: () => void;
  onSave: (payload: SavePayload) => void;
  onOpenGenerator: (applyFn: (password: string) => void) => void;
}) {
  const { mode } = edit;
  const [type, setType] = useState(edit.type);
  const [title, setTitle] = useState(edit.title);
  const [tags, setTags] = useState(edit.tags);
  const [alias, setAlias] = useState(edit.alias || '');
  const [fields, setFields] = useState<Record<string, string>>(edit.fields);

  const fieldDefs = editFieldsFor(type);
  const setField = (key: string, value: string) => setFields((f) => ({ ...f, [key]: value }));
  const generate = (key: string) => onOpenGenerator((password) => setField(key, password));

  const save = () => {
    if (!title.trim()) return;
    onSave({
      mode,
      id: edit.id,
      type,
      title,
      tags,
      alias,
      fields,
      allowedKeys: fieldDefs.map((f) => f.key),
    });
  };

  return (
    <div
      className="kit-modal-back"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="kit-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{mode === 'edit' ? 'Edit item' : 'New item'}</h2>

        {mode === 'new' ? (
          <div className={shared.fieldLg}>
            <div className={shared.flabel}>Type</div>
            <div className={styles.typerow}>
              {CAT_ORDER.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="kit-chip quiet"
                  aria-pressed={type === t}
                  onClick={() => {
                    setType(t);
                    setFields({});
                  }}
                >
                  {TYPE_LABEL[t]}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <div className={shared.fieldLg}>
          <div className={shared.flabel}>Title</div>
          <input
            className={styles.in}
            placeholder="Item name"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        {fieldDefs.map((f) => (
          <EditFieldRow
            key={f.key}
            f={f}
            value={fields[f.key]}
            onChange={setField}
            onGenerate={generate}
          />
        ))}

        <div className={shared.fieldLg}>
          <div className={shared.flabel}>Tags (comma-separated)</div>
          <input
            className={styles.in}
            placeholder="personal, finance"
            value={tags}
            onChange={(e) => setTags(e.target.value)}
          />
        </div>

        {/* Connector alias (issue #298 item 4): a stable name an automation
        binds to, so replacing this item later re-heals the binding without a
        manifest edit. */}
        <div className={shared.fieldLg}>
          <div className={shared.flabel}>Connector alias (optional)</div>
          <input
            className={`${styles.in} ${styles.mono}`}
            placeholder="e.g. github-token"
            value={alias}
            onChange={(e) => setAlias(e.target.value.trim())}
          />
        </div>

        <div className="kit-modal-foot">
          <button type="button" className="kit-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="kit-btn primary" disabled={!title.trim()} onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
