// Cross-referencing (#272): the owner's pick IS the consent. A link the
// owner asserts lets an app resolve the far end of a domain it was never
// granted — and only for as long as both the grant and the link live.
import { describe, expect, test } from "vitest";

import { tempDir } from "@centraid/test-kit/temp-dir";

import { silentLogger, usePlaneFixture } from "./vault-plane.test-fixtures.js";
import { openVaultRegistry } from "./vault-registry.js";

describe("vault-plane cross-references", () => {
  const fixture = usePlaneFixture();

  test("cross-referencing (issue #272): shell pick → owner link → app resolves the far end without a scope", async () => {
    const plane = fixture.openPlane(await tempDir());
    const owner = plane.ownerCredential;
    const purpose = "dpv:ServiceProvision";
    const PNG =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

    // The owner's vault holds a note and a photo (two different domains).
    const note = plane.gateway.invoke(owner, {
      command: "knowledge.create_note",
      input: { title: "Trip plan", body_text: "pack the camera" },
      purpose,
    });
    expect(note.status).toBe("executed");
    const noteId = (note as { output: { note_id: string } }).output.note_id;
    const photo = plane.gateway.invoke(owner, {
      command: "media.add_asset",
      input: { data_uri: PNG, title: "Beach sunset" },
      purpose,
    });
    expect(photo.status).toBe("executed");
    const assetId = (photo as { output: { asset_id: string } }).output.asset_id;

    // The shell picker finds both — term search rides FTS, browse rides pk order.
    const searched = plane.pickEntities({ term: "trip" });
    expect(
      searched.cards.some((c) => c.type === "knowledge.note" && c.id === noteId)
    ).toBe(true);
    const browsed = plane.pickEntities({ kinds: ["media.asset"] });
    expect(browsed.cards).toHaveLength(1);
    expect(browsed.cards[0]).toMatchObject({
      type: "media.asset",
      id: assetId,
      status: "live",
    });

    // The pick is the consent: the shell asserts the link as the owner.
    const linked = await plane.linkAsOwner({
      from_type: "knowledge.note",
      from_id: noteId,
      to_type: "media.asset",
      to_id: assetId,
      selector: { exact: "camera", prefix: "pack the ", suffix: "", start: 9 },
    });
    expect(linked.status).toBe("executed");
    const linkId = (linked as { output: { link_id: string } }).output.link_id;
    const anchor = plane.db.vault
      .prepare("SELECT anchor_id FROM core_link_anchor WHERE link_id = ?")
      .get(linkId) as { anchor_id: string };
    expect(plane.pickAnchors({ term: "camera" }).anchors).toStrictEqual([
      expect.objectContaining({
        type: "core.link_anchor",
        id: anchor.anchor_id,
        title: "camera",
        sourceType: "knowledge.note",
        sourceId: noteId,
        sourceField: "body_content_id",
      }),
    ]);

    // A notes-shaped app (knowledge + core.link read, NO media scope) renders
    // the photo's card through its own bridge via resolvable-if-linked.
    plane.enrollApp("notes");
    plane.approveGrant("notes", {
      purpose,
      scopes: [
        { schema: "knowledge", verbs: "read" },
        { schema: "core", table: "link", verbs: "read" },
      ],
    });
    const bridge = plane.bridgeFor("notes");
    const resolved = await bridge({
      op: "resolve",
      payload: { refs: [{ type: "media.asset", id: assetId }], purpose },
    });
    expect(resolved.ok).toBe(true);
    const cards = (resolved.result as { cards: Array<Record<string, unknown>> })
      .cards;
    expect(cards[0]).toMatchObject({ status: "live", title: "Beach sunset" });

    // The issue's acceptance test, revoke half: pull the app's grant and its
    // projections go dark — while the note, the photo and the link all remain
    // the owner's, untouched.
    const grants =
      plane.listApps().find((a) => a.name === "notes")?.grants ?? [];
    expect(grants).toHaveLength(1);
    plane.revokeGrant(grants[0]!.grantId);
    const revoked = await bridge({
      op: "resolve",
      payload: { refs: [{ type: "media.asset", id: assetId }], purpose },
    });
    expect(revoked.ok).toBe(true);
    expect(
      (revoked.result as { cards: Array<{ status: string }> }).cards[0]!.status
    ).toBe("denied");
    const darkRead = await bridge({
      op: "read",
      payload: { entity: "knowledge.note", purpose },
    });
    expect(darkRead.ok).toBe(false);
    expect(darkRead.code).toBe("VAULT_CONSENT");
    const survivors = plane.db.vault
      .prepare(
        `SELECT (SELECT count(*) FROM knowledge_note WHERE note_id = ?)
            + (SELECT count(*) FROM media_asset WHERE asset_id = ?)
            + (SELECT count(*) FROM core_link WHERE link_id = ? AND valid_to IS NULL) AS n`
      )
      .get(noteId, assetId, linkId) as { n: number };
    expect(survivors.n).toBe(3);

    // Re-grant, then end the link: unlink ends the authorization too.
    plane.approveGrant("notes", {
      purpose,
      scopes: [
        { schema: "knowledge", verbs: "read" },
        { schema: "core", table: "link", verbs: "read" },
      ],
    });
    const unlinked = await plane.unlinkAsOwner(linkId);
    expect(unlinked.status).toBe("executed");
    const dark = await bridge({
      op: "resolve",
      payload: { refs: [{ type: "media.asset", id: assetId }], purpose },
    });
    expect(dark.ok).toBe(true);
    expect(
      (dark.result as { cards: Array<{ status: string }> }).cards[0]!.status
    ).toBe("denied");
  });

  test("owner routes (issue #272): picker searches, POST links asserts, DELETE ends", async () => {
    const dir = await tempDir();
    const registry = openVaultRegistry({
      rootDir: dir,
      logger: silentLogger,
      ownerName: "Priya",
    });
    registry.create("Personal");
    fixture.push(() => registry.stop());
    const plane = registry.current();
    const purpose = "dpv:ServiceProvision";
    const note = plane.gateway.invoke(plane.ownerCredential, {
      command: "knowledge.create_note",
      input: {
        title: "Camera shopping",
        body_text: "compare mirrorless bodies",
      },
      purpose,
    });
    const noteId = (note as { output: { note_id: string } }).output.note_id;
    const task = plane.gateway.invoke(plane.ownerCredential, {
      command: "schedule.add_task",
      input: { title: "Visit the camera store" },
      purpose,
    });
    const taskId = (task as { output: { task_id: string } }).output.task_id;

    const base = await fixture.serveOwnerRoutes(registry);

    // Term search hits both kinds through their FTS indexes.
    const picked = (await (
      await fetch(`${base}/picker?term=camera`)
    ).json()) as {
      cards: Array<{ type: string; id: string; title: string }>;
    };
    expect(
      picked.cards.some((c) => c.type === "knowledge.note" && c.id === noteId)
    ).toBe(true);
    expect(
      picked.cards.some((c) => c.type === "schedule.task" && c.id === taskId)
    ).toBe(true);

    // POST /links asserts the picked relationship as the owner.
    const linkRes = await fetch(`${base}/links`, {
      method: "POST",
      body: JSON.stringify({
        from_type: "knowledge.note",
        from_id: noteId,
        to_type: "schedule.task",
        to_id: taskId,
      }),
    });
    expect(linkRes.status).toBe(200);
    const linked = (await linkRes.json()) as {
      status: string;
      output: { link_id: string };
    };
    expect(linked.status).toBe("executed");
    const row = plane.db.vault
      .prepare("SELECT asserted_by, valid_to FROM core_link WHERE link_id = ?")
      .get(linked.output.link_id) as {
      asserted_by: string;
      valid_to: string | null;
    };
    expect(row).toMatchObject({ asserted_by: "owner", valid_to: null });

    // A malformed body is a 400, not a crash.
    const bad = await fetch(`${base}/links`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(bad.status).toBe(400);

    // DELETE /links/<id> end-dates — temporal, the row survives.
    const unlinkRes = await fetch(`${base}/links/${linked.output.link_id}`, {
      method: "DELETE",
    });
    expect(unlinkRes.status).toBe(200);
    expect(((await unlinkRes.json()) as { status: string }).status).toBe(
      "executed"
    );
    const ended = plane.db.vault
      .prepare("SELECT valid_to FROM core_link WHERE link_id = ?")
      .get(linked.output.link_id) as { valid_to: string | null };
    expect(ended.valid_to).not.toBeNull();
  });
});
