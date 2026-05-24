import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import * as tar from 'tar';
import { ManifestError, parseAppManifest } from '@centraid/runtime-core';
import type { HarnessConfig, PublishOptions, PublishResult } from './types.js';
import { HarnessError } from './types.js';

/** Files/folders we never include in the upload. */
const EXCLUDE = new Set([
  'node_modules',
  '.git',
  '.DS_Store',
  'dist',
  'data.sqlite',
  'runtime.sqlite',
  'current.json',
  '_registry.json',
  'versions',
  '_uploads',
  '_trash',
]);

/**
 * Build the project (unless `skipBuild`), then tarball + upload to the gateway.
 *
 * Throws HarnessError on build/upload failure. Returns the parsed plugin
 * response body on success.
 */
export async function publishProject(
  projectDir: string,
  appId: string,
  config: HarnessConfig,
  options: PublishOptions = {},
): Promise<PublishResult> {
  if (!(await dirExists(projectDir))) {
    throw new HarnessError('no_project', `Project directory not found: ${projectDir}`);
  }

  if (!options.skipBuild) {
    await runBuild(projectDir, options.buildCommand);
  }

  // Validate the manifest *before* tarring + uploading so an invalid
  // manifest fails loudly at publish time — the runtime would otherwise
  // accept the upload, then the dispatcher would 503/400 on every
  // subsequent invocation, which is a much worse failure mode (the user
  // sees a successful publish but a dead app).
  await assertManifestValid(projectDir);

  const tarStream = tar.create(
    {
      gzip: true,
      cwd: projectDir,
      // Preserve relative paths; refuse anything outside the project dir.
      preservePaths: false,
      filter: (relPath) => {
        // tar walks the cwd via the "." / "./" prefix — keep that, otherwise
        // it never recurses and we ship an empty archive (plugin then 400s
        // with TAR_BAD_ARCHIVE).
        const stripped = relPath.replace(/^\.\/+/, '');
        if (stripped === '' || stripped === '.') return true;
        const top = stripped.split('/')[0] ?? '';
        if (EXCLUDE.has(top)) return false;
        // Drop top-level dotfiles / dotdirs (.env, .vscode, …) but not the
        // cwd marker itself, which is already handled above.
        if (top.startsWith('.')) return false;
        return true;
      },
    },
    ['.'],
  );

  // Buffer the tar.gz so we can compute Content-Length and retry safely.
  const chunks: Buffer[] = [];
  for await (const chunk of tarStream as unknown as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  const body = Buffer.concat(chunks);

  const url = new URL(
    `/centraid/_apps/${encodeURIComponent(appId)}/upload`,
    config.gatewayUrl,
  ).toString();

  const headers: Record<string, string> = {
    'Content-Type': 'application/gzip',
    'Content-Length': String(body.byteLength),
  };
  if (config.gatewayToken && config.gatewayToken.length > 0) {
    headers['Authorization'] = `Bearer ${config.gatewayToken}`;
  }

  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers, body });
  } catch (err) {
    throw new HarnessError(
      'gateway_unreachable',
      `Could not reach gateway at ${config.gatewayUrl}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new HarnessError(
        'auth_required',
        `Gateway rejected upload (HTTP ${res.status}). Configure your gateway token in Settings.`,
      );
    }
    throw new HarnessError(
      'upload_failed',
      `Upload failed (HTTP ${res.status}): ${text || res.statusText}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HarnessError(
      'upload_failed',
      `Upload succeeded but response was not JSON: ${text.slice(0, 200)}`,
    );
  }

  return parsed as PublishResult;
}

async function runBuild(
  projectDir: string,
  override?: PublishOptions['buildCommand'],
): Promise<void> {
  const cmd = override ?? (await pickBuildCommand(projectDir));
  if (!cmd) return; // nothing to build

  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd.bin, cmd.args, {
      cwd: projectDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', (err) =>
      reject(new HarnessError('build_failed', `Failed to spawn ${cmd.bin}: ${err.message}`)),
    );
    child.on('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new HarnessError(
            'build_failed',
            `${cmd.bin} ${cmd.args.join(' ')} exited with code ${code}: ${stderr.trim()}`,
          ),
        );
    });
  });
}

async function pickBuildCommand(
  projectDir: string,
): Promise<{ bin: string; args: string[] } | undefined> {
  // Prefer `bun run build` if a build script exists; otherwise fall back to `tsc`.
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(projectDir, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    if (pkg.scripts && typeof pkg.scripts.build === 'string') {
      return { bin: 'bun', args: ['run', 'build'] };
    }
  } catch {
    /* no package.json — try tsc */
  }
  if (await fileExists(path.join(projectDir, 'tsconfig.json'))) {
    return { bin: 'tsc', args: ['-p', 'tsconfig.json'] };
  }
  return undefined;
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await fs.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

/**
 * Read `app.json` from the project, parse it through the runtime-core
 * validator, and throw `HarnessError('invalid_manifest')` on any
 * shape problem. Also enforces the additional rule that every declared
 * action/query has a matching handler file on disk — a manifest entry
 * that points at a missing file would 500 on first invocation.
 */
async function assertManifestValid(projectDir: string): Promise<void> {
  const manifestPath = path.join(projectDir, 'app.json');
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath, 'utf8');
  } catch (err) {
    throw new HarnessError(
      'invalid_manifest',
      `Cannot read app.json at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let manifest;
  try {
    manifest = parseAppManifest(raw);
  } catch (err) {
    if (err instanceof ManifestError) {
      throw new HarnessError(
        'invalid_manifest',
        `app.json invalid (${err.code})${err.path ? ` at ${err.path}` : ''}: ${err.message}`,
      );
    }
    throw err;
  }
  // Walk every declared handler; require a matching .js file.
  for (const a of manifest.actions) {
    const file = path.join(projectDir, 'actions', `${a.name}.js`);
    if (!(await fileExists(file))) {
      throw new HarnessError(
        'invalid_manifest',
        `app.json declares action "${a.name}" but ${path.relative(projectDir, file)} does not exist`,
      );
    }
  }
  for (const q of manifest.queries) {
    const file = path.join(projectDir, 'queries', `${q.name}.js`);
    if (!(await fileExists(file))) {
      throw new HarnessError(
        'invalid_manifest',
        `app.json declares query "${q.name}" but ${path.relative(projectDir, file)} does not exist`,
      );
    }
  }
}
