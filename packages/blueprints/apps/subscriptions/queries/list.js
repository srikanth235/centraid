/**
 * The subscriptions projection: every finance.recurring_series — the vault's
 * model of money that repeats — joined to the account it charges and the
 * counterparty it pays, with each amount normalized to a monthly figure so
 * the running total is comparable. Active series with an anchor date also
 * carry next_on (the anchor rolled forward by the cadence to today or later)
 * and feed the 30-day upcoming window. Files attach per subscription (a
 * receipt or contract). Everything comes from the vault; this app holds no
 * rows.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

const CADENCE = {
  DAILY: { label: 'Daily', unit: 'days', perMonth: 365 / 12 },
  WEEKLY: { label: 'Weekly', unit: 'weeks', perMonth: 52 / 12 },
  MONTHLY: { label: 'Monthly', unit: 'months', perMonth: 1 },
  YEARLY: { label: 'Yearly', unit: 'years', perMonth: 1 / 12 },
};

/**
 * Read FREQ (and an optional INTERVAL) out of an rrule string; default
 * monthly. `FREQ=MONTHLY;INTERVAL=3` → every 3 months at a third of the
 * monthly rate, so quarterly charges stop masquerading as monthly ones.
 */
function cadenceOf(rrule) {
  const text = String(rrule ?? '');
  const match = /FREQ=([A-Z]+)/.exec(text);
  const freq = CADENCE[match?.[1]] ? match[1] : 'MONTHLY';
  const base = CADENCE[freq];
  const raw = Number(/INTERVAL=(\d+)/.exec(text)?.[1] ?? 1);
  const interval = Number.isFinite(raw) && raw > 1 ? Math.floor(raw) : 1;
  return {
    freq,
    interval,
    label: interval === 1 ? base.label : `Every ${interval} ${base.unit}`,
    unit: base.unit,
    perMonth: base.perMonth / interval,
  };
}

// ---------- Renewal dates: roll the anchor forward by the cadence ----------
// A series' anchor_on is its first/next charge date; the k-th occurrence is
// always computed from the anchor (never cumulatively), so a Jan 31 monthly
// charge clamps to Feb 28 and returns to Mar 31 instead of drifting.

const DAY_MS = 86400000;

/** The vault's local YYYY-MM-DD for "today" — never the UTC slice. */
function todayKey() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function partsOf(key) {
  const [y, m, d] = key.split('-').map(Number);
  return { y, m, d };
}

function addDaysKey(key, n) {
  const { y, m, d } = partsOf(key);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Add months keeping the anchor's day-of-month, clamped to month length. */
function addMonthsKey(key, n) {
  const { y, m, d } = partsOf(key);
  const total = m - 1 + n;
  const yy = y + Math.floor(total / 12);
  const mm = ((total % 12) + 12) % 12;
  const last = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
  const pad = (v) => String(v).padStart(2, '0');
  return `${yy}-${pad(mm + 1)}-${pad(Math.min(d, last))}`;
}

function stepOf(cad) {
  if (cad.freq === 'DAILY') return { days: cad.interval };
  if (cad.freq === 'WEEKLY') return { days: cad.interval * 7 };
  return { months: cad.freq === 'YEARLY' ? cad.interval * 12 : cad.interval };
}

/** The k-th charge of a series, counted from its anchor. */
function occurrenceAt(anchorKey, cad, k) {
  const step = stepOf(cad);
  return step.days
    ? addDaysKey(anchorKey, k * step.days)
    : addMonthsKey(anchorKey, k * step.months);
}

/** Smallest k whose occurrence lands on or after fromKey. */
function firstOnOrAfter(anchorKey, cad, fromKey) {
  if (anchorKey >= fromKey) return 0;
  const step = stepOf(cad);
  if (step.days) {
    const a = partsOf(anchorKey);
    const f = partsOf(fromKey);
    const gap = Math.round((Date.UTC(f.y, f.m - 1, f.d) - Date.UTC(a.y, a.m - 1, a.d)) / DAY_MS);
    return Math.ceil(gap / step.days);
  }
  const a = partsOf(anchorKey);
  const f = partsOf(fromKey);
  const months = (f.y - a.y) * 12 + (f.m - a.m);
  let k = Math.max(0, Math.floor(months / step.months) - 1);
  while (occurrenceAt(anchorKey, cad, k) < fromKey) k += 1;
  return k;
}

/** Shared attachment-projection shape (see the Notes app). */
function attachmentsBySubject(subjectType, attachments, contentById) {
  const bySubject = new Map();
  for (const a of attachments) {
    if (a.subject_type !== subjectType) continue;
    const content = contentById.get(a.content_id);
    if (!bySubject.has(a.subject_id)) bySubject.set(a.subject_id, []);
    bySubject.get(a.subject_id).push({
      attachment_id: a.attachment_id,
      content_id: a.content_id,
      role: a.role,
      is_primary: a.is_primary,
      media_type: content?.media_type ?? 'application/octet-stream',
      title: content?.title ?? null,
      content_uri: content?.content_uri ?? '',
      byte_size: content?.byte_size ?? 0,
    });
  }
  for (const list of bySubject.values()) {
    list.sort((x, y) => (y.is_primary ?? 0) - (x.is_primary ?? 0));
  }
  return bySubject;
}

export default async ({ ctx }) => {
  const purpose = 'dpv:Billing';
  try {
    const [series, accounts, parties, contents, attachments] = await Promise.all([
      ctx.vault.read({ entity: 'finance.recurring_series', purpose }),
      ctx.vault.read({ entity: 'core.account', purpose }),
      ctx.vault.read({ entity: 'core.party', purpose }),
      ctx.vault.read({ entity: 'core.content_item', purpose }),
      ctx.vault.read({
        entity: 'core.attachment',
        where: [{ column: 'subject_type', op: 'eq', value: 'finance.recurring_series' }],
        purpose,
      }),
    ]);

    const accountById = new Map((accounts.rows ?? []).map((a) => [a.account_id, a]));
    const partyName = new Map((parties.rows ?? []).map((p) => [p.party_id, p.display_name]));
    const contentById = new Map((contents.rows ?? []).map((c) => [c.content_id, c]));
    const attBySeries = attachmentsBySubject(
      'finance.recurring_series',
      attachments.rows ?? [],
      contentById,
    );

    const today = todayKey();
    const horizon = addDaysKey(today, 30);
    const upcoming = [];
    let monthlyActiveMinor = 0;
    const subscriptions = (series.rows ?? [])
      .map((s) => {
        const cad = cadenceOf(s.rrule);
        const monthly = Math.round((s.expected_minor ?? 0) * cad.perMonth);
        if (s.status === 'active') monthlyActiveMinor += monthly;
        const account = accountById.get(s.account_id);
        const currency = account?.currency ?? '';
        // The next renewal: the anchor rolled forward by the cadence until
        // it lands on or after today. Read-only — the reconciler still owns
        // matching real transactions; this only projects the calendar.
        const anchorOn = /^\d{4}-\d{2}-\d{2}/.test(String(s.anchor_on ?? ''))
          ? String(s.anchor_on).slice(0, 10)
          : null;
        let nextOn = null;
        if (s.status === 'active' && anchorOn) {
          let k = firstOnOrAfter(anchorOn, cad, today);
          nextOn = occurrenceAt(anchorOn, cad, k);
          // Every charge inside the 30-day window (a weekly series lands
          // several times); capped so a degenerate rrule can't spin.
          for (let on = nextOn, guard = 0; on <= horizon && guard < 40; guard += 1) {
            upcoming.push({
              series_id: s.series_id,
              on,
              expected_minor: s.expected_minor,
              currency,
            });
            k += 1;
            on = occurrenceAt(anchorOn, cad, k);
          }
        }
        return {
          series_id: s.series_id,
          expected_minor: s.expected_minor,
          currency,
          account: account?.name ?? 'Account',
          rrule: s.rrule,
          cadence_label: cad.label,
          monthly_minor: monthly,
          status: s.status,
          anchor_on: anchorOn,
          next_on: nextOn,
          counterparty: s.counterparty_party_id
            ? (partyName.get(s.counterparty_party_id) ?? null)
            : null,
          attachments: attBySeries.get(s.series_id) ?? [],
        };
      })
      .toSorted(
        (a, b) =>
          (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) ||
          String(a.next_on ?? '9999-12-31').localeCompare(String(b.next_on ?? '9999-12-31')) ||
          b.monthly_minor - a.monthly_minor,
      );
    upcoming.sort((a, b) => a.on.localeCompare(b.on) || b.expected_minor - a.expected_minor);

    return {
      subscriptions,
      monthly_active_minor: monthlyActiveMinor,
      upcoming,
      accounts: (accounts.rows ?? []).map((a) => ({
        account_id: a.account_id,
        name: a.name,
        currency: a.currency,
      })),
      parties: (parties.rows ?? [])
        .map((p) => ({ party_id: p.party_id, display_name: p.display_name }))
        .toSorted((a, b) => String(a.display_name).localeCompare(String(b.display_name))),
    };
  } catch (err) {
    return {
      subscriptions: [],
      monthly_active_minor: 0,
      upcoming: [],
      accounts: [],
      parties: [],
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};
