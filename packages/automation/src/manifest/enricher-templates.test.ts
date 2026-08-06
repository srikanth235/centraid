// governance: allow-repo-hygiene file-size-limit one suite over the whole enricher-template contract — each template’s manifest validity, determinism lint, and stub-ctx spine behavior share the one fixture (#299)
/*
 * The enricher automation templates (issue #299 phases 1–2): their
 * manifests must parse under the runtime's real validator (vault block +
 * data trigger coherence), their handlers must pass the determinism lint,
 * and — driven with a stub ctx — they must enforce the spine's contract:
 * derivatives only, stage-don't-write, cursor watermarks, honest skips.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { lintHandlerSource } from "../handler/lint.js";
import { parseManifest } from "./manifest.js";

// Lives here beside bundled-templates.test.ts for the same reason: the
// dependency points automation → blueprints, never the other way.
const require = createRequire(import.meta.url);
const PACKAGE_ROOT = path.dirname(
  require.resolve("@centraid/blueprints/package.json")
);

// The four photos-domain enrichers (photo-captioner, screenshot-extractor,
// face-proposer, trip-albums) were deleted in issue #712: that work is
// becoming the Photos app's own rather than four gateway-lane automations
// taking a model turn over a member's photographs. Their behaviour suites
// went with them.
const ENRICHERS = [
  "doc-text-extractor",
  "doc-filer",
  "doc-entity-linker",
  "obligation-extractor",
  "renewal-reminders",
] as const;
/** The reminder's whole logic IS its condition trigger. */
const CONDITION_ENRICHERS = new Set(["renewal-reminders"]);

function automationDir(id: string): string {
  return path.join(PACKAGE_ROOT, "automations", id, "automations", id);
}

async function loadHandler(
  id: string
): Promise<(args: unknown) => Promise<unknown>> {
  const mod = (await import(
    pathToFileURL(path.join(automationDir(id), "handler.js")).href
  )) as {
    default: (args: unknown) => Promise<unknown>;
  };
  return mod.default;
}

/** A recording stub ctx: canned reads/agent turns, captured invokes. */
function stubCtx(options: {
  reads: Record<string, Record<string, unknown>[]>;
  input?: unknown;
  agent?: (call: {
    prompt: string;
    json?: unknown;
    content?: { contentId: string; variant: string }[];
  }) => unknown;
}) {
  const invokes: { command: string; input: Record<string, unknown> }[] = [];
  const agentCalls: {
    prompt: string;
    content?: { contentId: string; variant: string }[];
  }[] = [];
  const state = new Map<string, unknown>();
  const logs: string[] = [];
  const ctx = {
    now: "2099-01-01T00:00:00.000Z",
    vault: {
      read: async (request: { entity: string }) => ({
        rows: options.reads[request.entity] ?? [],
        receiptId: "r",
      }),
      invoke: async (request: {
        command: string;
        input: Record<string, unknown>;
      }) => {
        invokes.push({ command: request.command, input: request.input });
        return { status: "executed", output: { batch_id: "b1" } };
      },
    },
    agent: async (call: {
      prompt: string;
      json?: unknown;
      content?: { contentId: string; variant: string }[];
    }) => {
      agentCalls.push({
        prompt: call.prompt,
        ...(call.content ? { content: call.content } : {}),
      });
      return options.agent ? options.agent(call) : {};
    },
    state: {
      get: async (k: string) => state.get(k),
      set: async (k: string, v: unknown) => void state.set(k, v),
      delete: async (k: string) => void state.delete(k),
    },
    runs: { last: async () => undefined, list: async () => [] },
    input: options.input as never,
  };
  const log = {
    info: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
    error: (m: string) => logs.push(m),
  };
  return { ctx, log, invokes, agentCalls, state, logs };
}

describe("enricher template hygiene", () => {
  it.each(ENRICHERS.map((id) => [id] as const))(
    "%s: manifest parses, data trigger + vault block cohere, ships disabled",
    (id) => {
      const manifest = parseManifest(
        readFileSync(path.join(automationDir(id), "automation.json"), "utf8")
      );
      expect(manifest.enabled).toBe(false); // enabling IS the owner's opt-in
      expect(manifest.vault).toBeDefined();
      const wantKind = CONDITION_ENRICHERS.has(id) ? "condition" : "data";
      expect(manifest.triggers.some((t) => t.kind === wantKind)).toBe(true);
      expect(manifest.connector).toBeUndefined(); // enrichers use ctx.agent — connectors forbid it
    }
  );

  it.each(ENRICHERS.map((id) => [id] as const))(
    "%s: handler passes the determinism lint",
    (id) => {
      const source = readFileSync(
        path.join(automationDir(id), "handler.js"),
        "utf8"
      );
      expect(lintHandlerSource(source)).toStrictEqual([]);
    }
  );
});

describe("doc-text-extractor behavior", () => {
  it("OCRs a scan (no text variant) through core.set_extracted_text", async () => {
    const handler = await loadHandler("doc-text-extractor");
    const harness = stubCtx({
      reads: {
        "core.content_item": [
          { content_id: "d1", media_type: "application/pdf" },
        ],
        "core.content_derivative": [{ content_id: "d1", variant: "preview" }],
      },
      agent: () => ({ text: "Warranty expires 2027-03-01" }),
    });
    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as {
      summary: string;
    };
    expect(harness.agentCalls[0]!.content).toStrictEqual([
      { contentId: "d1", variant: "preview" },
    ]);
    expect(harness.invokes.map((i) => i.command)).toStrictEqual([
      "core.set_extracted_text",
    ]);
    expect(harness.invokes[0]!.input).toStrictEqual({
      content_id: "d1",
      text: "Warranty expires 2027-03-01",
    });
    expect(result.summary).toContain("OCRed 1");
  });

  it("summarizes a document that already has text, staged as an annotation", async () => {
    const handler = await loadHandler("doc-text-extractor");
    const harness = stubCtx({
      reads: {
        "core.content_item": [
          { content_id: "d2", media_type: "application/pdf" },
        ],
        "core.content_derivative": [{ content_id: "d2", variant: "text" }],
      },
      agent: () => ({ summary: "Home insurance policy for 2026." }),
    });
    await handler({ ctx: harness.ctx, log: harness.log });
    expect(harness.agentCalls[0]!.content).toStrictEqual([
      { contentId: "d2", variant: "text" },
    ]);
    expect(harness.invokes.map((i) => i.command)).toStrictEqual([
      "sync.stage_rows",
    ]);
    const rows = harness.invokes[0]!.input.rows as {
      external_id: string;
      payload: { body: string };
    }[];
    expect(rows[0]!.external_id).toBe("d2:summary");
    expect(rows[0]!.payload.body).toContain("insurance");
  });

  it("inline text items and underivable binaries are skipped without agent turns", async () => {
    const handler = await loadHandler("doc-text-extractor");
    const harness = stubCtx({
      reads: {
        "core.content_item": [
          { content_id: "d3", media_type: "text/plain" },
          { content_id: "d4", media_type: "application/pdf" },
        ],
        "core.content_derivative": [],
      },
    });
    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as {
      summary: string;
    };
    expect(harness.agentCalls).toHaveLength(0);
    expect(harness.invokes).toHaveLength(0);
    expect(result.summary).toContain("skipped 1");
  });

  it("re-enters a parent behind the content cursor when a visual derivative arrives late", async () => {
    const handler = await loadHandler("doc-text-extractor");
    const reads: Record<string, Record<string, unknown>[]> = {
      "core.content_item": [
        { content_id: "d5", media_type: "application/pdf" },
      ],
      "core.content_derivative": [],
    };
    const harness = stubCtx({
      reads,
      agent: () => ({
        text: "Late preview exposes the albatross renewal date",
      }),
    });
    await handler({ ctx: harness.ctx, log: harness.log });
    expect(harness.state.get("cursor")).toBe("d5");
    expect(harness.agentCalls).toHaveLength(0);

    // The parent no longer appears in the new-content page. Its independently
    // ordered derivative row must pull it back into the automation.
    reads["core.content_item"] = [];
    reads["core.content_derivative"] = [
      { derivative_id: "dv-1", content_id: "d5", variant: "preview" },
    ];
    await handler({ ctx: harness.ctx, log: harness.log });
    expect(harness.agentCalls.at(-1)?.content).toStrictEqual([
      { contentId: "d5", variant: "preview" },
    ]);
    expect(harness.invokes.at(-1)).toStrictEqual({
      command: "core.set_extracted_text",
      input: {
        content_id: "d5",
        text: "Late preview exposes the albatross renewal date",
      },
    });
    expect(harness.state.get("derivativeCursor")).toBe("dv-1");
  });
});

describe("doc-entity-linker behavior", () => {
  it("links only people already in the vault, anchored to the exact passage", async () => {
    const handler = await loadHandler("doc-entity-linker");
    const harness = stubCtx({
      reads: {
        "core.content_derivative": [
          { derivative_id: "dv1", content_id: "d1", variant: "text" },
        ],
        "core.party": [
          { party_id: "p1", kind: "person", display_name: "Rahul Mehta" },
          { party_id: "p2", kind: "org", display_name: "Acme Corp" },
        ],
      },
      agent: () => ({
        mentions: [
          {
            name: "Rahul Mehta",
            exact: "payable to Rahul Mehta by June 30",
            prefix: "is ",
          },
          { name: "Sunita Rao", exact: "witnessed by Sunita Rao" },
        ],
      }),
    });
    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as {
      summary: string;
    };
    expect(harness.invokes.map((i) => i.command)).toStrictEqual([
      "core.link_entities",
    ]);
    const input = harness.invokes[0]!.input as Record<string, unknown>;
    expect(input.from_id).toBe("d1");
    expect(input.to_id).toBe("p1"); // Rahul exists; Sunita doesn't — dropped
    expect(input.relation).toBe("references");
    expect((input.selector as { exact: string }).exact).toContain(
      "Rahul Mehta"
    );
    expect(result.summary).toContain("1 named nobody");
  });

  it("an identical-live-link refusal is caught, never a failed fire", async () => {
    const handler = await loadHandler("doc-entity-linker");
    const harness = stubCtx({
      reads: {
        "core.content_derivative": [
          { derivative_id: "dv2", content_id: "d2", variant: "text" },
        ],
        "core.party": [
          { party_id: "p1", kind: "person", display_name: "Rahul Mehta" },
        ],
      },
      agent: () => ({
        mentions: [{ name: "Rahul Mehta", exact: "Rahul Mehta again" }],
      }),
    });
    harness.ctx.vault.invoke = async () => {
      throw new Error("precondition no_identical_live_link failed");
    };
    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as {
      summary: string;
    };
    expect(result.summary).toContain("linked 0");
  });
});

describe("obligation-extractor behavior", () => {
  it("stages dated obligations as tentative events; dateless ones drop", async () => {
    const handler = await loadHandler("obligation-extractor");
    const harness = stubCtx({
      reads: {
        "core.content_derivative": [
          { derivative_id: "dv1", content_id: "d1", variant: "text" },
        ],
      },
      agent: () => ({
        obligations: [
          {
            what: "Home insurance renewal",
            kind: "renewal",
            date: "2027-03-01",
          },
          { what: "Some vague thing", kind: "due", date: "soon" },
        ],
      }),
    });
    await handler({ ctx: harness.ctx, log: harness.log });
    const input = harness.invokes[0]!.input as {
      kind: string;
      rows: {
        external_id: string;
        payload: { status: string; dtstart: string };
      }[];
    };
    expect(input.kind).toBe("enrichment.obligations");
    expect(input.rows).toHaveLength(1); // "soon" is not a date
    expect(input.rows[0]!.external_id).toBe("obligation:d1:0");
    expect(input.rows[0]!.payload.status).toBe("tentative");
    expect(input.rows[0]!.payload.dtstart).toBe("2027-03-01");
  });
});

describe("renewal-reminders behavior", () => {
  it("formats the brief from the condition trigger rows — reads nothing, writes nothing", async () => {
    const handler = await loadHandler("renewal-reminders");
    const harness = stubCtx({
      reads: {},
      input: {
        rows: [
          {
            summary: "Passport expiry",
            dtstart: "2026-07-18",
            status: "tentative",
          },
          {
            summary: "Home insurance renewal (renewal)",
            dtstart: "2026-07-12",
            status: "tentative",
          },
        ],
      },
    });
    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as {
      summary: string;
      output: { upcoming: { due: string }[] };
    };
    expect(harness.invokes).toHaveLength(0);
    expect(harness.agentCalls).toHaveLength(0);
    expect(result.summary).toContain("2 deadlines");
    expect(result.output.upcoming[0]!.due).toBe("2026-07-12"); // soonest first
  });
});

describe("doc-filer behavior", () => {
  it("proposes title + folder + doctype from the text variant, staged for review", async () => {
    const handler = await loadHandler("doc-filer");
    const harness = stubCtx({
      reads: {
        "core.content_derivative": [
          { derivative_id: "dv1", content_id: "d1", variant: "text" },
        ],
        "core.content_item": [
          {
            content_id: "d1",
            media_type: "application/pdf",
            title: "scan_001",
          },
        ],
        "core.concept_scheme": [
          { scheme_id: "sf", uri: "https://centraid.dev/schemes/folders" },
        ],
        "core.concept": [
          { scheme_id: "sf", notation: "insurance", pref_label: "Insurance" },
          { scheme_id: "sf", notation: "root", pref_label: "Documents" },
        ],
      },
      agent: (call) => {
        // The existing folder labels ride into the prompt.
        expect(call.prompt).toContain("Insurance");
        expect(call.prompt).not.toContain("Documents,");
        return {
          title: "Home insurance policy 2026",
          folder: "Insurance",
          doctype: "policy",
          confidence: 0.9,
        };
      },
    });
    await handler({ ctx: harness.ctx, log: harness.log });
    expect(harness.agentCalls[0]!.content).toStrictEqual([
      { contentId: "d1", variant: "text" },
    ]);
    expect(harness.invokes.map((i) => i.command)).toStrictEqual([
      "sync.stage_rows",
    ]);
    const input = harness.invokes[0]!.input as {
      kind: string;
      rows: {
        entity_type: string;
        external_id: string;
        payload: Record<string, unknown>;
      }[];
    };
    expect(input.kind).toBe("enrichment.doctype");
    expect(input.rows.map((r) => r.entity_type)).toStrictEqual([
      "core.content_item",
      "core.tag",
    ]);
    expect(input.rows[0]!.payload).toStrictEqual({
      content_id: "d1",
      title: "Home insurance policy 2026",
      folder: "Insurance",
    });
    expect(input.rows[1]!.payload.scheme_uri).toBe("urn:centraid:doctype");
    expect(harness.state.get("cursor")).toBe("dv1");
  });
});
