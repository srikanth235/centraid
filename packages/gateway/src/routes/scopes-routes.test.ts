/*
 * The cross-vault scopes listing (issue #599 Phase 4).
 *
 * A real `gateway.db` with real members and real `member_roles`, because every
 * claim here is an authorization fact: what a member may see is what they were
 * granted, a vault they hold nothing in does not exist as far as they are
 * concerned, and the app-follows-the-person auto-mount is driven by those same
 * grants. The vault REGISTRY is stubbed — this route only ever reads a vault's
 * presentation and its installed-app set, never its contents.
 */

import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { AUTHED_DEVICE_HEADER } from '@centraid/app-engine';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { describe, afterEach, expect, test } from 'vitest';

import { EnrollmentStore } from '../serve/enrollment-store.js';
import { GatewayDatabase } from '../serve/gateway-db.js';
import { makeScopesRouteHandler, type ScopeVault } from './scopes-routes.js';

const servers: http.Server[] = [];
const databases: GatewayDatabase[] = [];
const dirs: string[] = [];
describe('scopes-routes suite', () => {
  afterEach(async () => {
    for (const server of servers.splice(0)) server.close();
    for (const database of databases.splice(0)) database.close();
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  interface ScopeRow {
    vaultId: string;
    label: string;
    color?: string;
    icon?: string;
    role: string;
    installed?: boolean;
  }

  interface Harness {
    url: string;
    enrollments: EnrollmentStore;
    /** Priya: admin of her own vault, `write` in Family. */
    priya: string;
    /** Sid: `read` in Family only. */
    sid: string;
    /** What each vault has installed — mutated by the auto-mount seam. */
    installed: Map<string, Set<string>>;
    /** Every (vaultId, appId) the auto-mount seam was asked to install. */
    ensured: Array<[string, string]>;
    get: (endpointId?: string, query?: string, hostCustody?: boolean) => Promise<Response>;
  }

  // Three mounted vaults, oldest first — the registry's own order.
  const VAULTS: ScopeVault[] = [
    {
      vaultId: 'vault-priya',
      name: 'Priya',
      color: '#b91c1c',
      icon: 'sparkle',
    },
    { vaultId: 'vault-family', name: 'Family' },
    { vaultId: 'vault-partner', name: 'Partner only' },
  ];

  async function harness(opts: { ensureFails?: boolean } = {}): Promise<Harness> {
    const root = await tempDir('scopes-routes-');
    dirs.push(root);
    const database = GatewayDatabase.open(root);
    databases.push(database);
    const enrollments = EnrollmentStore.open(database);

    const priya = enrollments.enroll({
      endpointId: 'priya-laptop',
      vaultId: 'vault-priya',
      role: 'admin',
      label: 'Priya laptop',
      memberLabel: 'Priya',
    });
    enrollments.members.setGrant(priya.memberId, 'vault-family', 'write');
    const sid = enrollments.enroll({
      endpointId: 'sid-phone',
      vaultId: 'vault-family',
      role: 'read',
      label: 'Sid phone',
      memberLabel: 'Sid',
    });

    const installed = new Map<string, Set<string>>([
      ['vault-priya', new Set(['notes'])],
      ['vault-family', new Set<string>()],
      ['vault-partner', new Set<string>()],
    ]);
    const ensured: Array<[string, string]> = [];

    const handler = makeScopesRouteHandler({
      enrollments,
      listVaults: () => VAULTS,
      installedApps: (vaultId) => installed.get(vaultId),
      ensureAppInstalled: async (vaultId, appId) => {
        ensured.push([vaultId, appId]);
        if (opts.ensureFails) throw new Error('install exploded');
        installed.get(vaultId)?.add(appId);
        return true;
      },
      isHostCustody: (req) => req.headers['x-test-host-custody'] === '1',
    });
    const server = http.createServer((req, res) => {
      void (async () => {
        if (!(await handler(req, res))) {
          res.statusCode = 404;
          res.end('{}');
        }
      })();
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}/centraid/_vault/scopes`;

    return {
      url: base,
      enrollments,
      priya: priya.memberId,
      sid: sid.memberId,
      installed,
      ensured,
      get: (endpointId, query, hostCustody = false) =>
        fetch(`${base}${query ?? ''}`, {
          headers: {
            ...(endpointId ? { [AUTHED_DEVICE_HEADER]: endpointId } : {}),
            ...(hostCustody ? { 'x-test-host-custody': '1' } : {}),
          },
        }),
    };
  }

  async function scopesOf(response: Response): Promise<ScopeRow[]> {
    return ((await response.json()) as { scopes: ScopeRow[] }).scopes;
  }

  // ---------------------------------------------------------------------------
  // What a member sees
  // ---------------------------------------------------------------------------

  test('a member sees exactly the vaults they hold a role in, in registry order', async () => {
    const f = await harness();

    const scopes = await scopesOf(await f.get('priya-laptop'));

    // Partner-only is mounted and invisible: absence, never a refusal.
    expect(scopes).toStrictEqual([
      {
        vaultId: 'vault-priya',
        label: 'Priya',
        color: '#b91c1c',
        icon: 'sparkle',
        role: 'admin',
      },
      { vaultId: 'vault-family', label: 'Family', role: 'write' },
    ]);
  });

  test('another member of the same household sees only their own row', async () => {
    const f = await harness();

    const scopes = await scopesOf(await f.get('sid-phone'));

    expect(scopes).toStrictEqual([{ vaultId: 'vault-family', label: 'Family', role: 'read' }]);
  });

  test('a grant on a vault this gateway does not mount is not a scope', async () => {
    const f = await harness();
    f.enrollments.members.setGrant(f.sid, 'vault-elsewhere', 'admin');

    const scopes = await scopesOf(await f.get('sid-phone'));

    expect(scopes.map((row) => row.vaultId)).toStrictEqual(['vault-family']);
  });

  test('host custody sees every mounted vault as admin', async () => {
    const f = await harness();

    const scopes = await scopesOf(await f.get(undefined, undefined, true));

    expect(scopes.map((row) => [row.vaultId, row.role])).toStrictEqual([
      ['vault-priya', 'admin'],
      ['vault-family', 'admin'],
      ['vault-partner', 'admin'],
    ]);
  });

  test('an unproved caller is refused before any vault is listed', async () => {
    const f = await harness();

    const response = await f.get();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'forbidden',
    });
  });

  test('a revoked device no longer resolves to its member', async () => {
    const f = await harness();
    f.enrollments.revoke('sid-phone');

    const response = await f.get('sid-phone');

    expect(response.status).toBe(403);
  });

  test('the scopes listing is a GET-only surface', async () => {
    const f = await harness();

    const response = await fetch(f.url, {
      method: 'POST',
      headers: { [AUTHED_DEVICE_HEADER]: 'priya-laptop' },
    });

    expect(response.status).toBe(405);
  });

  // ---------------------------------------------------------------------------
  // `installed`, and the app-follows-the-person auto-mount
  // ---------------------------------------------------------------------------

  test('with no app named, no installed flag is reported at all', async () => {
    const f = await harness();

    const scopes = await scopesOf(await f.get('priya-laptop'));

    expect(scopes.every((row) => row.installed === undefined)).toBe(true);
    expect(f.ensured).toStrictEqual([]);
  });

  test('an app already in one vault follows the member into the other', async () => {
    const f = await harness();

    const scopes = await scopesOf(await f.get('priya-laptop', '?app=notes'));

    expect(scopes).toStrictEqual([
      expect.objectContaining({ vaultId: 'vault-priya', installed: true }),
      expect.objectContaining({
        vaultId: 'vault-family',
        role: 'write',
        installed: true,
      }),
    ]);
    // Installed into the vault that was MISSING it, and only that one.
    expect(f.ensured).toStrictEqual([['vault-family', 'notes']]);
    expect([...f.installed.get('vault-family')!]).toStrictEqual(['notes']);
    // The vault the caller holds nothing in was never touched.
    expect([...f.installed.get('vault-partner')!]).toStrictEqual([]);
  });

  test('an app in none of the caller vaults is not auto-mounted anywhere', async () => {
    const f = await harness();

    const scopes = await scopesOf(await f.get('priya-laptop', '?app=tally'));

    expect(scopes.map((row) => row.installed)).toStrictEqual([false, false]);
    expect(f.ensured).toStrictEqual([]);
  });

  test('a failed auto-mount degrades to installed:false instead of a 500', async () => {
    const f = await harness({ ensureFails: true });

    const response = await f.get('priya-laptop', '?app=notes');

    expect(response.status).toBe(200);
    await expect(scopesOf(response)).resolves.toStrictEqual([
      expect.objectContaining({ vaultId: 'vault-priya', installed: true }),
      expect.objectContaining({ vaultId: 'vault-family', installed: false }),
    ]);
    expect(f.ensured).toStrictEqual([['vault-family', 'notes']]);
  });

  test('a second listing is idempotent — nothing is installed twice', async () => {
    const f = await harness();
    await f.get('priya-laptop', '?app=notes');

    const scopes = await scopesOf(await f.get('priya-laptop', '?app=notes'));

    expect(scopes.map((row) => row.installed)).toStrictEqual([true, true]);
    expect(f.ensured).toStrictEqual([['vault-family', 'notes']]);
  });
});
