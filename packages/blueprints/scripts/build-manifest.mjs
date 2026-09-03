#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const PACKAGE_ROOT = path.resolve(here, "..");
const SOURCE_INDEX = path.join(PACKAGE_ROOT, "index.json");
const OUTPUT = path.join(PACKAGE_ROOT, "manifest.json");

async function walk(dir, base = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (e) => {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          return walk(full, base);
        }
        return e.isFile()
          ? [path.relative(base, full).split(path.sep).join("/")]
          : [];
      })
    )
  )
    .flat()
    .toSorted();
}

const raw = await fs.readFile(SOURCE_INDEX, "utf8");
const src = JSON.parse(raw);

const enriched = {
  manifestVersion: src.manifestVersion,
  templates: [],
};

const templates = await Promise.all(
  src.templates.map(async (tmpl) => {
    const kindDir = tmpl.kind === "automation" ? "automations" : "apps";
    const dir = path.join(PACKAGE_ROOT, kindDir, tmpl.id);
    let files = [];
    try {
      files = await walk(dir);
    } catch {
      console.warn(
        `[build-manifest] missing template dir for "${tmpl.id}", skipping`
      );
      return undefined;
    }
    let appKnobs;
    let seats;
    let states;
    try {
      const rawLocal = await fs.readFile(path.join(dir, "app.json"), "utf8");
      const parsed = JSON.parse(rawLocal);
      if (Array.isArray(parsed?.knobs)) appKnobs = parsed.knobs;
      if (parsed?.seats && typeof parsed.seats === "object")
        seats = parsed.seats;
      if (parsed?.states && typeof parsed.states === "object")
        states = parsed.states;
    } catch {
      // Intentionally empty.
    }
    const kind = tmpl.kind ?? "app";
    return {
      ...tmpl,
      kind,
      files,
      ...(appKnobs ? { appKnobs } : {}),
      ...(seats ? { seats } : {}),
      ...(states ? { states } : {}),
    };
  })
);
enriched.templates.push(...templates.filter(Boolean));

await fs.writeFile(OUTPUT, JSON.stringify(enriched, null, 2) + "\n");
process.stdout.write(
  `[build-manifest] wrote ${enriched.templates.length} templates → ${path.relative(process.cwd(), OUTPUT)}\n`
);
