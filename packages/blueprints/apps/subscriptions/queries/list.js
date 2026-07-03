/**
 * The subscriptions projection: every finance.recurring_series — the vault's
 * model of money that repeats — joined to the account it charges and the
 * counterparty it pays, with each amount normalized to a monthly figure so
 * the running total is comparable. Files attach per subscription (a receipt
 * or contract). Everything comes from the vault; this app holds no rows.
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
  const freq = /FREQ=([A-Z]+)/.exec(text);
  const base = CADENCE[freq?.[1]] ?? CADENCE.MONTHLY;
  const interval = Number(/INTERVAL=(\d+)/.exec(text)?.[1] ?? 1);
  if (!Number.isFinite(interval) || interval <= 1) return base;
  return {
    label: `Every ${interval} ${base.unit}`,
    unit: base.unit,
    perMonth: base.perMonth / interval,
  };
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

    let monthlyActiveMinor = 0;
    const subscriptions = (series.rows ?? [])
      .map((s) => {
        const cad = cadenceOf(s.rrule);
        const monthly = Math.round((s.expected_minor ?? 0) * cad.perMonth);
        if (s.status === 'active') monthlyActiveMinor += monthly;
        const account = accountById.get(s.account_id);
        return {
          series_id: s.series_id,
          expected_minor: s.expected_minor,
          currency: account?.currency ?? '',
          account: account?.name ?? 'Account',
          rrule: s.rrule,
          cadence_label: cad.label,
          monthly_minor: monthly,
          status: s.status,
          counterparty: s.counterparty_party_id
            ? (partyName.get(s.counterparty_party_id) ?? null)
            : null,
          attachments: attBySeries.get(s.series_id) ?? [],
        };
      })
      .toSorted(
        (a, b) =>
          (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) ||
          b.monthly_minor - a.monthly_minor,
      );

    return {
      subscriptions,
      monthly_active_minor: monthlyActiveMinor,
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
      accounts: [],
      parties: [],
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};
