/**
 * One person's full profile, gathered from the vault: the party (name), the
 * people_profile (role, cadence, last-contacted, how-you-met, avatar hue), the
 * party's contact identifiers (phone/email), and every child record — list,
 * favorite, relationships, important dates, notes (annotations on the party),
 * tasks, gift ideas, open debts and the interaction history. Nothing is stored
 * by the app; it is all a read of the owner's vault.
 *
 * TS conversion note: the vault read surface returns `Record<string, unknown>`
 * rows (see HandlerCtx.vault), so each raw row set is cast once to a typed
 * shape (`as unknown as X[]`) at its read site. Handler logic is otherwise
 * byte-for-byte the pre-conversion JS.
 */

interface RawProfile {
  role?: string | null;
  avatar_color?: string | null;
  cadence_days: number;
  last_contacted_at?: string | null;
  created_at: string;
  met?: string | null;
}

interface RawParty {
  display_name: string;
}

interface RawIdentifier {
  scheme: string;
  value: string;
}

interface RawRelationship {
  relationship_id: string;
  name: string;
  kind: string;
  pet?: string | null;
}

interface RawDate {
  date_id: string;
  label: string;
  month_day: string;
  reminder_on?: number | boolean | null;
}

interface RawNote {
  annotation_id: string;
  body_text: string;
  created_at: string;
}

interface RawTask {
  task_id: string;
  body_text: string;
  done?: number | boolean | null;
}

interface RawGift {
  gift_id: string;
  body_text: string;
  state: string;
}

interface RawDebt {
  debt_id: string;
  direction: string;
  amount_minor: number;
  currency: string;
  reason?: string | null;
  settled_at?: string | null;
}

interface RawInteraction {
  interaction_id: string;
  kind: string;
  body_text?: string | null;
  occurred_at: string;
}

interface RawTag {
  concept_id: string;
}

interface RawConcept {
  concept_id: string;
  scheme_id: string;
  notation?: string;
}

interface RawScheme {
  uri: string;
  scheme_id: string;
}

interface ContactEntry {
  kind: string;
  value: string;
}

const LIST_SCHEME_URI = 'https://centraid.dev/schemes/lists';
const FLAGS_SCHEME_URI = 'https://centraid.dev/schemes/flags';

export default async ({ input, ctx }: HandlerArgs) => {
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
    const profile = ((profiles.rows ?? []) as unknown as RawProfile[])[0];
    const party = ((parties.rows ?? []) as unknown as RawParty[])[0];
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
          where: [
            { column: 'party_id', op: 'eq', value: partyId },
            { column: 'deleted_at', op: 'is-null' },
          ],
          purpose,
        }),
        ctx.vault.read({
          entity: 'people.important_date',
          where: [
            { column: 'party_id', op: 'eq', value: partyId },
            { column: 'deleted_at', op: 'is-null' },
          ],
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
          where: [
            { column: 'party_id', op: 'eq', value: partyId },
            { column: 'deleted_at', op: 'is-null' },
          ],
          orderBy: { column: 'created_at', dir: 'desc' },
          purpose,
        }),
        ctx.vault.read({
          entity: 'people.gift',
          where: [
            { column: 'party_id', op: 'eq', value: partyId },
            { column: 'deleted_at', op: 'is-null' },
          ],
          orderBy: { column: 'created_at', dir: 'desc' },
          purpose,
        }),
        ctx.vault.read({
          entity: 'people.debt',
          where: [
            { column: 'party_id', op: 'eq', value: partyId },
            { column: 'deleted_at', op: 'is-null' },
          ],
          purpose,
        }),
        ctx.vault.read({
          entity: 'people.interaction',
          where: [
            { column: 'party_id', op: 'eq', value: partyId },
            { column: 'deleted_at', op: 'is-null' },
          ],
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

    const identifierRows = (ids.rows ?? []) as unknown as RawIdentifier[];
    const relRows = (rels.rows ?? []) as unknown as RawRelationship[];
    const dateRows = (dates.rows ?? []) as unknown as RawDate[];
    const noteRows = (notes.rows ?? []) as unknown as RawNote[];
    const taskRows = (tasks.rows ?? []) as unknown as RawTask[];
    const giftRows = (gifts.rows ?? []) as unknown as RawGift[];
    const debtRows = (debts.rows ?? []) as unknown as RawDebt[];
    const interactionRows = (interactions.rows ?? []) as unknown as RawInteraction[];
    const tagRows = (tags.rows ?? []) as unknown as RawTag[];
    const conceptRows = (concepts.rows ?? []) as unknown as RawConcept[];
    const schemeRows = (schemes.rows ?? []) as unknown as RawScheme[];

    const listScheme = schemeRows.find((s) => s.uri === LIST_SCHEME_URI);
    const listConceptIds = new Set<string>(
      conceptRows
        .filter((c) => listScheme && c.scheme_id === listScheme.scheme_id)
        .map((c) => c.concept_id),
    );
    const flagsScheme = schemeRows.find((s) => s.uri === FLAGS_SCHEME_URI);
    const starredConceptId = flagsScheme
      ? (conceptRows.find((c) => c.scheme_id === flagsScheme.scheme_id && c.notation === 'starred')
          ?.concept_id ?? null)
      : null;
    let listId: string | null = null;
    let starred = false;
    for (const t of tagRows) {
      if (listConceptIds.has(t.concept_id)) listId = t.concept_id;
      if (starredConceptId != null && t.concept_id === starredConceptId) starred = true;
    }

    const contact: ContactEntry[] = [];
    for (const i of identifierRows) {
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
      list_id: listId,
      starred,
      contact,
      relationships: relRows.map((r) => ({
        relationship_id: r.relationship_id,
        name: r.name,
        kind: r.kind,
        pet: r.pet ?? null,
      })),
      dates: dateRows.map((d) => ({
        date_id: d.date_id,
        label: d.label,
        month_day: d.month_day,
        reminder_on: !!d.reminder_on,
      })),
      notes: noteRows.map((n) => ({
        annotation_id: n.annotation_id,
        text: n.body_text,
        created_at: n.created_at,
      })),
      tasks: taskRows.map((t) => ({
        task_id: t.task_id,
        text: t.body_text,
        done: !!t.done,
      })),
      gifts: giftRows.map((g) => ({
        gift_id: g.gift_id,
        text: g.body_text,
        state: g.state,
      })),
      debts: debtRows
        .filter((d) => d.settled_at == null)
        .map((d) => ({
          debt_id: d.debt_id,
          direction: d.direction,
          amount_minor: d.amount_minor,
          currency: d.currency,
          reason: d.reason ?? '',
        })),
      interactions: interactionRows.map((i) => ({
        interaction_id: i.interaction_id,
        kind: i.kind,
        text: i.body_text ?? '',
        occurred_at: i.occurred_at,
      })),
    };
    return { person };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { person: null, vaultDenied: { code: e.code, message: e.message } };
  }
};
