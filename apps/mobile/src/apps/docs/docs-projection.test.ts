import { describe, expect, it } from "vitest";

import {
  bytesOnDevice,
  docRowState,
  kindIconName,
  originsByDocument,
  projectDrive,
  purgeDaysLeft,
  sharesByDocument,
  sortDocuments,
} from "./docs-projection";
import type { DriveEntityRows, MobileDriveDoc } from "./docs-projection";

const FOLDERS_URI = "https://centraid.dev/schemes/folders";
const FLAGS_URI = "https://centraid.dev/schemes/flags";
const TAGS_URI = "centraid:tags:v1";

function fixtureRows(
  overrides: Partial<DriveEntityRows> = {}
): DriveEntityRows {
  return {
    origins: null,
    schemes: [
      { scheme_id: "s-folders", uri: FOLDERS_URI },
      { scheme_id: "s-flags", uri: FLAGS_URI },
      { scheme_id: "s-tags", uri: TAGS_URI },
    ],
    concepts: [
      { concept_id: "c-root", scheme_id: "s-folders", notation: "root" },
      {
        concept_id: "c-property",
        scheme_id: "s-folders",
        pref_label: "Property",
        broader_concept_id: "c-root",
      },
      { concept_id: "c-starred", scheme_id: "s-flags", notation: "starred" },
      { concept_id: "c-urgent", scheme_id: "s-tags", pref_label: "urgent" },
    ],
    tags: [
      {
        tag_id: "t1",
        concept_id: "c-property",
        target_id: "doc-lease",
        target_type: "core.document",
      },
      {
        tag_id: "t2",
        concept_id: "c-root",
        target_id: "doc-scan",
        target_type: "core.document",
      },
      {
        tag_id: "t3",
        concept_id: "c-starred",
        target_id: "doc-lease",
        target_type: "core.document",
      },
      {
        tag_id: "t4",
        concept_id: "c-urgent",
        target_id: "doc-lease",
        target_type: "core.document",
      },
      {
        tag_id: "t5",
        concept_id: "c-gone",
        target_id: "doc-orphan",
        target_type: "core.document",
      },
    ],
    documents: [
      {
        document_id: "doc-lease",
        current_content_id: "content-lease",
        title: "Lease — 14 Sitwell Road.pdf",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-08-01T00:00:00Z",
        deleted_at: null,
        purge_at: null,
      },
      {
        document_id: "doc-scan",
        current_content_id: "content-scan",
        title: "Passport scan.jpg",
        created_at: "2026-02-01T00:00:00Z",
        updated_at: "2026-07-01T00:00:00Z",
        deleted_at: null,
        purge_at: null,
      },
      {
        document_id: "doc-orphan",
        current_content_id: "content-orphan",
        title: "Deed of grant.docx",
        created_at: "2026-03-01T00:00:00Z",
        updated_at: "2026-06-01T00:00:00Z",
        deleted_at: null,
        purge_at: null,
      },
      {
        document_id: "doc-trashed",
        current_content_id: "content-trashed",
        title: "Old invoice.pdf",
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-05-01T00:00:00Z",
        deleted_at: "2026-08-10T00:00:00Z",
        purge_at: "2026-09-09T00:00:00Z",
      },
    ],
    contents: [
      {
        content_id: "content-lease",
        media_type: "application/pdf",
        byte_size: 120_000,
      },
      {
        content_id: "content-scan",
        media_type: "image/jpeg",
        byte_size: 2_400_000,
      },
      {
        content_id: "content-orphan",
        media_type: "application/octet-stream",
        byte_size: 880_000,
      },
      {
        content_id: "content-trashed",
        media_type: "application/pdf",
        byte_size: 9_000,
      },
    ],
    custody: [
      { content_id: "content-scan", custody_state: "local-only" },
      { content_id: "content-lease", custody_state: "replicated" },
    ],
    shares: null,
    ...overrides,
  };
}

describe(projectDrive, () => {
  const projection = projectDrive(fixtureRows());
  const byId = new Map(
    projection.documents.map((doc) => [doc.document_id, doc])
  );

  it("projects folders from the folders scheme, root excluded", () => {
    expect(projection.rootFolderId).toBe("c-root");
    expect(projection.folders).toStrictEqual([
      { folder_id: "c-property", name: "Property", parent_id: null },
    ]);
  });

  it("joins the current content, the star, the labels and custody onto the wrapper", () => {
    const lease = byId.get("doc-lease");
    expect(lease?.media_type).toBe("application/pdf");
    expect(lease?.byte_size).toBe(120_000);
    expect(lease?.folder_id).toBe("c-property");
    expect(lease?.starred).toBe(true);
    expect(lease?.tags).toStrictEqual([{ tag_id: "t4", label: "urgent" }]);
    expect(lease?.custody_state).toBe("replicated");
  });

  it("treats a root tag as unfiled (folder_id null), and counts it", () => {
    expect(byId.get("doc-scan")?.folder_id).toBeNull();
    expect(projection.unfiledCount).toBe(1);
  });

  it("marks a document whose folder tag has nothing on the other end", () => {
    const orphan = byId.get("doc-orphan");
    expect(orphan?.folderGone).toBe(true);
    expect(orphan?.folder_id).toBeNull();
    expect(byId.get("doc-scan")?.folderGone).toBe(false);
  });

  it("keeps trashed documents with their purge dates", () => {
    const trashed = byId.get("doc-trashed");
    expect(trashed?.trashed).toBe(true);
    expect(trashed?.purge_at).toBe("2026-09-09T00:00:00Z");
  });

  it("ships shared_with null on every row when the share reads are absent — unknown, not negative", () => {
    for (const doc of projection.documents) {
      expect(doc.shared_with).toBeNull();
    }
  });

  it("says it does not KNOW what was shared when the origin read is absent", () => {
    expect(projection.sharedFromKnown).toBe(false);
    for (const doc of projection.documents) {
      expect(doc.shared_from).toBeNull();
    }
  });

  it("hangs the placement on the row it names, once the origin read answers", () => {
    const answered = projectDrive(
      fixtureRows({
        origins: {
          origins: [
            {
              target_type: "core.document",
              target_id: "doc-lease",
              origin_vault_id: "vault-alice",
              origin_item_id: "doc-far-away",
              shared_at: 1_788_183_726_358,
            },
          ],
          bindings: [
            {
              party_id: "party-alice",
              vault_id: "vault-alice",
              revoked_at: null,
            },
          ],
          parties: [{ party_id: "party-alice", display_name: "Alice" }],
        },
      })
    );
    expect(answered.sharedFromKnown).toBe(true);
    const lease = answered.documents.find(
      (doc) => doc.document_id === "doc-lease"
    );
    expect(lease?.shared_from).toMatchObject({
      vault_id: "vault-alice",
      party_id: "party-alice",
      name: "Alice",
    });
    expect(
      answered.documents.filter((doc) => doc.shared_from !== null)
    ).toHaveLength(1);
  });
});

describe(originsByDocument, () => {
  const origin = {
    target_type: "core.document",
    target_id: "doc-1",
    origin_vault_id: "vault-alice",
    origin_item_id: "doc-far-away",
    shared_at: 1_788_183_726_358,
  };
  const binding = {
    party_id: "party-alice",
    vault_id: "vault-alice",
    revoked_at: null,
  };
  const party = { party_id: "party-alice", display_name: "Alice" };

  it("names the sender through the link binding, and carries when it landed", () => {
    const found = originsByDocument({
      origins: [origin],
      bindings: [binding],
      parties: [party],
    }).get("doc-1");
    expect(found).toStrictEqual({
      vault_id: "vault-alice",
      party_id: "party-alice",
      name: "Alice",
      at: 1_788_183_726_358,
    });
  });

  it("leaves the vault unnamed rather than wearing its id as a name", () => {
    const noBinding = originsByDocument({
      origins: [origin],
      bindings: [],
      parties: [party],
    }).get("doc-1");
    expect(noBinding).toMatchObject({ party_id: null, name: null });
    expect(noBinding?.vault_id).toBe("vault-alice");

    const revoked = originsByDocument({
      origins: [origin],
      bindings: [{ ...binding, revoked_at: "2026-08-31T00:00:00Z" }],
      parties: [party],
    }).get("doc-1");
    expect(revoked).toMatchObject({ party_id: null, name: null });
  });

  it("keeps a bound vault unnamed when the directory holds no name for it", () => {
    const unnamed = originsByDocument({
      origins: [origin],
      bindings: [binding],
      parties: [{ party_id: "party-alice", display_name: "   " }],
    }).get("doc-1");
    expect(unnamed).toMatchObject({ party_id: "party-alice", name: null });
  });

  it("ignores placements of anything that is not a document", () => {
    const map = originsByDocument({
      origins: [
        { ...origin, target_type: "media.asset", target_id: "asset-1" },
      ],
      bindings: [binding],
      parties: [party],
    });
    expect(map.size).toBe(0);
  });
});

describe(sharesByDocument, () => {
  const shareRows = {
    grants: [
      {
        grant_id: "g-doc",
        circle_id: "circle-family",
        container_type: "core.document",
        container_id: "doc-lease",
        plane: "commons",
        revoked_at: null,
        implicit_circle: 0,
      },
      {
        grant_id: "g-folder",
        circle_id: "circle-implicit",
        container_type: "docs.folder",
        container_id: "c-property",
        plane: "commons",
        revoked_at: null,
        implicit_circle: 1,
      },
      {
        grant_id: "g-revoked",
        circle_id: "circle-family",
        container_type: "core.document",
        container_id: "doc-lease",
        plane: "commons",
        revoked_at: "2026-05-01T00:00:00Z",
        implicit_circle: 0,
      },
    ],
    circles: [
      { circle_id: "circle-family", name: "Family" },
      { circle_id: "circle-implicit", name: "__implicit__" },
    ],
    members: [
      {
        circle_id: "circle-family",
        party_id: "p-ana",
        capability: "read+write",
      },
      { circle_id: "circle-family", party_id: "p-tom", capability: "read" },
      { circle_id: "circle-implicit", party_id: "p-ana", capability: "read" },
    ],
    states: [
      { grant_id: "g-doc", party_id: "p-ana", status: "current" },
      { grant_id: "g-doc", party_id: "p-tom", status: "refused" },
    ],
    parties: [
      { party_id: "p-ana", display_name: "Ana" },
      { party_id: "p-tom", display_name: "Tom" },
    ],
  };
  const folderByDoc = new Map([["doc-lease", "c-property"]]);
  const folderConcepts = [
    { concept_id: "c-root", scheme_id: "s-folders", notation: "root" },
    {
      concept_id: "c-property",
      scheme_id: "s-folders",
      pref_label: "Property",
      broader_concept_id: "c-root",
    },
  ];

  it("joins document grants and the folder chain's grants, document-first, with honest labels and pending counts", () => {
    const byDoc = sharesByDocument(shareRows, {
      documentIds: ["doc-lease", "doc-scan"],
      folderByDoc,
      folderConcepts,
    });
    const entries = byDoc.get("doc-lease");
    expect(entries?.map((entry) => entry.grant_id)).toStrictEqual([
      "g-doc",
      "g-folder",
    ]);
    const [docShare, folderShare] = entries ?? [];
    expect(docShare?.label).toBe("Family");
    expect(docShare?.members.map((member) => member.label)).toStrictEqual([
      "Ana",
    ]);
    expect(docShare?.pending_count).toBe(0);
    expect(folderShare?.label).toBe("Ana");
    expect(folderShare?.via).toBe("folder");
    expect(folderShare?.pending_count).toBe(1);
    expect(byDoc.has("doc-scan")).toBe(false);
  });
});

describe(docRowState, () => {
  const base = {
    media_type: "application/pdf",
    title: "Lease.pdf",
    trashed: false,
    purge_at: null,
    custody_state: null,
  };
  const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();

  it("says nothing on an ordinary renderable row", () => {
    expect(docRowState(base, { offline: false })).toBeNull();
  });

  it("puts 'cannot be shown' first — before the custody mark", () => {
    const mark = docRowState(
      {
        ...base,
        media_type: "application/vnd.ms-excel",
        custody_state: "local-only",
      },
      { offline: false }
    );
    expect(mark).toStrictEqual({
      kind: "text",
      text: "cannot be shown",
      net: false,
    });
  });

  it("gives the slot to the purge countdown in trash, over every other state", () => {
    const mark = docRowState(
      {
        ...base,
        media_type: "application/vnd.ms-excel",
        trashed: true,
        purge_at: soon,
        custody_state: "local-only",
      },
      { offline: true }
    );
    expect(mark?.kind).toBe("text");
    expect(mark?.text).toMatch(/^purged in 3 days$/u);
  });

  it("keeps a trashed slot blank when the vault never asserted a purge date", () => {
    expect(
      docRowState({ ...base, trashed: true }, { offline: false })
    ).toBeNull();
  });

  it("says 'will not open' offline only when the bytes are positively elsewhere", () => {
    expect(
      docRowState({ ...base, custody_state: "remote-only" }, { offline: true })
    ).toStrictEqual({ kind: "text", text: "will not open", net: true });
    expect(docRowState(base, { offline: true })).toBeNull();
  });

  it("ends the ladder at the device glyph — a mark, never a sentence", () => {
    expect(
      docRowState({ ...base, custody_state: "local-only" }, { offline: false })
    ).toStrictEqual({
      kind: "glyph",
      text: "on this device only",
      net: false,
    });
  });
});

describe("helpers", () => {
  it("counts purge days up, never negative", () => {
    expect(purgeDaysLeft(null)).toBeNull();
    expect(purgeDaysLeft("not a date")).toBeNull();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    expect(purgeDaysLeft(past)).toBe(0);
  });

  it("treats only remote-only and missing as bytes-elsewhere", () => {
    expect(bytesOnDevice({ custody_state: "remote-only" })).toBe(false);
    expect(bytesOnDevice({ custody_state: "missing" })).toBe(false);
    expect(bytesOnDevice({ custody_state: "local-only" })).toBe(true);
    expect(bytesOnDevice({ custody_state: null })).toBe(true);
  });

  it("sorts by the remembered orders", () => {
    const docs = [
      { title: "B", byte_size: 2, updated_at: "2026-02-01", created_at: "" },
      { title: "A", byte_size: 9, updated_at: "2026-03-01", created_at: "" },
    ] as unknown as MobileDriveDoc[];
    expect(
      sortDocuments(docs, "changed", -1).map((doc) => doc.title)
    ).toStrictEqual(["A", "B"]);
    expect(
      sortDocuments(docs, "name", 1).map((doc) => doc.title)
    ).toStrictEqual(["A", "B"]);
    expect(
      sortDocuments(docs, "size", -1).map((doc) => doc.title)
    ).toStrictEqual(["A", "B"]);
  });

  it("maps the web's own glyph roles onto the shared icon registry", () => {
    expect(kindIconName({ media_type: "application/pdf" })).toBe("FileText");
    expect(kindIconName({ media_type: "image/png" })).toBe("Image");
    expect(kindIconName({ media_type: "text/csv" })).toBe("Table");
    expect(kindIconName({ media_type: "audio/mpeg" })).toBe("Music");
    expect(kindIconName({ media_type: null, title: "x.bin" })).toBe("FileText");
  });
});

describe("mounted-source provenance on the drive row", () => {
  const stamped = (extra: Record<string, unknown>): DriveEntityRows =>
    fixtureRows({
      documents: [
        {
          document_id: "doc-lease",
          current_content_id: "content-lease",
          title: "Lease — 14 Sitwell Road.pdf",
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-08-01T00:00:00Z",
          deleted_at: null,
          purge_at: null,
          ...extra,
        },
      ],
    });

  it("carries the document row's own canWrite and every source label", () => {
    const { documents } = projectDrive(
      stamped({
        __centraidCanWrite: false,
        __centraidScopeLabels: ["Studio", "Home"],
      })
    );
    expect(documents[0]?.canWrite).toBe(false);
    expect(documents[0]?.scopeLabels).toStrictEqual(["Studio", "Home"]);
  });

  it("reads an unstamped drive as the member's own", () => {
    const { documents } = projectDrive(fixtureRows());
    expect(documents.every((doc) => doc.canWrite)).toBe(true);
    expect(documents[0]?.scopeLabels).toStrictEqual([]);
  });

  it("keeps the replica row itself, so the shared overlay reader can be asked", () => {
    const { documents } = projectDrive(
      stamped({ __centraid_pending_key: "intent-1" })
    );
    expect(documents[0]?.raw["__centraid_pending_key"]).toBe("intent-1");
  });
});
