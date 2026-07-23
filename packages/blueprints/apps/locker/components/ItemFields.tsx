// Field descriptors + rows for the detail pane's read view, keyed by the
// vault's field names — the per-type shape app.js's `fieldDescriptors()` /
// `fieldRowTpl()` rendered. `secret` fields hide behind a reveal toggle and
// carry copy; the password field grows a strength meter on reveal; the OTP
// row runs the real client-side TOTP tick via totp.ts's `useTotp` hook.
import { armConfirm } from '../kit.ts';
import { copy } from '../logic.ts';
import { catOf, fmtDate, monoOf, subOf } from '../format.ts';
import { strength, useTotp } from '../totp.ts';
import type { LockerDetail } from '../types.ts';
import { Icon, KitMeter } from './Shared.tsx';
import styles from './ItemFields.module.css';
import shared from './shared.module.css';

type FieldDesc =
  | { kind: 'plain'; k: string; val: string; mono: boolean; canCopy: boolean }
  | { kind: 'link'; k: string; val: string }
  | { kind: 'secret'; fid: string; k: string; val: string | null | undefined; strength: boolean }
  | { kind: 'otp'; seed: string };

// Field descriptors for the read view, keyed by the vault's field names.
function fieldDescriptors(sel: LockerDetail): FieldDesc[] {
  const fields: FieldDesc[] = [];
  const plain = (
    k: string,
    val: string | null | undefined,
    opts: { mono?: boolean } = {},
  ): FieldDesc => ({
    kind: 'plain',
    k,
    val: val || '—',
    mono: !!opts.mono,
    canCopy: !!val,
  });
  const link = (k: string, val: string): FieldDesc => ({ kind: 'link', k, val });
  const secret = (
    fid: string,
    k: string,
    val: string | null | undefined,
    opts: { strength?: boolean } = {},
  ): FieldDesc => ({
    kind: 'secret',
    fid,
    k,
    val,
    strength: !!opts.strength,
  });
  const otp = (seed: string): FieldDesc => ({ kind: 'otp', seed });

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

function OtpFieldRow({ seed }: { seed: string }) {
  const { code, offset } = useTotp(seed);
  return (
    <div className={styles.field}>
      <div className={styles.fieldMain}>
        <div className={styles.fieldK}>One-time password</div>
        <div className={styles.otp}>
          <span className={styles.otpCode}>{code || '••• •••'}</span>
          <svg className={styles.ring} viewBox="0 0 36 36">
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
          className={styles.fbtn}
          aria-label="Copy"
          onClick={() => copy(code.replace(' ', ''), 'Code', true)}
        >
          <Icon name="copy" sw={1.6} />
        </button>
      ) : null}
    </div>
  );
}

function FieldRow({
  f,
  reveal,
  onToggleReveal,
}: {
  f: FieldDesc;
  reveal: Record<string, boolean>;
  onToggleReveal: (fid: string) => void;
}) {
  if (f.kind === 'otp') return <OtpFieldRow seed={f.seed} />;

  if (f.kind === 'link') {
    return (
      <div className={styles.field}>
        <div className={styles.fieldMain}>
          <div className={styles.fieldK}>{f.k}</div>
          <div className={styles.fieldV}>
            <a href={f.val} target="_blank" rel="noreferrer">
              {f.val}
            </a>
          </div>
        </div>
        <button
          type="button"
          className={styles.fbtn}
          aria-label="Copy"
          onClick={() => copy(f.val, f.k)}
        >
          <Icon name="copy" sw={1.6} />
        </button>
      </div>
    );
  }

  if (f.kind === 'plain') {
    return (
      <div className={styles.field}>
        <div className={styles.fieldMain}>
          <div className={styles.fieldK}>{f.k}</div>
          <div className={f.mono ? `${styles.fieldV} ${styles.mono}` : styles.fieldV}>{f.val}</div>
        </div>
        {f.canCopy ? (
          <button
            type="button"
            className={styles.fbtn}
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
    <div className={styles.field}>
      <div className={styles.fieldMain}>
        <div className={styles.fieldK}>{f.k}</div>
        <div className={`${styles.fieldV} ${styles.mono}`}>
          {f.val ? (revealed ? f.val : '••••••••••••') : '—'}
        </div>
        {st ? (
          <div className={shared.strength}>
            <KitMeter ratio={st.ratio} tone={st.tone} />
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
            className={styles.fbtn}
            aria-label="Reveal"
            onClick={() => onToggleReveal(f.fid)}
          >
            <Icon name={revealed ? 'eyeOff' : 'eye'} sw={1.6} />
          </button>
          <button
            type="button"
            className={styles.fbtn}
            aria-label="Copy"
            onClick={() => copy(f.val!, f.k, true)}
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
}: {
  sel: LockerDetail | null;
  reveal: Record<string, boolean>;
  onToggleReveal: (fid: string) => void;
  onToggleFav: (sel: LockerDetail) => void;
  onEdit: (sel: LockerDetail) => void;
  onTrash: (sel: LockerDetail) => void;
  onRestore: (sel: LockerDetail) => void;
  onPurge: (sel: LockerDetail) => void;
}) {
  if (!sel) {
    return (
      <div className={shared.detailInner}>
        <div className={shared.listEmpty} style={{ padding: '40px' }}>
          Opening…
        </div>
      </div>
    );
  }
  const fields = fieldDescriptors(sel);
  const noteText = sel.type === 'note' ? sel.content : sel.notes;
  const tags = sel.tags ?? [];
  return (
    <div className={shared.detailInner}>
      <div className={shared.dhead}>
        <span className={shared.dtile} style={{ background: catOf(sel.type).color }}>
          {monoOf(sel)}
        </span>
        <div style={{ minWidth: 0 }}>
          <div className={shared.dtitle}>{sel.title}</div>
          <div className={shared.dsub}>{subOf(sel) || catOf(sel.type).label}</div>
        </div>
        <div className={styles.dheadTools}>
          {sel.trashed ? null : (
            <>
              <button
                type="button"
                className={sel.favorite ? `${styles.dtool} ${styles.on}` : styles.dtool}
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
                className={styles.dtool}
                aria-label="Edit"
                onClick={() => onEdit(sel)}
              >
                <Icon name="edit" />
              </button>
            </>
          )}
        </div>
      </div>

      <div className={shared.fields}>
        {fields.length === 0 ? (
          <div className={shared.listEmpty} style={{ padding: '20px' }}>
            No fields.
          </div>
        ) : (
          fields.map((f) => (
            <FieldRow
              key={f.kind === 'secret' ? f.fid : f.kind === 'otp' ? 'otp' : f.k}
              f={f}
              reveal={reveal}
              onToggleReveal={onToggleReveal}
            />
          ))
        )}
      </div>

      {noteText ? (
        <>
          <div className={shared.dlabel}>Note</div>
          <div className={styles.note}>{noteText}</div>
        </>
      ) : null}

      {tags.length > 0 ? (
        <div className={styles.tags}>
          {tags.map((t) => (
            <span className={styles.tag} key={t}>
              {t}
            </span>
          ))}
        </div>
      ) : null}

      <div className={styles.meta}>Updated {fmtDate(sel.updated_at)}</div>

      <div style={{ display: 'flex', gap: '8px', marginTop: '20px' }}>
        {sel.trashed ? (
          <>
            <button type="button" className="kit-btn" onClick={() => onRestore(sel)}>
              Restore
            </button>
            <button
              type="button"
              className={`kit-btn danger ${styles.del}`}
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
            className={`kit-btn danger ${styles.del}`}
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
