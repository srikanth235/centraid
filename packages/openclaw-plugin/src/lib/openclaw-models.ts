/*
 * OpenClaw model enumeration + capability-tier classification for
 * runner-status.
 *
 * Enumeration shells out to `openclaw models list --json`. OpenClaw returns
 * concrete model keys with no tier semantics, so — to match the rest of the
 * picker — we classify them into capability tiers (smart / balanced / fast)
 * with a one-shot LLM call (`openclaw infer model run --gateway --json`), and
 * cache the result on disk keyed by the model-list hash. Classification runs
 * synchronously on an explicit refresh, and fire-and-forget on a cold cache,
 * so a normal runner-status read never blocks on the LLM.
 *
 * Everything is best-effort: any failure (binary missing, non-zero exit,
 * unparseable JSON, timeout) degrades to an unclassified / empty result so
 * runner-status never breaks.
 */

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ModelTier, RunnerModel } from '@centraid/app-engine';

/** `openclaw models list` is a local config/catalog read — keep the cap short. */
const LIST_TIMEOUT_MS = 6_000;
/** Classification is an LLM round-trip through the gateway — allow longer. */
const CLASSIFY_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const VALID_TIERS: readonly ModelTier[] = ['smart', 'balanced', 'fast'];

interface OpenClawModelEntry {
  key?: unknown;
  name?: unknown;
  tags?: unknown;
}

/**
 * Run `openclaw models list --json` and return the configured models.
 * Inherits the current process env so the same profile / state dir
 * (OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH) the plugin runs under is used.
 */
export function listOpenClawModels(): Promise<RunnerModel[]> {
  return new Promise((resolve) => {
    execFile(
      'openclaw',
      ['models', 'list', '--json'],
      { timeout: LIST_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
      (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        resolve(parseModelsJson(stdout));
      },
    );
  });
}

/** Parse the `{ models: [{ key, name, tags }] }` body into RunnerModel[]. */
export function parseModelsJson(stdout: string): RunnerModel[] {
  let body: unknown;
  try {
    body = JSON.parse(stdout);
  } catch {
    return [];
  }
  const entries = (body as { models?: unknown }).models;
  if (!Array.isArray(entries)) return [];
  const models: RunnerModel[] = [];
  for (const raw of entries as OpenClawModelEntry[]) {
    if (!raw || typeof raw.key !== 'string' || !raw.key) continue;
    const model: RunnerModel = { id: raw.key };
    if (typeof raw.name === 'string' && raw.name) model.name = raw.name;
    if (Array.isArray(raw.tags) && raw.tags.includes('default')) model.default = true;
    models.push(model);
  }
  return models;
}

// ─── Classification ────────────────────────────────────────────────────────

type TierMap = Record<string, ModelTier>;

interface TierCache {
  /** Hash of the classified model-id set — reclassify when it changes. */
  hash: string;
  tiers: TierMap;
}

/** Stable hash of the model ids so a changed catalog invalidates the cache. */
export function hashModelIds(models: readonly RunnerModel[]): string {
  const ids = models.map((m) => m.id).sort();
  return createHash('sha256').update(ids.join('\n')).digest('hex').slice(0, 16);
}

/** The classifier prompt — asks for a compact JSON array of {id, tier}. */
function classifyPrompt(models: readonly RunnerModel[]): string {
  const ids = models.map((m) => m.id).join(', ');
  return (
    'You classify LLM model ids into exactly one capability tier each: ' +
    'smart (flagship / most capable), balanced (mid-range), or fast ' +
    '(small / mini / nano / flash / cheap). ' +
    'Output ONLY a compact JSON array, no prose: ' +
    '[{"id":"<id>","tier":"smart|balanced|fast"}]. Classify: ' +
    ids
  );
}

/** Parse the `infer model run --json` envelope into an id→tier map. */
export function parseClassification(stdout: string): TierMap {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return {};
  }
  const outputs = (envelope as { outputs?: unknown }).outputs;
  const first = Array.isArray(outputs) ? (outputs[0] as { text?: unknown }) : undefined;
  let text = typeof first?.text === 'string' ? first.text.trim() : '';
  if (!text) return {};
  // Strip ``` / ```json code fences some models wrap the array in.
  text = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  let arr: unknown;
  try {
    arr = JSON.parse(text);
  } catch {
    return {};
  }
  if (!Array.isArray(arr)) return {};
  const map: TierMap = {};
  for (const raw of arr as Array<{ id?: unknown; tier?: unknown }>) {
    if (!raw || typeof raw.id !== 'string') continue;
    const tier = raw.tier as ModelTier;
    if (VALID_TIERS.includes(tier)) map[raw.id] = tier;
  }
  return map;
}

/** Run the one-shot classifier through the gateway. `{}` on any failure. */
export function classifyModels(models: readonly RunnerModel[]): Promise<TierMap> {
  if (!models.length) return Promise.resolve({});
  return new Promise((resolve) => {
    execFile(
      'openclaw',
      ['infer', 'model', 'run', '--gateway', '--json', '--prompt', classifyPrompt(models)],
      { timeout: CLASSIFY_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
      (err, stdout) => resolve(err ? {} : parseClassification(stdout)),
    );
  });
}

async function readCache(cachePath: string): Promise<TierCache | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(cachePath, 'utf8')) as TierCache;
    return parsed && typeof parsed.hash === 'string' && parsed.tiers ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeCache(cachePath: string, cache: TierCache): Promise<void> {
  try {
    await fs.mkdir(cachePath.replace(/\/[^/]*$/, ''), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(cache), 'utf8');
  } catch {
    /* cache is best-effort */
  }
}

function applyTiers(models: readonly RunnerModel[], tiers: TierMap): RunnerModel[] {
  return models.map((m) => (tiers[m.id] ? { ...m, tier: tiers[m.id] } : m));
}

/** In-flight background classifications, keyed by hash, to avoid overlap. */
const inFlight = new Set<string>();

/**
 * List OpenClaw models and attach capability tiers.
 *
 * - `refresh: true` → classify synchronously and rewrite the cache.
 * - otherwise → serve cached tiers; on a cold/stale cache, kick a
 *   fire-and-forget classification so the next read is tagged.
 */
export async function resolveOpenClawModels(opts: {
  cachePath: string;
  refresh?: boolean;
}): Promise<RunnerModel[]> {
  const models = await listOpenClawModels();
  if (!models.length) return [];
  const hash = hashModelIds(models);
  const cache = await readCache(opts.cachePath);

  if (opts.refresh) {
    const tiers = await classifyModels(models);
    if (Object.keys(tiers).length) await writeCache(opts.cachePath, { hash, tiers });
    return applyTiers(models, tiers);
  }

  if ((!cache || cache.hash !== hash) && !inFlight.has(hash)) {
    inFlight.add(hash);
    void classifyModels(models)
      .then((tiers) => {
        if (Object.keys(tiers).length) return writeCache(opts.cachePath, { hash, tiers });
      })
      .finally(() => inFlight.delete(hash));
  }

  return applyTiers(models, cache?.tiers ?? {});
}
