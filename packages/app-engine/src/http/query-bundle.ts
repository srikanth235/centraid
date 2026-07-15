/**
 * Browser query-module serving for the local-replica execution path (#406).
 *
 * Raw handler directories remain denied by `resolveStaticPath`. This module
 * exposes one narrower seam: a manifest-declared `queries/<name>.js` can be
 * bundled as browser ESM, but its entire relative import graph must resolve
 * through real paths contained by that same app's real `queries/` directory.
 * Bare imports, action imports, traversal, and symlink escapes fail the build.
 * Runtime code-dir resolution selects the live or draft worktree before this
 * module runs; the surrounding HTTP server authenticates the request.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import * as esbuild from 'esbuild';
import { findQuery, ManifestError, parseManifest } from '../registry/manifest.js';
import { computeEtag, finishStaticAsset } from './asset-variants.js';
import type { Encoding } from './compression.js';
import { sendError } from './http-utils.js';

export const QUERY_SOURCE_HASH_HEADER = 'X-Centraid-Query-Source-Hash';
export const QUERY_NAME_HEADER = 'X-Centraid-Query-Name';

const QUERY_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const QUERY_MODULE_EXTENSIONS = new Set(['.js', '.mjs']);

export class QueryBundleError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'QueryBundleError';
  }
}

export interface BuiltQueryBundle {
  appId: string;
  queryName: string;
  sourceHash: string;
  etag: string;
  code: Buffer;
  variants: Map<Encoding, Buffer>;
}

type QueryBundleResult =
  | { ok: true; bundle: BuiltQueryBundle }
  | { ok: false; error: QueryBundleError };

interface QueryDirectoryCache {
  signature: string;
  sourceHash: string;
  bundles: Map<string, QueryBundleResult>;
}

const bundleCache = new Map<string, QueryDirectoryCache>();
const inflight = new Map<string, Promise<QueryBundleResult>>();

/** Test/dev hook used when a code-store activation invalidates every worktree. */
export function clearQueryBundleCaches(): void {
  bundleCache.clear();
  inflight.clear();
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function queryTreeSignature(
  queryRoot: string,
  manifestText: string,
): Promise<{ signature: string; files: string[] }> {
  const lines = [`app.json\0${createHash('sha256').update(manifestText).digest('hex')}`];
  const seenDirs = new Set<string>();
  const files: string[] = [];

  async function walk(directory: string): Promise<void> {
    const realDirectory = await fs.realpath(directory);
    if (!isInside(queryRoot, realDirectory) || seenDirs.has(realDirectory)) return;
    seenDirs.add(realDirectory);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const file = path.join(directory, entry.name);
      const real = await fs.realpath(file).catch(() => undefined);
      if (!real || !isInside(queryRoot, real)) continue;
      const stat = await fs.stat(real).catch(() => undefined);
      if (!stat) continue;
      if (stat.isDirectory()) {
        await walk(real);
        continue;
      }
      if (!stat.isFile() || !QUERY_MODULE_EXTENSIONS.has(path.extname(real))) continue;
      const relative = path.relative(queryRoot, real).split(path.sep).join('/');
      lines.push(`${relative}\0${stat.mtimeMs}\0${stat.ctimeMs}\0${stat.size}`);
      files.push(real);
    }
  }

  await walk(queryRoot);
  const signature = lines.sort().join('\n');
  return { signature, files };
}

async function hashQuerySources(
  queryRoot: string,
  manifestText: string,
  files: string[],
): Promise<string> {
  const hash = createHash('sha256');
  hash.update('app.json\0').update(manifestText).update('\0');
  for (const file of [...new Set(files)].sort()) {
    const relative = path.relative(queryRoot, file).split(path.sep).join('/');
    hash
      .update(relative)
      .update('\0')
      .update(await fs.readFile(file))
      .update('\0');
  }
  return hash.digest('hex');
}

async function resolveQueryImport(
  queryRoot: string,
  resolveDir: string,
  specifier: string,
): Promise<esbuild.OnResolveResult> {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
    return { errors: [{ text: `query bundles allow relative imports only: "${specifier}"` }] };
  }
  const target = path.resolve(resolveDir, specifier);
  const extension = path.extname(target);
  const candidates = extension ? [target] : [target, `${target}.js`, `${target}.mjs`];
  for (const candidate of candidates) {
    const real = await fs.realpath(candidate).catch(() => undefined);
    if (!real || !isInside(queryRoot, real)) continue;
    const stat = await fs.stat(real).catch(() => undefined);
    if (!stat?.isFile() || !QUERY_MODULE_EXTENSIONS.has(path.extname(real))) continue;
    return { path: real };
  }
  return {
    errors: [
      {
        text: `query import escapes queries/ or does not resolve: "${specifier}"`,
      },
    ],
  };
}

function queryGraphPlugin(queryRoot: string): esbuild.Plugin {
  return {
    name: 'centraid-query-only-graph',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.kind === 'entry-point') return null;
        return resolveQueryImport(queryRoot, args.resolveDir, args.path);
      });
    },
  };
}

function safeBuildMessage(error: unknown, queryName: string): string {
  const errors = (error as { errors?: esbuild.Message[] }).errors;
  const first = errors?.[0];
  if (!first) return `Could not bundle query "${queryName}".`;
  const location = first.location;
  const where = location
    ? `${path.basename(location.file || `${queryName}.js`)}:${location.line}:${location.column}`
    : `${queryName}.js`;
  return `${where}: ${first.text}`;
}

async function buildQuery(
  appId: string,
  queryName: string,
  queryRoot: string,
  entryFile: string,
  sourceHash: string,
): Promise<QueryBundleResult> {
  try {
    const result = await esbuild.build({
      absWorkingDir: queryRoot,
      entryPoints: [entryFile],
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'es2022',
      write: false,
      logLevel: 'silent',
      legalComments: 'none',
      plugins: [queryGraphPlugin(queryRoot)],
    });
    const output = result.outputFiles?.[0];
    if (!output) {
      return {
        ok: false,
        error: new QueryBundleError(
          'query_bundle_failed',
          422,
          `Could not bundle query "${queryName}": esbuild produced no output.`,
        ),
      };
    }
    const code = Buffer.from(output.contents);
    return {
      ok: true,
      bundle: {
        appId,
        queryName,
        sourceHash,
        etag: computeEtag(code),
        code,
        variants: new Map(),
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: new QueryBundleError('query_bundle_failed', 422, safeBuildMessage(error, queryName)),
    };
  }
}

/** Validate a declared query and build only its browser-safe queries/ graph. */
export async function bundleDeclaredQuery(
  codeDir: string,
  appId: string,
  queryName: string,
): Promise<BuiltQueryBundle> {
  if (!QUERY_NAME_RE.test(queryName)) {
    throw new QueryBundleError(
      'invalid_query_name',
      400,
      'Query names must use letters, digits, hyphens, or underscores.',
    );
  }

  const codeRoot = await fs.realpath(codeDir).catch(() => undefined);
  if (!codeRoot) {
    throw new QueryBundleError('query_source_missing', 404, 'App code directory is missing.');
  }

  let manifestText: string;
  try {
    const manifestFile = await fs.realpath(path.join(codeRoot, 'app.json'));
    if (!isInside(codeRoot, manifestFile)) throw new Error('manifest escapes app code directory');
    manifestText = await fs.readFile(manifestFile, 'utf8');
  } catch {
    throw new QueryBundleError('invalid_manifest', 422, 'App manifest is unavailable.');
  }
  try {
    const manifest = parseManifest(manifestText);
    if (manifest.id !== appId) {
      throw new QueryBundleError(
        'invalid_manifest',
        422,
        `App manifest id "${manifest.id}" does not match registered app "${appId}".`,
      );
    }
    if (!findQuery(manifest, queryName)) {
      throw new QueryBundleError(
        'unknown_query',
        404,
        `App "${appId}" has no declared query "${queryName}".`,
      );
    }
  } catch (error) {
    if (error instanceof QueryBundleError) throw error;
    const message = error instanceof ManifestError ? error.message : 'App manifest is invalid.';
    throw new QueryBundleError('invalid_manifest', 422, message);
  }

  const queryPath = path.join(codeRoot, 'queries');
  const queryPathStat = await fs.lstat(queryPath).catch(() => undefined);
  const queryRoot = await fs.realpath(queryPath).catch(() => undefined);
  if (
    !queryRoot ||
    !queryPathStat?.isDirectory() ||
    queryPathStat.isSymbolicLink() ||
    path.relative(codeRoot, queryRoot) !== 'queries'
  ) {
    throw new QueryBundleError(
      'query_source_missing',
      404,
      'App query source directory is missing.',
    );
  }
  const entryCandidate = path.resolve(queryRoot, `${queryName}.js`);
  if (!isInside(queryRoot, entryCandidate)) {
    throw new QueryBundleError('invalid_query_name', 400, 'Query path escapes queries/.');
  }
  const entryFile = await fs.realpath(entryCandidate).catch(() => undefined);
  const entryStat = entryFile ? await fs.stat(entryFile).catch(() => undefined) : undefined;
  if (
    !entryFile ||
    !entryStat?.isFile() ||
    !isInside(queryRoot, entryFile) ||
    path.extname(entryFile) !== '.js'
  ) {
    throw new QueryBundleError(
      'query_source_missing',
      404,
      `Declared query "${queryName}" has no safe queries/${queryName}.js source.`,
    );
  }

  let signature: string;
  let files: string[];
  try {
    ({ signature, files } = await queryTreeSignature(queryRoot, manifestText));
  } catch {
    throw new QueryBundleError(
      'query_source_unavailable',
      409,
      'Query sources changed while preparing the bundle; retry the request.',
    );
  }
  const cacheKey = `${codeRoot}\0${queryRoot}`;
  let directory = bundleCache.get(cacheKey);
  if (!directory || directory.signature !== signature) {
    let sourceHash: string;
    try {
      sourceHash = await hashQuerySources(queryRoot, manifestText, files);
    } catch {
      throw new QueryBundleError(
        'query_source_unavailable',
        409,
        'Query sources changed while preparing the bundle; retry the request.',
      );
    }
    directory = { signature, sourceHash, bundles: new Map() };
    bundleCache.set(cacheKey, directory);
  }
  const cached = directory.bundles.get(queryName);
  if (cached) {
    if (cached.ok) return cached.bundle;
    throw cached.error;
  }

  const flightKey = `${cacheKey}\0${queryName}\0${signature}`;
  let pending = inflight.get(flightKey);
  if (!pending) {
    pending = buildQuery(appId, queryName, queryRoot, entryFile, directory.sourceHash).finally(() =>
      inflight.delete(flightKey),
    );
    inflight.set(flightKey, pending);
  }
  const result = await pending;
  const current = bundleCache.get(cacheKey);
  if (current?.signature === signature) current.bundles.set(queryName, result);
  if (!result.ok) throw result.error;
  return result.bundle;
}

export async function serveQueryBundle(
  req: IncomingMessage,
  res: ServerResponse,
  options: { codeDir: string; appId: string; queryName: string },
): Promise<true> {
  try {
    const bundle = await bundleDeclaredQuery(options.codeDir, options.appId, options.queryName);
    res.setHeader(QUERY_NAME_HEADER, bundle.queryName);
    res.setHeader(QUERY_SOURCE_HASH_HEADER, bundle.sourceHash);
    res.setHeader(
      'Access-Control-Expose-Headers',
      `ETag, ${QUERY_NAME_HEADER}, ${QUERY_SOURCE_HASH_HEADER}`,
    );
    return finishStaticAsset(req, res, {
      contentType: 'application/javascript; charset=utf-8',
      etag: bundle.etag,
      rawSize: bundle.code.length,
      loadRaw: () => bundle.code,
      variants: bundle.variants,
    });
  } catch (error) {
    if (error instanceof QueryBundleError) {
      return sendError(res, error.status, error.code, error.message);
    }
    return sendError(res, 500, 'query_bundle_failed', 'Could not prepare query bundle.');
  }
}
