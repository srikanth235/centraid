import {
  definePendingProjection,
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
      const partyId = stablePendingRowId(intentId, "party");
      const profileId = stablePendingRowId(intentId, "profile");
      return [
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
      ];
    },
    "edit-person": ({ input }) => [...person(input), ...profile(input)],
    "set-cadence": ({ input }) => profile(input),
    "trash-person": ({ input }) => profile(input),
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
      const listId = stablePendingRowId(intentId, "list");
      return [
        pendingUpsert("core.concept", listId, {
          concept_id: listId,
          pref_label:
            typeof input.name === "string" ? input.name : "Pending list",
        }),
      ];
    },
    "rename-list": ({ input }) =>
      pendingPatch("core.concept", input.list_id, { pref_label: input.name }, [
        "pref_label",
      ]),
    "delete-list": ({ input }) =>
      pendingPatch("core.concept", input.list_id, input),
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

export default peoplePendingProjection;
