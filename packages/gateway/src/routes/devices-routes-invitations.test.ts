/*
 * Invitation minting on `POST /centraid/_gateway/devices/ticket` (issue #599).
 *
 * Minting splits by TARGET, not by role: self-pair is open to any member at
 * their own roles, inviting another person is an ownership act, and one
 * ticket may carry several vaults at distinct roles.
 */

import { afterEach, expect, test } from 'vitest';
import { parsePairingTicket } from '../serve/pairing-store.js';
import { cleanupHarnesses, deviceHeaders, harness } from './devices-routes.test-fixtures.js';

afterEach(cleanupHarnesses);

test('minting splits by target: self-pair is open, inviting is an ownership act', async () => {
  const f = await harness();
  f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-a',
    label: 'Owner',
    role: 'admin',
    memberLabel: 'Priya',
  });
  const writer = f.enrollments.enroll({
    endpointId: 'full-key',
    vaultId: 'vault-a',
    label: 'Member',
    role: 'write',
    memberLabel: 'Sid',
  });
  const body = JSON.stringify({ vaultId: 'vault-a' });
  const anonymous = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    body,
  });
  expect(anonymous.status).toBe(403);

  // Self-pair: a `write` member pairs their OWN new phone with no owner
  // involvement — "ask your spouse for a QR" fails the family test.
  const selfPair = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: deviceHeaders('full-key'),
    body,
  });
  expect(selfPair.status).toBe(200);
  expect(await selfPair.json()).toMatchObject({ memberId: writer.memberId, role: 'write' });

  // …but never above their own role.
  const escalated = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: deviceHeaders('full-key'),
    body: JSON.stringify({ grants: [{ vaultId: 'vault-a', role: 'admin' }] }),
  });
  expect(escalated.status).toBe(403);
  expect(await escalated.json()).toMatchObject({ error: 'role_above_own' });

  // …and never for another person.
  const denied = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: deviceHeaders('full-key'),
    body: JSON.stringify({ vaultId: 'vault-a', newMemberLabel: 'Kid' }),
  });
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ error: 'not_admin' });

  const minted = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: deviceHeaders('owner-key'),
    body,
  });
  expect(minted.status).toBe(200);
  const payload = (await minted.json()) as { ticket: string };
  const parsed = parsePairingTicket(payload.ticket);
  expect(parsed).toBeDefined();
  if (!parsed) throw new Error('ticket did not parse');
  expect(parsed.gw).toBe('endpoint-ticket');
  // Self-pair bakes the member's CURRENT roles, so the owner's second device
  // lands at admin without anyone having to name a role.
  expect(f.tickets.redeem(parsed.t, parsed.s)).toMatchObject({
    grants: [{ vaultId: 'vault-a', role: 'admin' }],
  });
});

test('an owner may delegate owner role — a second admin device is grantable', async () => {
  const f = await harness();
  f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-a',
    label: 'Owner',
    role: 'admin',
  });

  const minted = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: deviceHeaders('owner-key'),
    body: JSON.stringify({ vaultId: 'vault-a', role: 'admin' }),
  });
  expect(minted.status).toBe(200);
  const payload = (await minted.json()) as { ticket: string; role: string };
  expect(payload.role).toBe('admin');
  const parsed = parsePairingTicket(payload.ticket);
  if (!parsed) throw new Error('ticket did not parse');
  expect(f.tickets.redeem(parsed.t, parsed.s)).toMatchObject({
    grants: [{ vaultId: 'vault-a', role: 'admin' }],
  });

  const nonsense = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: deviceHeaders('owner-key'),
    body: JSON.stringify({ vaultId: 'vault-a', role: 'superuser' }),
  });
  expect(nonsense.status).toBe(400);
  expect(await nonsense.json()).toMatchObject({ error: 'invalid_role' });
});

test('an owner invites a new person into two vaults with one ticket', async () => {
  const f = await harness({
    vaultName: (id) => ({ 'vault-a': 'Personal', 'vault-b': 'Family' })[id],
  });
  const owner = f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-a',
    label: 'Owner',
    role: 'admin',
    memberLabel: 'Priya',
  });
  f.enrollments.members.setGrant(owner.memberId, 'vault-b', 'admin');

  const minted = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: deviceHeaders('owner-key'),
    body: JSON.stringify({
      newMemberLabel: 'Kid',
      grants: [
        { vaultId: 'vault-b', role: 'write' },
        { vaultId: 'vault-a', role: 'read' },
      ],
    }),
  });
  expect(minted.status).toBe(200);
  const payload = (await minted.json()) as {
    ticket: string;
    memberId: string;
    memberLabel: string;
  };
  expect(payload.memberLabel).toBe('Kid');

  // One scan enrols the joining device into BOTH vaults, at the distinct
  // roles the invitation named, bound to the invited member.
  const parsed = parsePairingTicket(payload.ticket);
  if (!parsed) throw new Error('ticket did not parse');
  const enrolled = f.tickets.redeemAndEnroll(parsed.t, parsed.s, f.enrollments, {
    endpointId: 'kid-phone',
    label: 'Kid phone',
  });
  expect(enrolled?.map((row) => ({ vaultId: row.vaultId, role: row.role }))).toEqual([
    { vaultId: 'vault-a', role: 'read' },
    { vaultId: 'vault-b', role: 'write' },
  ]);
  expect(enrolled?.every((row) => row.memberId === payload.memberId)).toBe(true);

  // A vault the owner does not administer cannot be granted away.
  const outside = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: deviceHeaders('owner-key'),
    body: JSON.stringify({
      memberId: payload.memberId,
      grants: [{ vaultId: 'vault-c', role: 'read' }],
    }),
  });
  expect(outside.status).toBe(404);
});

test('minting a ticket with no resolvable vault answers vault_required', async () => {
  const f = await harness();
  // Enrolled in a vault the handler's `vaultName` does not know, and no
  // explicit target — nothing to scope the ticket to.
  f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-b',
    label: 'Owner',
    role: 'admin',
  });
  const anonymousVault = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: deviceHeaders('owner-key'),
    body: JSON.stringify({}),
  });
  expect(anonymousVault.status).toBe(404);

  const noVaults = await harness();
  noVaults.enrollments.enroll({
    endpointId: 'lonely-key',
    vaultId: 'vault-a',
    label: 'Owner',
    role: 'admin',
  });
  const unknownTarget = await fetch(`${noVaults.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: deviceHeaders('lonely-key'),
    body: JSON.stringify({ vaultId: 'no-such-vault' }),
  });
  expect(unknownTarget.status).toBe(400);
  expect(await unknownTarget.json()).toMatchObject({ error: 'vault_required' });
});

test('a gateway with no iroh endpoint refuses to mint a dud ticket', async () => {
  const f = await harness({ endpointTicket: () => undefined });
  f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-a',
    label: 'Owner',
    role: 'admin',
  });
  const response = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: deviceHeaders('owner-key'),
    body: JSON.stringify({ vaultId: 'vault-a' }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: 'no_iroh_endpoint' });
});

test('a pre-founding gateway refuses ordinary pairing with uninitialized', async () => {
  const f = await harness({ isUninitialized: () => true });
  f.enrollments.enroll({
    endpointId: 'owner-key',
    vaultId: 'vault-a',
    label: 'Owner',
    role: 'admin',
  });
  const response = await fetch(`${f.base}/centraid/_gateway/devices/ticket`, {
    method: 'POST',
    headers: deviceHeaders('owner-key'),
    body: JSON.stringify({ vaultId: 'vault-a' }),
  });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: 'uninitialized' });
});
