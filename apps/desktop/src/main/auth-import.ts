// Status reporter for locally-installed coding-agent CLIs.
//
// Originally this module imported Claude Code / Codex OAuth credentials
// into pi-coding-agent's auth.json so pi could use the user's existing
// subscription without a second OAuth dance. Now that pi is gone and the
// builder + chat both drive turns through `@centraid/local-chat-runner`
// (codex app-server / Claude SDK), no translation is needed:
//
//   - codex app-server reads `~/.codex/auth.json` directly; the user runs
//     `codex login` once and we never touch the file.
//   - Claude Agent SDK reads `ANTHROPIC_API_KEY` from the environment;
//     there's no in-process flow that consumes the Claude Code keychain
//     OAuth token, so the import step is intentionally a no-op.
//
// What survives: a status read the Settings UI uses to tell the user
// which CLIs / keys are already on this machine. The `importAvailableCreds`
// entry point is kept for IPC compat so the renderer's "Resync" button
// still wires up — it just returns the latest availability snapshot.

import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CODEX_AUTH_FILE = path.join(os.homedir(), '.codex', 'auth.json');

export interface AuthStatus {
  /** `~/.codex/auth.json` exists (i.e. `codex login` has run). */
  codexAvailable: boolean;
  /** Claude Code keychain entry exists (macOS only). Informational —
   *  the Claude SDK uses `ANTHROPIC_API_KEY`, not the OAuth token. */
  claudeAvailable: boolean;
  /** `ANTHROPIC_API_KEY` is set in the main-process environment. */
  anthropicApiKeyAvailable: boolean;
}

export interface AuthImportResult {
  /** Always false today — the runtime reads creds in-place; nothing is imported. */
  importedCodex: false;
  importedClaude: false;
  status: AuthStatus;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

async function probeClaudeKeychain(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  // Listing the metadata is silent; reading the value (`-w`) would prompt
  // the user. We only need a boolean here.
  return execAsync(`security find-generic-password -s ${shellQuote(KEYCHAIN_SERVICE)}`)
    .then(() => true)
    .catch(() => false);
}

async function probeCodexAuth(): Promise<boolean> {
  return fs
    .access(CODEX_AUTH_FILE)
    .then(() => true)
    .catch(() => false);
}

export async function readAuthStatus(): Promise<AuthStatus> {
  const [codexAvailable, claudeAvailable] = await Promise.all([
    probeCodexAuth(),
    probeClaudeKeychain(),
  ]);
  return {
    codexAvailable,
    claudeAvailable,
    anthropicApiKeyAvailable:
      typeof process.env.ANTHROPIC_API_KEY === 'string' && process.env.ANTHROPIC_API_KEY.length > 0,
  };
}

/**
 * No-op kept for IPC compatibility. The Settings UI's "Resync" button
 * still calls this; it now just re-reads the status snapshot. `overwrite`
 * is accepted but ignored — there's nothing to overwrite.
 */
export async function importAvailableCreds(
  _opts: { overwrite?: boolean } = {},
): Promise<AuthImportResult> {
  return {
    importedCodex: false,
    importedClaude: false,
    status: await readAuthStatus(),
  };
}
