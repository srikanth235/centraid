// governance: allow-repo-hygiene file-size-limit one suite over the whole enricher-template contract — each template’s manifest validity, determinism lint, and stub-ctx spine behavior share the one fixture (#299)
/*
 * The enricher automation templates (#299 phases 1–2): their
 * manifests must parse under the runtime's real validator (vault block +
 * data trigger coherence), their handlers must pass the determinism lint,
 * and — driven with a stub ctx — they must enforce the spine's contract:
 * derivatives only, stage-don't-write, cursor watermarks, honest skips.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { ENRICH_CAPABILITIES } from "../../enrich/capability-registry.js";
import { lintHandlerSource } from "../handler/lint.js";
import { parseManifest } from "./manifest.js";

// Lives here beside bundled-templates.test.ts for the same reason: the
// dependency points automation → blueprints, never the other way.
const require = createRequire(import.meta.url);
const PACKAGE_ROOT = path.dirname(
  require.resolve("@centraid/blueprints/package.json")
);
const requireFromBlueprints = createRequire(
  path.join(PACKAGE_ROOT, "package.json")
);

const ENRICHERS = [
  "photo-ocr",
  "transcript",
  "embed-image",
  "embed-text",
  "faces",
  "doc-text-extractor",
  "doc-filer",
  "doc-entity-linker",
  "obligation-extractor",
  "renewal-reminders",
] as const;
/** The reminder's whole logic IS its condition trigger. */
const CONDITION_ENRICHERS = new Set(["renewal-reminders"]);

/** A valid one-page born-digital PDF for the generated handler's pdf.js path. */
function searchablePdf(text: string): Buffer {
  const stream = deflateSync(
    Buffer.from(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`)
  );
  const objects = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
    Buffer.from(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
        "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"
    ),
    Buffer.concat([
      Buffer.from(
        `<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`
      ),
      stream,
      Buffer.from("\nendstream"),
    ]),
    Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
  ];
  const chunks = [Buffer.from("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets = [0];
  let size = chunks[0]!.length;
  for (const [index, object] of objects.entries()) {
    offsets.push(size);
    const bytes = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
    chunks.push(bytes);
    size += bytes.length;
  }
  const xrefAt = size;
  const xref = offsets
    .map((offset, index) =>
      index === 0
        ? "0000000000 65535 f \n"
        : `${String(offset).padStart(10, "0")} 00000 n \n`
    )
    .join("");
  chunks.push(
    Buffer.from(
      `xref\n0 ${offsets.length}\n${xref}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\n` +
        `startxref\n${xrefAt}\n%%EOF\n`
    )
  );
  return Buffer.concat(chunks);
}

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
    setPhotoOcrRuntimeForTests?: (runtime: unknown) => void;
    setEmbedImageRuntimeForTests?: (runtime: unknown) => void;
    setEmbedTextRuntimeForTests?: (runtime: unknown) => void;
    setFacesRuntimeForTests?: (runtime: unknown) => void;
    setTranscriptRuntimeForTests?: (runtime: unknown) => void;
  };
  mod.setPhotoOcrRuntimeForTests?.({
    weightsPresent: () => true,
    recognize: async () => ({
      id: "test",
      regions: [{ text: "Total", box: [1, 2, 3, 4] }],
    }),
  });
  const embedding = {
    weightsPresent: () => true,
    infer: async () => ({ id: "test", vector: [0.1, 0.2] }),
  };
  mod.setEmbedImageRuntimeForTests?.(embedding);
  mod.setEmbedTextRuntimeForTests?.(embedding);
  mod.setFacesRuntimeForTests?.({
    weightsPresent: () => true,
    infer: async () => ({ id: "test", faces: [] }),
  });
  mod.setTranscriptRuntimeForTests?.({
    weightsPresent: () => true,
    transcribe: async () => ({ id: "test", text: "spoken fixture" }),
  });
  return mod.default;
}

async function loadPhotoOcrModule() {
  return (await import(
    pathToFileURL(path.join(automationDir("photo-ocr"), "handler.js")).href
  )) as {
    default: (args: unknown) => Promise<unknown>;
    setPhotoOcrRuntimeForTests: (runtime: unknown) => void;
  };
}

async function loadTranscriptModule() {
  return (await import(
    pathToFileURL(path.join(automationDir("transcript"), "handler.js")).href
  )) as {
    default: (args: unknown) => Promise<unknown>;
    setTranscriptRuntimeForTests: (runtime: unknown) => void;
  };
}

async function loadWorkspacePdfJs() {
  const resolved = requireFromBlueprints.resolve(
    "pdfjs-dist/legacy/build/pdf.mjs"
  );
  return import(pathToFileURL(resolved).href);
}

/** A recording stub ctx: canned reads/delegate turns, captured invokes. */
function stubCtx(options: {
  reads: Record<string, Record<string, unknown>[]>;
  read?: (request: Record<string, unknown>) => Record<string, unknown>[];
  input?: unknown;
  fetch?: (call: { url: string; method: string; body?: string }) => Promise<{
    status: number;
    headers: Record<string, string>;
    text: string;
  }>;
  delegate?: (call: {
    prompt: string;
    json?: unknown;
    content?: { contentId: string; variant: string }[];
  }) => unknown;
  content?: (request: {
    contentId?: string;
    variant?: string;
    maxBytes?: number;
    purpose?: string;
  }) => unknown;
}) {
  const invokes: { command: string; input: Record<string, unknown> }[] = [];
  const delegateCalls: {
    prompt: string;
    content?: { contentId: string; variant: string }[];
  }[] = [];
  const state = new Map<string, unknown>();
  const logs: string[] = [];
  const ctx = {
    now: "2099-01-01T00:00:00.000Z",
    vault: {
      read: async (request: Record<string, unknown>) => ({
        rows:
          options.read?.(request) ??
          options.reads[String(request.entity)] ??
          [],
        receiptId: "r",
      }),
      invoke: async (request: {
        command: string;
        input: Record<string, unknown>;
      }) => {
        invokes.push({ command: request.command, input: request.input });
        return { status: "executed", output: { batch_id: "b1" } };
      },
      content: async (request: {
        contentId?: string;
        variant?: string;
        maxBytes?: number;
        purpose?: string;
      }) =>
        options.content?.(request) ??
        (request.variant === "text" || request.variant === "transcript"
          ? {
              status: "ok",
              kind: "text",
              mediaType: "text/plain",
              text: "fixture text",
              truncated: false,
            }
          : {
              status: "ok",
              kind: "bytes",
              mediaType: "image/jpeg",
              byteSize: 7,
              base64: "Zml4dHVyZQ==",
            }),
    },
    delegate: async (call: {
      prompt: string;
      json?: unknown;
      content?: { contentId: string; variant: string }[];
    }) => {
      delegateCalls.push({
        prompt: call.prompt,
        ...(call.content ? { content: call.content } : {}),
      });
      return options.delegate ? options.delegate(call) : {};
    },
    state: {
      get: async (k: string) => state.get(k),
      set: async (k: string, v: unknown) => void state.set(k, v),
      delete: async (k: string) => void state.delete(k),
    },
    runs: { last: async () => undefined, list: async () => [] },
    fetch:
      options.fetch ?? (async () => ({ status: 200, headers: {}, text: "{}" })),
    input: options.input as never,
  };
  const log = {
    info: (m: string) => logs.push(m),
    warn: (m: string) => logs.push(m),
    error: (m: string) => logs.push(m),
  };
  return { ctx, log, invokes, delegateCalls, state, logs };
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
      expect(manifest.connector).toBeUndefined();
    }
  );

  it("faces declares the core content rail used for preview reads", () => {
    const manifest = parseManifest(
      readFileSync(path.join(automationDir("faces"), "automation.json"), "utf8")
    );
    expect(manifest.vault?.scopes).toStrictEqual(
      expect.arrayContaining([{ schema: "core", verbs: "read+act" }])
    );
  });

  it.each([
    ["photo-ocr", true],
    // The docs domain's delegate-capable enricher (#807).
    ["doc-text-extractor", true],
    ["embed-image", false],
    ["embed-text", false],
    // Faces has no delegate variant anywhere, structurally (#807).
    ["faces", false],
  ] as const)("%s declares its delegate step honestly", (id, expected) => {
    const manifest = parseManifest(
      readFileSync(path.join(automationDir(id), "automation.json"), "utf8")
    );
    expect(manifest.enrich?.delegateStep !== undefined).toBe(expected);
  });

  // The registry's `delegateCapable` is a claim ABOUT these manifests, read by
  // Settings to say when a member's delegate profile would be inert. It is a
  // second copy of the fact, so it is pinned to the first here rather than
  // trusted.
  it.each(ENRICH_CAPABILITIES.map((cap) => [cap.id, cap] as const))(
    "%s's delegateCapable flag matches its shipped manifest",
    (_id, cap) => {
      const manifest = parseManifest(
        readFileSync(
          path.join(automationDir(cap.defaultTemplateId), "automation.json"),
          "utf8"
        )
      );
      expect(cap.delegateCapable).toBe(
        manifest.enrich?.delegateStep !== undefined
      );
    }
  );

  it.each(ENRICHERS.map((id) => [id] as const))(
    "%s: handler passes the determinism lint",
    (id) => {
      const source = readFileSync(
        [
          "photo-ocr",
          "embed-image",
          "embed-text",
          "faces",
          "transcript",
        ].includes(id)
          ? path.join(
              PACKAGE_ROOT,
              "..",
              "..",
              "packages",
              "model-runtime",
              "automation-handlers",
              `${id}.js`
            )
          : path.join(automationDir(id), "handler.js"),
        "utf8"
      );
      expect(lintHandlerSource(source)).toStrictEqual([]);
    }
  );

  it("keeps the shared PDF.js runtime out of the published OCR handler", () => {
    const handler = readFileSync(
      path.join(automationDir("photo-ocr"), "handler.js")
    );
    expect(handler.byteLength).toBeLessThan(256_000);
  });
});

describe("photo-ocr capture behavior", () => {
  it("runs bundled OCR code and returns reading-order text", async () => {
    const module = await loadPhotoOcrModule();
    module.setPhotoOcrRuntimeForTests({
      weightsPresent: () => true,
      recognize: async () => ({
        id: "capture",
        regions: [
          { text: "42", box: [20, 10, 2, 2], confidence: 0.6 },
          { text: "Total", box: [0, 0, 8, 2], confidence: 0.8 },
        ],
      }),
    });
    const harness = stubCtx({
      reads: {},
      input: {
        capture: { bytes: "cmVjZWlwdA==", mediaType: "image/jpeg" },
      },
    });

    const result = (await module.default({
      ctx: harness.ctx,
      log: harness.log,
    })) as {
      output: { text: string; confidence?: number; model: string };
    };

    expect(result.output).toStrictEqual({
      text: "Total\n42",
      confidence: 0.7,
      engine: "automation",
      model: "pp-ocrv4@1",
    });
    expect(harness.invokes).toHaveLength(0);
  });

  it("throws when local model assets are absent so the automation ledger records failure", async () => {
    const module = await loadPhotoOcrModule();
    module.setPhotoOcrRuntimeForTests({ weightsPresent: () => false });
    const harness = stubCtx({
      reads: {},
      input: {
        capture: { bytes: "cmVjZWlwdA==", mediaType: "image/jpeg" },
      },
    });

    await expect(
      module.default({ ctx: harness.ctx, log: harness.log })
    ).rejects.toThrow("install the bundled automation model assets");
  });

  it("extracts a born-digital PDF inside the generated automation handler", async () => {
    const module = await loadPhotoOcrModule();
    module.setPhotoOcrRuntimeForTests({
      weightsPresent: () => true,
      loadPdfJs: loadWorkspacePdfJs,
      recognize: async () => {
        throw new Error("born-digital PDF text must not call image OCR");
      },
    });
    const pdf = searchablePdf("Centraid PDF automation");
    const harness = stubCtx({
      reads: {},
      input: {
        capture: {
          bytes: pdf.toString("base64"),
          mediaType: "application/pdf",
        },
      },
    });

    await expect(
      module.default({ ctx: harness.ctx, log: harness.log })
    ).resolves.toMatchObject({
      output: {
        text: "Centraid PDF automation",
        engine: "automation",
        model: "pp-ocrv4@1",
      },
    });
  });
});

describe("recognition automation spine", () => {
  const asset = {
    asset_id: "a1",
    content_id: "c1",
    kind: "photo",
    width: 100,
    height: 80,
  };

  it("writes deterministic OCR through the validated text command and re-arms a full batch", async () => {
    const handler = await loadHandler("photo-ocr");
    const assets = Array.from({ length: 16 }, (_, index) => ({
      ...asset,
      asset_id: `a${String(index + 1).padStart(2, "0")}`,
      content_id: `c${index + 1}`,
    }));
    const harness = stubCtx({
      reads: {},
      read: (request) => {
        if (request.entity === "media.asset") {
          return (request.orderBy as { dir?: string })?.dir === "desc"
            ? [assets.at(-1)!]
            : assets;
        }
        return [];
      },
      fetch: async (call) => ({
        status: 200,
        headers: {},
        text:
          call.method === "GET"
            ? JSON.stringify({ status: "ok", model: "pp-ocrv4@1" })
            : JSON.stringify({
                status: "ok",
                model: "pp-ocrv4@1",
                results: [{ regions: [{ text: "Total", box: [1, 2, 3, 4] }] }],
              }),
      }),
    });

    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as {
      output: { rearm: boolean };
    };
    expect(harness.invokes).toHaveLength(16);
    expect(harness.invokes[0]).toMatchObject({
      command: "core.set_extracted_text",
      input: {
        text: "Total",
        capability: "ocr",
        model: "pp-ocrv4@1",
        regions: [{ text: "Total", box: [1, 2, 3, 4] }],
      },
    });
    expect(result.output.rearm).toBe(true);
    expect(harness.state.get("cursor")).toBe("a16");
  });

  it("seeds OCR from an existing current-model stamp without a billed/service derivation", async () => {
    const handler = await loadHandler("photo-ocr");
    let posts = 0;
    const harness = stubCtx({
      reads: {},
      read: (request) => {
        if (request.entity === "media.asset") {
          return (request.orderBy as { dir?: string })?.dir === "desc"
            ? [asset]
            : [];
        }
        if (request.entity === "enrich.derivation")
          return [{ model: "pp-ocrv4@1", target_id: "c1" }];
        return [];
      },
      fetch: async (call) => {
        if (call.method === "POST") posts += 1;
        return {
          status: 200,
          headers: {},
          text: JSON.stringify({ status: "ok", model: "pp-ocrv4@1" }),
        };
      },
    });
    await handler({ ctx: harness.ctx, log: harness.log });
    expect(harness.state.get("cursor")).toBe("a1");
    expect(posts).toBe(0);
    expect(harness.invokes).toHaveLength(0);
  });

  it("coerces delegate OCR text without grounding, strips invalid boxes, and stamps only ACP identity", async () => {
    const handler = await loadHandler("photo-ocr");
    const harness = stubCtx({
      reads: {},
      input: { variant: "delegate", delegateModel: "owner/pin" },
      read: (request) => (request.entity === "media.asset" ? [asset] : []),
      delegate: () => ({
        __centraidModel: "acp-confirmed@7",
        regions: [
          { text: "Unboxed" },
          { text: "Outside", box: [99, 79, 4, 4] },
          { text: "Typed strictly", box: ["1", 2, 3, 4] },
        ],
      }),
    });
    await handler({ ctx: harness.ctx, log: harness.log });
    expect(harness.invokes[0]).toMatchObject({
      command: "core.set_extracted_text",
      input: {
        text: "Unboxed\nOutside\nTyped strictly",
        model: "acp-confirmed@7",
        prompt_rev: "ocr-v1",
        regions: [
          { text: "Unboxed" },
          { text: "Outside" },
          { text: "Typed strictly" },
        ],
      },
    });
    expect(harness.invokes[0]?.input).not.toHaveProperty("confidence");
  });

  it("transcribes bounded audio/video originals through the typed transcript command", async () => {
    const transcript = await loadHandler("transcript");
    const contentCalls: Array<{
      contentId?: string;
      variant?: string;
      maxBytes?: number;
      purpose?: string;
    }> = [];
    const assets = [
      { ...asset, asset_id: "a1", content_id: "c1", kind: "audio" },
      { ...asset, asset_id: "a2", content_id: "c2", kind: "video" },
    ];
    const transcriptHarness = stubCtx({
      reads: {},
      read: (request) => (request.entity === "media.asset" ? assets : []),
      content: (request) => {
        contentCalls.push(request);
        return {
          status: "ok",
          kind: "bytes",
          mediaType: request.contentId === "c1" ? "audio/wav" : "video/mp4",
          byteSize: 7,
          base64: "Zml4dHVyZQ==",
        };
      },
    });
    await expect(
      transcript({ ctx: transcriptHarness.ctx, log: transcriptHarness.log })
    ).resolves.toMatchObject({
      output: {
        derived: 2,
        skipped: 0,
        model: "whisper-tiny.en-q8@1",
        rearm: true,
      },
    });
    expect(transcriptHarness.invokes).toStrictEqual([
      {
        command: "core.set_extracted_text",
        input: {
          content_id: "c1",
          text: "spoken fixture",
          variant: "transcript",
          capability: "transcript",
          model: "whisper-tiny.en-q8@1",
        },
      },
      {
        command: "core.set_extracted_text",
        input: {
          content_id: "c2",
          text: "spoken fixture",
          variant: "transcript",
          capability: "transcript",
          model: "whisper-tiny.en-q8@1",
        },
      },
    ]);
    expect(transcriptHarness.state.get("cursor")).toBe("a2");
    expect(contentCalls).toStrictEqual([
      {
        contentId: "c1",
        variant: "original",
        maxBytes: 64 * 1024 * 1024,
      },
      {
        contentId: "c2",
        variant: "original",
        maxBytes: 64 * 1024 * 1024,
      },
    ]);
  });

  it("both embedding recipes use their typed vector command", async () => {
    await Promise.all(
      (
        [
          ["embed-image", asset],
          [
            "embed-text",
            { derivative_id: "d1", content_id: "c1", variant: "text" },
          ],
        ] as const
      ).map(async ([id, row]) => {
        const embed = await loadHandler(id);
        const harness = stubCtx({
          reads: {},
          read: (request) =>
            request.entity ===
            (id === "embed-image" ? "media.asset" : "core.content_derivative")
              ? [row]
              : [],
          fetch: async (call) => ({
            status: 200,
            headers: {},
            text:
              call.method === "GET"
                ? JSON.stringify({ status: "ok", model: `${id}@1` })
                : JSON.stringify({
                    status: "ok",
                    model: `${id}@1`,
                    results: [{ vector: [0.1, 0.2] }],
                  }),
          }),
        });
        await embed({ ctx: harness.ctx, log: harness.log });
        expect(harness.invokes[0]?.command).toBe("enrich.upsert_embedding");
        expect(harness.invokes[0]?.input).toMatchObject({
          model: "clip-vit-b-32@1",
          vector: [0.1, 0.2],
        });
      })
    );
  });

  it("faces accepts capability-scoped per-item consent and prior stamps on a model bump", async () => {
    const handler = await loadHandler("faces");
    const harness = stubCtx({
      reads: {},
      read: (request) => {
        if (request.entity === "enrich.request")
          return [{ request_id: "r1", target_id: "a1", capability: "faces" }];
        if (request.entity === "media.asset") return [asset];
        if (request.entity === "enrich.derivation")
          return [{ target_id: "a1", model: "faces@old", variant: "faces" }];
        return [];
      },
      fetch: async (call) => ({
        status: 200,
        headers: {},
        text:
          call.method === "GET"
            ? JSON.stringify({ status: "ok", model: "yunet-sface@1" })
            : JSON.stringify({
                status: "ok",
                model: "yunet-sface@1",
                results: [{ faces: [] }],
              }),
      }),
    });
    harness.state.set("model", "faces@old");
    await handler({ ctx: harness.ctx, log: harness.log });
    expect(harness.invokes.map((entry) => entry.command)).toStrictEqual([
      "enrich.upsert_faces",
      "enrich.mark_requests_drained",
      "enrich.rebuild_face_clusters",
    ]);
  });

  it("faces drains a target-less request as a bounded vault-wide consent walk", async () => {
    const handler = await loadHandler("faces");
    const harness = stubCtx({
      reads: {},
      read: (request) => {
        if (request.entity === "enrich.request")
          return [
            { request_id: "vault-wide", target_id: null, capability: "faces" },
          ];
        if (request.entity === "media.asset") return [asset];
        return [];
      },
      fetch: async (call) => ({
        status: 200,
        headers: {},
        text:
          call.method === "GET"
            ? JSON.stringify({ status: "ok", model: "yunet-sface@1" })
            : JSON.stringify({
                status: "ok",
                model: "yunet-sface@1",
                results: [{ faces: [] }],
              }),
      }),
    });
    await handler({ ctx: harness.ctx, log: harness.log });
    expect(harness.invokes).toContainEqual({
      command: "enrich.mark_requests_drained",
      input: { request_ids: ["vault-wide"] },
    });
    expect(harness.state.get("requestCursor:vault-wide")).toBe("a1");
  });
});

describe("recognition automation: honest failure vs honest skip (issue #731)", () => {
  // The recognition automations run self-contained local inference
  // (no HTTP enrichment service): the only I/O a batch can fail on is the
  // `ctx.vault.content` byte/text fetch. These tests drive that fetch
  // directly through the stub's `content` hook rather than `fetch`.
  const photoAsset = {
    asset_id: "a1",
    content_id: "c1",
    kind: "photo",
    width: 100,
    height: 80,
  };
  const audioAsset = { asset_id: "a1", content_id: "c1", kind: "audio" };

  it("photo-ocr throws when the preview fetch fails mid-batch — the cursor never advances", async () => {
    const handler = await loadHandler("photo-ocr");
    const harness = stubCtx({
      reads: {},
      read: (request) => (request.entity === "media.asset" ? [photoAsset] : []),
      content: () => ({ status: "not-found" }),
    });
    // An already-established cursor (not the first fire) — so a subsequent
    // outage is the only thing under test, not the one-time seed.
    harness.state.set("selection", "deterministic:pp-ocrv4@1:local");
    harness.state.set("cursor", "a0");
    await expect(
      handler({ ctx: harness.ctx, log: harness.log })
    ).rejects.toThrow(/preview is unavailable/u);
    expect(harness.state.get("cursor")).toBe("a0");
    expect(harness.invokes).toHaveLength(0);
  });

  it("photo-ocr honors an honest empty OCR result as a skip — the cursor still advances", async () => {
    const module = await loadPhotoOcrModule();
    module.setPhotoOcrRuntimeForTests({
      weightsPresent: () => true,
      recognize: async () => ({ id: "test", regions: [] }),
    });
    const harness = stubCtx({
      reads: {},
      read: (request) => (request.entity === "media.asset" ? [photoAsset] : []),
    });
    const result = (await module.default({
      ctx: harness.ctx,
      log: harness.log,
    })) as { output: { derived: number; skipped: number } };
    expect(result.output).toMatchObject({ derived: 0, skipped: 1 });
    expect(harness.state.get("cursor")).toBe("a1");
    expect(harness.invokes).toHaveLength(0);
  });

  it("embed-image throws when the preview fetch fails mid-batch — the cursor never advances", async () => {
    const handler = await loadHandler("embed-image");
    const harness = stubCtx({
      reads: {},
      read: (request) => (request.entity === "media.asset" ? [photoAsset] : []),
      content: () => ({ status: "not-found" }),
    });
    harness.state.set("model", "clip-vit-b-32@1");
    harness.state.set("cursor", "a0");
    await expect(
      handler({ ctx: harness.ctx, log: harness.log })
    ).rejects.toThrow(/preview is unavailable/u);
    expect(harness.state.get("cursor")).toBe("a0");
    expect(harness.invokes).toHaveLength(0);
  });

  it("embed-text throws when the derivative-text fetch fails mid-batch — the cursor never advances", async () => {
    const handler = await loadHandler("embed-text");
    const item = { derivative_id: "d1", content_id: "c1", variant: "text" };
    const harness = stubCtx({
      reads: {},
      read: (request) =>
        request.entity === "core.content_derivative" ? [item] : [],
      content: () => ({ status: "not-found" }),
    });
    harness.state.set("model", "clip-vit-b-32@1");
    harness.state.set("cursor", "d0");
    await expect(
      handler({ ctx: harness.ctx, log: harness.log })
    ).rejects.toThrow(/text is unavailable/u);
    expect(harness.state.get("cursor")).toBe("d0");
    expect(harness.invokes).toHaveLength(0);
  });

  it("transcript throws when the bounded-original fetch fails mid-batch — the cursor never advances", async () => {
    const handler = await loadHandler("transcript");
    const harness = stubCtx({
      reads: {},
      read: (request) => (request.entity === "media.asset" ? [audioAsset] : []),
      content: () => ({ status: "not-found" }),
    });
    harness.state.set("model", "whisper-tiny.en-q8@1");
    harness.state.set("cursor", "a0");
    await expect(
      handler({ ctx: harness.ctx, log: harness.log })
    ).rejects.toThrow(/bounded original is unavailable/u);
    expect(harness.state.get("cursor")).toBe("a0");
    expect(harness.invokes).toHaveLength(0);
  });

  it("transcript treats an oversized original as a permanent skip, not a failure — the cursor still advances", async () => {
    // MAX_SOURCE_BYTES is a fixed policy ceiling: retrying an oversized
    // asset can never succeed, so — unlike a missing blob or a transient
    // store error — it must not stall the batch. This is the one case
    // `ctx.vault.content` reports as "too-large" rather than folding it
    // into "not-found"/"no-variant", and the handler is expected to tell
    // the two apart.
    const handler = await loadHandler("transcript");
    const harness = stubCtx({
      reads: {},
      read: (request) => (request.entity === "media.asset" ? [audioAsset] : []),
      content: () => ({
        status: "too-large",
        byteSize: 999_999_999,
        maxBytes: 64 * 1024 * 1024,
      }),
    });
    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as {
      output: { derived: number; skipped: number };
    };
    expect(result.output).toMatchObject({ derived: 0, skipped: 1 });
    expect(harness.state.get("cursor")).toBe("a1");
    expect(harness.invokes).toHaveLength(0);
  });

  it("transcript honors an honest empty transcript as a skip — the cursor still advances", async () => {
    const harness = stubCtx({
      reads: {},
      read: (request) => (request.entity === "media.asset" ? [audioAsset] : []),
      content: () => ({
        status: "ok",
        kind: "bytes",
        mediaType: "audio/wav",
        byteSize: 7,
        base64: "Zml4dHVyZQ==",
      }),
    });
    // Override the transcript module directly so this one call returns
    // honestly-empty text — loadHandler's shared default fixture always
    // returns non-empty speech.
    const mod = await loadTranscriptModule();
    mod.setTranscriptRuntimeForTests({
      weightsPresent: () => true,
      transcribe: async () => ({ id: "test", text: "   " }),
    });
    const result = (await mod.default({
      ctx: harness.ctx,
      log: harness.log,
    })) as { output: { derived: number; skipped: number } };
    expect(result.output).toMatchObject({ derived: 0, skipped: 1 });
    expect(harness.state.get("cursor")).toBe("a1");
    expect(harness.invokes).toHaveLength(0);
    // loadHandler's default (non-empty) fixture must not leak into later
    // tests that reuse the module's cached singleton.
    mod.setTranscriptRuntimeForTests({
      weightsPresent: () => true,
      transcribe: async () => ({ id: "test", text: "spoken fixture" }),
    });
  });

  it("embed-text re-embeds a source rewritten under the same model", async () => {
    const handler = await loadHandler("embed-text");
    const item = { derivative_id: "d2", content_id: "c1", variant: "text" };
    const harness = stubCtx({
      reads: {},
      read: (request) => {
        if (request.entity === "core.content_derivative") return [item];
        if (request.entity === "enrich.derivation")
          return [
            {
              target_id: "c1",
              model: "clip-vit-b-32@1",
              payload_json: JSON.stringify({ source_version: "d1" }),
            },
          ];
        return [];
      },
    });

    await handler({ ctx: harness.ctx, log: harness.log });

    expect(harness.invokes).toHaveLength(1);
    expect(harness.invokes[0]).toMatchObject({
      command: "enrich.upsert_embedding",
      input: { model: "clip-vit-b-32@1", source_version: "d2" },
    });
  });

  it("embed-text skips when model and source derivative are unchanged", async () => {
    const handler = await loadHandler("embed-text");
    const item = { derivative_id: "d2", content_id: "c1", variant: "text" };
    const harness = stubCtx({
      reads: {},
      read: (request) => {
        if (request.entity === "core.content_derivative") return [item];
        if (request.entity === "enrich.derivation")
          return [
            {
              target_id: "c1",
              model: "clip-vit-b-32@1",
              payload_json: JSON.stringify({ source_version: "d2" }),
            },
          ];
        return [];
      },
    });
    harness.state.set("model", "clip-vit-b-32@1");
    harness.state.set("cursor", "d1");

    const result = (await handler({
      ctx: harness.ctx,
      log: harness.log,
    })) as { output: { derived: number; skipped: number } };

    expect(result.output).toMatchObject({ derived: 0, skipped: 1 });
    expect(harness.invokes).toHaveLength(0);
  });
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
      delegate: () => ({ text: "Warranty expires 2027-03-01" }),
    });
    const result = (await handler({ ctx: harness.ctx, log: harness.log })) as {
      summary: string;
    };
    expect(harness.delegateCalls[0]!.content).toStrictEqual([
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

  // ── the delegate variant (issue #807, Wave 5) ───────────────────────────
  // `doc-text` has no bundled deterministic engine — both variants take a
  // model turn. What the delegate variant adds is a PINNED engine whose
  // answer is stamped: profile, ACP-confirmed model, prompt revision.
  it("stamps the resolved profile and confirmed model on a delegate transcription", async () => {
    const handler = await loadHandler("doc-text-extractor");
    const harness = stubCtx({
      reads: {
        "core.content_item": [
          { content_id: "d1", media_type: "application/pdf" },
        ],
        "core.content_derivative": [{ content_id: "d1", variant: "preview" }],
      },
      input: {
        variant: "delegate",
        profileId: "docs-vlm",
        delegateModel: "owner/pin",
      },
      delegate: () => ({
        text: "Warranty expires 2027-03-01",
        __centraidModel: "acp-confirmed@7",
      }),
    });

    await handler({ ctx: harness.ctx, log: harness.log });

    expect(harness.invokes[0]!.input).toStrictEqual({
      content_id: "d1",
      text: "Warranty expires 2027-03-01",
      capability: "doc-text",
      // The identity that ANSWERED, never the id that was asked for.
      model: "acp-confirmed@7",
      prompt_rev: "doc-text-v1",
      profile: "docs-vlm",
    });
  });

  it("refuses a delegate transcription with no ACP-confirmed model identity", async () => {
    const handler = await loadHandler("doc-text-extractor");
    const harness = stubCtx({
      reads: {
        "core.content_item": [
          { content_id: "d1", media_type: "application/pdf" },
        ],
        "core.content_derivative": [{ content_id: "d1", variant: "preview" }],
      },
      input: {
        variant: "delegate",
        profileId: "docs-vlm",
        delegateModel: "owner/pin",
      },
      delegate: () => ({ text: "Warranty expires 2027-03-01" }),
    });

    await expect(
      handler({ ctx: harness.ctx, log: harness.log })
    ).rejects.toThrow("no ACP-confirmed model identity");
    expect(harness.invokes).toHaveLength(0);
  });

  it("refuses a delegate fire that names no pinned model, spending no turn", async () => {
    const handler = await loadHandler("doc-text-extractor");
    const harness = stubCtx({
      reads: { "core.content_item": [], "core.content_derivative": [] },
      input: { variant: "delegate", profileId: "docs-vlm" },
    });

    await expect(
      handler({ ctx: harness.ctx, log: harness.log })
    ).rejects.toThrow("requires an explicit pinned model");
    expect(harness.delegateCalls).toHaveLength(0);
  });

  it("refuses a prompt revision the profile pinned but the handler does not ship", async () => {
    const handler = await loadHandler("doc-text-extractor");
    const harness = stubCtx({
      reads: { "core.content_item": [], "core.content_derivative": [] },
      input: {
        variant: "delegate",
        profileId: "docs-vlm",
        delegateModel: "owner/pin",
        promptRev: "doc-text-v9",
      },
    });

    await expect(
      handler({ ctx: harness.ctx, log: harness.log })
    ).rejects.toThrow('pins prompt revision "doc-text-v9"');
    expect(harness.delegateCalls).toHaveLength(0);
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
      delegate: () => ({ summary: "Home insurance policy for 2026." }),
    });
    await handler({ ctx: harness.ctx, log: harness.log });
    expect(harness.delegateCalls[0]!.content).toStrictEqual([
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

  it("inline text items and underivable binaries are skipped without delegate turns", async () => {
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
    expect(harness.delegateCalls).toHaveLength(0);
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
      delegate: () => ({
        text: "Late preview exposes the albatross renewal date",
      }),
    });
    await handler({ ctx: harness.ctx, log: harness.log });
    expect(harness.state.get("cursor")).toBe("d5");
    expect(harness.delegateCalls).toHaveLength(0);

    // The parent no longer appears in the new-content page. Its independently
    // ordered derivative row must pull it back into the automation.
    reads["core.content_item"] = [];
    reads["core.content_derivative"] = [
      { derivative_id: "dv-1", content_id: "d5", variant: "preview" },
    ];
    await handler({ ctx: harness.ctx, log: harness.log });
    expect(harness.delegateCalls.at(-1)?.content).toStrictEqual([
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
      delegate: () => ({
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
      delegate: () => ({
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
      delegate: () => ({
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
    expect(harness.delegateCalls).toHaveLength(0);
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
      delegate: (call) => {
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
    expect(harness.delegateCalls[0]!.content).toStrictEqual([
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
