// The expense detail popover: category/description header, amount, the
// per-person split breakdown, and delete/close/edit actions.
import { MS, cat, first, money, tint, todayKey } from '../format.ts';
import type { Group, LedgerRow } from '../types.ts';
import { ArmedButton, KitAvatar, ModalBackdrop } from './Shared.tsx';
import shared from './shared.module.css';

export function DetailModal({
  row,
  me,
  groups,
  currency,
  onClose,
  onEdit,
  onDelete,
}: {
  row: LedgerRow;
  me: string | null;
  groups: Group[];
  currency: string;
  onClose: () => void;
  onEdit: (row: LedgerRow) => void;
  onDelete: (expenseId: string) => void;
}) {
  const c = cat(row.category);
  const d = new Date((row.spent_on || todayKey()) + 'T12:00:00');
  const when = `${MS[d.getMonth()]} ${d.getDate()}`;
  const paidLine =
    row.paid_by === me ? `You paid · ${when}` : `${first(row.paid_by_name)} paid · ${when}`;
  const groupName = groups.find((g) => g.group_id === row.group_id)?.name || '';

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="kit-modal" style={{ maxWidth: '440px' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '13px' }}>
          <span
            className={shared.excat}
            style={{ width: '46px', height: '46px', fontSize: '22px', background: tint(c.color) }}
          >
            {c.icon}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{ margin: 0 }}>{row.description}</h2>
            <div className="s-sub">{groupName}</div>
          </div>
        </div>
        <div
          style={{
            font: 'var(--font-title)',
            fontSize: '30px',
            fontWeight: 600,
            margin: '16px 0 4px',
          }}
        >
          {money(row.amount_minor, currency)}
        </div>
        <div className="s-sub" style={{ marginBottom: '14px' }}>
          {paidLine}
        </div>
        <div className={shared.flabel}>Split</div>
        <div>
          {(row.splits ?? []).map((s) => (
            <div
              key={s.party_id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '11px',
                padding: '8px 0',
                borderBottom: '1px solid var(--line)',
              }}
            >
              <KitAvatar name={s.name} size="28px" color={s.color} initials={s.initials} />
              <span style={{ flex: 1, font: 'var(--t-body)', fontSize: '13.5px' }}>
                {s.party_id === me ? 'You' : s.name}
              </span>
              <span style={{ font: 'var(--t-mono)', fontSize: '12px', color: 'var(--ink-2)' }}>
                {money(s.share_minor, currency)}
              </span>
            </div>
          ))}
        </div>
        <div className="kit-modal-foot">
          <ArmedButton
            className={`kit-btn danger ${shared.del}`}
            label="Delete"
            armedLabel="Delete — sure?"
            onConfirm={() => onDelete(row.expense_id)}
          />
          <button type="button" className="kit-btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="kit-btn primary" onClick={() => onEdit(row)}>
            Edit
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
