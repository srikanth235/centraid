/*
 * Host-possession authentication for the gateway's founding/control lane.
 *
 * The daemon never persists a reusable HTTP token. Instead, the loopback
 * bearer is derived from the gateway endpoint secret, which is already under
 * KeyStore custody. A local CLI that can open that custody store can derive
 * the same bearer; a browser page, an enrolled remote peer, and a copied
 * desktop data directory cannot.
 */

import { createHmac } from 'node:crypto';

const LANDLORD_BEARER_CONTEXT = 'centraid/landlord-http/v1';

export function landlordBearerForEndpointSecret(secret: Uint8Array): string {
  return createHmac('sha256', Buffer.from(secret))
    .update(LANDLORD_BEARER_CONTEXT, 'utf8')
    .digest('hex');
}
