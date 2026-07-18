// The profile drawer's body sections (relationships, important dates, tasks,
// notes, gift ideas, debts, contact, history) — split out of Details.tsx to
// keep files small. Pure functions of props: `dp` is the freshly-read PERSON,
// `adders` is which "+ add" affordances are open. Every write flows out
// through the `on*` callback props; nothing here calls the vault itself.
import type { ReactNode } from '../react-core.min.js';
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
} from '../format.ts';
import { I } from '../icons.ts';
import type { DetailPerson } from '../types.ts';
import { Icon } from './Shared.tsx';
import type { DrawerCallbacks } from './Details.tsx';
import {
  DateAddRow,
  DebtAddRow,
  GiftAddRow,
  NoteAddRow,
  RelationshipAddRow,
  TaskAddRow,
} from './AddRows.tsx';
import styles from './DetailSections.module.css';
import shared from './shared.module.css';

function SectionLabel({
  text,
  addKey,
  open,
  onToggle,
  extra,
}: {
  text: string;
  addKey?: string;
  open?: boolean;
  onToggle?: () => void;
  extra?: ReactNode;
}) {
  return (
    <div className={styles.detailLabel}>
      {text}
      {extra ?? null}
      {addKey ? (
        <button type="button" className={styles.addToggle} onClick={onToggle}>
          {open ? 'close' : '+ add'}
        </button>
      ) : null}
    </div>
  );
}

function DebtsSection({
  dp,
  adders,
  onToggleAdder,
  onAddDebt,
  onSettleDebt,
}: {
  dp: DetailPerson;
  adders: Record<string, boolean>;
  onToggleAdder: (key: string) => void;
  onAddDebt: (fields: Record<string, unknown>) => Promise<boolean>;
  onSettleDebt: (debtId: string) => void;
}) {
  const debts = dp.debts ?? [];
  const net = debts.reduce(
    (a, b) => a + (b.direction === 'owed' ? b.amount_minor : -b.amount_minor),
    0,
  );
  const netLabel =
    net === 0
      ? 'settled'
      : net > 0
        ? `net owes you ${fmtMoney(net, 'USD')}`
        : `net you owe ${fmtMoney(-net, 'USD')}`;
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
        <div className={styles.kv}>
          {debts.map((b) => {
            const owe = b.direction === 'owe';
            const amount = fmtMoney(b.amount_minor, 'USD');
            return (
              <div className={styles.kvRow} key={b.debt_id}>
                <span style={{ flex: 1 }}>
                  <span
                    style={{
                      display: 'block',
                      font: 'var(--t-body)',
                      fontWeight: 500,
                      color: owe ? 'var(--ink)' : 'var(--ok)',
                    }}
                  >
                    {(owe ? 'You owe ' : 'Owes you ') + amount}
                  </span>
                  <span
                    style={{
                      display: 'block',
                      font: 'var(--t-small)',
                      fontSize: '12px',
                      color: 'var(--ink-3)',
                    }}
                  >
                    {b.reason || ''}
                  </span>
                </span>
                <button
                  type="button"
                  className={`kit-chip quiet ${styles.chipSm}`}
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
}: {
  dp: DetailPerson;
  color: string;
  adders: Record<string, boolean>;
} & DrawerCallbacks) {
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
      <div className={styles.detailActions}>
        <button type="button" className={`kit-btn primary ${shared.detailBtn}`} onClick={onMessage}>
          <Icon svg={I.message} />
          Message
        </button>
        <button type="button" className={`kit-btn ${shared.detailBtn}`} onClick={onCall}>
          <Icon svg={I.call} />
          Call
        </button>
        <button type="button" className={`kit-btn ${shared.detailBtn}`} onClick={onToggleStar}>
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
          <div
            style={{
              font: 'var(--t-small)',
              fontSize: '12px',
              color: 'var(--ink-2)',
              marginTop: '2px',
            }}
          >
            {cadence(dp.cadence_days ?? 30)} · last {fmt(days)}
          </div>
        </div>
        <span
          className={`kit-chip quiet ${styles.chipSm}`}
          style={{ borderColor: st.color, color: st.color }}
        >
          {st.label}
        </span>
      </div>

      {dp.met ? (
        <>
          <div className={styles.detailLabel}>How you met</div>
          <p style={{ margin: 0, font: 'var(--t-body)', color: 'var(--ink-2)', lineHeight: 1.5 }}>
            {dp.met}
          </p>
        </>
      ) : null}

      {contact.length > 0 ? (
        <>
          <div className={styles.detailLabel}>Contact</div>
          <div className={styles.kv}>
            {contact.map((c, i) => (
              <div className={styles.kvRow} key={i}>
                <Icon svg={c.kind === 'phone' ? I.phone : I.mail} />
                <span className={styles.kvV}>{c.value}</span>
                <span className={styles.kvK}>{c.kind}</span>
              </div>
            ))}
          </div>
        </>
      ) : null}

      <SectionLabel
        text="Relationships"
        addKey="rel"
        open={!!adders.rel}
        onToggle={() => onToggleAdder('rel')}
      />
      {rels.length > 0 ? (
        <div>
          {rels.map((r, i) => (
            <div className={styles.rel} key={i}>
              <span className={styles.relBadge}>
                {r.pet === 'cat' ? '🐱' : r.pet === 'dog' ? '🐶' : r.name?.[0] || '·'}
              </span>
              <span style={{ flex: 1, font: 'var(--t-body)', fontWeight: 500 }}>{r.name}</span>
              <span style={{ font: 'var(--t-small)', fontSize: '11.5px', color: 'var(--ink-3)' }}>
                {r.kind}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      {adders.rel ? <RelationshipAddRow onSubmit={(fields) => onAddRelationship(fields)} /> : null}

      <SectionLabel
        text="Important dates"
        addKey="date"
        open={!!adders.date}
        onToggle={() => onToggleAdder('date')}
      />
      {dates.length > 0 ? (
        <div className={styles.kv}>
          {dates.map((d) => (
            <div className={styles.kvRow} key={d.date_id}>
              <span style={{ flex: 1 }}>
                <span style={{ display: 'block', font: 'var(--t-body)', fontWeight: 500 }}>
                  {d.label}
                </span>
                <span
                  style={{
                    display: 'block',
                    font: 'var(--t-small)',
                    fontSize: '12px',
                    color: 'var(--ink-3)',
                  }}
                >
                  {fmtMonthDay(d.month_day)} · {inFmt(daysUntilAnnual(d.month_day))}
                </span>
              </span>
              <button
                type="button"
                className={shared.miniBtn}
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

      <SectionLabel
        text="Tasks"
        addKey="task"
        open={!!adders.task}
        onToggle={() => onToggleAdder('task')}
      />
      {tasks.length > 0 ? (
        <div>
          {tasks.map((t) => (
            <div className={styles.taskrow} key={t.task_id}>
              <button
                type="button"
                className={t.done ? `${styles.taskbox} ${styles.on}` : styles.taskbox}
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

      <div className={styles.detailLabel}>Notes</div>
      <div>
        {notes.map((nn, i) => (
          <div className={styles.note} key={i}>
            <p>{nn.text}</p>
            <div className={styles.when}>{fmt(daysSinceIso(nn.created_at))}</div>
          </div>
        ))}
        <NoteAddRow onSubmit={(fields) => onAddNote(fields)} />
      </div>

      <SectionLabel
        text="Gift ideas"
        addKey="gift"
        open={!!adders.gift}
        onToggle={() => onToggleAdder('gift')}
      />
      {gifts.length > 0 ? (
        <div>
          {gifts.map((g) => {
            const given = g.state === 'given';
            return (
              <div className={styles.taskrow} key={g.gift_id}>
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
                  className={`kit-chip quiet ${styles.chipSm}`}
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

      <DebtsSection
        dp={dp}
        adders={adders}
        onToggleAdder={onToggleAdder}
        onAddDebt={onAddDebt}
        onSettleDebt={onSettleDebt}
      />

      {interactions.length > 0 ? (
        <>
          <div className={styles.detailLabel}>History</div>
          <div>
            {interactions.map((t, i) => (
              <div className={shared.activityItem} key={i}>
                <div className={shared.activityRail}>
                  <span className={shared.activityDot} style={{ background: color }}></span>
                  <span className={shared.activityLine}></span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <span className={shared.activityKind} style={{ color: 'var(--ink-2)' }}>
                      {t.kind}
                    </span>
                    <span className={shared.activityDate} style={{ marginLeft: 'auto' }}>
                      {fmt(daysSinceIso(t.occurred_at))}
                    </span>
                  </div>
                  <div
                    style={{
                      marginTop: '2px',
                      font: 'var(--t-body)',
                      fontSize: '13.5px',
                      color: 'var(--ink-2)',
                    }}
                  >
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
