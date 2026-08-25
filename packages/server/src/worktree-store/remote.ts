// GitHub export/import of the apps repo; session branches are deliberately NOT pushed.

import { promises as fs } from "node:fs";
import path from "node:path";

import { run, runRaw } from "./git.js";

export interface ExportOptions {
  remoteName?: string;
  /** Force-push (`+`) the refs. Off by default — a rejected push surfaces. */
  force?: boolean;
}

export interface ExportResult {
  remoteName: string;
  remoteUrl: string;
  pushed: string[];
}

export async function exportToRemote(
  bareDir: string,
  remoteUrl: string,
  opts: ExportOptions = {}
): Promise<ExportResult> {
  const remoteName = opts.remoteName ?? "origin";

  // `remote add` fails if it exists — probe, then `set-url`.
  const existing = await runRaw(["remote", "get-url", remoteName], {
    cwd: bareDir,
    allowNonZero: true,
  });
  if (existing.code === 0) {
    await run(["remote", "set-url", remoteName, remoteUrl], { cwd: bareDir });
  } else {
    await run(["remote", "add", remoteName, remoteUrl], { cwd: bareDir });
  }

  const lead = opts.force ? "+" : "";
  const mainSpec = `${lead}refs/heads/main:refs/heads/main`;
  const tagSpec = `${lead}refs/tags/*:refs/tags/*`;
  await run(["push", remoteName, mainSpec, tagSpec], { cwd: bareDir });

  return { remoteName, remoteUrl, pushed: [mainSpec, tagSpec] };
}

export interface ImportResult {
  root: string;
  bareDir: string;
}

/** Clone `remoteUrl` into `<root>/apps.git`; refuses if it exists. */
export async function importFromRemote(
  root: string,
  remoteUrl: string
): Promise<ImportResult> {
  const bareDir = path.join(root, "apps.git");
  if (await pathExists(bareDir)) {
    throw new Error(
      `Refusing to import: ${bareDir} already exists. Import targets a fresh gateway root.`
    );
  }
  await fs.mkdir(root, { recursive: true });
  await run(["clone", "--bare", remoteUrl, bareDir], { cwd: root });
  return { root, bareDir };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
