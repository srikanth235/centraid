/**
 * Sidecar reads for the item pane (#872) — a helper, not a query.
 *
 * ONE RULE RUNS THROUGH ALL OF IT: a sealed cell never rides these payloads.
 * `value_sealed` and `private_key` come back as the vault's placeholder, and a
 * revision's `snapshot_json` is opened here and never forwarded — so these
 * return the SHAPE of a secret, never the secret.
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

interface RevisionRow {
  revision_id: string;
  operation: string;
  snapshot_json: string;
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
      acceptTruncation: true,
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

/**
 * THE PLAIN COLUMNS A REVISION MAY NAME, and the word it names each by.
 *
 * IT IS AN ALLOW-LIST, AND THE SEALED COLUMNS ARE NOT ON IT. A snapshot keeps
 * `password`, `otp_seed`, `card_number`, `cvv` and `content` exactly as the row
 * held them — ciphertext under the item's own additional data — so comparing
 * two snapshots would answer "was this cell rewritten", never "did the value
 * change", and the ciphertext is not something a payload may carry either way.
 *
 * A ROTATION IS READ OFF ITS PLAIN WITNESS: the vault re-stamps
 * `password_set_at` exactly when a password is set and leaves it alone when an
 * edit round-trips the sealed placeholder, so the timestamp says a rotation
 * happened without anything having to look at the secret.
 */
const REVISION_COLUMNS: Readonly<Record<string, string>> = {
  type: "type",
  title: "title",
  username: "username",
  url: "url",
  url_match_policy: "url_match_policy",
  notes: "notes",
  cardholder: "cardholder",
  expiry: "expiry",
  brand: "brand",
  fullname: "fullname",
  email: "email",
  phone: "phone",
  address: "address",
  network: "network",
  compromised: "compromised",
  archived_at: "archived",
  deleted_at: "trashed",
  password_set_at: "password",
};

/** What the state that SUPERSEDED this snapshot says differently — column
 *  names, never values. */
function changedBetween(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Record<string, unknown> {
  const changed: Record<string, unknown> = {};
  for (const [column, word] of Object.entries(REVISION_COLUMNS)) {
    const was = before[column] ?? null;
    const now = after[column] ?? null;
    if (was !== now) changed[word] = true;
  }
  return changed;
}

/**
 * ONE ITEM'S REVISIONS (#916, owner decision D2). `locker_item_history` was a
 * SECOND revision mechanism for the same question, and it is gone: an item's
 * pre-mutation state is a `core_entity_revision` row, and `locker.item`
 * declares `revisions: { retain: 'forever' }` so a password rotated last March
 * is still here.
 *
 * The snapshot is opened HERE and never forwarded. What comes back is what
 * changed and when — a rotation is nameable, the password it rotated away from
 * is not. That value survives sealed in the snapshot and leaves the vault only
 * through `locker.export`, which is confirmed and receipted as the mass unseal
 * it is.
 *
 * `current` is the item as it stands now: newest-first, each revision is
 * superseded by the one before it in the list, and the newest by the item
 * itself.
 */
export async function readHistory(
  ctx: HandlerCtx,
  itemId: string,
  current: Record<string, unknown>,
  purpose: string,
  limit = 50
): Promise<Record<string, unknown>[]> {
  let rows: RevisionRow[] = [];
  try {
    const result = await ctx.vault.read({
      acceptTruncation: true,
      entity: "core.entity_revision",
      where: [
        { column: "entity_type", op: "eq", value: "locker.item" },
        { column: "entity_id", op: "eq", value: itemId },
      ],
      orderBy: { column: "recorded_at", dir: "desc" },
      limit,
      purpose,
    });
    rows = (result.rows ?? []) as unknown as RevisionRow[];
  } catch {
    // A read the grant does not cover leaves the section empty; it never takes
    // the pane down with it.
    return [];
  }
  let after = current;
  return rows.map((row) => {
    let snapshot: Record<string, unknown> | null = null;
    try {
      snapshot = JSON.parse(row.snapshot_json) as Record<string, unknown>;
    } catch {
      // A snapshot that will not parse names NOTHING. An empty object diffed
      // against the live item would report every column as changed, which is a
      // louder claim than "unreadable" and a false one.
      snapshot = null;
    }
    const changed = snapshot ? changedBetween(snapshot, after) : {};
    if (snapshot) after = snapshot;
    return {
      revision_id: row.revision_id,
      operation: row.operation,
      changed,
      recorded_at: row.recorded_at,
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
      acceptTruncation: true,
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
      acceptTruncation: true,
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
