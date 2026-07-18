/**
 * The People journal is now a projection over canonical knowledge notes and
 * contact activities (issue #450). Owner-authored entries are knowledge.note
 * rows tagged in the People-journal scheme; automatic entries are
 * core.activity rows linked `about` a party, with optional annotations.
 */

interface RawTag {
  target_id: string;
  concept_id: string;
}
interface RawConcept {
  concept_id: string;
  scheme_id: string;
  notation: string;
}
interface RawScheme {
  scheme_id: string;
  uri: string;
}
interface RawNote {
  note_id: string;
  title: string;
  body_content_id: string;
  created_at: string;
}
interface RawContent {
  content_id: string;
  content_uri: string;
}
interface RawLink {
  from_id: string;
  to_id: string;
}
interface RawActivity {
  activity_id: string;
  kind_concept_id: string;
  started_at: string;
}
interface RawAnnotation {
  target_id: string;
  body_text: string;
}
interface RawParty {
  party_id: string;
  display_name: string;
}
interface RawProfile {
  party_id: string;
  avatar_color?: string | null;
}

const JOURNAL_SCHEME_URI = 'https://centraid.dev/schemes/people-journal';

function decodeText(uri: string | undefined): string {
  if (!uri?.startsWith('data:')) return '';
  const comma = uri.indexOf(',');
  if (comma < 0) return '';
  try {
    return decodeURIComponent(uri.slice(comma + 1));
  } catch {
    return '';
  }
}

export default async ({ ctx }: HandlerArgs) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const [tags, concepts, schemes, activityLinks] = await Promise.all([
      ctx.vault.read({
        entity: 'core.tag',
        where: [{ column: 'target_type', op: 'eq', value: 'knowledge.note' }],
        purpose,
      }),
      ctx.vault.read({ entity: 'core.concept', purpose }),
      ctx.vault.read({ entity: 'core.concept_scheme', purpose }),
      ctx.vault.read({
        entity: 'core.link',
        where: [
          { column: 'from_type', op: 'eq', value: 'core.activity' },
          { column: 'to_type', op: 'eq', value: 'core.party' },
          { column: 'valid_to', op: 'is-null' },
        ],
        purpose,
      }),
    ]);
    const conceptRows = (concepts.rows ?? []) as unknown as RawConcept[];
    const journalScheme = ((schemes.rows ?? []) as unknown as RawScheme[]).find(
      (scheme) => scheme.uri === JOURNAL_SCHEME_URI,
    );
    const markerId = conceptRows.find(
      (concept) => concept.scheme_id === journalScheme?.scheme_id && concept.notation === 'entry',
    )?.concept_id;
    const noteIds = ((tags.rows ?? []) as unknown as RawTag[])
      .filter((tag) => tag.concept_id === markerId)
      .map((tag) => tag.target_id);
    const links = (activityLinks.rows ?? []) as unknown as RawLink[];
    const activityIds = [...new Set(links.map((link) => link.from_id))];
    const partyIds = [...new Set(links.map((link) => link.to_id))];

    const [notes, activities, annotations, parties, profiles] = await Promise.all([
      noteIds.length > 0
        ? ctx.vault.read({
            entity: 'knowledge.note',
            where: [
              { column: 'note_id', op: 'in', value: noteIds },
              { column: 'deleted_at', op: 'is-null' },
            ],
            orderBy: { column: 'created_at', dir: 'desc' },
            purpose,
          })
        : Promise.resolve({ rows: [] }),
      activityIds.length > 0
        ? ctx.vault.read({
            entity: 'core.activity',
            where: [{ column: 'activity_id', op: 'in', value: activityIds }],
            orderBy: { column: 'started_at', dir: 'desc' },
            purpose,
          })
        : Promise.resolve({ rows: [] }),
      activityIds.length > 0
        ? ctx.vault.read({
            entity: 'knowledge.annotation',
            where: [
              { column: 'target_type', op: 'eq', value: 'core.activity' },
              { column: 'target_id', op: 'in', value: activityIds },
            ],
            purpose,
          })
        : Promise.resolve({ rows: [] }),
      partyIds.length > 0
        ? ctx.vault.read({
            entity: 'core.party',
            where: [{ column: 'party_id', op: 'in', value: partyIds }],
            purpose,
          })
        : Promise.resolve({ rows: [] }),
      partyIds.length > 0
        ? ctx.vault.read({
            entity: 'people.profile',
            where: [{ column: 'party_id', op: 'in', value: partyIds }],
            purpose,
          })
        : Promise.resolve({ rows: [] }),
    ]);
    const noteRows = (notes.rows ?? []) as unknown as RawNote[];
    const contentIds = noteRows.map((note) => note.body_content_id);
    const contents =
      contentIds.length > 0
        ? await ctx.vault.read({
            entity: 'core.content_item',
            where: [{ column: 'content_id', op: 'in', value: contentIds }],
            purpose,
          })
        : { rows: [] };
    const contentById = new Map(
      ((contents.rows ?? []) as unknown as RawContent[]).map((content) => [
        content.content_id,
        content.content_uri,
      ]),
    );
    const conceptById = new Map(conceptRows.map((concept) => [concept.concept_id, concept]));
    const partyById = new Map(
      ((parties.rows ?? []) as unknown as RawParty[]).map((party) => [party.party_id, party]),
    );
    const colorById = new Map(
      ((profiles.rows ?? []) as unknown as RawProfile[]).map((profile) => [
        profile.party_id,
        profile.avatar_color,
      ]),
    );
    const partyByActivity = new Map(links.map((link) => [link.from_id, link.to_id]));
    const textByActivity = new Map(
      ((annotations.rows ?? []) as unknown as RawAnnotation[]).map((annotation) => [
        annotation.target_id,
        annotation.body_text,
      ]),
    );

    const owner = noteRows.map((note) => ({
      kind: 'entry',
      id: note.note_id,
      sort_at: note.created_at,
      date: note.created_at.slice(0, 10),
      mood: note.title.replace(/^People journal · /, ''),
      text: decodeText(contentById.get(note.body_content_id)),
    }));
    const auto = ((activities.rows ?? []) as unknown as RawActivity[]).map((activity) => {
      const partyId = partyByActivity.get(activity.activity_id) ?? '';
      return {
        kind: 'auto',
        id: activity.activity_id,
        sort_at: activity.started_at,
        date: activity.started_at,
        touch: conceptById.get(activity.kind_concept_id)?.notation ?? 'interaction',
        text: textByActivity.get(activity.activity_id) ?? '',
        party_id: partyId,
        name: partyById.get(partyId)?.display_name ?? '—',
        avatar_color: colorById.get(partyId) ?? null,
      };
    });

    return {
      entries: [...owner, ...auto].toSorted((a, b) =>
        String(b.sort_at).localeCompare(String(a.sort_at)),
      ),
    };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { entries: [], vaultDenied: { code: e.code, message: e.message } };
  }
};
