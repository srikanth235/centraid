import { createHmac } from 'node:crypto';

/**
 * Stable direct-host identity for the explicitly KIT-LESS `--init-vault`
 * escape hatch. It is enrolled only into the vault that invocation creates;
 * normal founding and subsequent vault creation never inherit it.
 */
export function kitlessHostIdentity(endpointSecret: Uint8Array): string {
  return `host:${createHmac('sha256', Buffer.from(endpointSecret))
    .update('centraid-kitless-host-v1')
    .digest('hex')}`;
}
