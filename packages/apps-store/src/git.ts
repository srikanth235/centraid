// Thin promisified wrapper around the system `git` binary.
//
// We shell out instead of pulling in a JS git library for three
// reasons: the surface we need is small (~10 subcommands), the
// embedded Electron host already ships git, and the system binary is
// the reference implementation — no semantic-drift risk against a
// porcelain we can't audit. The standalone gateway daemon documents
// the git binary requirement in its README; if a JS-only path
// becomes necessary later, swapping the implementation behind this
// module is the change.
//
// The wrapper is intentionally minimal:
//   - one `run()` entry point that spawns `git -C <cwd> <args>` and
//     buffers stdout/stderr,
//   - non-zero exit codes throw `GitError` carrying the args, exit
//     code, and stderr (so callers don't have to format their own
//     error messages),
//   - stdout is returned trimmed (every porcelain command we use
//     ends in a trailing newline we don't want to thread through
//     parsers).
//
// Environment scrubbing: we explicitly set committer + author
// identity to the centraid agent on every commit-producing call.
// That way the host's `~/.gitconfig` user.name/email never leak
// into the app repo's history — every commit is attributable to the
// agent identity per the issue's "Commit authorship" decision.

import { spawn } from 'node:child_process';

/** Author + committer identity stamped on every commit. */
export const AGENT_IDENTITY = {
  name: 'Centraid Agent',
  email: 'bot@centraid',
} as const;

export interface GitRunOptions {
  /**
   * Repo or worktree the command runs against. Equivalent to
   * `git -C <cwd>`. Required because we never assume `process.cwd()`.
   */
  cwd: string;
  /**
   * Extra environment variables. Merged on top of the scrubbed
   * default (which forces the agent identity and disables every
   * interactive prompt).
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Bytes-on-stdin. When provided, written to the child's stdin and
   * closed; useful for `commit -F -` and similar.
   */
  stdin?: string;
  /**
   * Don't throw on non-zero exit. The caller gets `{ code, stdout,
   * stderr }` and decides. Used by `revParse` and `existsRef` style
   * probes where "missing" is an expected outcome.
   */
  allowNonZero?: boolean;
}

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    public readonly args: readonly string[],
    public readonly code: number,
    public readonly stdout: string,
    public readonly stderr: string,
  ) {
    super(
      `git ${args.join(' ')} exited with code ${code}: ${stderr.trim() || stdout.trim() || '(no output)'}`,
    );
    this.name = 'GitError';
  }
}

/**
 * Spawn `git` with the given args. Throws `GitError` on non-zero
 * exit unless `allowNonZero` is set. Returns the trimmed stdout
 * (full result via `runRaw` when callers need stderr too).
 */
export async function run(args: readonly string[], opts: GitRunOptions): Promise<string> {
  const result = await runRaw(args, opts);
  if (result.code !== 0 && !opts.allowNonZero) {
    throw new GitError(args, result.code, result.stdout, result.stderr);
  }
  return result.stdout.replace(/\n+$/, '');
}

export function runRaw(args: readonly string[], opts: GitRunOptions): Promise<GitRunResult> {
  return new Promise<GitRunResult>((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Force the agent identity on every commit-producing call. The
      // alternative — `git -c user.name=... -c user.email=...` on
      // every commit — is noisier and easier to forget on a new
      // call site.
      GIT_AUTHOR_NAME: AGENT_IDENTITY.name,
      GIT_AUTHOR_EMAIL: AGENT_IDENTITY.email,
      GIT_COMMITTER_NAME: AGENT_IDENTITY.name,
      GIT_COMMITTER_EMAIL: AGENT_IDENTITY.email,
      // No interactive prompts (askpass, credential helpers, editor)
      // — every operation has to be fully scripted.
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: 'true',
      GIT_EDITOR: 'true',
      ...opts.env,
    };
    const child = spawn('git', args as string[], {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (opts.stdin !== undefined) {
      child.stdin.end(opts.stdin);
    } else {
      child.stdin.end();
    }
  });
}

/**
 * `git rev-parse <ref>` returning the sha, or `undefined` if the
 * ref doesn't resolve. Used as the canonical "does this ref exist"
 * probe — `for-each-ref` works too but rev-parse is a single fork.
 */
export async function revParse(cwd: string, ref: string): Promise<string | undefined> {
  const result = await runRaw(['rev-parse', '--verify', '--quiet', ref], {
    cwd,
    allowNonZero: true,
  });
  if (result.code !== 0) return undefined;
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : undefined;
}
