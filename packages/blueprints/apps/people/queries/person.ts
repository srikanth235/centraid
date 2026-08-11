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
  // people.profile's own primary key — not otherwise surfaced to the client;
  // carried through so drawer writes (trash-person/log-interaction) can key
  // the pending-write overlay's optimistic upsert on the real row id
  // (issue #738, see pending-projection.ts) instead of guessing at party_id.
  profile_id: string;
  role?: string | null;
  avatar_color?: string | null;
  cadence_days: number;
  last_contacted_at?: string | null;
  created_at: string;
  met?: string | null;
}

interface RawParty {
  party_id: string;
  display_name: string;
  kind?: string;
}

interface RawIdentifier {
  scheme: string;
  value: string;
}

interface RawContactChannel {
  channel_id: string;
  party_id: string;
  kind: "phone" | "email" | "address" | "handle";
  label?: string | null;
  value: string;
  normalized_value: string;
  is_preferred: number;
  provenance_json?: string | null;
}

interface RawLink {
  link_id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  relation_concept_id: string;
  valid_to?: string | null;
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
  title: string;
  status: string;
}

interface RawDebt {
  obligation_id: string;
  from_party: string;
  to_party: string;
  amount_minor: number;
  currency: string;
  reason?: string | null;
  settled_at?: string | null;
}

interface RawInteraction {
  activity_id: string;
  kind_concept_id: string;
  started_at: string;
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
  channel_id?: string;
  kind: "phone" | "email" | "address" | "handle";
  label?: string | null;
  value: string;
  normalized_value?: string;
  preferred?: boolean;
  provenance?: Record<string, unknown> | null;
  duplicate_party_ids?: string[];
  duplicate_names?: string[];
  legacy?: boolean;
}

const LIST_SCHEME_URI = "https://centraid.dev/schemes/lists";
const FLAGS_SCHEME_URI = "https://centraid.dev/schemes/flags";
const RELATIONS_SCHEME_URI = "urn:duaility:relations";

export default async function personHandler({ input, ctx }: HandlerArgs) {
  const purpose = "dpv:ServiceProvision";
  const partyId = String(input?.party_id ?? "");
  if (!partyId) return { person: null };
  try {
    const [profiles, parties] = await Promise.all([
      ctx.vault.read({
        entity: "people.profile",
        where: [
          { column: "party_id", op: "eq", value: partyId },
          { column: "deleted_at", op: "is-null" },
        ],
        purpose,
      }),
      ctx.vault.read({
        entity: "core.party",
        where: [{ column: "party_id", op: "eq", value: partyId }],
        purpose,
      }),
    ]);
    const profile = ((profiles.rows ?? []) as unknown as RawProfile[])[0];
    const party = ((parties.rows ?? []) as unknown as RawParty[])[0];
    if (!profile || !party) return { person: null };

    const [
      ids,
      channelRowsResult,
      outgoingLinks,
      incomingLinks,
      dates,
      notes,
      debtsFrom,
      debtsTo,
      tags,
      concepts,
      schemes,
      vault,
    ] = await Promise.all([
      ctx.vault.read({
        entity: "core.party_identifier",
        where: [{ column: "party_id", op: "eq", value: partyId }],
        purpose,
      }),
      ctx.vault.read({
        entity: "social.contact_channel",
        purpose,
        limit: 2000,
      }),
      ctx.vault.read({
        entity: "core.link",
        where: [
          { column: "from_type", op: "eq", value: "core.party" },
          { column: "from_id", op: "eq", value: partyId },
          { column: "valid_to", op: "is-null" },
        ],
        purpose,
      }),
      ctx.vault.read({
        entity: "core.link",
        where: [
          { column: "to_type", op: "eq", value: "core.party" },
          { column: "to_id", op: "eq", value: partyId },
          { column: "valid_to", op: "is-null" },
        ],
        purpose,
      }),
      ctx.vault.read({
        entity: "people.important_date",
        where: [
          { column: "party_id", op: "eq", value: partyId },
          { column: "deleted_at", op: "is-null" },
        ],
        purpose,
      }),
      ctx.vault.read({
        entity: "knowledge.annotation",
        where: [
          { column: "target_type", op: "eq", value: "core.party" },
          { column: "target_id", op: "eq", value: partyId },
        ],
        orderBy: { column: "created_at", dir: "desc" },
        purpose,
      }),
      ctx.vault.read({
        entity: "tally.obligation",
        where: [
          { column: "from_party", op: "eq", value: partyId },
          { column: "deleted_at", op: "is-null" },
        ],
        purpose,
      }),
      ctx.vault.read({
        entity: "tally.obligation",
        where: [
          { column: "to_party", op: "eq", value: partyId },
          { column: "deleted_at", op: "is-null" },
        ],
        purpose,
      }),
      ctx.vault.read({
        entity: "core.tag",
        where: [
          { column: "target_type", op: "eq", value: "core.party" },
          { column: "target_id", op: "eq", value: partyId },
        ],
        purpose,
      }),
      ctx.vault.read({ entity: "core.concept", purpose }),
      ctx.vault.read({ entity: "core.concept_scheme", purpose }),
      ctx.vault.read({ entity: "core.vault", purpose }),
    ]);

    const identifierRows = (ids.rows ?? []) as unknown as RawIdentifier[];
    const allChannelRows = (channelRowsResult.rows ??
      []) as unknown as RawContactChannel[];
    const channelRows = allChannelRows.filter(
      (channel) => channel.party_id === partyId
    );
    const outgoing = (outgoingLinks.rows ?? []) as unknown as RawLink[];
    const incoming = (incomingLinks.rows ?? []) as unknown as RawLink[];
    const dateRows = (dates.rows ?? []) as unknown as RawDate[];
    const noteRows = (notes.rows ?? []) as unknown as RawNote[];
    const debtRows = [
      ...((debtsFrom.rows ?? []) as unknown as RawDebt[]),
      ...((debtsTo.rows ?? []) as unknown as RawDebt[]),
    ].filter(
      (row, index, all) =>
        all.findIndex((x) => x.obligation_id === row.obligation_id) === index
    );
    const tagRows = (tags.rows ?? []) as unknown as RawTag[];
    const conceptRows = (concepts.rows ?? []) as unknown as RawConcept[];
    const schemeRows = (schemes.rows ?? []) as unknown as RawScheme[];
    const ownerPartyId = String((vault.rows ?? [])[0]?.owner_party_id ?? "");

    const relationLinks = outgoing.filter(
      (link) =>
        link.to_type === "core.party" &&
        conceptRows.some(
          (concept) =>
            concept.concept_id === link.relation_concept_id &&
            concept.notation?.startsWith("people-")
        )
    );
    const relationSchemeId = schemeRows.find(
      (scheme) => scheme.uri === RELATIONS_SCHEME_URI
    )?.scheme_id;
    const giftTaskIds = new Set(
      incoming
        .filter(
          (link) =>
            link.from_type === "schedule.task" &&
            conceptRows.some(
              (concept) =>
                concept.concept_id === link.relation_concept_id &&
                concept.scheme_id === relationSchemeId &&
                concept.notation === "gift-for"
            )
        )
        .map((link) => link.from_id)
    );
    const taskIds = incoming
      .filter((link) => link.from_type === "schedule.task")
      .map((link) => link.from_id);
    const activityIds = incoming
      .filter((link) => link.from_type === "core.activity")
      .map((link) => link.from_id);
    const duplicatePartyIds = [
      ...new Set(
        channelRows.flatMap((channel) =>
          allChannelRows
            .filter(
              (other) =>
                other.party_id !== partyId &&
                other.kind === channel.kind &&
                other.normalized_value === channel.normalized_value
            )
            .map((other) => other.party_id)
        )
      ),
    ];
    const [
      relatedParties,
      duplicateParties,
      tasks,
      interactions,
      interactionNotes,
    ] = await Promise.all([
      relationLinks.length > 0
        ? ctx.vault.read({
            entity: "core.party",
            where: [
              {
                column: "party_id",
                op: "in",
                value: relationLinks.map((l) => l.to_id),
              },
            ],
            purpose,
          })
        : Promise.resolve({ rows: [] }),
      duplicatePartyIds.length > 0
        ? ctx.vault.read({
            entity: "core.party",
            where: [
              {
                column: "party_id",
                op: "in",
                value: duplicatePartyIds,
              },
            ],
            purpose,
          })
        : Promise.resolve({ rows: [] }),
      taskIds.length > 0
        ? ctx.vault.read({
            entity: "schedule.task",
            where: [{ column: "task_id", op: "in", value: taskIds }],
            purpose,
          })
        : Promise.resolve({ rows: [] }),
      activityIds.length > 0
        ? ctx.vault.read({
            entity: "core.activity",
            where: [{ column: "activity_id", op: "in", value: activityIds }],
            orderBy: { column: "started_at", dir: "desc" },
            purpose,
          })
        : Promise.resolve({ rows: [] }),
      activityIds.length > 0
        ? ctx.vault.read({
            entity: "knowledge.annotation",
            where: [
              { column: "target_type", op: "eq", value: "core.activity" },
              { column: "target_id", op: "in", value: activityIds },
            ],
            purpose,
          })
        : Promise.resolve({ rows: [] }),
    ]);
    const relatedPartyRows = (relatedParties.rows ??
      []) as unknown as RawParty[];
    const duplicatePartyRows = (duplicateParties.rows ??
      []) as unknown as RawParty[];
    const taskRows = (tasks.rows ?? []) as unknown as RawTask[];
    const interactionRows = (interactions.rows ??
      []) as unknown as RawInteraction[];
    const interactionNoteRows = (interactionNotes.rows ??
      []) as unknown as Array<RawNote & { target_id: string }>;

    const listScheme = schemeRows.find((s) => s.uri === LIST_SCHEME_URI);
    const listConceptIds = new Set<string>(
      conceptRows
        .filter((c) => listScheme && c.scheme_id === listScheme.scheme_id)
        .map((c) => c.concept_id)
    );
    const flagsScheme = schemeRows.find((s) => s.uri === FLAGS_SCHEME_URI);
    const starredConceptId = flagsScheme
      ? (conceptRows.find(
          (c) =>
            c.scheme_id === flagsScheme.scheme_id && c.notation === "starred"
        )?.concept_id ?? null)
      : null;
    let listId: string | null = null;
    let starred = false;
    for (const t of tagRows) {
      if (listConceptIds.has(t.concept_id)) listId = t.concept_id;
      if (starredConceptId != null && t.concept_id === starredConceptId)
        starred = true;
    }
    const conceptById = new Map(
      conceptRows.map((concept) => [concept.concept_id, concept])
    );
    const relatedById = new Map(
      relatedPartyRows.map((related) => [related.party_id, related])
    );
    const interactionText = new Map(
      interactionNoteRows.map((annotation) => [
        annotation.target_id,
        annotation.body_text,
      ])
    );

    const duplicateNameById = new Map(
      duplicatePartyRows.map((row) => [row.party_id, row.display_name])
    );
    const contact: ContactEntry[] = channelRows
      .toSorted(
        (a, b) =>
          b.is_preferred - a.is_preferred ||
          a.kind.localeCompare(b.kind) ||
          a.channel_id.localeCompare(b.channel_id)
      )
      .map((channel) => {
        const duplicateIds = allChannelRows
          .filter(
            (other) =>
              other.party_id !== partyId &&
              other.kind === channel.kind &&
              other.normalized_value === channel.normalized_value
          )
          .map((other) => other.party_id);
        let provenance: Record<string, unknown> | null = null;
        try {
          provenance = channel.provenance_json
            ? (JSON.parse(channel.provenance_json) as Record<string, unknown>)
            : null;
        } catch {
          provenance = { source: "unreadable provenance" };
        }
        return {
          channel_id: channel.channel_id,
          kind: channel.kind,
          label: channel.label ?? null,
          value: channel.value,
          normalized_value: channel.normalized_value,
          preferred: Boolean(channel.is_preferred),
          provenance,
          duplicate_party_ids: duplicateIds,
          duplicate_names: duplicateIds.map(
            (id) => duplicateNameById.get(id) ?? id
          ),
        };
      });
    const channelKeys = new Set(
      channelRows.map(
        (channel) => `${channel.kind}:${channel.normalized_value}`
      )
    );
    for (const i of identifierRows) {
      const kind =
        i.scheme === "tel" ? "phone" : i.scheme === "email" ? "email" : null;
      if (!kind) continue;
      const key = `${kind}:${i.value.trim().toLocaleLowerCase("en-US")}`;
      if (!channelKeys.has(key))
        contact.push({ kind, value: i.value, legacy: true });
    }

    const person = {
      party_id: partyId,
      profile_id: profile.profile_id,
      name: party.display_name,
      role: profile.role ?? "",
      avatar_color: profile.avatar_color ?? null,
      cadence_days: profile.cadence_days,
      last_contacted_at: profile.last_contacted_at ?? null,
      created_at: profile.created_at,
      met: profile.met ?? "",
      list_id: listId,
      starred,
      contact,
      relationships: relationLinks.map((link) => {
        const related = relatedById.get(link.to_id);
        const notation =
          conceptById.get(link.relation_concept_id)?.notation ??
          "people-related";
        const tokens = notation.replace(/^people-/u, "").split("-");
        const pet = related?.kind === "animal" ? (tokens.pop() ?? null) : null;
        return {
          relationship_id: link.link_id,
          related_party_id: link.to_id,
          name: related?.display_name ?? "—",
          kind: tokens.join(" ") || "related",
          pet,
        };
      }),
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
      tasks: taskRows
        .filter((t) => !giftTaskIds.has(t.task_id))
        .map((t) => ({
          task_id: t.task_id,
          text: t.title,
          done: t.status === "completed",
        })),
      gifts: taskRows
        .filter((t) => giftTaskIds.has(t.task_id))
        .map((t) => ({
          gift_id: t.task_id,
          text: t.title,
          state: t.status === "completed" ? "given" : "idea",
        })),
      debts: debtRows
        .filter((d) => d.settled_at == null)
        .map((d) => ({
          debt_id: d.obligation_id,
          direction: d.from_party === ownerPartyId ? "owe" : "owed",
          amount_minor: d.amount_minor,
          currency: d.currency,
          reason: d.reason ?? "",
        })),
      interactions: interactionRows.map((i) => ({
        interaction_id: i.activity_id,
        kind: conceptById.get(i.kind_concept_id)?.notation ?? "interaction",
        text: interactionText.get(i.activity_id) ?? "",
        occurred_at: i.started_at,
      })),
    };
    return { person };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return { person: null, vaultDenied: { code: e.code, message: e.message } };
  }
}
