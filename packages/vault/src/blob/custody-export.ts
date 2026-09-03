import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { asVaultDiskFullError } from "../errors.js";
import type { LocalBlobStore } from "./local.js";

export function exportLocalTier(
  local: LocalBlobStore,
  destDir: string
): { copied: number } {
  const destRoot = path.join(destDir, "blobs");
  let copied = 0;
  for (const sha of local.listSync()) {
    const bytes = local.getSync(sha);
    if (!bytes) continue;
    const file = path.join(destRoot, "sha256", sha.slice(0, 2), sha);
    if (!existsSync(file)) {
      writeBlobFile(file, bytes);
      copied += 1;
    }
  }
  return { copied };
}

function writeBlobFile(file: string, bytes: Buffer): void {
  const tmp = `${file}.tmp`;
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(tmp, bytes, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw asVaultDiskFullError("blob export write", error);
  }
}
