// Field descriptors + rows for the detail pane's read view, keyed by the
// vault's field names — the per-type shape app.js's `fieldDescriptors()` /
// `fieldRowTpl()` rendered. `secret` fields hide behind a reveal toggle and
// carry copy; the password field grows a strength meter on reveal; the OTP
// row runs the real client-side TOTP tick via totp.js's `useTotp` hook.
import { armConfirm } from '../kit.js';
import { copy } from '../logic.js';
import { catOf, fmtDate, monoOf, subOf } from '../format.js';
import { strength, useTotp } from '../totp.js';
import { Icon } from './Shared.jsx';

// Field descriptors for the read view, keyed by the vault's field names.
function fieldDescriptors(sel) {
  const fields = [];
  const plain = (k, val, opts = {}) => ({
    kind: 'plain',
    k,
    val: val || '—',
    mono: !!opts.mono,
    canCopy: !!val,
  });
  const link = (k, val) => ({ kind: 'link', k, val });
  const secret = (fid, k, val, opts = {}) => ({
    kind: 'secret',
    fid,
    k,
    val,
    strength: !!opts.strength,
  });
  const otp = (seed) => ({ kind: 'otp', seed });

  if (sel.type === 'login') {
    fields.push(plain('Username', sel.username));
    fields.push(secret('pw-' + sel.item_id, 'Password', sel.password, { strength: true }));
    if (sel.url) fields.push(link('Website', sel.url));
    if (sel.otp_seed) fields.push(otp(sel.otp_seed));
  } else if (sel.type === 'card') {
    fields.push(secret('num-' + sel.item_id, 'Card number', sel.card_number));
    fields.push(plain('Cardholder', sel.cardholder));
    fields.push(plain('Expiry', sel.expiry, { mono: true }));
    fields.push(secret('cvv-' + sel.item_id, 'CVV', sel.cvv));
    if (sel.brand) fields.push(plain('Brand', sel.brand));
  } else if (sel.type === 'identity') {
    fields.push(plain('Full name', sel.fullname));
    fields.push(plain('Email', sel.email));
    fields.push(plain('Phone', sel.phone, { mono: true }));
    fields.push(plain('Address', sel.address));
  } else if (sel.type === 'wifi') {
    fields.push(plain('Network', sel.network));
    fields.push(secret('wf-' + sel.item_id, 'Password', sel.password, { strength: true }));
  } else if (sel.type === 'password') {
    fields.push(secret('pw-' + sel.item_id, 'Password', sel.password, { strength: true }));
  }
  return fields;
}

function OtpFieldRow({ seed }) {
  const { code, offset } = useTotp(seed);
  return (
    <div className="v-field">
      <div className="v-field-main">
        <div className="v-field-k">One-time password</div>
        <div className="v-otp">
          <span className="v-otp-code">{code || '••• •••'}</span>
          <svg className="v-ring" viewBox="0 0 36 36">
            <circle
              cx="18"
              cy="18"
              r="15"
              fill="none"
              stroke="var(--line-strong)"
              strokeWidth="3"
            />
            <circle
              cx="18"
              cy="18"
              r="15"
              fill="none"
              stroke="var(--_accent)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeDasharray="94.2"
              strokeDashoffset={offset}
              transform="rotate(-90 18 18)"
            />
          </svg>
        </div>
      </div>
      {code ? (
        <button
          type="button"
          className="v-fbtn"
          aria-label="Copy"
          onClick={() => copy(code.replace(' ', ''), 'Code', true)}
        >
          <Icon name="copy" sw={1.6} />
        </button>
      ) : null}
    </div>
  );
}

function FieldRow({ f, reveal, onToggleReveal }) {
  if (f.kind === 'otp') return <OtpFieldRow seed={f.seed} />;

  if (f.kind === 'link') {
    return (
      <div className="v-field">
        <div className="v-field-main">
          <div className="v-field-k">{f.k}</div>
          <div className="v-field-v">
            <a href={f.val} target="_blank" rel="noreferrer">
              {f.val}
            </a>
          </div>
        </div>
        <button type="button" className="v-fbtn" aria-label="Copy" onClick={() => copy(f.val, f.k)}>
          <Icon name="copy" sw={1.6} />
        </button>
      </div>
    );
  }

  if (f.kind === 'plain') {
    return (
      <div className="v-field">
        <div className="v-field-main">
          <div className="v-field-k">{f.k}</div>
          <div className={f.mono ? 'v-field-v mono' : 'v-field-v'}>{f.val}</div>
        </div>
        {f.canCopy ? (
          <button
            type="button"
            className="v-fbtn"
            aria-label="Copy"
            onClick={() => copy(f.val, f.k)}
          >
            <Icon name="copy" sw={1.6} />
          </button>
        ) : null}
      </div>
    );
  }

  // secret
  const revealed = !!reveal[f.fid];
  const st = f.strength && revealed && f.val ? strength(f.val) : null;
  return (
    <div className="v-field">
      <div className="v-field-main">
        <div className="v-field-k">{f.k}</div>
        <div className="v-field-v mono">{f.val ? (revealed ? f.val : '••••••••••••') : '—'}</div>
        {st ? (
          <div className="v-strength">
            <kit-meter ratio={st.ratio} tone={st.tone}></kit-meter>
            <span style={{ font: 'var(--t-mono)', fontSize: '10px', color: st.color }}>
              {st.label}
            </span>
          </div>
        ) : null}
      </div>
      {f.val ? (
        <>
          <button
            type="button"
            className="v-fbtn"
            aria-label="Reveal"
            onClick={() => onToggleReveal(f.fid)}
          >
            <Icon name={revealed ? 'eyeOff' : 'eye'} sw={1.6} />
          </button>
          <button
            type="button"
            className="v-fbtn"
            aria-label="Copy"
            onClick={() => copy(f.val, f.k, true)}
          >
            <Icon name="copy" sw={1.6} />
          </button>
        </>
      ) : null}
    </div>
  );
}

export function ItemPane({
  sel,
  reveal,
  onToggleReveal,
  onToggleFav,
  onEdit,
  onTrash,
  onRestore,
  onPurge,
}) {
  if (!sel) {
    return (
      <div className="v-detail-inner">
        <div className="v-list-empty" style={{ padding: '40px' }}>
          Opening…
        </div>
      </div>
    );
  }
  const fields = fieldDescriptors(sel);
  const noteText = sel.type === 'note' ? sel.content : sel.notes;
  return (
    <div className="v-detail-inner">
      <div className="v-dhead">
        <span className="v-dtile" style={{ background: catOf(sel.type).color }}>
          {monoOf(sel)}
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="v-dtitle">{sel.title}</div>
          <div className="v-dsub">{subOf(sel) || catOf(sel.type).label}</div>
        </div>
        <div className="v-dhead-tools">
          {sel.trashed ? null : (
            <>
              <button
                type="button"
                className={sel.favorite ? 'v-dtool on' : 'v-dtool'}
                aria-label="Favorite"
                onClick={() => onToggleFav(sel)}
              >
                <Icon
                  name="starFill"
                  size={17}
                  sw={1.6}
                  fill={sel.favorite ? 'currentColor' : 'none'}
                />
              </button>
              <button
                type="button"
                className="v-dtool"
                aria-label="Edit"
                onClick={() => onEdit(sel)}
              >
                <Icon name="edit" />
              </button>
            </>
          )}
        </div>
      </div>

      <div className="v-fields">
        {fields.length === 0 ? (
          <div className="v-list-empty" style={{ padding: '20px' }}>
            No fields.
          </div>
        ) : (
          fields.map((f) => (
            <FieldRow key={f.fid ?? f.k} f={f} reveal={reveal} onToggleReveal={onToggleReveal} />
          ))
        )}
      </div>

      {noteText ? (
        <>
          <div className="v-dlabel">Note</div>
          <div className="v-note">{noteText}</div>
        </>
      ) : null}

      {(sel.tags || []).length > 0 ? (
        <div className="v-tags">
          {sel.tags.map((t) => (
            <span className="v-tag" key={t}>
              {t}
            </span>
          ))}
        </div>
      ) : null}

      <div className="v-meta">Updated {fmtDate(sel.updated_at)}</div>

      <div style={{ display: 'flex', gap: '8px', marginTop: '20px' }}>
        {sel.trashed ? (
          <>
            <button type="button" className="kit-btn" onClick={() => onRestore(sel)}>
              Restore
            </button>
            <button
              type="button"
              className="kit-btn danger v-del"
              style={{ marginRight: 0 }}
              onClick={(e) => {
                if (!armConfirm(e.currentTarget, { armedLabel: 'Delete forever — sure?' })) return;
                onPurge(sel);
              }}
            >
              Delete forever
            </button>
          </>
        ) : (
          <button
            type="button"
            className="kit-btn danger v-del"
            style={{ marginRight: 0 }}
            onClick={() => onTrash(sel)}
          >
            Move to trash
          </button>
        )}
      </div>
    </div>
  );
}
