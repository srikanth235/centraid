// Who a document is shared with (#821, #929), as the drive and search
// projections ship it.
//
// Three rules are load-bearing here, and each one is a sentence a member would
// otherwise read wrongly:
//
//   * a grant on a FOLDER reaches the documents inside it, at any depth, and
//     the row says the share came `via: "folder"` — a rail that claimed the
//     document itself was shared would send a member looking for a share they
//     never made;
//   * a DENIAL of the (new, therefore parked-for-approval) share scopes leaves
//     `shared_with: null` on every row and the drive otherwise whole — a
//     regression here does not read as a bug, it reads as "shared with nobody";
//   * a ONE-PERSON audience is labelled by that person and names no circle,
//     because since #929 a standing answer points at either, not at a
//     machine-named circle standing in for someone.
import { describe, expect, it, vi } from "vitest";

import {
  FOLDER_SCHEME_URI,
  ROOT_FOLDER_NOTATION,
} from "../../_shared/concept-scheme-kit.ts";
import driveHandler from "./drive.ts";
import searchHandler from "./search.ts";

const SHARE_ENTITIES = new Set([
  "share.authority",
  "share.fulfillment",
  "share.party_vault_binding",
  "social.circle",
  "social.circle_member",
  "core.party",
]);

// One folders scheme: root › Property › Leases. `doc-lease` sits two levels
// down, `doc-loose` sits at the top level.
const ROWS: Record<string, Array<Record<string, unknown>>> = {
  "core.concept_scheme": [{ scheme_id: "s-folders", uri: FOLDER_SCHEME_URI }],
  "core.concept": [
    {
      concept_id: "c-root",
      scheme_id: "s-folders",
      notation: ROOT_FOLDER_NOTATION,
    },
    {
      concept_id: "c-property",
      scheme_id: "s-folders",
      pref_label: "Property",
      broader_concept_id: "c-root",
    },
    {
      concept_id: "c-leases",
      scheme_id: "s-folders",
      pref_label: "Leases",
      broader_concept_id: "c-property",
    },
  ],
  "core.tag": [
    {
      tag_id: "t-1",
      concept_id: "c-leases",
      target_id: "doc-lease",
      target_type: "core.document",
      tagged_at: "2026-02-01T00:00:00Z",
    },
    {
      tag_id: "t-2",
      concept_id: "c-root",
      target_id: "doc-loose",
      target_type: "core.document",
      tagged_at: "2026-01-01T00:00:00Z",
    },
  ],
  "core.document": [
    {
      document_id: "doc-lease",
      current_content_id: "content-lease",
      title: "The lease",
      created_at: "2026-02-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
    },
    {
      document_id: "doc-loose",
      current_content_id: "content-loose",
      title: "A note",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ],
  "core.content_item": [
    { content_id: "content-lease", media_type: "application/pdf" },
    { content_id: "content-loose", media_type: "text/plain" },
  ],
  "social.circle": [{ circle_id: "circle-family", name: "Family" }],
  "social.circle_member": [
    { circle_id: "circle-family", party_id: "party-ana" },
    { circle_id: "circle-family", party_id: "party-tom" },
  ],
  "core.party": [
    { party_id: "party-ana", display_name: "Ana" },
    { party_id: "party-tom", display_name: "Tom" },
    { party_id: "party-ravi", display_name: "Ravi" },
  ],
  "share.authority": [
    // The answer is on the GRANDPARENT folder, not on the document.
    {
      authority_id: "grant-property",
      principal_kind: "circle",
      principal_id: "circle-family",
      subject_type: "docs.folder",
      subject_id: "c-property",
      verb: "edit",
      decision: "granted",
      revoked_at: null,
      expires_at: null,
    },
    // A one-off recipient is ONE PERSON now, not a machine-named circle.
    {
      authority_id: "grant-note",
      principal_kind: "person",
      principal_id: "party-ravi",
      subject_type: "core.document",
      subject_id: "doc-loose",
      verb: "view",
      decision: "granted",
      revoked_at: null,
      expires_at: null,
    },
  ],
  "share.party_vault_binding": [
    { party_id: "party-ana", vault_id: "vault-ana", revoked_at: null },
    { party_id: "party-tom", vault_id: "vault-tom", revoked_at: null },
    { party_id: "party-ravi", vault_id: "vault-ravi", revoked_at: null },
  ],
  // Ana holds it; Tom's vault has never been reached.
  "share.fulfillment": [
    {
      grant_id: "grant-property",
      peer_vault_id: "vault-ana",
      state: "delivered",
      delivered_at: "2026-02-02T00:00:00Z",
    },
    {
      grant_id: "grant-property",
      peer_vault_id: "vault-tom",
      state: "syncing",
      delivered_at: null,
    },
    {
      grant_id: "grant-note",
      peer_vault_id: "vault-ravi",
      state: "delivered",
      delivered_at: "2026-01-02T00:00:00Z",
    },
  ],
};

interface SharedWith {
  grant_id: string;
  circle_id: string | null;
  audience: "person" | "circle";
  label: string;
  via: string;
  container_id: string;
  member_count: number;
  pending_count: number;
  members: Array<{ party_id: string; status: string; capability: string }>;
}
interface Row {
  document_id: string;
  shared_with: SharedWith[] | null;
}

/** A ctx whose share/social reads either answer from ROWS or throw a denial. */
function ctxOf(shareDenied: boolean) {
  const read = vi.fn<
    (request: { entity: string }) => Promise<{
      rows: Array<Record<string, unknown>>;
    }>
  >(async ({ entity }) => {
    if (shareDenied && SHARE_ENTITIES.has(entity))
      throw Object.assign(new Error("scope awaiting owner approval"), {
        code: "VAULT_ACCESS",
      });
    return { rows: ROWS[entity] ?? [] };
  });
  return { ctx: { vault: { read, search: read } } as unknown as never, read };
}

const rowFor = (documents: Row[], id: string): SharedWith[] | null => {
  const row = documents.find((d) => d.document_id === id);
  if (!row) throw new Error(`expected a row for ${id}`);
  return row.shared_with;
};

describe("the drive's shared_with (#821)", () => {
  it("resolves a grant on an ancestor folder, and says it came through one", async () => {
    const result = (await driveHandler({
      input: {},
      ...ctxOf(false),
    } as never)) as { documents: Row[] };

    const shares = rowFor(result.documents, "doc-lease");
    expect(shares).toHaveLength(1);
    expect(shares?.[0]).toMatchObject({
      grant_id: "grant-property",
      label: "Family",
      via: "folder",
      // The folder the member would have to change — the grandparent, not
      // the folder the document is filed in.
      container_id: "c-property",
      member_count: 2,
      pending_count: 1,
    });
    expect(shares?.[0]?.members).toStrictEqual([
      {
        party_id: "party-ana",
        label: "Ana",
        capability: "read+write",
        status: "current",
      },
      {
        party_id: "party-tom",
        label: "Tom",
        capability: "read+write",
        status: "invited",
      },
    ]);
  });

  it("labels a one-person audience by the person, and carries no circle", async () => {
    const result = (await driveHandler({
      input: {},
      ...ctxOf(false),
    } as never)) as { documents: Row[] };

    const shares = rowFor(result.documents, "doc-loose");
    expect(shares?.[0]).toMatchObject({
      label: "Ravi",
      audience: "person",
      circle_id: null,
      via: "document",
      pending_count: 0,
    });
  });

  it("degrades to null on a denial, and keeps the drive whole", async () => {
    const result = (await driveHandler({
      input: {},
      ...ctxOf(true),
    } as never)) as { documents: Row[]; vaultDenied?: unknown };

    expect(result.vaultDenied).toBeUndefined();
    expect(result.documents).toHaveLength(2);
    for (const row of result.documents) expect(row.shared_with).toBeNull();
  });
});

describe("search rows carry the same fact (#821)", () => {
  it("decorates a match exactly as the drive decorates a browsed row", async () => {
    const result = (await searchHandler({
      input: { term: "lease" },
      ...ctxOf(false),
    } as never)) as { documents: Row[] };

    expect(rowFor(result.documents, "doc-lease")?.[0]).toMatchObject({
      grant_id: "grant-property",
      label: "Family",
      via: "folder",
    });
  });

  it("leaves a match's shares null when the share reads deny", async () => {
    const result = (await searchHandler({
      input: { term: "lease" },
      ...ctxOf(true),
    } as never)) as { documents: Row[]; vaultDenied?: unknown };

    expect(result.vaultDenied).toBeUndefined();
    for (const row of result.documents) expect(row.shared_with).toBeNull();
  });
});
