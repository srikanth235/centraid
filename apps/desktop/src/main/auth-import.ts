// Imports Claude Code / Codex OAuth credentials that already live on the
// machine into pi's auth store (`~/.pi/agent/auth.json`), so the coding
// agent can use the user's existing subscription without a second OAuth
// dance.
//
// Why this is safe: pi-ai (the model layer pi uses) ships first-party
// OAuth providers for both Anthropic (`anthropic`) and Codex
// (`openai-codex`). When it sees an OAuth access token it injects the
// Claude Code-style request fingerprint (`anthropic-beta:
// claude-code-20250219,oauth-2025-04-20` + `user-agent: claude-cli/...`),
// so requests are wire-indistinguishable from the apps that minted the
// tokens. Refreshes hit the same endpoints Claude Code / Codex use.
//
// Codex is preferred when both subscriptions are present (per product
// direction): we only register the Anthropic slot when no Codex creds
// exist, so the coding agent's default model lookup picks Codex.

import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

const PI_AUTH_DIR_ENV = 'PI_CODING_AGENT_DIR';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CODEX_AUTH_FILE = path.join(os.homedir(), '.codex', 'auth.json');

interface PiOAuthCredential {
  type: 'oauth';
  access: string;
  refresh: string;
  expires: number;
  /** Codex carries `accountId`; Claude carries `subscriptionType`. */
  [extra: string]: unknown;
}

type PiAuthFile = Record<string, { type: 'api_key' | 'oauth'; [extra: string]: unknown }>;

export type AuthSource = 'codex' | 'claude-code' | 'pi';

export interface ProviderStatus {
  /** `pi` = present in pi's auth.json. The other values describe the on-disk
   * source we'd import from if we synced now. */
  source: AuthSource;
  /** Unix-ms expiry of the access token, when known. */
  expires?: number;
  /** Codex-only: the ChatGPT account id baked into the token. */
  accountId?: string;
  /** Claude Code-only: `pro` / `max` / etc. */
  subscriptionType?: string;
}

export interface AuthStatus {
  /** Whether Codex creds exist on this machine (regardless of pi's state). */
  codexAvailable: boolean;
  /** Whether the Claude Code keychain entry exists (macOS only). */
  claudeAvailable: boolean;
  /** Per-provider snapshot from pi's auth.json. Missing → not connected. */
  providers: Partial<Record<'openai-codex' | 'anthropic', ProviderStatus>>;
}

export interface AuthImportResult {
  importedCodex: boolean;
  importedClaude: boolean;
  /** Which provider pi will prefer (Codex when both are present). */
  preferred?: 'openai-codex' | 'anthropic';
  status: AuthStatus;
}

function piAuthPath(): string {
  const envDir = process.env[PI_AUTH_DIR_ENV];
  if (envDir) {
    const expanded = envDir.startsWith('~') ? path.join(os.homedir(), envDir.slice(1)) : envDir;
    return path.join(expanded, 'auth.json');
  }
  return path.join(os.homedir(), '.pi', 'agent', 'auth.json');
}

function decodeJwtExpiryMs(jwt: string): number | undefined {
  // Best-effort: read the `exp` claim from a non-encrypted JWT. Returns
  // milliseconds since epoch, or undefined if anything looks off. We never
  // verify the signature — this is purely to fill in `expires` when the
  // source file/keychain didn't carry it explicitly.
  try {
    const parts = jwt.split('.');
    if (parts.length < 2) return undefined;
    const payload = parts[1];
    if (!payload) return undefined;
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = Buffer.from(base64, 'base64').toString('utf8');
    const obj = JSON.parse(json) as { exp?: unknown };
    if (typeof obj.exp === 'number') return obj.exp * 1000;
  } catch {
    /* swallow — fall through to undefined */
  }
  return undefined;
}

async function readClaudeCodeCreds(): Promise<PiOAuthCredential | null> {
  if (process.platform !== 'darwin') return null;
  const account = os.userInfo().username;
  // `-w` prints the password value to stdout. The first invocation surfaces
  // a system "Always Allow" dialog; subsequent calls are silent. We don't
  // catch the EACCES specially — if the user denies, we just report no
  // creds and move on, same as a missing entry.
  const cmd = `security find-generic-password -s ${shellQuote(KEYCHAIN_SERVICE)} -a ${shellQuote(account)} -w`;
  try {
    const { stdout } = await execAsync(cmd, { encoding: 'utf8' });
    const parsed = JSON.parse(stdout.trim()) as {
      claudeAiOauth?: {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
        subscriptionType?: string;
      };
    };
    const oauth = parsed?.claudeAiOauth;
    if (!oauth?.accessToken || !oauth?.refreshToken) return null;
    const expires =
      typeof oauth.expiresAt === 'number'
        ? oauth.expiresAt
        : (decodeJwtExpiryMs(oauth.accessToken) ?? Date.now() + 3600_000);
    const cred: PiOAuthCredential = {
      type: 'oauth',
      access: oauth.accessToken,
      refresh: oauth.refreshToken,
      expires,
    };
    if (typeof oauth.subscriptionType === 'string') {
      cred.subscriptionType = oauth.subscriptionType;
    }
    return cred;
  } catch {
    return null;
  }
}

async function readCodexCreds(): Promise<PiOAuthCredential | null> {
  try {
    const raw = await fs.readFile(CODEX_AUTH_FILE, 'utf8');
    const parsed = JSON.parse(raw) as {
      tokens?: {
        access_token?: string;
        refresh_token?: string;
        account_id?: string;
      };
      OPENAI_API_KEY?: string | null;
    };
    const tokens = parsed?.tokens;
    if (!tokens?.access_token || !tokens?.refresh_token) return null;
    // Codex's auth.json doesn't store `expires` directly — derive it from
    // the access token's `exp` claim. Fall back to 28 days, matching
    // ChatGPT subscription token lifetimes.
    const expires = decodeJwtExpiryMs(tokens.access_token) ?? Date.now() + 28 * 86_400_000;
    const cred: PiOAuthCredential = {
      type: 'oauth',
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires,
    };
    if (typeof tokens.account_id === 'string') {
      cred.accountId = tokens.account_id;
    }
    return cred;
  } catch {
    return null;
  }
}

async function readPiAuthFile(): Promise<PiAuthFile> {
  try {
    const raw = await fs.readFile(piAuthPath(), 'utf8');
    return JSON.parse(raw) as PiAuthFile;
  } catch {
    return {};
  }
}

async function writePiAuthFile(data: PiAuthFile): Promise<void> {
  const filePath = piAuthPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  // Atomic replace — write to a temp file and rename. pi uses a file lock
  // on auth.json; a rename keeps the inode swap atomic so concurrent pi
  // refreshers won't read a half-written file.
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  await fs.rename(tmp, filePath);
}

function shellQuote(s: string): string {
  // `security` runs under /bin/sh via util.promisify(exec); single-quote
  // and escape any embedded single quotes. The values we pass are a
  // hard-coded service name and the OS username, so this is belt-and-
  // suspenders rather than load-bearing security, but worth doing anyway.
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function statusFromCreds(
  codex: PiOAuthCredential | null,
  claude: PiOAuthCredential | null,
  pi: PiAuthFile,
): AuthStatus {
  const out: AuthStatus = {
    codexAvailable: !!codex,
    claudeAvailable: !!claude,
    providers: {},
  };
  const cdx = pi['openai-codex'];
  if (cdx?.type === 'oauth') {
    const status: ProviderStatus = { source: 'pi' };
    if (typeof cdx.expires === 'number') status.expires = cdx.expires;
    if (typeof cdx.accountId === 'string') status.accountId = cdx.accountId;
    out.providers['openai-codex'] = status;
  }
  const ant = pi['anthropic'];
  if (ant?.type === 'oauth') {
    const status: ProviderStatus = { source: 'pi' };
    if (typeof ant.expires === 'number') status.expires = ant.expires;
    if (typeof ant.subscriptionType === 'string') {
      status.subscriptionType = ant.subscriptionType;
    }
    out.providers['anthropic'] = status;
  }
  return out;
}

/**
 * Read pi's auth.json and the source files / keychain entry, return a
 * status snapshot for the Settings UI. No side effects; no secrets.
 */
export async function readAuthStatus(): Promise<AuthStatus> {
  // For "available?" we don't need to invoke `security -w` (which prompts).
  // Listing the entry's metadata is silent and tells us if it exists.
  const claudeAvailable =
    process.platform === 'darwin'
      ? await execAsync(`security find-generic-password -s ${shellQuote(KEYCHAIN_SERVICE)}`)
          .then(() => true)
          .catch(() => false)
      : false;
  const codexAvailable = await fs
    .access(CODEX_AUTH_FILE)
    .then(() => true)
    .catch(() => false);
  const pi = await readPiAuthFile();
  // We pass placeholder PiOAuthCredential nulls below — we just need the
  // *availability* booleans plus pi's real entries. statusFromCreds reads
  // its `codex` / `claude` args only for those two booleans (which we
  // overwrite directly), so it's fine to not re-read the actual creds.
  const status = statusFromCreds(null, null, pi);
  status.codexAvailable = codexAvailable;
  status.claudeAvailable = claudeAvailable;
  return status;
}

/**
 * Read source creds (Codex auth.json, Claude Code keychain) and write into
 * pi's auth.json. Codex is preferred when both are present — Anthropic is
 * only registered if Codex is absent, so pi's default-model picker lands
 * on Codex.
 *
 * @param opts.overwrite When true, replaces existing pi entries.
 *   Use for an explicit "Re-sync" button. When false (auto-import), we
 *   leave already-populated slots alone so a working pi setup doesn't get
 *   stomped by stale source-file tokens.
 */
export async function importAvailableCreds(
  opts: { overwrite?: boolean } = {},
): Promise<AuthImportResult> {
  const overwrite = !!opts.overwrite;
  const [codex, claude] = await Promise.all([readCodexCreds(), readClaudeCodeCreds()]);
  const pi = await readPiAuthFile();
  let importedCodex = false;
  let importedClaude = false;
  let preferred: AuthImportResult['preferred'];

  if (codex && (overwrite || !pi['openai-codex'])) {
    pi['openai-codex'] = codex;
    importedCodex = true;
  }
  // Codex preferred — only write the Anthropic slot when no Codex creds
  // exist on the machine. If the user later removes Codex and re-syncs,
  // Anthropic will get registered then.
  if (claude && !codex && (overwrite || !pi['anthropic'])) {
    pi['anthropic'] = claude;
    importedClaude = true;
  }
  if (codex) preferred = 'openai-codex';
  else if (claude) preferred = 'anthropic';

  if (importedCodex || importedClaude) {
    await writePiAuthFile(pi);
  }

  const status = statusFromCreds(codex, claude, pi);
  const result: AuthImportResult = { importedCodex, importedClaude, status };
  if (preferred) result.preferred = preferred;
  return result;
}

/** Path of pi's auth.json, exposed so Settings can show it in the UI. */
export function getPiAuthPath(): string {
  return piAuthPath();
}
