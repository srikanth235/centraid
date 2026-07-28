import { handshakeGateway, ROUTES } from '@centraid/protocol';
import { endpointIdForSecret } from '@centraid/tunnel';

import { jsonFail, runJson, type Fail } from './json-cli.js';
import { daemonKeyStore } from './key-store.js';
import { landlordBearerForEndpointSecret } from './landlord-auth.js';
import { renderTerminalQr } from './pair-qr.js';
import { daemonLayoutFor } from './paths.js';
import { resolveDaemonConfig } from './resolve-config.js';

interface InitTicketArgs {
  dataDir?: string;
  configPath?: string;
  port?: number;
  json: boolean;
  qr: boolean;
}

function parseArgs(args: string[], fail: Fail): InitTicketArgs {
  const parsed: InitTicketArgs = { json: false, qr: false };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const take = (): string => {
      const value = args[++i];
      if (value === undefined) fail(`${flag} requires a value`, 2);
      return value;
    };
    if (flag === '--data-dir') parsed.dataDir = take();
    else if (flag === '--config') parsed.configPath = take();
    else if (flag === '--port') {
      const port = Number(take());
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        fail('--port must be an integer in [1, 65535]', 2);
      }
      parsed.port = port;
    } else if (flag === '--json') parsed.json = true;
    else if (flag === '--qr') parsed.qr = true;
    else fail(`unknown flag "${flag}"`, 2);
  }
  return parsed;
}

export async function commandInitTicket(
  args: string[],
  fail: Fail,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const json = args.includes('--json');
  const localFail: Fail = jsonFail(json, fail);
  await runJson(json, fail, async () => {
    const parsed = parseArgs(args, localFail);
    const config = await resolveDaemonConfig(
      { dataDir: parsed.dataDir, configPath: parsed.configPath },
      localFail,
    );
    const port = parsed.port ?? config.port;
    if (!port) localFail('daemon needs a fixed loopback port for init-ticket', 1);
    const baseUrl = `http://127.0.0.1:${port}`;
    // `endpointTicket` is auth-gated on `/_gateway/info` (#568 item C). Load the
    // host-custody key first so the readiness handshake can present the landlord
    // bearer; an anonymous GET would look like "endpoint not ready" forever.
    const secret = daemonKeyStore(daemonLayoutFor(config.dataDir).keysDir).load('endpoint-key.bin');
    if (!secret) {
      localFail('daemon endpoint identity is not ready or belongs to another data directory', 1);
    }
    const landlordBearer = landlordBearerForEndpointSecret(secret);
    const handshake = await handshakeGateway(baseUrl, landlordBearer, fetchImpl);
    if (!handshake.ok) {
      localFail(`daemon not running at ${baseUrl} — start it before minting a founding ticket`, 1);
    }
    if (
      handshake.info.endpointId !== endpointIdForSecret(secret) ||
      handshake.info.endpointTicket === undefined
    ) {
      localFail('daemon endpoint identity is not ready or belongs to another data directory', 1);
    }
    const response = await fetchImpl(`${baseUrl}${ROUTES.gatewayFoundingTicket}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${landlordBearer}`,
      },
    }).catch(() => localFail('daemon stopped before it could mint the founding ticket', 1));
    const body = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      ticket?: string;
      expiresAt?: string;
      message?: string;
    };
    if (
      !response.ok ||
      body.ok !== true ||
      typeof body.ticket !== 'string' ||
      typeof body.expiresAt !== 'string'
    ) {
      localFail(body.message ?? `daemon refused founding ticket (HTTP ${response.status})`, 1);
    }
    const ticket = body.ticket;
    const expiresAt = body.expiresAt;
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: true, ticket, expiresAt })}\n`);
      return;
    }
    const lines = [
      'One-time gateway founding ticket',
      `Expires: ${expiresAt}`,
      '',
      ticket,
      '',
      'Open Centraid on the first device and choose Create or Restore.',
    ];
    if (parsed.qr) lines.push('', (await renderTerminalQr(ticket)).trimEnd());
    process.stdout.write(`${lines.join('\n')}\n`);
  });
}
