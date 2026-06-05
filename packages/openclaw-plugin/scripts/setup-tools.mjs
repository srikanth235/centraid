#!/usr/bin/env node
/*
 * setup-tools.mjs
 *
 * Idempotently patches `~/.openclaw/openclaw.json` so the centraid plugin's
 * three agent tools (`centraid_describe`, `centraid_read`,
 * `centraid_write`) are merged into `tools.alsoAllow`. `alsoAllow` is
 * the documented additive form — it does not replace the active profile,
 * so the user's existing tool baseline survives.
 *
 * Load-bearing for the per-app conversation endpoint: the OpenClaw
 * conversation runner passes a `toolsAllow` allowlist of just the three
 * centraid tools, but that allowlist is intersected with the resolved
 * agent's effective policy — so the tools must clear that gate first.
 * Without this script's patch, turns would see an empty tool set.
 *
 * No-op when all ids are already in the list. Atomic write via tmpfile +
 * rename.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOOLS = ['centraid_describe', 'centraid_read', 'centraid_write'];

const stateDir = process.env.OPENCLAW_STATE_DIR ?? path.join(os.homedir(), '.openclaw');
const configPath = path.join(stateDir, 'openclaw.json');

async function main() {
  let raw;
  try {
    raw = await fs.readFile(configPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      console.error(`No openclaw config at ${configPath}. Run \`openclaw onboard\` first.`);
      process.exit(1);
    }
    throw err;
  }

  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to parse ${configPath} as JSON: ${err.message}`);
    process.exit(1);
  }

  const tools = (config.tools ??= {});
  const existing = Array.isArray(tools.alsoAllow) ? tools.alsoAllow : [];
  const merged = [...existing];
  let added = 0;
  for (const id of TOOLS) {
    if (!merged.includes(id)) {
      merged.push(id);
      added += 1;
    }
  }
  if (added === 0) {
    process.stdout.write(
      'centraid tools already in tools.alsoAllow — nothing to do.\n' +
        "(the centraid conversation endpoint uses these via runEmbeddedAgent's toolsAllow allowlist.)\n",
    );
    return;
  }
  tools.alsoAllow = merged;

  const tmp = `${configPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, configPath);
  process.stdout.write(
    `Added ${added} centraid tool id(s) to tools.alsoAllow in ${configPath}.\n` +
      "(These are intersected with the resolved agent's effective policy at run time,\n" +
      " so the conversation endpoint's allowlist actually surfaces them.)\n" +
      'Restart the gateway: `openclaw gateway restart`\n',
  );
}

main().catch((err) => {
  process.stderr.write(`${err?.stack ?? err}\n`);
  process.exit(1);
});
