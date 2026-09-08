import {
  definePendingProjection,
  pendingInputValues,
  pendingPatch,
  pendingUpsert,
  stablePendingRowId,
} from "../_shared/pending-overlay.js";

const EVENT_FIELDS = [
  "summary",
  "description",
  "dtstart",
  "dtend",
  "start_tz",
  "end_tz",
  "recurrence_semantics",
  "rrule",
  "conferencing_uri",
] as const;

export const agendaPendingProjection = definePendingProjection({
  appId: "agenda",
  revisions: {
    "edit-event": ["propose"],
  },
  actions: {
    propose: ({ input, intentId }) => {
      // An id the write already carries is REUSED, never re-minted, so a
      // revision keeps the row it already showed (#922 G2).
      const eventId =
        typeof input.event_id === "string" && input.event_id.length > 0
          ? input.event_id
          : stablePendingRowId(intentId, "event");
      return {
        // The id the projection minted rides the write (#922 G2).
        input: { event_id: eventId },
        optimistic: [
          pendingUpsert("core.event", eventId, {
            event_id: eventId,
            status: "tentative",
            ...pendingInputValues(input, EVENT_FIELDS),
          }),
        ],
      };
    },
    rsvp: ({ input }) => pendingPatch("core.event", input.event_id, input),
    "edit-event": ({ input }) =>
      pendingPatch("core.event", input.event_id, input, EVENT_FIELDS),
    "edit-occurrence": ({ input }) =>
      pendingPatch("core.event", input.event_id, input),
    "cancel-event": ({ input }) =>
      pendingPatch("core.event", input.event_id, input, ["status"]),
    attach: ({ input }) => pendingPatch("core.event", input.subject_id, input),
    detach: {
      excluded: true,
      reason:
        "The detach payload carries only an attachment id, not its event row.",
    },
  },
});
