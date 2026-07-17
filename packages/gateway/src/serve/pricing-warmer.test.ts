import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { costForUsage, setPricingCatalog } from '@centraid/app-engine';
import { PricingWarmer } from './pricing-warmer.js';

// A minimal raw-LiteLLM shape the shared filter accepts. `claude-probe` is a
// synthetic id so a refresh is observable via costForUsage without depending on
// the real bundled snapshot.
function rawCatalog(inputRate: number): Record<string, unknown> {
  return {
    'claude-probe': {
      litellm_provider: 'anthropic',
      input_cost_per_token: inputRate,
      output_cost_per_token: inputRate,
    },
  };
}

function okResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
}

function freshCacheFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'centraid-pricing-')), 'model-pricing.json');
}

afterEach(() => {
  // Reset the process-global catalog to the bundled snapshot for other suites
  // by overlaying a known table (vitest isolates modules per file anyway).
  setPricingCatalog({ 'reset-marker': { input_cost_per_token: 0 } });
});

describe('PricingWarmer', () => {
  it('refresh fetches, filters, overlays the catalog, and writes the disk cache', async () => {
    const cacheFile = freshCacheFile();
    const warmer = new PricingWarmer({
      cacheFile,
      fetchImpl: async () => okResponse(JSON.stringify(rawCatalog(1e-6))),
    });
    await warmer.refresh();

    // Overlaid: 1,000,000 tokens × $1e-6 = $1.
    expect(costForUsage('claude-probe', { inputTokens: 1_000_000 })).toBeCloseTo(1, 9);
    expect(existsSync(cacheFile)).toBe(true);
    const disk = JSON.parse(readFileSync(cacheFile, 'utf8')) as {
      models: Record<string, unknown>;
    };
    expect(disk.models['claude-probe']).toBeTruthy();
  });

  it('boot seeds from a fresh disk cache without fetching', async () => {
    const cacheFile = freshCacheFile();
    writeFileSync(
      cacheFile,
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        models: { 'claude-probe': { input_cost_per_token: 2e-6, output_cost_per_token: 2e-6 } },
      }),
    );
    let fetched = false;
    const warmer = new PricingWarmer({
      cacheFile,
      fetchImpl: async () => {
        fetched = true;
        return okResponse('{}');
      },
    });
    await warmer.boot();
    expect(costForUsage('claude-probe', { inputTokens: 1_000_000 })).toBeCloseTo(2, 9);
    expect(fetched).toBe(false); // fresh cache ⇒ no background refresh
  });

  it('a failed refresh keeps the last-good table (never blanks a price)', async () => {
    const cacheFile = freshCacheFile();
    // Seed a good table first.
    const warmer = new PricingWarmer({
      cacheFile,
      fetchImpl: async () => okResponse(JSON.stringify(rawCatalog(3e-6))),
    });
    await warmer.refresh();
    expect(costForUsage('claude-probe', { inputTokens: 1_000_000 })).toBeCloseTo(3, 9);

    // A subsequent failing fetch must not wipe the table.
    const failing = new PricingWarmer({
      cacheFile,
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    await failing.refresh();
    expect(costForUsage('claude-probe', { inputTokens: 1_000_000 })).toBeCloseTo(3, 9);
  });
});
