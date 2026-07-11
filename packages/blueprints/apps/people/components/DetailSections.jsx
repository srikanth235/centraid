// The profile drawer's body sections (relationships, important dates, tasks,
// notes, gift ideas, debts, contact, history) — split out of Details.jsx to
// keep files small. Pure functions of props: `dp` is the freshly-read PERSON,
// `adders` is which "+ add" affordances are open. Every write flows out
// through the `on*` callback props; nothing here calls the vault itself.
import { fmtMoney } from '../kit.js';
import {
  cadence,
  daysSince,
  daysSinceIso,
  daysUntilAnnual,
  fmt,
  fmtMonthDay,
  inFmt,
  statusOf,
} from '../format.js';
import { I } from '../icons.js';
import { Icon } from './Shared.jsx';
import {
  DateAddRow,
  DebtAddRow,
  GiftAddRow,
  NoteAddRow,
  RelationshipAddRow,
  TaskAddRow,
} from './AddRows.jsx';

function SectionLabel({ text, addKey, open, onToggle, extra }) {
  return (
    <div className="d-detail-label">
      {text}
      {extra ?? null}
      {addKey ? (
        <button type="button" className="d-addtoggle" onClick={onToggle}>
          {open ? 'close' : '+ add'}
        </button>
      ) : null}
    </div>
  );
}

function DebtsSection({ dp, adders, onToggleAdder, onAddDebt, onSettleDebt }) {
  const debts = dp.debts ?? [];
  const net = debts.reduce((a, b) => a + (b.direction === 'owed' ? b.amount_minor : -b.amount_minor), 0);
  const netLabel =
    net === 0 ? 'settled' : net > 0 ? `net owes you ${fmtMoney(net, 'USD')}` : `net you owe ${fmtMoney(-net, 'USD')}`;
  const netEl =
    debts.length > 0 ? (
      <span
        style={{
          fontFamily: 'var(--mono)',
          fontSize: '11px',
          textTransform: 'none',
          letterSpacing: 0,
          color: net >= 0 ? 'var(--ok)' : 'var(--ink-3)',
        }}
      >
        {netLabel}
      </span>
    ) : null;
  return (
    <>
      <SectionLabel
        text="Debts"
        addKey="debt"
        open={!!adders.debt}
        onToggle={() => onToggleAdder('debt')}
        extra={netEl}
      />
      {debts.length > 0 ? (
        <div className="d-kv">
          {debts.map((b) => {
            const owe = b.direction === 'owe';
            const amount = fmtMoney(b.amount_minor, 'USD');
            return (
              <div className="d-kv-row" key={b.debt_id}>
                <span style={{ flex: 1 }}>
                  <span style={{ display: 'block', font: 'var(--t-body)', fontWeight: 500, color: owe ? 'var(--ink)' : 'var(--ok)' }}>
                    {(owe ? 'You owe ' : 'Owes you ') + amount}
                  </span>
                  <span style={{ display: 'block', font: 'var(--t-small)', fontSize: '12px', color: 'var(--ink-3)' }}>
                    {b.reason || ''}
                  </span>
                </span>
                <button
                  type="button"
                  className="kit-chip quiet d-chip-sm"
                  style={{ borderColor: 'var(--line)', color: 'var(--ink-2)' }}
                  onClick={() => onSettleDebt(b.debt_id)}
                >
                  settle
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      {adders.debt ? <DebtAddRow onSubmit={(fields) => onAddDebt(fields)} /> : null}
    </>
  );
}

export function Sections({
  dp,
  color,
  adders,
  onMessage,
  onCall,
  onToggleStar,
  onToggleAdder,
  onAddRelationship,
  onAddDate,
  onToggleReminder,
  onAddTask,
  onToggleTask,
  onAddNote,
  onAddGift,
  onToggleGift,
  onAddDebt,
  onSettleDebt,
}) {
  const st = statusOf(dp);
  const days = daysSince(dp);
  const contact = dp.contact ?? [];
  const rels = dp.relationships ?? [];
  const dates = dp.dates ?? [];
  const tasks = dp.tasks ?? [];
  const gifts = dp.gifts ?? [];
  const notes = dp.notes ?? [];
  const interactions = dp.interactions ?? [];

  return (
    <>
      <div className="d-detail-actions">
        <button type="button" className="kit-btn primary d-detail-btn" onClick={onMessage}>
          <Icon svg={I.message} />
          Message
        </button>
        <button type="button" className="kit-btn d-detail-btn" onClick={onCall}>
          <Icon svg={I.call} />
          Call
        </button>
        <button type="button" className="kit-btn d-detail-btn" onClick={onToggleStar}>
          {dp.starred ? '★ Favorite' : '☆ Favorite'}
        </button>
      </div>

      <div
        style={{
          border: '1px solid var(--line)',
          borderRadius: '12px',
          background: 'var(--bg-elev)',
          padding: '13px 15px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <div style={{ font: 'var(--t-strong)', fontSize: '13px' }}>Keep in touch</div>
          <div style={{ font: 'var(--t-small)', fontSize: '12px', color: 'var(--ink-2)', marginTop: '2px' }}>
            {cadence(dp.cadence_days ?? 30)} · last {fmt(days)}
          </div>
        </div>
        <span className="kit-chip quiet d-chip-sm" style={{ borderColor: st.color, color: st.color }}>
          {st.label}
        </span>
      </div>

      {dp.met ? (
        <>
          <div className="d-detail-label">How you met</div>
          <p style={{ margin: 0, font: 'var(--t-body)', color: 'var(--ink-2)', lineHeight: 1.5 }}>{dp.met}</p>
        </>
      ) : null}

      {contact.length > 0 ? (
        <>
          <div className="d-detail-label">Contact</div>
          <div className="d-kv">
            {contact.map((c, i) => (
              <div className="d-kv-row" key={i}>
                <Icon svg={c.kind === 'phone' ? I.phone : I.mail} />
                <span className="d-kv-v">{c.value}</span>
                <span className="d-kv-k">{c.kind}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <SectionLabel text="Relationships" addKey="rel" open={!!adders.rel} onToggle={() => onToggleAdder('rel')} />
      {rels.length > 0 ? (
        <div>
          {rels.map((r, i) => (
            <div className="d-rel" key={i}>
              <span className="d-rel-badge">{r.pet === 'cat' ? '🐱' : r.pet === 'dog' ? '🐶' : r.name?.[0] || '·'}</span>
              <span style={{ flex: 1, font: 'var(--t-body)', fontWeight: 500 }}>{r.name}</span>
              <span style={{ font: 'var(--t-small)', fontSize: '11.5px', color: 'var(--ink-3)' }}>{r.kind}</span>
            </div>
          ))}
        </div>
      ) : null}
      {adders.rel ? <RelationshipAddRow onSubmit={(fields) => onAddRelationship(fields)} /> : null}

      <SectionLabel text="Important dates" addKey="date" open={!!adders.date} onToggle={() => onToggleAdder('date')} />
      {dates.length > 0 ? (
        <div className="d-kv">
          {dates.map((d) => (
            <div className="d-kv-row" key={d.date_id}>
              <span style={{ flex: 1 }}>
                <span style={{ display: 'block', font: 'var(--t-body)', fontWeight: 500 }}>{d.label}</span>
                <span style={{ display: 'block', font: 'var(--t-small)', fontSize: '12px', color: 'var(--ink-3)' }}>
                  {fmtMonthDay(d.month_day)} · {inFmt(daysUntilAnnual(d.month_day))}
                </span>
              </span>
              <button
                type="button"
                className="d-mini-btn"
                aria-label="Reminder"
                style={{
                  background: d.reminder_on
                    ? 'color-mix(in oklab, var(--_accent) 12%, transparent)'
                    : 'color-mix(in oklab, var(--ink) 5%, transparent)',
                  color: d.reminder_on ? 'var(--_accent)' : 'var(--ink-3)',
                }}
                onClick={() => onToggleReminder(d.date_id)}
              >
                <Icon svg={I.bellSm} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {adders.date ? <DateAddRow onSubmit={(fields) => onAddDate(fields)} /> : null}

      <SectionLabel text="Tasks" addKey="task" open={!!adders.task} onToggle={() => onToggleAdder('task')} />
      {tasks.length > 0 ? (
        <div>
          {tasks.map((t) => (
            <div className="d-taskrow" key={t.task_id}>
              <button
                type="button"
                className={t.done ? 'd-taskbox on' : 'd-taskbox'}
                aria-label="Toggle task"
                onClick={() => onToggleTask(t.task_id)}
              >
                {t.done ? <Icon svg={I.checkTask} /> : null}
              </button>
              <span
                style={{
                  flex: 1,
                  font: 'var(--t-body)',
                  color: t.done ? 'var(--ink-3)' : 'var(--ink)',
                  textDecoration: t.done ? 'line-through' : 'none',
                }}
              >
                {t.text}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {adders.task ? <TaskAddRow onSubmit={(fields) => onAddTask(fields)} /> : null}

      <div className="d-detail-label">Notes</div>
      <div>
        {notes.map((nn, i) => (
          <div className="d-note" key={i}>
            <p>{nn.text}</p>
            <div className="when">{fmt(daysSinceIso(nn.created_at))}</div>
          </div>
        ))}
        <NoteAddRow onSubmit={(fields) => onAddNote(fields)} />
      </div>

      <SectionLabel text="Gift ideas" addKey="gift" open={!!adders.gift} onToggle={() => onToggleAdder('gift')} />
      {gifts.length > 0 ? (
        <div>
          {gifts.map((g) => {
            const given = g.state === 'given';
            return (
              <div className="d-taskrow" key={g.gift_id}>
                <Icon svg={I.gift} />
                <span
                  style={{
                    flex: 1,
                    font: 'var(--t-body)',
                    color: given ? 'var(--ink-3)' : 'var(--ink)',
                    textDecoration: given ? 'line-through' : 'none',
                  }}
                >
                  {g.text}
                </span>
                <button
                  type="button"
                  className="kit-chip quiet d-chip-sm"
                  style={{
                    borderColor: given
                      ? 'color-mix(in oklab, var(--ok) 30%, transparent)'
                      : 'color-mix(in oklab, var(--c-family) 30%, transparent)',
                    background: given
                      ? 'color-mix(in oklab, var(--ok) 14%, transparent)'
                      : 'color-mix(in oklab, var(--c-family) 14%, transparent)',
                    color: given ? 'var(--ok)' : 'var(--c-family)',
                  }}
                  onClick={() => onToggleGift(g.gift_id)}
                >
                  {g.state}
                </button>
              </div>
            );
          })}
        </div>
      ) : null}
      {adders.gift ? <GiftAddRow onSubmit={(fields) => onAddGift(fields)} /> : null}

      <DebtsSection dp={dp} adders={adders} onToggleAdder={onToggleAdder} onAddDebt={onAddDebt} onSettleDebt={onSettleDebt} />

      {interactions.length > 0 ? (
        <>
          <div className="d-detail-label">History</div>
          <div>
            {interactions.map((t, i) => (
              <div className="d-activity-item" key={i}>
                <div className="d-activity-rail">
                  <span className="d-activity-dot" style={{ background: color }}></span>
                  <span className="d-activity-line"></span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span className="d-activity-kind" style={{ color: 'var(--ink-2)' }}>
                      {t.kind}
                    </span>
                    <span className="d-activity-date" style={{ marginLeft: 'auto' }}>
                      {fmt(daysSinceIso(t.occurred_at))}
                    </span>
                  </div>
                  <div style={{ marginTop: '2px', font: 'var(--t-body)', fontSize: '13.5px', color: 'var(--ink-2)' }}>
                    {t.text || ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}
