import { describe, expect, it } from "vitest";

import { editorWrite } from "./editor-write";

const base = {
  documentId: "doc-lease",
  baselineTitle: "Lease",
} as const;

describe(editorWrite, () => {
  it("title-only-empty-body: renaming while the body is still absent does not send body_text", () => {
    const intent = editorWrite({
      ...base,
      typedTitle: "Lease 2026",
      baselineBody: null,
      typedBody: null,
    });
    expect(intent).toStrictEqual({
      kind: "write",
      action: "rename",
      input: { document_id: "doc-lease", title: "Lease 2026" },
    });
    expect(intent).not.toHaveProperty("input.body_text");
  });

  it("title-only-empty-body: a title change against a known body still omits body_text", () => {
    const intent = editorWrite({
      ...base,
      typedTitle: "Lease 2026",
      baselineBody: "the existing clauses",
      typedBody: null,
    });
    expect(intent).toStrictEqual({
      kind: "write",
      action: "rename",
      input: { document_id: "doc-lease", title: "Lease 2026" },
    });
  });

  it("writes the typed body only once this device actually has one", () => {
    expect(
      editorWrite({
        ...base,
        typedTitle: null,
        baselineBody: "the existing clauses",
        typedBody: "amended clauses",
      })
    ).toStrictEqual({
      kind: "write",
      action: "edit",
      input: {
        document_id: "doc-lease",
        body_text: "amended clauses",
      },
    });
  });

  it("carries a simultaneous title and body change on edit, never as an empty body", () => {
    expect(
      editorWrite({
        ...base,
        typedTitle: "Lease 2026",
        baselineBody: "the existing clauses",
        typedBody: "amended clauses",
      })
    ).toStrictEqual({
      kind: "write",
      action: "edit",
      input: {
        document_id: "doc-lease",
        body_text: "amended clauses",
        title: "Lease 2026",
      },
    });
  });

  it("does not dispatch when nothing changed, including while the body is still absent", () => {
    expect(
      editorWrite({
        ...base,
        typedTitle: null,
        baselineBody: null,
        typedBody: null,
      })
    ).toStrictEqual({ kind: "nochange" });
    expect(
      editorWrite({
        ...base,
        typedTitle: "Lease",
        baselineBody: "the existing clauses",
        typedBody: "the existing clauses",
      })
    ).toStrictEqual({ kind: "nochange" });
  });

  it("does not invent a body when the title is cleared while the body is still absent", () => {
    expect(
      editorWrite({
        ...base,
        typedTitle: "   ",
        baselineBody: null,
        typedBody: null,
      })
    ).toStrictEqual({ kind: "nochange" });
  });
});
