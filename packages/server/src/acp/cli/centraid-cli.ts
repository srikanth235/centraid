#!/usr/bin/env node

import { statSync } from "node:fs";
import path from "node:path";

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value) + "\n");
}

function fail(message: string, code = 1): never {
  process.stderr.write(`centraid-acp: ${message}\n`);
  process.exit(code);
}

function usage(): never {
  process.stderr.write(
    [
      "Usage:",
      "  centraid-acp preview snapshot",
      "",
      "The CLI operates relative to the current working directory.",
      "",
    ].join("\n")
  );
  process.exit(2);
}

const PREVIEW_SNAPSHOT_REL = path.join(".preview", "snapshot.png");

function commandPreviewSnapshot(): void {
  const abs = path.resolve(process.cwd(), PREVIEW_SNAPSHOT_REL);
  try {
    const stat = statSync(abs);
    printJson({
      path: abs,
      exists: true,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      ageMs: Date.now() - stat.mtimeMs,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      printJson({ path: abs, exists: false });
      return;
    }
    fail(error instanceof Error ? error.message : String(error));
  }
}

function main(argv: string[]): void {
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") usage();
  const top = argv[0];
  if (top === "preview") {
    const sub = argv[1];
    if (sub !== "snapshot") {
      process.stderr.write(
        `centraid-acp: unknown preview subcommand "${sub ?? ""}"\n`
      );
      usage();
    }
    if (argv.length > 2) {
      process.stderr.write(
        "centraid-acp: `preview snapshot` takes no arguments\n"
      );
      process.exit(2);
    }
    commandPreviewSnapshot();
    return;
  }
  process.stderr.write(`centraid-acp: unknown command "${top}"\n`);
  usage();
}

main(process.argv.slice(2));
