/**
 * One person's full profile, gathered from the vault: the party (name), the
 * people_profile (role, cadence, last-contacted, how-you-met, avatar hue), the
 * party's contact identifiers (phone/email), and every child record — circle,
 * favorite, relationships, important dates, notes (annotations on the party),
 * tasks, gift ideas, open debts and the interaction history. Nothing is stored
 * by the app; it is all a read of the owner's vault.
 *
 * @type {import('@centraid/app-engine').QueryHandler}
 */

const CIRCLE_SCHEME_URI = 'https://centraid.dev/schemes/circles';
const FLAGS_SCHEME_URI = 'https://centraid.dev/schemes/flags';

export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const partyId = String(input?.party_id ?? '');
  if (!partyId) return { person: null };
  try {
    const [profiles, parties] = await Promise.all([
      ctx.vault.read({
        entity: 'people.profile',
        where: [{ column: 'party_id', op: 'eq', value: partyId }],
        purpose,
      }),
      ctx.vault.read({
        entity: 'core.party',
        where: [{ column: 'party_id', op: 'eq', value: partyId }],
        purpose,
      }),
    ]);
    const profile = (profiles.rows ?? [])[0];
    const party = (parties.rows ?? [])[0];
    if (!profile || !party) return { person: null };

    const [ids, rels, dates, notes, tasks, gifts, debts, interactions, tags, concepts, schemes] =
      await Promise.all([
        ctx.vault.read({
          entity: 'core.party_identifier',
          where: [{ column: 'party_id', op: 'eq', value: partyId }],
          purpose,
        }),
        ctx.vault.read({
          entity: 'people.relationship',
          where: [{ column: 'party_id', op: 'eq', value: partyId }],
          purpose,
        }),
        ctx.vault.read({
          entity: 'people.important_date',
          where: [{ column: 'party_id', op: 'eq', value: partyId }],
          purpose,
        }),
        ctx.vault.read({
          entity: 'knowledge.annotation',
          where: [
            { column: 'target_type', op: 'eq', value: 'core.party' },
            { column: 'target_id', op: 'eq', value: partyId },
          ],
          orderBy: { column: 'created_at', dir: 'desc' },
          purpose,
        }),
        ctx.vault.read({
          entity: 'people.task',
          where: [{ column: 'party_id', op: 'eq', value: partyId }],
          orderBy: { column: 'created_at', dir: 'desc' },
          purpose,
        }),
        ctx.vault.read({
          entity: 'people.gift',
          where: [{ column: 'party_id', op: 'eq', value: partyId }],
          orderBy: { column: 'created_at', dir: 'desc' },
          purpose,
        }),
        ctx.vault.read({
          entity: 'people.debt',
          where: [{ column: 'party_id', op: 'eq', value: partyId }],
          purpose,
        }),
        ctx.vault.read({
          entity: 'people.interaction',
          where: [{ column: 'party_id', op: 'eq', value: partyId }],
          orderBy: { column: 'occurred_at', dir: 'desc' },
          purpose,
        }),
        ctx.vault.read({
          entity: 'core.tag',
          where: [
            { column: 'target_type', op: 'eq', value: 'core.party' },
            { column: 'target_id', op: 'eq', value: partyId },
          ],
          purpose,
        }),
        ctx.vault.read({ entity: 'core.concept', purpose }),
        ctx.vault.read({ entity: 'core.concept_scheme', purpose }),
      ]);

    const circleScheme = (schemes.rows ?? []).find((s) => s.uri === CIRCLE_SCHEME_URI);
    const circleConceptIds = new Set(
      (concepts.rows ?? [])
        .filter((c) => circleScheme && c.scheme_id === circleScheme.scheme_id)
        .map((c) => c.concept_id),
    );
    const flagsScheme = (schemes.rows ?? []).find((s) => s.uri === FLAGS_SCHEME_URI);
    const starredConceptId = flagsScheme
      ? ((concepts.rows ?? []).find(
          (c) => c.scheme_id === flagsScheme.scheme_id && c.notation === 'starred',
        )?.concept_id ?? null)
      : null;
    let circleId = null;
    let starred = false;
    for (const t of tags.rows ?? []) {
      if (circleConceptIds.has(t.concept_id)) circleId = t.concept_id;
      if (starredConceptId != null && t.concept_id === starredConceptId) starred = true;
    }

    const contact = [];
    for (const i of ids.rows ?? []) {
      if (i.scheme === 'tel') contact.push({ kind: 'phone', value: i.value });
      else if (i.scheme === 'email') contact.push({ kind: 'email', value: i.value });
    }

    const person = {
      party_id: partyId,
      name: party.display_name,
      role: profile.role ?? '',
      avatar_color: profile.avatar_color ?? null,
      cadence_days: profile.cadence_days,
      last_contacted_at: profile.last_contacted_at ?? null,
      created_at: profile.created_at,
      met: profile.met ?? '',
      circle_id: circleId,
      starred,
      contact,
      relationships: (rels.rows ?? []).map((r) => ({
        relationship_id: r.relationship_id,
        name: r.name,
        kind: r.kind,
        pet: r.pet ?? null,
      })),
      dates: (dates.rows ?? []).map((d) => ({
        date_id: d.date_id,
        label: d.label,
        month_day: d.month_day,
        reminder_on: !!d.reminder_on,
      })),
      notes: (notes.rows ?? []).map((n) => ({
        annotation_id: n.annotation_id,
        text: n.body_text,
        created_at: n.created_at,
      })),
      tasks: (tasks.rows ?? []).map((t) => ({
        task_id: t.task_id,
        text: t.body_text,
        done: !!t.done,
      })),
      gifts: (gifts.rows ?? []).map((g) => ({
        gift_id: g.gift_id,
        text: g.body_text,
        state: g.state,
      })),
      debts: (debts.rows ?? [])
        .filter((d) => d.settled_at == null)
        .map((d) => ({
          debt_id: d.debt_id,
          direction: d.direction,
          amount_minor: d.amount_minor,
          currency: d.currency,
          reason: d.reason ?? '',
        })),
      interactions: (interactions.rows ?? []).map((i) => ({
        interaction_id: i.interaction_id,
        kind: i.kind,
        text: i.body_text ?? '',
        occurred_at: i.occurred_at,
      })),
    };
    return { person };
  } catch (err) {
    return { person: null, vaultDenied: { code: err.code, message: err.message } };
  }
};
