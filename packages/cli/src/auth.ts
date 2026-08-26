export interface AuthOptions {
  token?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve a bearer for product CLI calls.
 * Precedence: --token > CENTRAID_TOKEN > CENTRAID_GATEWAY_TOKEN.
 *
 * The daemon keeps no persistent `token.bin` (#505), so there is no
 * on-disk token to auto-discover from a data dir. To reach a local daemon's
 * loopback listener, start it with `CENTRAID_GATEWAY_TOKEN=<hex>` and pass the
 * same value here (or `--token`); a remote `direct`-tier gateway takes the
 * per-device token minted by pairing.
 */
export function resolveToken(opts: AuthOptions): string | undefined {
  if (opts.token && opts.token.trim() !== "") return opts.token.trim();
  const env = opts.env ?? process.env;
  return (
    env.CENTRAID_TOKEN?.trim() ||
    env.CENTRAID_GATEWAY_TOKEN?.trim() ||
    undefined
  );
}
