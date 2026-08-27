/**
 * Sidecar reads for the item pane (#872) — a helper, not a query.
 *
 * ONE RULE RUNS THROUGH ALL OF IT: a sealed cell never rides these payloads.
 * `value_sealed`, `private_key` and `history.password` come back as the
 * vault's placeholder, so these return the SHAPE of a secret, never the
 * secret.
 */

const SEALED_PLACEHOLDER = "«sealed»";

interface FieldRow {
  field_id: string;
  section: string;
  label: string;
  kind: string;
  value_text: string | null;
  value_sealed: string | null;
  position?: number;
}

interface AddressRow {
  address_id: string;
  url: string;
  match_policy: string;
  position?: number;
}

interface PasskeyRow {
  item_id: string;
  rp_id: string;
  user_handle: string | null;
  display_name: string | null;
  credential_id: string | null;
  algorithm: string | null;
  private_key: string | null;
  created_at: string;
}

interface HistoryRow {
  revision_id: string;
  operation: string;
  title: string | null;
  password: string | null;
  changed_json: string;
  recorded_at: string;
}

interface AttachmentRow {
  attachment_id: string;
  target_type: string;
  target_id: string;
  content_id: string;
  role: string;
}

interface ContentRow {
  content_id: string;
  title?: string | null;
  media_type?: string | null;
  byte_size?: number | null;
}

async function rowsOf<T>(
  ctx: HandlerCtx,
  entity: string,
  itemId: string,
  purpose: string,
  column = "item_id"
): Promise<T[]> {
  try {
    const result = await ctx.vault.read({
      entity,
      where: [{ column, op: "eq", value: itemId }],
      purpose,
    });
    return (result.rows ?? []) as unknown as T[];
  } catch {
    // A sidecar the grant does not cover leaves its section empty; it never
    // takes the pane down with it.
    return [];
  }
}

export async function readAlias(
  ctx: HandlerCtx,
  itemId: string,
  purpose: string
): Promise<string | null> {
  const rows = await rowsOf<{ alias: string }>(
    ctx,
    "locker.item_alias",
    itemId,
    purpose
  );
  return rows[0]?.alias ?? null;
}

export async function readFields(
  ctx: HandlerCtx,
  itemId: string,
  purpose: string
): Promise<
  {
    field_id: string;
    section: string;
    label: string;
    kind: string;
    value: string | null;
    sealed: boolean;
  }[]
> {
  const rows = await rowsOf<FieldRow>(
    ctx,
    "locker.item_field",
    itemId,
    purpose
  );
  return rows
    .toSorted(
      (a, b) =>
        a.section.localeCompare(b.section) ||
        (a.position ?? 0) - (b.position ?? 0) ||
        a.label.localeCompare(b.label)
    )
    .map((row) => ({
      field_id: row.field_id,
      section: row.section,
      label: row.label,
      kind: row.kind,
      // A sealed custom value reads back as the placeholder, like
      // `locker_item.password`; `null` with `sealed: true` is the honest
      // shape.
      value: row.kind === "sealed" ? null : row.value_text,
      sealed:
        row.kind === "sealed" &&
        (row.value_sealed === SEALED_PLACEHOLDER || row.value_sealed != null),
    }));
}

export async function readAddresses(
  ctx: HandlerCtx,
  itemId: string,
  purpose: string
): Promise<{ address_id: string; url: string; match_policy: string }[]> {
  const rows = await rowsOf<AddressRow>(
    ctx,
    "locker.item_address",
    itemId,
    purpose
  );
  return rows
    .toSorted((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((row) => ({
      address_id: row.address_id,
      url: row.url,
      match_policy: row.match_policy,
    }));
}

export async function readPasskey(
  ctx: HandlerCtx,
  itemId: string,
  purpose: string
): Promise<Record<string, unknown> | null> {
  const rows = await rowsOf<PasskeyRow>(
    ctx,
    "locker.item_passkey",
    itemId,
    purpose
  );
  const row = rows[0];
  if (!row) return null;
  return {
    rp_id: row.rp_id,
    user_handle: row.user_handle,
    display_name: row.display_name,
    credential_id: row.credential_id,
    algorithm: row.algorithm,
    created_at: row.created_at,
    // Key material is sealed; its PRESENCE is what the slot draws.
    has_private_key: row.private_key != null,
  };
}

export async function readHistory(
  ctx: HandlerCtx,
  itemId: string,
  purpose: string,
  limit = 50
): Promise<Record<string, unknown>[]> {
  const rows = await rowsOf<HistoryRow>(
    ctx,
    "locker.item_history",
    itemId,
    purpose
  );
  return rows
    .toSorted((a, b) => b.recorded_at.localeCompare(a.recorded_at))
    .slice(0, limit)
    .map((row) => {
      let changed: Record<string, unknown> = {};
      try {
        changed = JSON.parse(row.changed_json) as Record<string, unknown>;
      } catch {
        changed = {};
      }
      return {
        revision_id: row.revision_id,
        operation: row.operation,
        title: row.title,
        changed,
        recorded_at: row.recorded_at,
        // A previous password is sealed in the history row; this says one is
        // retained.
        has_previous_password: row.password != null,
      };
    });
}

/** Attachment METADATA. The bytes are NOT sealed — the sealed class is a
 *  column class — so this returns what the file IS (GAPS §3.3 #8). */
export async function readAttachments(
  ctx: HandlerCtx,
  itemId: string,
  purpose: string
): Promise<Record<string, unknown>[]> {
  let edges: AttachmentRow[] = [];
  try {
    const result = await ctx.vault.read({
      entity: "core.attachment",
      where: [
        { column: "target_type", op: "eq", value: "locker.item" },
        { column: "target_id", op: "eq", value: itemId },
      ],
      purpose,
    });
    edges = (result.rows ?? []) as unknown as AttachmentRow[];
  } catch {
    return [];
  }
  if (edges.length === 0) return [];
  let contents: ContentRow[] = [];
  try {
    const result = await ctx.vault.read({
      entity: "core.content_item",
      where: [
        {
          column: "content_id",
          op: "in",
          value: edges.map((edge) => edge.content_id),
        },
      ],
      purpose,
    });
    contents = (result.rows ?? []) as unknown as ContentRow[];
  } catch {
    contents = [];
  }
  const byId = new Map(contents.map((row) => [row.content_id, row]));
  return edges.map((edge) => {
    const content = byId.get(edge.content_id);
    return {
      attachment_id: edge.attachment_id,
      content_id: edge.content_id,
      role: edge.role,
      title: content?.title ?? null,
      media_type: content?.media_type ?? null,
      byte_size: content?.byte_size ?? null,
    };
  });
}
