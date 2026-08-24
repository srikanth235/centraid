// Bidirectional provider continuation (#630): a local edit of a row
// that came from Google becomes an already-approved outbox artifact. The
// edit itself is the user's consent to update that same provider object;
// credentials remain executor-only, and revoke/needs-auth leaves the durable
// item approved for reconnect rather than losing it.

import type { HandlerCtx } from "../gateway/types.js";

interface Mapping {
  connection_id: string;
  kind: string;
  label: string;
  external_id: string;
}

function latestSourcePayload(
  ctx: HandlerCtx,
  mapping: Mapping
): Record<string, unknown> {
  const row = ctx.db
    .prepare(
      `SELECT r.payload_json
         FROM sync_import_row r
         JOIN sync_import_batch b ON b.batch_id = r.batch_id
        WHERE b.connection_id = ? AND r.external_id = ?
        ORDER BY b.created_at DESC, r.seq DESC LIMIT 1`
    )
    .get(mapping.connection_id, mapping.external_id) as
    | { payload_json: string }
    | undefined;
  return row ? (JSON.parse(row.payload_json) as Record<string, unknown>) : {};
}

function eventArtifact(
  ctx: HandlerCtx,
  eventId: string,
  source: Record<string, unknown>,
  changedFields: readonly string[]
): {
  artifact: Record<string, unknown>;
  request: Record<string, unknown>;
} {
  const event = ctx.db
    .prepare(
      `SELECT summary, description, dtstart, dtend, start_tz, rrule, status,
              sequence, updated_at
         FROM core_event WHERE event_id = ?`
    )
    .get(eventId) as {
    summary: string;
    description: string | null;
    dtstart: string;
    dtend: string | null;
    start_tz: string | null;
    rrule: string | null;
    status: string;
    sequence: number;
    updated_at: string;
  };
  const providerVersion =
    typeof source.providerVersion === "string"
      ? source.providerVersion
      : undefined;
  const googleDate = (value: string | null): Record<string, unknown> | null => {
    if (!value) return null;
    return /^\d{4}-\d{2}-\d{2}$/u.test(value)
      ? { date: value }
      : {
          dateTime: value,
          ...(event.start_tz ? { timeZone: event.start_tz } : {}),
        };
  };
  // Google expects prefixed RRULE lines. Canonical storage is bare `FREQ=…`
  // (and may still hold legacy `RRULE:…` from older pulls) — never double-prefix.
  const recurrence = event.rrule
    ? event.rrule
        .split("\n")
        .map((line) => {
          const bare = line.replace(/^\s*RRULE:/iu, "").trim();
          return bare ? `RRULE:${bare}` : "";
        })
        .filter(Boolean)
    : [];
  const patch = {
    summary: event.summary,
    description: event.description,
    start: googleDate(event.dtstart),
    end: googleDate(event.dtend),
    recurrence,
    status: event.status,
  };
  const provenance = Object.fromEntries(
    ["summary", "description", "start", "end", "recurrence", "status"].map(
      (field) => [
        field,
        {
          source: changedFields.includes(field) ? "local" : "google",
          providerVersion: providerVersion ?? null,
          localRevision: event.sequence,
          modifiedAt: event.updated_at,
        },
      ]
    )
  );
  return {
    artifact: {
      provider: "google-calendar",
      patch,
      provenance,
      providerVersion: providerVersion ?? null,
    },
    request: {
      method: "PATCH",
      url: "",
      headers: {
        authorization: "Bearer {{connection:access_token}}",
        "content-type": "application/json",
        ...(providerVersion ? { "if-match": providerVersion } : {}),
      },
      body: JSON.stringify(patch),
    },
  };
}

function contactArtifact(
  ctx: HandlerCtx,
  partyId: string,
  source: Record<string, unknown>,
  changedFields: readonly string[]
): {
  artifact: Record<string, unknown>;
  request: Record<string, unknown>;
} {
  const party = ctx.db
    .prepare(
      "SELECT display_name, sort_name, birth_date, updated_at FROM core_party WHERE party_id = ?"
    )
    .get(partyId) as {
    display_name: string;
    sort_name: string | null;
    birth_date: string | null;
    updated_at: string;
  };
  const channels = ctx.db
    .prepare(
      `SELECT kind, normalized_value, label
         FROM social_contact_channel
        WHERE party_id = ? AND kind IN ('email','phone')
        ORDER BY kind, is_preferred DESC, channel_id`
    )
    .all(partyId) as {
    kind: string;
    normalized_value: string;
    label: string | null;
  }[];
  const identifiers = ctx.db
    .prepare(
      `SELECT scheme AS kind, value AS normalized_value, label
         FROM core_party_identifier
        WHERE party_id = ? AND scheme IN ('email','tel') AND valid_to IS NULL
        ORDER BY scheme, is_primary DESC, identifier_id`
    )
    .all(partyId) as {
    kind: string;
    normalized_value: string;
    label: string | null;
  }[];
  const merged = new Map<string, (typeof channels)[number]>();
  for (const channel of [...channels, ...identifiers]) {
    const kind = channel.kind === "tel" ? "phone" : channel.kind;
    merged.set(`${kind}:${channel.normalized_value}`, { ...channel, kind });
  }
  const [familyName, givenName] = (party.sort_name ?? "")
    .split(",")
    .map((value) => value.trim());
  const date = party.birth_date?.match(
    /^(?:(?<year>\d{4})|--)-(?<month>\d{2})-(?<day>\d{2})$/u
  )?.groups;
  const providerVersion =
    typeof source.providerVersion === "string"
      ? source.providerVersion
      : undefined;
  const patch = {
    ...(providerVersion ? { etag: providerVersion } : {}),
    names: [
      {
        displayName: party.display_name,
        ...(givenName ? { givenName } : {}),
        ...(familyName ? { familyName } : {}),
      },
    ],
    emailAddresses: [...merged.values()]
      .filter((item) => item.kind === "email")
      .map((item) => ({ value: item.normalized_value, type: item.label })),
    phoneNumbers: [...merged.values()]
      .filter((item) => item.kind === "phone")
      .map((item) => ({ value: item.normalized_value, type: item.label })),
    birthdays: date
      ? [
          {
            date: {
              ...(date.year ? { year: Number(date.year) } : {}),
              month: Number(date.month),
              day: Number(date.day),
            },
          },
        ]
      : [],
  };
  const provenance = Object.fromEntries(
    ["names", "emailAddresses", "phoneNumbers", "birthdays"].map((field) => [
      field,
      {
        source: changedFields.includes(field) ? "local" : "google",
        providerVersion: providerVersion ?? null,
        modifiedAt: party.updated_at,
      },
    ])
  );
  return {
    artifact: {
      provider: "google-contacts",
      patch,
      provenance,
      providerVersion: providerVersion ?? null,
    },
    request: {
      method: "PATCH",
      url: "",
      headers: {
        authorization: "Bearer {{connection:access_token}}",
        "content-type": "application/json",
      },
      body: JSON.stringify(patch),
    },
  };
}

function queue(
  ctx: HandlerCtx,
  mapping: Mapping,
  targetType: string,
  targetId: string,
  changedFields: readonly string[]
): void {
  const source = latestSourcePayload(ctx, mapping);
  const calendar = mapping.kind === "pull.gcal";
  const external = mapping.external_id.replace(
    calendar ? /^gcal:/u : /^gcontacts:/u,
    ""
  );
  if (!external) return;
  const shaped = calendar
    ? eventArtifact(ctx, targetId, source, changedFields)
    : contactArtifact(ctx, targetId, source, changedFields);
  shaped.request.url = calendar
    ? `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(external)}`
    : `https://people.googleapis.com/v1/${external}:updateContact?updatePersonFields=names,emailAddresses,phoneNumbers,birthdays`;
  const verb = calendar ? "gcal.update_event" : "gcontacts.update_contact";
  const existing = ctx.db
    .prepare(
      `SELECT item_id FROM outbox_item
        WHERE connection_id = ? AND verb = ? AND target_type = ? AND target_id = ?
          AND status = 'approved'
        ORDER BY staged_at DESC LIMIT 1`
    )
    .get(mapping.connection_id, verb, targetType, targetId) as
    | { item_id: string }
    | undefined;
  if (existing) {
    ctx.db
      .prepare(
        `UPDATE outbox_item
            SET artifact_json = ?, request_json = ?, staged_at = ?, decided_at = ?,
                note = 'coalesced provider write-back from a newer local revision'
          WHERE item_id = ?`
      )
      .run(
        JSON.stringify(shaped.artifact),
        JSON.stringify(shaped.request),
        ctx.now,
        ctx.now,
        existing.item_id
      );
    ctx.wrote("outbox.item", existing.item_id);
    return;
  }
  const itemId = ctx.newId();
  ctx.db
    .prepare(
      `INSERT INTO outbox_item
         (item_id, connection_id, actor_id, actor_kind, verb, target,
          target_type, target_id, recipient_party_id, artifact_json, request_json,
          status, grant_id, staged_at, decided_at, drained_at, result_json,
          published_message_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'approved', NULL, ?, ?, NULL,
               NULL, NULL, 'approved by the explicit local edit of this provider-sourced row')`
    )
    .run(
      itemId,
      mapping.connection_id,
      ctx.identity.callerId,
      ctx.identity.provAgentKind,
      verb,
      calendar ? "primary" : external,
      targetType,
      targetId,
      JSON.stringify(shaped.artifact),
      JSON.stringify(shaped.request),
      ctx.now,
      ctx.now
    );
  ctx.wrote("outbox.item", itemId);
}

/**
 * Continue local edits back to the provider only when a durable external-id
 * map proves that the canonical row came from that exact connection.
 */
export function queueProviderWriteback(
  ctx: HandlerCtx,
  targetType: "core.event" | "core.party",
  targetId: string,
  changedFields: readonly string[]
): void {
  const expectedKind =
    targetType === "core.event" ? "pull.gcal" : "pull.gcontacts";
  const mappings = ctx.db
    .prepare(
      `SELECT m.connection_id, c.kind, c.label, m.external_id
         FROM sync_external_entity m
         JOIN sync_connection c ON c.connection_id = m.connection_id
        WHERE m.target_type = ? AND m.target_id = ? AND c.kind = ?
        ORDER BY m.connection_id`
    )
    .all(targetType, targetId, expectedKind) as unknown as Mapping[];
  for (const mapping of mappings)
    queue(ctx, mapping, targetType, targetId, changedFields);
}
