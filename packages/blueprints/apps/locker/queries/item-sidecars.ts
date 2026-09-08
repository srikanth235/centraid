import { inList, readPages } from "../../_shared/paged-reads.ts";
import {
  ownerKey,
  readRepresentations,
} from "../../_shared/representation-reads.ts";
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
  byte_size?: number | null;
}

/**
 * ONE SIDECAR TABLE FOR ONE ITEM (#996 wave 4, R8).
 *
 * Every sidecar is the same shape of read — one item's rows out of a table
 * keyed on the item — so it is one walk, given the table, its projection and
 * its own primary key. A vault's largest custom-field set is still a set one
 * member typed, so the walk's stated ceiling is far above it and throwing
 * there is the right answer: a pane silently missing half a card's fields is
 * worse than one that says it could not be drawn.
 */
async function rowsOf<T extends object>(
  ctx: HandlerCtx,
  spec: { name: string; select: string; from: string; pkColumn: string },
  itemId: string,
  column = "item_id"
): Promise<T[]> {
  try {
    return await readPages<T>(ctx, {
      name: spec.name,
      select: spec.select,
      from: spec.from,
      where: `${column} = ?`,
      bind: [itemId],
      order: {
        sortColumn: spec.pkColumn,
        pkColumn: spec.pkColumn,
        descending: false,
      },
    });
  } catch {
    // A sidecar the grant does not cover leaves its section empty; it never
    // takes the pane down with it.
    return [];
  }
}

export async function readAlias(
  ctx: HandlerCtx,
  itemId: string
): Promise<string | null> {
  const rows = await rowsOf<{ alias: string }>(
    ctx,
    {
      name: "locker.sidecars.alias",
      select: "alias, item_id",
      from: "locker_item_alias",
      pkColumn: "alias",
    },
    itemId
  );
  return rows[0]?.alias ?? null;
}

export async function readFields(
  ctx: HandlerCtx,
  itemId: string
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
    {
      name: "locker.sidecars.fields",
      // `value_sealed` is projected because its PRESENCE is what the pane
      // draws; the column holds ciphertext at rest, never plaintext.
      select:
        "field_id, item_id, section, label, kind, value_text, value_sealed, position",
      from: "locker_item_field",
      pkColumn: "field_id",
    },
    itemId
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
  itemId: string
): Promise<{ address_id: string; url: string; match_policy: string }[]> {
  const rows = await rowsOf<AddressRow>(
    ctx,
    {
      name: "locker.sidecars.addresses",
      select: "address_id, item_id, url, match_policy, position",
      from: "locker_item_address",
      pkColumn: "address_id",
    },
    itemId
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
  itemId: string
): Promise<Record<string, unknown> | null> {
  const rows = await rowsOf<PasskeyRow>(
    ctx,
    {
      name: "locker.sidecars.passkey",
      select:
        "item_id, rp_id, user_handle, display_name, credential_id, algorithm, private_key, created_at",
      from: "locker_item_passkey",
      pkColumn: "item_id",
    },
    itemId
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
  limit = 50
): Promise<Record<string, unknown>[]> {
  let rows: RevisionRow[] = [];
  try {
    const result = await ctx.vault.page<RevisionRow>({
      query: {
        name: "locker.sidecars.revisions",
        select:
          "revision_id, entity_type, entity_id, operation, snapshot_json, recorded_at",
        from: "core_entity_revision",
        where: "entity_type = ? AND entity_id = ?",
        bind: ["locker.item", itemId],
        order: {
          sortColumn: "recorded_at",
          pkColumn: "revision_id",
          descending: true,
        },
      },
      limit,
    });
    rows = result.rows;
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
  itemId: string
): Promise<Record<string, unknown>[]> {
  let edges: AttachmentRow[] = [];
  try {
    edges = await readPages<AttachmentRow>(ctx, {
      name: "locker.sidecars.attachments",
      select: "attachment_id, target_type, target_id, content_id, role",
      from: "core_attachment",
      where: "target_type = ? AND target_id = ?",
      bind: ["locker.item", itemId],
      order: {
        sortColumn: "attachment_id",
        pkColumn: "attachment_id",
        descending: false,
      },
    });
  } catch {
    return [];
  }
  if (edges.length === 0) return [];
  let contents: ContentRow[] = [];
  try {
    const contentIn = inList(
      "content_id",
      edges.map((edge) => edge.content_id)
    );
    contents = await readPages<ContentRow>(ctx, {
      name: "locker.sidecars.contents",
      select: "content_id, byte_size",
      from: "core_content_item",
      where: contentIn.sql,
      bind: contentIn.bind,
      order: {
        sortColumn: "content_id",
        pkColumn: "content_id",
        descending: false,
      },
    });
  } catch {
    contents = [];
  }
  // Bytes carry no media type since #996 (R20(b)); the attachment's own
  // representation says what it reads them as, and bytes have no title.
  const representations = await readRepresentations({
    ctx,
    contentIds: edges.map((edge) => edge.content_id),
  });
  const byId = new Map(contents.map((row) => [row.content_id, row]));
  return edges.map((edge) => {
    const content = byId.get(edge.content_id);
    return {
      attachment_id: edge.attachment_id,
      content_id: edge.content_id,
      role: edge.role,
      media_type:
        representations.byOwner.get(
          ownerKey("core.attachment", edge.attachment_id)
        ) ??
        representations.byContent.get(edge.content_id) ??
        null,
      byte_size: content?.byte_size ?? null,
    };
  });
}
