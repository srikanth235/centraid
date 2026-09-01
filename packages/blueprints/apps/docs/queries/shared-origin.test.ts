// The Shared shelf's data door (#903): a document DELIVERED into this vault.
//
// A join, not a filter — the drive's window is built from folders-scheme tags
// and a delivered copy carries none.
//
// The ctx honours `where`, unlike `shares.test.ts`'s — a harness returning
// every row would report the second door open while only the first ever was.
import { describe, expect, it, vi } from "vitest";

import {
  FOLDER_SCHEME_URI,
  ROOT_FOLDER_NOTATION,
} from "../../_shared/concept-scheme-kit.ts";
import driveHandler from "./drive.ts";

const ORIGIN_ENTITIES = new Set([
  "core.share_origin",
  "share.party_vault_binding",
]);

// `doc-sent` carries no folders-scheme tag at all: it arrived, which is the
// only reason it exists.
const ROWS: Record<string, Array<Record<string, unknown>>> = {
  "core.concept_scheme": [{ scheme_id: "s-folders", uri: FOLDER_SCHEME_URI }],
  "core.concept": [
    {
      concept_id: "c-root",
      scheme_id: "s-folders",
      notation: ROOT_FOLDER_NOTATION,
    },
  ],
  "core.tag": [
    {
      tag_id: "t-1",
      concept_id: "c-root",
      target_id: "doc-filed",
      target_type: "core.document",
      tagged_at: "2026-01-01T00:00:00Z",
    },
  ],
  "core.document": [
    {
      document_id: "doc-filed",
      current_content_id: "content-filed",
      title: "A note",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
    {
      document_id: "doc-sent",
      current_content_id: "content-sent",
      title: "Ferry timetable",
      created_at: "2026-03-01T00:00:00Z",
      updated_at: "2026-03-01T00:00:00Z",
    },
  ],
  "core.content_item": [
    { content_id: "content-filed", media_type: "text/plain" },
    { content_id: "content-sent", media_type: "text/markdown" },
  ],
  "core.share_origin": [
    {
      item_type: "core.document",
      item_id: "doc-sent",
      origin_vault_id: "vault-ravi",
      shared_at: 1_772_000_000_000,
    },
  ],
  "share.party_vault_binding": [
    {
      binding_id: "b-1",
      party_id: "party-ravi",
      vault_id: "vault-ravi",
      linked_at: "2026-02-01T00:00:00Z",
      revoked_at: null,
    },
  ],
  "core.party": [{ party_id: "party-ravi", display_name: "Ravi" }],
};

interface Clause {
  column: string;
  op: string;
  value?: unknown;
}

/** Honours eq / in / is-null, which is every op these reads use. */
function matches(row: Record<string, unknown>, where: Clause[]): boolean {
  return where.every((clause) => {
    const cell = row[clause.column];
    if (clause.op === "is-null") return cell === null || cell === undefined;
    if (clause.op === "in")
      return (clause.value as unknown[]).includes(cell as never);
    return cell === clause.value;
  });
}

interface OriginRow {
  document_id: string;
  title: string;
  folder_id: string | null;
  shared_from: {
    vault_id: string;
    party_id: string | null;
    name: string | null;
    at: number;
  } | null;
}

function ctxOf({ deniedEntities = new Set<string>() } = {}) {
  const read = vi.fn<
    (request: { entity: string; where?: Clause[] }) => Promise<{
      rows: Array<Record<string, unknown>>;
    }>
  >(async ({ entity, where }) => {
    if (deniedEntities.has(entity))
      throw Object.assign(new Error("scope awaiting owner approval"), {
        code: "VAULT_CONSENT",
      });
    const rows = ROWS[entity] ?? [];
    return { rows: where ? rows.filter((r) => matches(r, where)) : rows };
  });
  return { ctx: { vault: { read, search: read } } as unknown as never, read };
}

const run = async (opts?: Parameters<typeof ctxOf>[0]) =>
  (await driveHandler({
    input: {},
    ctx: ctxOf(opts).ctx,
  } as never)) as unknown as {
    documents: OriginRow[];
    shared_from_known: boolean;
  };

const rowFor = (documents: OriginRow[], id: string): OriginRow => {
  const row = documents.find((d) => d.document_id === id);
  if (!row) throw new Error(`expected a row for ${id}`);
  return row;
};

describe("the drive's shared_from (#903)", () => {
  it("reaches a delivered document that carries no folder tag at all", async () => {
    const { documents } = await run();
    // The regression this locks: `doc-sent` is in NO folder, so the tag window
    // cannot see it and the seat shows a received document nowhere.
    expect(documents.map((d) => d.document_id).toSorted()).toStrictEqual([
      "doc-filed",
      "doc-sent",
    ]);
    expect(rowFor(documents, "doc-sent").folder_id).toBeNull();
  });

  it("names the sender through a live binding, and dates the arrival", async () => {
    const { documents } = await run();
    expect(rowFor(documents, "doc-sent").shared_from).toStrictEqual({
      vault_id: "vault-ravi",
      party_id: "party-ravi",
      name: "Ravi",
      at: 1_772_000_000_000,
    });
  });

  it("leaves an ordinary filed document with no placement record", async () => {
    const { documents } = await run();
    // `null` here is a FACT — it arrived some other way — not an unknown.
    expect(rowFor(documents, "doc-filed").shared_from).toBeNull();
  });

  it("withholds the NAME when no live binding says whose vault it was", async () => {
    const { documents } = await run({
      deniedEntities: new Set(["share.party_vault_binding"]),
    });
    // A denied binding read costs the NAME, never the arrival.
    expect(rowFor(documents, "doc-sent").shared_from).toStrictEqual({
      vault_id: "vault-ravi",
      party_id: null,
      name: null,
      at: 1_772_000_000_000,
    });
  });

  it("says it cannot say when the placement read itself is denied", async () => {
    const { documents, shared_from_known } = await run({
      deniedEntities: new Set(["core.share_origin"]),
    });
    // ABSENT IS NOT EMPTY: the tagged half still answers, and the shelf is told
    // the read failed rather than drawing an empty inbox.
    expect(shared_from_known).toBe(false);
    expect(documents.map((d) => d.document_id)).toStrictEqual(["doc-filed"]);
  });

  it("reports the placement read as answered on an ordinary drive", async () => {
    expect((await run()).shared_from_known).toBe(true);
  });
});

describe("the origin read's own denial is not the drive's", () => {
  it("keeps every other decoration whole when placements are denied", async () => {
    const { documents } = await run({
      deniedEntities: new Set(ORIGIN_ENTITIES),
    });
    const filed = rowFor(documents, "doc-filed");
    expect(filed.title).toBe("A note");
    expect(filed.shared_from).toBeNull();
  });
});
