import path from "node:path";

// Where the generated bundles land. The repo root by default; the drift check
// in `automation-handlers/bundle-drift.test.ts` (#781) points it at a temp
// directory so it can rebuild and diff against the committed bundles without
// writing into the working tree.
const root = process.env.CENTRAID_AUTOMATION_BUNDLE_ROOT
  ? path.resolve(process.env.CENTRAID_AUTOMATION_BUNDLE_ROOT)
  : path.resolve(import.meta.dirname, "../..");

const handlers = [
  {
    entrypoint: path.join(
      import.meta.dirname,
      "automation-handlers/photo-ocr.js"
    ),
    output: path.join(
      root,
      "packages/blueprints/automations/photo-ocr/automations/photo-ocr"
    ),
  },
  ...(
    [
      "embed-image",
      "embed-text",
      "faces",
      // Not a model recipe: `place-names` inlines a vendored settlement table
      // (`src/gazetteer-data.ts`) instead of loading weights, so its bundle is
      // large where the others are small and needs no `runtime/` assets at all.
      // The build is the same one — one entrypoint, minified, self-contained.
      "place-names",
      "transcript",
    ] as const
  ).map((id) => ({
    entrypoint: path.join(import.meta.dirname, `automation-handlers/${id}.js`),
    output: path.join(
      root,
      `packages/blueprints/automations/${id}/automations/${id}`
    ),
  })),
] as const;

const results = await Promise.all(
  handlers.map(async (handler) => ({
    handler,
    result: await Bun.build({
      entrypoints: [handler.entrypoint],
      outdir: handler.output,
      naming: "handler.js",
      target: "node",
      format: "esm",
      splitting: false,
      sourcemap: "none",
      minify: true,
      banner: `${handler.entrypoint.endsWith("photo-ocr.js") ? "// governance: allow-repo-hygiene file-size-limit (#731) the self-contained OCR/PDF handler is one deployable runtime unit; splitting its bundled model/runtime rail would duplicate the content-resolution and bounded-batch invariants.\n" : ""}// Generated recognition automation. Source: packages/model-runtime/automation-handlers.\n`,
    }),
  }))
);

for (const { handler, result } of results) {
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`failed to bundle ${handler.entrypoint}`);
  }
}
