import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, expect, test } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { commandLockStatus } from '../cli/lock-admin.js';
import { GatewayDatabase, GatewayLockError } from './gateway-db.js';

const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  while (roots.length > 0) await fs.rm(roots.pop()!, { recursive: true, force: true });
});

async function waitForReady(child: ChildProcess): Promise<void> {
  const stdout = child.stdout;
  if (!stdout) throw new Error('lock holder has no stdout');
  let output = '';
  let errors = '';
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`lock holder timed out: ${output}`)), 10_000);
    stdout.setEncoding('utf8');
    stdout.on('data', (chunk: string) => {
      output += chunk;
      if (!output.includes('LOCK_READY')) return;
      clearTimeout(timeout);
      resolve();
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      errors += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`lock holder exited before ready (${code ?? signal}): ${output}${errors}`));
    });
  });
}

async function capture(run: () => Promise<void>): Promise<string> {
  const original = process.stdout.write;
  const chunks: string[] = [];
  process.stdout.write = ((chunk: unknown): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await run();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

test('SIGKILL releases gateway.db immediately and sqlite3 reads during restart recovery', async () => {
  const dataDir = await tempDir('gateway-sigkill-lock-');
  roots.push(dataDir);
  const script = [
    `import { DatabaseSync } from 'node:sqlite';`,
    `import path from 'node:path';`,
    `const db = new DatabaseSync(path.join(${JSON.stringify(dataDir)}, 'gateway.db'), { timeout: 0 });`,
    `db.exec("CREATE TABLE IF NOT EXISTS gateway_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;");`,
    `db.prepare('PRAGMA locking_mode = EXCLUSIVE').get();`,
    `db.exec("BEGIN EXCLUSIVE; INSERT INTO gateway_meta (key, value) VALUES ('schema', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value; COMMIT;");`,
    `process.stdout.write('LOCK_READY\\n');`,
    `setInterval(() => {}, 60_000);`,
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  await waitForReady(child);

  expect(() => GatewayDatabase.open(dataDir, { lock: 'exclusive' })).toThrow(GatewayLockError);
  const wedged = JSON.parse(
    await capture(() =>
      commandLockStatus(
        ['--data-dir', dataDir, '--json'],
        (message): never => {
          throw new Error(message);
        },
        (async () => Response.json({ error: 'wedged' }, { status: 503 })) as typeof fetch,
      ),
    ),
  ) as Record<string, unknown>;
  expect(wedged).toMatchObject({
    held: true,
    answering: false,
    holderPid: child.pid,
  });
  expect(wedged.detail).toMatch(/held but the daemon is not answering.*OS holder pid/i);

  child.kill('SIGKILL');
  await once(child, 'exit');

  const restarted = GatewayDatabase.open(dataDir, { lock: 'exclusive' });
  restarted.close();
  const sqlite = spawnSync(
    'sqlite3',
    [path.join(dataDir, 'gateway.db'), "SELECT value FROM gateway_meta WHERE key='schema';"],
    { encoding: 'utf8' },
  );
  expect(sqlite.status, sqlite.stderr).toBe(0);
  expect(sqlite.stdout.trim()).toBe('1');
});
