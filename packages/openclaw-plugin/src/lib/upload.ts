import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import * as tar from "tar";

export interface UploadResult {
  sha256: string;
  bytes: number;
  files: number;
  declaredVersion?: string;
  versionId: string;
  /** Absolute path of the extracted directory (caller is expected to move/commit it). */
  extractedDir: string;
}

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MiB total tarball
const MAX_ENTRY_BYTES = 5 * 1024 * 1024; //  5 MiB per file
const MAX_ENTRIES = 5000;

/** Files we accept inside an upload. Broader than the static-serve allowlist. */
const UPLOAD_EXT_ALLOWLIST = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".ts", ".json", ".md", ".txt",
  ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico",
  ".woff", ".woff2", ".ttf", ".otf", ".map",
]);

/** Filenames forbidden inside an upload. `data.sqlite` lives outside versions. */
const FORBIDDEN_FILES = new Set(["data.sqlite", "_registry.json", "current.json"]);

export class UploadError extends Error {
  constructor(
    public readonly code:
      | "too_large"
      | "too_many_files"
      | "entry_too_large"
      | "bad_path"
      | "bad_entry_type"
      | "forbidden_file"
      | "bad_extension"
      | "bad_archive"
      | "empty",
    message: string,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

/**
 * Stream the request body into a temp tar.gz file under `<appsDir>/_uploads/`,
 * compute sha256, then extract under guards.
 *
 * On success, returns metadata + an extractedDir that the caller is responsible
 * for moving into the canonical version location (or removing on rollback).
 */
export async function ingestUpload(
  req: IncomingMessage,
  appsDir: string,
  appId: string,
): Promise<UploadResult> {
  const uploadsDir = path.join(appsDir, "_uploads");
  await fs.mkdir(uploadsDir, { recursive: true, mode: 0o700 });
  const id = crypto.randomBytes(8).toString("hex");
  const tarPath = path.join(uploadsDir, `${appId}.${id}.tgz`);
  const extractDir = path.join(uploadsDir, `${appId}.${id}.extract`);
  await fs.mkdir(extractDir, { mode: 0o700 });

  const hash = crypto.createHash("sha256");
  let bytes = 0;

  // Step 1: stream → temp file, hashing as we go, with size cap.
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(tarPath);
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) {
        aborted = true;
        out.destroy();
        reject(new UploadError("too_large", `Upload exceeds ${MAX_UPLOAD_BYTES} bytes.`));
        return;
      }
      hash.update(chunk);
      out.write(chunk);
    });
    req.on("end", () => {
      if (!aborted) {
        out.end(() => resolve());
      }
    });
    req.on("error", (err) => {
      aborted = true;
      out.destroy();
      reject(err);
    });
  }).catch(async (err) => {
    await safeRm(tarPath);
    await safeRm(extractDir);
    throw err;
  });

  if (bytes === 0) {
    await safeRm(tarPath);
    await safeRm(extractDir);
    throw new UploadError("empty", "Upload body is empty.");
  }

  const sha256 = hash.digest("hex");

  // Step 2: extract with strict filter.
  let fileCount = 0;
  try {
    await pipeline(
      Readable.from(await fs.readFile(tarPath)),
      tar.x({
        cwd: extractDir,
        strict: true,
        // Refuse symlinks/hardlinks/devices.
        keep: false,
        preservePaths: false,
        preserveOwner: false,
        unlink: true,
        filter: (entryPath: string, statOrEntry: import("node:fs").Stats | tar.ReadEntry) => {
          // We only run this in extract mode, so the filter receives ReadEntry.
          const entry = statOrEntry as tar.ReadEntry;
          // Reject anything that's not a normal file or directory.
          if (entry.type !== "File" && entry.type !== "Directory") {
            throw new UploadError(
              "bad_entry_type",
              `Entry "${entryPath}" has disallowed type "${entry.type}".`,
            );
          }
          // Path-traversal guard. tar already normalizes but verify.
          const normalized = path.posix.normalize(entryPath);
          if (
            normalized.startsWith("/") ||
            normalized.startsWith("../") ||
            normalized === ".." ||
            normalized.includes("/../")
          ) {
            throw new UploadError("bad_path", `Entry "${entryPath}" escapes archive root.`);
          }
          if (entry.type === "Directory") return true;

          const base = path.posix.basename(normalized);
          if (FORBIDDEN_FILES.has(base)) {
            throw new UploadError(
              "forbidden_file",
              `"${base}" is not part of the versioned code; it persists across versions outside this archive.`,
            );
          }

          const ext = path.posix.extname(normalized).toLowerCase();
          if (!UPLOAD_EXT_ALLOWLIST.has(ext)) {
            throw new UploadError(
              "bad_extension",
              `Entry "${entryPath}" has disallowed extension "${ext}".`,
            );
          }

          if (entry.size != null && entry.size > MAX_ENTRY_BYTES) {
            throw new UploadError(
              "entry_too_large",
              `Entry "${entryPath}" exceeds ${MAX_ENTRY_BYTES} bytes.`,
            );
          }
          fileCount += 1;
          if (fileCount > MAX_ENTRIES) {
            throw new UploadError("too_many_files", `Archive has more than ${MAX_ENTRIES} files.`);
          }
          return true;
        },
        onwarn: (_code, message) => {
          // Treat tar warnings (typically about strict-mode violations) as fatal.
          throw new UploadError("bad_archive", `tar: ${message}`);
        },
      }),
    );
  } catch (err) {
    await safeRm(tarPath);
    await safeRm(extractDir);
    if (err instanceof UploadError) throw err;
    throw new UploadError(
      "bad_archive",
      err instanceof Error ? err.message : String(err),
    );
  }

  // Step 3: read declaredVersion from extracted app.json (best-effort).
  let declaredVersion: string | undefined;
  try {
    const appJsonRaw = await fs.readFile(path.join(extractDir, "app.json"), "utf8");
    const parsed = JSON.parse(appJsonRaw) as { version?: unknown };
    if (typeof parsed.version === "string") declaredVersion = parsed.version;
  } catch {
    /* app.json is optional */
  }

  // Step 4: synthesize versionId from timestamp + sha-prefix.
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const versionId = `v_${ts}_${sha256.slice(0, 6)}`;

  // Step 5: drop the temp tarball; we've extracted what we need.
  await safeRm(tarPath);

  return {
    sha256,
    bytes,
    files: fileCount,
    declaredVersion,
    versionId,
    extractedDir: extractDir,
  };
}

async function safeRm(target: string): Promise<void> {
  try {
    await fs.rm(target, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}
