// Client↔gateway seam laws for chat history (#420, #599 Decision 14) — the
// module had no test file (#656 Layer 1B). The load-bearing law is vault
// pinning: a conversation row lives in exactly ONE vault, so once its vault is
// known the client must NAME it on the wire rather than let the shell's ambient
// default-scope pointer decide. Routes are single-sourced from
// `./conversation-routes.ts`, so these tests assert against that builder
// rather than restating the path literals.

import { afterEach, describe, expect, it } from "vitest";

import { conversationPath, conversationsPath } from "./conversation-routes.js";
import {
  history,
  installSeamContractHarness,
  json,
  requests,
  respond,
  sent,
  sentJson,
  wireLog,
} from "./gateway-client-seam-fixtures.js";

installSeamContractHarness();

const SESSIONS = conversationsPath("daily");
const SESSION = conversationPath("daily", "s-1");

describe("conversation history seam", () => {
  it("law: list, create, load, and delete ride the shared route builders", async () => {
    await expect(history.listConversations("daily")).resolves.toStrictEqual([
      { sessionId: "s-1", title: "First" },
    ]);
    await history.createConversation("daily");
    await history.loadConversation("daily", "s-1");
    await history.deleteConversation("daily", "s-1");

    expect(wireLog()).toStrictEqual([
      `GET ${SESSIONS}`,
      `POST ${SESSIONS}`,
      `GET ${SESSION}`,
      `DELETE ${SESSION}`,
    ]);
  });

  it("law: a named scope pins the request to that vault, overriding the ambient pointer", async () => {
    await history.createConversation("daily", "Groceries", "vault-shared");

    const request = sent(`POST ${SESSIONS}`);
    expect(request.headers.get("x-centraid-vault")).toBe("vault-shared");
    expect(sentJson(`POST ${SESSIONS}`)).toStrictEqual({ title: "Groceries" });
  });

  it("law: an omitted scope degrades to the shell's ambient vault, never to none", async () => {
    await history.loadConversation("daily", "s-1");

    expect(sent(`GET ${SESSION}`).headers.get("x-centraid-vault")).toBe(
      "vault-1"
    );
  });

  it("law: every mutation of one thread reaches the same scoped session route", async () => {
    await history.renameConversation("daily", "s-1", "Renamed", "vault-shared");
    await history.setConversationPinned("daily", "s-1", true, "vault-shared");
    await history.setConversationArchived("daily", "s-1", true, "vault-shared");

    expect(wireLog()).toStrictEqual([
      `PATCH ${SESSION}`,
      `PATCH ${SESSION}`,
      `PATCH ${SESSION}`,
    ]);
    expect(
      requests.map((request) => JSON.parse(String(request.body)) as unknown)
    ).toStrictEqual([
      { title: "Renamed" },
      { pinned: true },
      { archived: true },
    ]);
    expect(
      requests.every(
        (request) => request.headers.get("x-centraid-vault") === "vault-shared"
      )
    ).toBe(true);
  });

  it("law: turn feedback addresses the turn, not the session", async () => {
    respond(`PATCH ${SESSION}/turns/t-1/feedback`, () => json({}));
    await history.setConversationFeedback("daily", "s-1", "t-1", "up");

    expect(wireLog()).toStrictEqual([`PATCH ${SESSION}/turns/t-1/feedback`]);
    expect(sentJson(`PATCH ${SESSION}/turns/t-1/feedback`)).toStrictEqual({
      feedback: "up",
    });
  });

  it("law: clearing feedback sends an explicit null, never an omitted field", async () => {
    respond(`PATCH ${SESSION}/turns/t-1/feedback`, () => json({}));
    await history.setConversationFeedback("daily", "s-1", "t-1", null);

    expect(sentJson(`PATCH ${SESSION}/turns/t-1/feedback`)).toStrictEqual({
      feedback: null,
    });
  });

  it("law: an empty search never reaches the gateway", async () => {
    await expect(
      history.searchConversations("daily", "   ")
    ).resolves.toStrictEqual([]);
    expect(wireLog()).toStrictEqual([]);
  });

  it("law: a search sends the raw query and the caller's limit", async () => {
    await expect(
      history.searchConversations("daily", "milk", 5)
    ).resolves.toStrictEqual([{ sessionId: "s-1", snippet: "…milk…" }]);

    const query = sent(`GET ${SESSIONS}/search`).query;
    expect(Object.fromEntries(query)).toStrictEqual({ q: "milk", limit: "5" });
  });

  it("law: a transcript page names its window on the wire", async () => {
    await history.loadConversation("daily", "s-1", undefined, {
      turns: 40,
      beforeSeq: 120,
    });
    expect(Object.fromEntries(sent(`GET ${SESSION}`).query)).toStrictEqual({
      turns: "40",
      beforeSeq: "120",
    });
  });

  it("law: a window value that could never be a cursor is dropped, not sent", async () => {
    // The gateway 400s a malformed window rather than ignoring it (a dropped
    // cursor would serve the NEWEST page to a client paging backwards). So the
    // client never puts one on the wire — it asks for the default page instead
    // of failing the whole load.
    await history.loadConversation("daily", "s-1", undefined, {
      turns: 0,
      beforeSeq: Number.NaN,
    });
    expect([...sent(`GET ${SESSION}`).query.keys()]).toStrictEqual([]);
  });

  it("law: an unwindowed load asks for the whole transcript, unchanged", async () => {
    await history.loadConversation("daily", "s-1");
    expect([...sent(`GET ${SESSION}`).query.keys()]).toStrictEqual([]);
  });

  it("law: absent collections read as empty, never undefined", async () => {
    respond(`GET ${SESSIONS}`, () => json({}));
    respond(`GET ${SESSIONS}/search`, () => json({}));

    await expect(history.listConversations("daily")).resolves.toStrictEqual([]);
    await expect(
      history.searchConversations("daily", "milk")
    ).resolves.toStrictEqual([]);
  });

  it("law: a delete that the gateway rejects still resolves — the row is gone either way", async () => {
    respond(`DELETE ${SESSION}`, () => new Response("nope", { status: 500 }));

    await expect(
      history.deleteConversation("daily", "s-1")
    ).resolves.toBeUndefined();
  });
});

describe("attachment blob seam", () => {
  const created: Blob[] = [];
  const realCreateObjectURL = URL.createObjectURL;

  afterEach(() => {
    created.length = 0;
    URL.createObjectURL = realCreateObjectURL;
    // Attachment URLs are cached across components on purpose (#659), so
    // a case that asserts the FETCH must start from an empty cache.
    history.resetAttachmentUrlCache();
  });

  /** jsdom ships no object-URL store; patch the method itself so `new URL` survives. */
  function stubObjectUrls(): void {
    URL.createObjectURL = (blob: Blob | MediaSource): string => {
      created.push(blob as Blob);
      return `blob:centraid/${created.length}`;
    };
  }

  it("law: an authed blob is fetched as bytes and handed back as a local object URL", async () => {
    stubObjectUrls();

    await expect(
      history.fetchAssistantAttachmentUrl("daily", "abc", "image/png")
    ).resolves.toBe("blob:centraid/1");
    const request = sent("GET /_centraid-conversations/apps/daily/blobs/abc");
    expect(request.headers.get("authorization")).toBe("Bearer token-1");
    expect(request.query.get("mime")).toBe("image/png");
  });

  it("law: a failed blob fetch is a typed error, never a broken object URL", async () => {
    stubObjectUrls();
    respond(
      "GET /_centraid-conversations/apps/daily/blobs/abc",
      () => new Response("", { status: 404 })
    );

    await expect(
      history.fetchAssistantAttachmentUrl("daily", "abc", "image/png")
    ).rejects.toMatchObject({ code: "gateway_error" });
    expect(created).toStrictEqual([]);
  });
});
