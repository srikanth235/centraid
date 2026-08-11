// People's pending-write projection (issue #738) — pure config, scope-kit
// style, consumed by `createPendingOverlayModel` in logic.ts. Projects into
// the two replica entities queries/people.ts, queries/person.ts and
// queries/trash.ts actually read: `core.party` (the canonical person) and
// `people.profile` (the CRM decoration — role, cadence, trash state). Only
// schema columns ride along; joined/derived fields (list membership, the
// favorite star) are the query's job.
//
// `star-person`/`unstar-person` are deliberately undeclared: favoriting is a
// SKOS flags-scheme `core.tag` row keyed by a `concept_id` the vault mints
// lazily and never hands to the client (queries/people.ts only ever returns
// the derived `starred` boolean) — there is no row id this pure function can
// honestly target without a wider read the client does not have.
import type {
  PendingMutation,
  PendingProjectionDeclaration,
} from "../_shared/pending-overlay.ts";

function stringField(
  input: Record<string, unknown>,
  key: string
): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

export const peoplePendingProjection: PendingProjectionDeclaration = {
  appId: "people",
  actions: {
    // people.add_person's own INSERTs (packages/vault/src/commands/people.ts):
    // a core.party plus its 1:1 people.profile. Both rows are minted here —
    // the profile's own id is namespaced off the intent's rowId since the two
    // tables keep separate primary keys.
    "add-person"(input, ctx) {
      const displayName = stringField(input, "display_name");
      if (!displayName) return [];
      const profileId = `${ctx.rowId}-profile`;
      const profileValues: Record<string, unknown> = {
        profile_id: profileId,
        party_id: ctx.rowId,
        cadence_days:
          typeof input.cadence_days === "number" ? input.cadence_days : 30,
      };
      const role = stringField(input, "role");
      if (role !== undefined) profileValues.role = role;
      const avatarColor = stringField(input, "avatar_color");
      if (avatarColor !== undefined) profileValues.avatar_color = avatarColor;
      return [
        {
          op: "upsert",
          entity: "core.party",
          rowId: ctx.rowId,
          values: {
            party_id: ctx.rowId,
            kind: "person",
            display_name: displayName,
          },
        },
        {
          op: "upsert",
          entity: "people.profile",
          rowId: profileId,
          values: profileValues,
        },
      ];
    },

    // people.edit_person touches core.party.display_name unconditionally (we
    // always know party_id — it IS core.party's own primary key) and
    // people.profile's role/avatar_color/met only when the client also sends
    // `profile_id` (an optional field app.json declares — not read by the
    // command, which re-derives the row from party_id server-side).
    "edit-person"(input) {
      const partyId = stringField(input, "party_id");
      if (!partyId) return [];
      const mutations: PendingMutation[] = [];
      const displayName = stringField(input, "display_name");
      if (displayName !== undefined) {
        mutations.push({
          op: "upsert",
          entity: "core.party",
          rowId: partyId,
          values: { display_name: displayName },
        });
      }
      const profileId = stringField(input, "profile_id");
      if (profileId) {
        const values: Record<string, unknown> = {};
        const role = stringField(input, "role");
        if (role !== undefined) values.role = role;
        const avatarColor = stringField(input, "avatar_color");
        if (avatarColor !== undefined) values.avatar_color = avatarColor;
        const met = stringField(input, "met");
        if (met !== undefined) values.met = met;
        if (Object.keys(values).length > 0) {
          mutations.push({
            op: "upsert",
            entity: "people.profile",
            rowId: profileId,
            values,
          });
        }
      }
      return mutations;
    },

    // people.trash_person/restore_person flip people_profile.deleted_at,
    // keyed by the profile's own row id (an optional `profile_id` field the
    // client threads through from the read that already carries it —
    // queries/people.ts, queries/person.ts, queries/trash.ts).
    "trash-person"(input) {
      const profileId = stringField(input, "profile_id");
      if (!profileId) return [];
      return [
        {
          op: "upsert",
          entity: "people.profile",
          rowId: profileId,
          values: { deleted_at: new Date().toISOString() },
        },
      ];
    },
    "restore-person"(input) {
      const profileId = stringField(input, "profile_id");
      if (!profileId) return [];
      return [
        {
          op: "upsert",
          entity: "people.profile",
          rowId: profileId,
          values: { deleted_at: null },
        },
      ];
    },

    // people.log_interaction stamps people_profile.last_contacted_at, which is
    // what clears a person from Reconnect — the whole point of the write.
    "log-interaction"(input) {
      const profileId = stringField(input, "profile_id");
      if (!profileId) return [];
      return [
        {
          op: "upsert",
          entity: "people.profile",
          rowId: profileId,
          values: { last_contacted_at: new Date().toISOString() },
        },
      ];
    },
  },
};
