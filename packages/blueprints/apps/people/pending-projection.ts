import {
  definePendingProjection,
  pendingDelete,
  pendingInputValues,
  pendingPatch,
  pendingUpsert,
  stablePendingRowId,
} from "../_shared/pending-overlay.js";

// Existing People commands address the person spine by party_id. The profile's
// separate profile_id is deliberately not guessed: the party row is the stable
// visible anchor for the pending state until canonical settlement arrives.
const profile = (input: Readonly<Record<string, unknown>>) =>
  pendingPatch("core.party", input.party_id, input);
const person = (input: Readonly<Record<string, unknown>>) =>
  pendingPatch("core.party", input.party_id, input, ["display_name"]);

export const peoplePendingProjection = definePendingProjection({
  appId: "people",
  revisions: {
    "edit-person": ["add-person"],
    "rename-list": ["create-list"],
  },
  actions: {
    "add-person": ({ input, intentId }) => {
      // An id the write already carries is REUSED, never re-minted, so a
      // revision keeps the row it already showed (#922 G2).
      const partyId =
        typeof input.party_id === "string" && input.party_id.length > 0
          ? input.party_id
          : stablePendingRowId(intentId, "party");
      const profileId = stablePendingRowId(intentId, "profile");
      return {
        // The id the projection minted rides the write (#922 G2).
        input: { party_id: partyId },
        optimistic: [
          pendingUpsert("core.party", partyId, {
            party_id: partyId,
            display_name:
              typeof input.display_name === "string"
                ? input.display_name
                : "Pending person",
          }),
          pendingUpsert("people.profile", profileId, {
            profile_id: profileId,
            party_id: partyId,
            deleted_at: null,
            ...pendingInputValues(input, [
              "role",
              "cadence_days",
              "avatar_color",
              "list_id",
            ]),
          }),
        ],
      };
    },
    "edit-person": ({ input }) => [...person(input), ...profile(input)],
    "set-cadence": ({ input }) => profile(input),
    "trash-person": {
      excluded: true,
      reason:
        "The trashed row is people.profile, keyed by profile_id; the payload carries only party_id, and the party row this app overlays has no tombstone column.",
    },
    "restore-person": ({ input }) => profile(input),
    "undo-person": ({ input }) => profile(input),
    "log-interaction": ({ input }) => profile(input),
    "star-person": ({ input }) => profile(input),
    "unstar-person": ({ input }) => profile(input),
    "move-person": ({ input }) => profile(input),
    "add-note": ({ input }) => profile(input),
    "add-task": ({ input }) => profile(input),
    "toggle-task": {
      excluded: true,
      reason: "A task id does not identify the parent People row.",
    },
    "add-important-date": ({ input }) => profile(input),
    "toggle-reminder": {
      excluded: true,
      reason: "A date id does not identify the parent People row.",
    },
    "add-relationship": ({ input }) => profile(input),
    "add-gift": ({ input }) => profile(input),
    "toggle-gift": {
      excluded: true,
      reason: "A gift id does not identify the parent People row.",
    },
    "add-debt": ({ input }) => profile(input),
    "settle-debt": {
      excluded: true,
      reason: "A debt id does not identify the parent People row.",
    },
    "create-list": ({ input, intentId }) => {
      // An id the write already carries is REUSED, never re-minted, so a
      // revision keeps the row it already showed (#922 G2).
      const listId =
        typeof input.list_id === "string" && input.list_id.length > 0
          ? input.list_id
          : stablePendingRowId(intentId, "list");
      return {
        // The id the projection minted rides the write (#922 G2).
        input: { list_id: listId },
        optimistic: [
          pendingUpsert("core.concept", listId, {
            concept_id: listId,
            pref_label:
              typeof input.name === "string" ? input.name : "Pending list",
          }),
        ],
      };
    },
    "rename-list": ({ input }) =>
      pendingPatch("core.concept", input.list_id, { pref_label: input.name }, [
        "pref_label",
      ]),
    "delete-list": ({ input }) => pendingDelete("core.concept", input.list_id),
    "add-journal-entry": {
      excluded: true,
      reason: "The journal entry has no People row identity.",
    },
    "save-contact-channel": ({ input }) => profile(input),
    "delete-contact-channel": {
      excluded: true,
      reason: "A channel id alone does not identify the parent People row.",
    },
    "undo-contact-channel": {
      excluded: true,
      reason: "A channel id alone does not identify the parent People row.",
    },
    "merge-people": ({ input }) =>
      pendingPatch("core.party", input.source_party_id, input),
  },
});
