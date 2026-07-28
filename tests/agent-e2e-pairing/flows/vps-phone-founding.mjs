// The zero-vault VPS → first-phone ceremony, every boundary in its real
// process. See the adjacent .md for the acceptance contract.
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { runFlow } from '../lib/harness.mjs';

function parseFoundingTicket(raw) {
  const payload = JSON.parse(Buffer.from(raw.trim(), 'base64url').toString('utf8'));
  if (payload.v !== 1 || payload.kind !== 'centraid-gw-found') {
    throw new Error(`not a Centraid founding ticket: ${raw.slice(0, 40)}…`);
  }
  return payload;
}

await runFlow(
  'vps-phone-founding',
  async (ctx) => {
    // 1. A genuinely empty daemon can mint a single possession-bound grant
    // through the host-only CLI. No automatic vault exists.
    const initOutput = await ctx.cli(['init-ticket', '--json']);
    const init = JSON.parse(initOutput.stdout.trim().split('\n').at(-1));
    if (init.ok !== true || typeof init.ticket !== 'string') {
      throw new Error(`init-ticket returned no founding grant: ${initOutput.stdout}`);
    }
    const ticket = parseFoundingTicket(init.ticket);
    if (ticket.exp <= Date.now() || !ticket.gw || !ticket.t || !ticket.s) {
      throw new Error('founding ticket is expired or incomplete');
    }
    ctx.note(`host minted one founding grant expiring ${new Date(ticket.exp).toISOString()}`);

    // 2. A never-seen phone proves its iroh identity and sees the zero-vault
    // state before creating anything.
    const phone = await ctx.newDevice();
    const admitted = await ctx.authorizeProbe(phone.endpointId);
    if (admitted.response.status !== 200 || admitted.json.allowed !== true) {
      throw new Error(`founding transport authorization failed: ${JSON.stringify(admitted.json)}`);
    }
    const before = await ctx.requestJson(phone, 'GET', '/centraid/_gateway/info');
    if (
      before.response.status !== 200 ||
      before.json.status !== 'uninitialized' ||
      before.json.endpointId !== ctx.gateway.endpointId
    ) {
      throw new Error(`fresh gateway status was wrong: ${JSON.stringify(before.json)}`);
    }
    ctx.note('fresh phone reached the live uninitialized gateway over iroh');

    // 3. The phone consumes the founding grant, creates exactly one vault,
    // and becomes its owner. The wrapped kit is the only recovery secret that
    // crosses this boundary.
    const password = 'agent-e2e correct horse battery staple';
    const initialized = await ctx.requestJson(phone, 'POST', '/centraid/_vault/vaults:initialize', {
      ticket: init.ticket,
      name: 'Phone founded',
      password,
      deviceName: 'agent-e2e first phone',
      platform: 'agent-e2e-phone',
    });
    if (
      initialized.response.status !== 201 ||
      initialized.json?.vault?.name !== 'Phone founded' ||
      initialized.json?.enrollment?.trust !== 'owner'
    ) {
      throw new Error(`phone founding failed: ${JSON.stringify(initialized.json)}`);
    }
    const vaultId = initialized.json.vault.vaultId;
    ctx.note(`phone created vault ${vaultId} and became its owner`);

    const enrolledAdmission = await ctx.authorizeProbe(phone.endpointId);
    if (enrolledAdmission.response.status !== 200 || enrolledAdmission.json.allowed !== true) {
      throw new Error(
        `owner transport authorization failed: ${JSON.stringify(enrolledAdmission.json)}`,
      );
    }

    // 4. Simulate the phone share-sheet boundary: export the wrapped JSON out
    // of the gateway data dir, then re-select and parse that exact artifact.
    const sharedKitPath = path.join(ctx.state.workspace, 'phone-shared-recovery-kit.json');
    await fs.writeFile(sharedKitPath, `${JSON.stringify(initialized.json.kit, null, 2)}\n`, {
      mode: 0o600,
    });
    const selectedKit = JSON.parse(await fs.readFile(sharedKitPath, 'utf8'));
    if (JSON.stringify(selectedKit) !== JSON.stringify(initialized.json.kit)) {
      throw new Error('re-selected recovery kit differs from the phone-exported artifact');
    }

    // 5. The ceremony remains blocked until that selected file and its
    // password decrypt to the exact fingerprint the gateway just issued.
    const verified = await ctx.requestJson(
      phone,
      'POST',
      '/centraid/_vault/vaults:initialize/verify',
      { kit: selectedKit, password, lossConsent: true },
    );
    if (
      verified.response.status !== 200 ||
      verified.json?.vaultId !== vaultId ||
      verified.json?.fingerprint !== initialized.json.fingerprint
    ) {
      throw new Error(`recovery-kit verification failed: ${JSON.stringify(verified.json)}`);
    }

    const ready = await ctx.requestJson(phone, 'GET', '/centraid/_gateway/info');
    if (ready.response.status !== 200 || ready.json.status !== 'ready') {
      throw new Error(`verified gateway did not become ready: ${JSON.stringify(ready.json)}`);
    }
    const roster = await ctx.requestJson(phone, 'GET', '/centraid/_gateway/devices');
    const owner = roster.json?.devices?.find(
      (row) =>
        row.endpointId === phone.endpointId && row.vaultId === vaultId && row.trust === 'owner',
    );
    if (!owner) throw new Error('first phone is not the durable owner enrollment');
    ctx.note('phone-created vault, owner enrollment, and exact wrapped-kit verification persisted');

    // 6. The stable host identity and phone access survive a process restart.
    const endpointBefore = ctx.gateway.endpointId;
    await ctx.restartGateway();
    if (ctx.gateway.endpointId !== endpointBefore) {
      throw new Error('gateway EndpointId changed after the founding restart');
    }
    const after = await ctx.requestJson(phone, 'GET', '/centraid/_gateway/info');
    if (after.response.status !== 200 || after.json.status !== 'ready') {
      throw new Error(`phone lost founded gateway after restart: ${JSON.stringify(after.json)}`);
    }

    // With no active founding grant, a second unknown device is rejected at
    // the transport boundary.
    const stranger = await ctx.newDevice();
    await ctx.expectTunnelRefused(stranger);
    ctx.note('restart retained EndpointId and owner; unknown second device was refused');

    return {
      pass: true,
      notes:
        'empty VPS → host init-ticket → first phone creates vault/owner → shares and re-selects wrapped kit → verifies → restart persists',
    };
  },
  { fresh: true },
);
