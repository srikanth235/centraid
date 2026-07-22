#!/usr/bin/env node
/*
 * `centraid` — product CLI over the gateway wire protocol (issue #504 batch 3).
 *
 * Auth: --token | CENTRAID_TOKEN | --data-dir → token.bin
 * Streaming verbs are deferred (documented below and in README).
 */

import { resolveToken } from './auth.js';
import { getHealth, getInfo, handshake, listApps } from './client.js';

const PKG_VERSION = '0.1.0';

function fail(message: string, code = 1): never {
  process.stderr.write(`centraid: ${message}\n`);
  process.exit(code);
}

function usage(): never {
  process.stderr.write(
    [
      'Usage:',
      '  centraid status  --url <gateway> [--token <t> | --data-dir <path>] [--json]',
      '  centraid health  --url <gateway> [--token <t> | --data-dir <path>] [--json]',
      '  centraid info    --url <gateway> [--token <t> | --data-dir <path>] [--json]',
      '  centraid list    --url <gateway> [--token <t> | --data-dir <path>] [--json]',
      '  centraid --help',
      '  centraid --version',
      '',
      'Auth (first match wins): --token, CENTRAID_TOKEN, <data-dir>/token.bin.',
      'Streaming attach/SSE is deferred — track under issue #504 (batch 3 stream follow-up).',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

interface GlobalFlags {
  url?: string;
  token?: string;
  dataDir?: string;
  json: boolean;
  rest: string[];
}

function parseArgs(argv: string[]): GlobalFlags {
  const out: GlobalFlags = { json: false, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--json') out.json = true;
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--data-dir') out.dataDir = argv[++i];
    else if (a === '--help' || a === '-h') usage();
    else if (a === '--version' || a === '-V') {
      process.stdout.write(`${PKG_VERSION}\n`);
      process.exit(0);
    } else out.rest.push(a);
  }
  return out;
}

function print(value: unknown, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value)}\n`);
    return;
  }
  if (typeof value === 'string') {
    process.stdout.write(`${value}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const flags = parseArgs(argv);
  const command = flags.rest[0];
  if (!command) usage();

  if (!flags.url) fail('--url is required (gateway base URL, e.g. http://127.0.0.1:8787)', 2);
  const token = await resolveToken({
    token: flags.token,
    dataDir: flags.dataDir,
  });
  const client = { baseUrl: flags.url, token };

  switch (command) {
    case 'status':
    case 'info': {
      const result = await handshake(client);
      if (!result.ok) fail(`${result.reason}: ${result.detail}`);
      print(
        {
          ok: true,
          version: result.info.version,
          schemaEpoch: result.info.schemaEpoch,
          instanceId: result.info.instanceId,
          capabilities: result.info.capabilities,
        },
        flags.json,
      );
      return;
    }
    case 'health': {
      const { status, body } = await getHealth(client);
      if (status < 200 || status >= 300) fail(`health HTTP ${status}`, 1);
      print(body ?? { ok: true, status }, flags.json);
      return;
    }
    case 'list': {
      const { status, body } = await listApps(client);
      if (status === 401) fail('unauthorized — check --token / token.bin', 1);
      if (status < 200 || status >= 300) fail(`list HTTP ${status}`, 1);
      print(body, flags.json);
      return;
    }
    case 'help':
      usage();
      break;
    default:
      fail(`unknown command '${command}'`, 2);
  }

  // silence unused in some paths
  void getInfo;
}

// Always run when executed as the process entry (bin / bun / node).
const entry = process.argv[1] ?? '';
if (entry.endsWith('cli.js') || entry.endsWith('cli.ts') || entry.endsWith('/cli')) {
  main().catch((err) => {
    fail(err instanceof Error ? err.message : String(err));
  });
}
